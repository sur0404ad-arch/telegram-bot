console.log("NEW VERSION LOADED");const express = require("express");
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
    .replace(/Перейти к навигации|Перейти к поиску/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitFast(text) {
  const clean = prepareForVoice(text);

  const parts = [];

  let first = clean.slice(0, 700);
  let cut = Math.max(first.lastIndexOf("."), first.lastIndexOf("!"), first.lastIndexOf("?"));
  if (cut > 250) first = first.slice(0, cut + 1);
  parts.push(first.trim());

  let rest = clean.slice(first.length).trim();

  while (rest.length > 0) {
    let part = rest.slice(0, 2200);
    cut = Math.max(part.lastIndexOf("."), part.lastIndexOf("!"), part.lastIndexOf("?"));

    if (cut > 900) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();

    if (parts.length >= 12) break;
  }

  return parts.filter((p) => p.length > 120);
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
          stability: 0.65,
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

function badTitle(title) {
  const t = title.toLowerCase();
  return (
    t.includes("эпилог") ||
    t.includes("обсуждение") ||
    t.includes("категория") ||
    t.includes("автор:") ||
    t.includes("комментар")
  );
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=" +
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

function priority(title) {
  const t = title.toLowerCase();

  if (badTitle(t)) return 999;
  if (t.includes("часть первая")) return 1;
  if (t.includes("часть 1")) return 1;
  if (t.endsWith("/i")) return 2;
  if (t.includes("глава i")) return 2;
  if (t.includes("/1")) return 3;
  return 10;
}

async function findFirstReadablePage(query) {
  const titles = await wikiSearch(query);

  for (const title of titles.slice(0, 5)) {
    const page = await getWikiPage(title);
    if (!page) continue;

    if (page.text.length > 5000 && !badTitle(page.title)) {
      return { title: page.title, text: page.text };
    }

    const childTitles = page.links
      .map((l) => l["*"])
      .filter(Boolean)
      .filter((x) => x.startsWith(page.title + "/"))
      .filter((x) => !badTitle(x))
      .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, "ru"))
      .slice(0, 8);

    for (const childTitle of childTitles) {
      const child = await getWikiPage(childTitle);
      if (child && child.text.length > 1500 && !badTitle(child.title)) {
        return { title: child.title, text: child.text };
      }
    }
  }

  return null;
}

async function readFast(chatId, query) {
  sessions.set(chatId, { active: true });

  await sendText(chatId, "Ищу книгу. Сейчас начну с первой найденной главы, чтобы не было долгой паузы...");

  const book = await findFirstReadablePage(query);

  if (!book) {
    sessions.delete(chatId);
    await sendText(chatId, "Не нашёл текст. Попробуй: название + автор.");
    return;
  }

  const parts = splitFast(book.text);

  await sendText(chatId, `Нашёл: ${book.title}\nГотовлю первое аудио...`);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    await sendAction(chatId);

    const audio = await makeVoice(parts[i]);

    await sendAudio(
      chatId,
      audio,
      `part_${i + 1}.mp3`,
      `Часть ${i + 1}`
    );
  }

  sessions.delete(chatId);
  await sendText(chatId, "Текущая глава закончилась.");
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
app.listen(PORT, () => console.log("Server started"));
