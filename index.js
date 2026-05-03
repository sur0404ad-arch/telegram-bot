const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

async function sendText(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendAction(chatId, action = "upload_audio") {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

async function sendAudio(chatId, audioBuffer, filename, caption = "") {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg",
  });
  if (caption) form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });

  if (!res.ok) throw new Error(await res.text());
}

function prepareForVoice(text) {
  return text
    .replace(/Материал из Викитеки|Викитека|Содержание|Править|править код/gi, "")
    .replace(/Перейти к навигации|Перейти к поиску/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function makeVoice(text) {
  const clean = prepareForVoice(text).slice(0, 4500);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: clean,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.62,
          similarity_boost: 0.85,
          style: 0.08,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function cleanHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<div[^>]*(metadata|noprint|mw-editsection|printfooter|catlinks)[\s\S]*?<\/div>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSmart(text) {
  const clean = prepareForVoice(text);

  const first = clean.slice(0, 900);
  const firstCut = Math.max(first.lastIndexOf("."), first.lastIndexOf("!"), first.lastIndexOf("?"));
  const firstPart = firstCut > 300 ? first.slice(0, firstCut + 1) : first;

  const parts = [firstPart.trim()];
  let rest = clean.slice(firstPart.length).trim();

  const max = 3200;

  while (rest.length > 0) {
    let part = rest.slice(0, max);
    const cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?"),
      part.lastIndexOf("»")
    );

    if (cut > 1200) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 200);
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=12&srsearch=" +
    encodeURIComponent(query);

  const data = await fetch(url).then((r) => r.json());
  return data?.query?.search?.map((x) => x.title) || [];
}

async function getWikiPage(title) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text|links&page=" +
    encodeURIComponent(title);

  const data = await fetch(url).then((r) => r.json());
  if (!data.parse) return null;

  return {
    title: data.parse.title,
    text: cleanHtml(data.parse.text?.["*"] || ""),
    links: data.parse.links || [],
  };
}

function badTitle(title) {
  const t = title.toLowerCase();
  return (
    t.includes("эпилог") ||
    t.includes("обсуждение") ||
    t.includes("категория") ||
    t.includes("автор:") ||
    t.includes("письмо") ||
    t.includes("комментар")
  );
}

function scoreTitle(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  let score = 0;
  if (t.includes(q)) score += 100;
  if (t.includes("(")) score += 30;
  if (t.includes("/часть первая")) score += 100;
  if (t.includes("/часть 1")) score += 100;
  if (t.endsWith("/i")) score += 80;
  if (t.includes("/глава i")) score += 80;
  if (badTitle(t)) score -= 500;

  return score;
}

function linkPriority(title) {
  const t = title.toLowerCase();

  if (badTitle(t)) return 999;
  if (t.includes("часть первая")) return 1;
  if (t.includes("часть 1")) return 1;
  if (t.endsWith("/i")) return 2;
  if (t.includes("глава i")) return 2;
  if (t.includes("часть вторая")) return 20;
  if (t.includes("часть 2")) return 20;

  return 10;
}

async function findBook(query) {
  const titles = await wikiSearch(query);
  if (!titles.length) return null;

  const sorted = titles
    .filter((t) => !badTitle(t))
    .sort((a, b) => scoreTitle(b, query) - scoreTitle(a, query));

  for (const title of sorted.slice(0, 6)) {
    const page = await getWikiPage(title);
    if (!page) continue;

    if (page.text.length > 10000 && !badTitle(page.title)) {
      return { title: page.title, text: page.text };
    }

    const childLinks = page.links
      .map((l) => l["*"])
      .filter(Boolean)
      .filter((x) => x.startsWith(page.title + "/"))
      .filter((x) => !badTitle(x))
      .sort((a, b) => linkPriority(a) - linkPriority(b) || a.localeCompare(b, "ru"))
      .slice(0, 30);

    let fullText = "";

    for (const childTitle of childLinks) {
      const child = await getWikiPage(childTitle);
      if (!child || child.text.length < 800) continue;

      fullText += "\n\n" + child.text;

      if (fullText.length > 150000) break;
    }

    if (fullText.length > 5000) {
      return { title: page.title, text: fullText };
    }
  }

  return null;
}

async function readBook(chatId, query) {
  sessions.set(chatId, { active: true });

  await sendText(chatId, "Принял запрос. Сначала отправлю короткое вступление, затем начну чтение книги.");

  const introPromise = makeVoice(
    `Вы попросили книгу: ${query}. Я ищу текст и готовлю первую часть. Пожалуйста, подождите.`
  );

  const bookPromise = findBook(query);

  try {
    await sendAction(chatId, "upload_audio");
    const introAudio = await introPromise;
    await sendAudio(chatId, introAudio, "intro.mp3", "Вступление");
  } catch (e) {
    console.log("INTRO ERROR:", e.message);
  }

  await sendText(chatId, "Ищу и очищаю текст книги. Это может занять немного времени.");

  const book = await bookPromise;

  if (!book) {
    sessions.delete(chatId);
    await sendText(chatId, "Не нашёл нормальный текст. Попробуй точнее: название + автор.");
    return;
  }

  const parts = splitSmart(book.text);

  await sendText(
    chatId,
    `Нашёл: ${book.title}\nНачинаю чтение.\nПервая часть короткая, дальше пойдут длинные части.\nОстановить: /stop`
  );

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    await sendAction(chatId, "upload_audio");

    if (i === 0) {
      await sendText(chatId, "Готовлю первую часть...");
    } else {
      await sendText(chatId, `Готовлю часть ${i + 1}...`);
    }

    const audio = await makeVoice(parts[i]);

    await sendAudio(
      chatId,
      audio,
      `part_${i + 1}.mp3`,
      `Часть ${i + 1} из ${parts.length}`
    );

    await new Promise((r) => setTimeout(r, 300));
  }

  sessions.delete(chatId);
  await sendText(chatId, "Книга закончилась.");
}

app.get("/", (req, res) => {
  res.send("Book voice reader is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendText(
        chatId,
        "Напиши название книги и автора. Например:\nПреступление и наказание Достоевский"
      );
      return;
    }

    if (text === "/stop") {
      const session = sessions.get(chatId);
      if (session) session.active = false;
      await sendText(chatId, "Останавливаю чтение.");
      return;
    }

    if (sessions.get(chatId)?.active) {
      await sendText(chatId, "Уже читаю. Напиши /stop, чтобы остановить.");
      return;
    }

    readBook(chatId, text).catch(async (err) => {
      console.log("STREAM ERROR:", err.message);
      await sendText(chatId, "Ошибка чтения:\n" + err.message);
      sessions.delete(chatId);
    });
  } catch (err) {
    console.log("ERROR:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
