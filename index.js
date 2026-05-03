const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

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

async function sendAudio(chatId, audioBuffer, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg",
  });

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });
}

function prepareForVoice(text) {
  return text
    .replace(/Викитека|Материал из Викитеки/gi, "")
    .replace(/Содержание|Править|править код|Источник/gi, "")
    .replace(/\[[0-9]+\]/g, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function makeVoice(text) {
  const clean = prepareForVoice(text);

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
          stability: 0.75,
          similarity_boost: 0.9,
          style: 0.12,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<sup[\s\S]*?<\/sup>/g, "")
    .replace(/<table[\s\S]*?<\/table>/g, "")
    .replace(/<div[^>]*(class="[^"]*(printfooter|catlinks|metadata|noprint|mw-editsection)[^"]*")[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

splitText(book.text, 3500)
  const parts = [];
  let rest = prepareForVoice(text);

  while (rest.length > 0) {
    let part = rest.slice(0, max);
    const cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?"),
      part.lastIndexOf(";")
    );

    if (cut > 400) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 50);
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
    text: htmlToText(data.parse.text?.["*"] || ""),
    links: data.parse.links || [],
  };
}

function scoreTitle(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase();

  let score = 0;
  if (t.includes(q)) score += 100;
  if (t.includes("(")) score += 20;
  if (t.includes("/")) score += 10;
  if (t.includes("автор")) score -= 30;
  if (t.includes("обсуждение")) score -= 50;
  if (t.includes("категория")) score -= 50;

  return score;
}

async function findBook(query) {
  const titles = await wikiSearch(query);

  if (!titles.length) return null;

  const sorted = titles.sort((a, b) => scoreTitle(b, query) - scoreTitle(a, query));

  for (const title of sorted.slice(0, 5)) {
    const page = await getWikiPage(title);
    if (!page) continue;

    if (page.text.length > 5000) {
      return { title: page.title, text: page.text };
    }

    const childLinks = page.links
      .map((l) => l["*"])
      .filter((x) => x && x.startsWith(page.title + "/"))
      .filter((x) => !x.includes("Обсуждение"))
      .slice(0, 40);

    let full = "";

    for (const childTitle of childLinks) {
      const child = await getWikiPage(childTitle);
      if (!child || child.text.length < 500) continue;

      full += "\n\n" + child.text;

      if (full.length > 60000) break;
    }

    if (full.length > 3000) {
      return { title: page.title, text: full };
    }
  }

  return null;
}

async function readBook(chatId, book) {
  const parts = splitText(book.text, 900);
  sessions.set(chatId, { active: true });

  await sendText(chatId, `Нашёл: ${book.title}\nНачинаю читать.\nОстановить: /stop`);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    const audio = await makeVoice(parts[i]);
    await sendAudio(chatId, audio, `part_${i + 1}.mp3`);

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
      await sendText(chatId, "Напиши название книги. Я найду текст и начну читать.");
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

    await sendText(chatId, "Ищу книгу...");

    const book = await findBook(text);

    if (!book) {
      await sendText(chatId, "Не нашёл книгу. Попробуй точнее: автор + название.");
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
