console.log("BOOK BOT CLEAN VOICE VERSION STARTED");

const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
}

async function sendText(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function sendAction(chatId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "upload_audio" })
  });
}

async function sendAudio(chatId, buffer, filename, caption) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("audio", buffer, {
    filename,
    contentType: "audio/mpeg"
  });

  if (caption) form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }
}

function cleanHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanVoiceText(text) {
  return text
    .replace(/Материал из Викитеки|Викитека|Содержание|Править|править код/gi, "")
    .replace(/Перейти к навигации|Перейти к поиску|Источник|См. также/gi, "")
    .replace(/Эта страница в последний раз была отредактирована[\s\S]*/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function narrationText(text) {
  return cleanVoiceText(text)
    .replace(/([.!?])\s+/g, "$1...\n\n")
    .replace(/—/g, " — ")
    .trim();
}

function splitParts(text) {
  const clean = cleanVoiceText(text);
  const parts = [];
  let rest = clean;

  while (rest.length > 0 && parts.length < 8) {
    let part = rest.slice(0, 1800);

    const cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?")
    );

    if (cut > 700) {
      part = part.slice(0, cut + 1);
    }

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 80);
}

async function makeVoice(text) {
  const res = await Promise.race([
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: narrationText(text),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.8,
          style: 0.48,
          use_speaker_boost: true
        }
      })
    }),
    timeout(45000)
  ]);

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return await res.buffer();
}

function isModernCopyrightRisk(query) {
  const q = query.toLowerCase();

  return (
    q.includes("гарри поттер") ||
    q.includes("harry potter") ||
    q.includes("мастер и маргарита") ||
    q.includes("булгаков")
  );
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=" +
    encodeURIComponent(query);

  const data = await Promise.race([
    fetch(url).then((r) => r.json()),
    timeout(12000)
  ]);

  return data?.query?.search?.map((x) => x.title) || [];
}

async function getWikiPage(title) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text|links&page=" +
    encodeURIComponent(title);

  const data = await Promise.race([
    fetch(url).then((r) => r.json()),
    timeout(12000)
  ]);

  if (!data.parse) return null;

  return {
    title: data.parse.title,
    text: cleanHtml(data.parse.text?.["*"] || "")
  };
}

async function findBook(query) {
  const titles = await wikiSearch(query);

  for (const title of titles) {
    const lower = title.toLowerCase();

    if (
      lower.includes("обсуждение") ||
      lower.includes("категория") ||
      lower.includes("автор:")
    ) {
      continue;
    }

    const page = await getWikiPage(title);

    if (page && page.text.length > 1500) {
      return page;
    }
  }

  return null;
}

async function readBook(chatId, query) {
  sessions.set(chatId, { active: true });

  if (isModernCopyrightRisk(query)) {
    await sendText(
      chatId,
      "Эта книга, скорее всего, защищена авторским правом. Я могу читать только легальные открытые тексты.\n\nПопробуй:\nПреступление и наказание Достоевский\nКапитанская дочка Пушкин\nШинель Гоголь"
    );
    sessions.delete(chatId);
    return;
  }

  await sendText(chatId, "📖 Ищу легальный открытый текст книги...");

  const book = await findBook(query);

  if (!book) {
    await sendText(
      chatId,
      "Не нашёл легальный открытый текст. Попробуй точнее: название + автор."
    );
    sessions.delete(chatId);
    return;
  }

  await sendText(chatId, `Нашёл: ${book.title}\nГотовлю голос. Остановить: /stop`);

  const parts = splitParts(book.text);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);

    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      sessions.delete(chatId);
      return;
    }

    await sendAction(chatId);

    const audio = await makeVoice(parts[i]);

    await sendAudio(chatId, audio, `part_${i + 1}.mp3`, `Часть ${i + 1}`);
  }

  await sendText(chatId, "Чтение главы закончено.");
  sessions.delete(chatId);
}

app.get("/", (req, res) => {
  res.send("Book bot is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("USER MESSAGE:", text);

    if (text === "/start") {
      await sendText(
        chatId,
        "Напиши название книги и автора.\nНапример: Преступление и наказание Достоевский"
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
      await sendText(chatId, "Уже читаю. Напиши /stop.");
      return;
    }

    readBook(chatId, text).catch(async (err) => {
      console.log("READ ERROR:", err.message);
      sessions.delete(chatId);
      await sendText(chatId, "Ошибка чтения:\n" + err.message);
    });
  } catch (err) {
    console.log("WEBHOOK ERROR:", err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("BOOK BOT CLEAN VOICE VERSION STARTED");
  console.log("SERVER RUNNING ON " + PORT);
});
