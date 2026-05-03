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

function prepareForVoice(text) {
  return text
    .replace(/Материал из Викитеки|Викитека|Содержание|Править|править код/gi, "")
    .replace(/Перейти к навигации|Перейти к поиску/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text, max = 3500) {
  const clean = prepareForVoice(text);
  const parts = [];
  let rest = clean;

  while (rest.length > 0) {
    let part = rest.slice(0, max);

    const cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?"),
      part.lastIndexOf("»")
    );

    if (cut > 1600) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 200);
}

async function makeVoice(text) {
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
        text: prepareForVoice(text),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.85,
          style: 0.22,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=" +
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
  if (t.includes("/часть первая")) score += 80;
  if (t.includes("/часть 1")) score += 80;
  if (t.includes("/i")) score += 50;
  if (t.includes("/глава i")) score += 50;
  if (t.includes("/эпилог")) score -= 500;
  if (badTitle(title)) score -= 300;

  return score;
}

function sortBookLinks(links, mainTitle) {
  return links
    .map((l) => l["*"])
    .filter(Boolean)
    .filter((x) => x.startsWith(mainTitle + "/"))
    .filter((x) => !badTitle(x))
    .sort((a, b) => {
      const aa = a.toLowerCase();
      const bb = b.toLowerCase();

      const priority = (x) => {
        if (x.includes("часть первая")) return 1;
        if (x.includes("часть 1")) return 1;
        if (x.endsWith("/i")) return 2;
        if (x.includes("глава i")) return 2;
        if (x.includes("часть вторая")) return 20;
        if (x.includes("часть 2")) return 20;
        return 10;
      };

      return priority(aa) - priority(bb) || a.localeCompare(b, "ru");
    });
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

    if (page.text.length > 8000 && !badTitle(page.title)) {
      return { title: page.title, text: page.text };
    }

    const childLinks = sortBookLinks(page.links, page.title).slice(0, 25);

    let fullText = "";

    for (const childTitle of childLinks) {
      const child = await getWikiPage(childTitle);
      if (!child || child.text.length < 800) continue;

      fullText += "\n\n" + child.text;

      if (fullText.length > 120000) break;
    }

    if (fullText.length > 5000) {
      return { title: page.title, text: fullText };
    }
  }

  return null;
}

async function readBook(chatId, book) {
  const parts = splitText(book.text, 3500);

  sessions.set(chatId, { active: true });

  await sendText(
    chatId,
    `Нашёл: ${book.title}\n\nГотовлю первую аудио-часть. Подождите 20–40 секунд.\nДальше части будут приходить подряд.\n\nОстановить: /stop`
  );

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);

    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    await sendAction(chatId, "upload_audio");

    if (i > 0) {
      await sendText(chatId, `Готовлю часть ${i + 1}...`);
    }

    const audio = await makeVoice(parts[i]);

    await sendAudio(
      chatId,
      audio,
      `part_${i + 1}.mp3`,
      `Часть ${i + 1} из ${parts.length}`
    );

    await new Promise((r) => setTimeout(r, 1200));
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

    await sendText(chatId, "Ищу книгу в интернете. Подождите пожалуйста...");

    const book = await findBook(text);

    if (!book) {
      await sendText(
        chatId,
        "Не нашёл нормальный текст. Попробуй точнее: название + автор.\n\nНапример:\nПреступление и наказание Достоевский"
      );
      return;
    }

    readBook(chatId, book).catch(async (err) => {
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
