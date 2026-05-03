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

async function sendAction(chatId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "upload_audio" }),
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
    .replace(/Перейти к навигации|Перейти к поиску|Источник|См. также/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitForFastStart(text) {
  const clean = prepareForVoice(text);
  const parts = [];

  let first = clean.slice(0, 450);
  let cut = Math.max(first.lastIndexOf("."), first.lastIndexOf("!"), first.lastIndexOf("?"));
  if (cut > 150) first = first.slice(0, cut + 1);
  parts.push(first.trim());

  let rest = clean.slice(first.length).trim();

  while (rest.length > 0 && parts.length < 10) {
    let part = rest.slice(0, 1700);
    cut = Math.max(part.lastIndexOf("."), part.lastIndexOf("!"), part.lastIndexOf("?"));
    if (cut > 700) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 80);
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
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.9,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function badTitle(title) {
  const t = title.toLowerCase();
  return (
    t.includes("эпилог") ||
    t.includes("обсуждение") ||
    t.includes("категория") ||
    t.includes("автор:") ||
    t.includes("комментар") ||
    t.includes("письмо")
  );
}

function titleScore(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  let score = 0;
  if (badTitle(t)) score -= 1000;
  if (t.includes(q)) score += 300;
  if (!t.includes("/")) score += 200;
  if (t.includes("(")) score += 50;
  if (t.includes("/часть первая")) score += 120;
  if (t.includes("/часть 1")) score += 120;
  if (t.endsWith("/i")) score += 100;
  if (t.includes("/глава i")) score += 100;
  if (t.includes("/iii") || t.includes("/iv") || t.includes("/v") || t.includes("/vi")) score -= 100;
  return score;
}

function linkPriority(title) {
  const t = title.toLowerCase();

  if (badTitle(t)) return 999;
  if (t.includes("часть первая")) return 1;
  if (t.includes("часть 1")) return 1;
  if (t.endsWith("/i")) return 2;
  if (t.includes("глава i")) return 2;
  if (t.endsWith("/1")) return 3;
  if (t.includes("часть вторая")) return 30;
  if (t.includes("часть 2")) return 30;
  return 10;
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" +
    encodeURIComponent(query);

  const data = await fetch(url).then((r) => r.json());
  return data?.query?.search?.map((x) => x.title).filter((x) => !badTitle(x)) || [];
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

async function findFirstReadablePage(query) {
  const titles = await wikiSearch(query);
  if (!titles.length) return null;

  const sorted = titles.sort((a, b) => titleScore(b, query) - titleScore(a, query));

  for (const title of sorted.slice(0, 5)) {
    const page = await getWikiPage(title);
    if (!page) continue;

    const childTitles = page.links
      .map((l) => l["*"])
      .filter(Boolean)
      .filter((x) => x.startsWith(page.title + "/"))
      .filter((x) => !badTitle(x))
      .sort((a, b) => linkPriority(a) - linkPriority(b) || a.localeCompare(b, "ru"))
      .slice(0, 6);

    for (const childTitle of childTitles) {
      const child = await getWikiPage(childTitle);
      if (child && child.text.length > 1500) {
        return { title: child.title, text: child.text };
      }
    }

    if (page.text.length > 2500 && !badTitle(page.title)) {
      return { title: page.title, text: page.text };
    }
  }

  return null;
}

async function readFast(chatId, query) {
  sessions.set(chatId, { active: true });

  await sendText(chatId, "Ищу книгу и готовлю первое аудио. Старт должен быть быстрее.");

  const book = await findFirstReadablePage(query);

  if (!book) {
    sessions.delete(chatId);
    await sendText(chatId, "Не нашёл текст. Попробуй точнее: название + автор.");
    return;
  }

  const parts = splitForFastStart(book.text);

  await sendText(chatId, `Нашёл: ${book.title}\nОтправляю первую короткую часть.`);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    await sendAction(chatId);

    const audio = await makeVoice(parts[i]);

    await sendAudio(chatId, audio, `part_${i + 1}.mp3`, `Часть ${i + 1}`);
  }

  sessions.delete(chatId);
  await sendText(chatId, "Глава закончилась. Напиши название снова, если продолжить.");
}

app.get("/", (req, res) => {
  res.send("Fast book reader is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendText(chatId, "Напиши название книги и автора.");
      return;
    }

    if (text === "/stop") {
      const session = sessions.get(chatId);
      if (session) session.active = false;
      await sendText(chatId, "Останавливаю чтение.");
      return;
    }

    if (sessions.get(chatId)?.active) {
      await sendText(chatId, "Уже читаю. Напиши /stop.");
      return;
    }

    readFast(chatId, text).catch(async (err) => {
      console.log("STREAM ERROR:", err.message);
      await sendText(chatId, "Ошибка:\n" + err.message);
      sessions.delete(chatId);
    });
  } catch (err) {
    console.log("ERROR:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("FAST VERSION STARTED"));
