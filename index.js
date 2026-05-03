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

async function sendAudio(chatId, audioBuffer, filename = "book.mp3") {
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

async function elevenLabs(text) {
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
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.8,
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return await res.buffer();
}

async function searchBook(query) {
  // 1. пробуем Gutenberg
  const gut = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(query)}`)
    .then(r => r.json());

  if (gut.results && gut.results.length > 0) {
    const book = gut.results[0];

    const url =
      book.formats["text/plain; charset=utf-8"] ||
      book.formats["text/plain"];

    if (url) {
      const text = await fetch(url).then(r => r.text());

      return {
        title: book.title,
        text
      };
    }
  }

  // 2. fallback — Wikisource (старый метод)
  const searchUrl =
    "https://ru.wikisource.org/w/api.php?action=opensearch&format=json&limit=5&search=" +
    encodeURIComponent(query);

  const data = await fetch(searchUrl).then(r => r.json());
  const title = data?.[1]?.[0];

  if (!title) return null;

  const pageUrl =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text&page=" +
    encodeURIComponent(title);

  const page = await fetch(pageUrl).then(r => r.json());
  const html = page?.parse?.text?.["*"];

  if (!html) return null;

  const cleanText = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title,
    text: cleanText
  };
}
  const searchUrl =
    "https://ru.wikisource.org/w/api.php?action=opensearch&format=json&limit=5&search=" +
    encodeURIComponent(query);

  const data = await fetch(searchUrl).then((r) => r.json());
  const title = data?.[1]?.[0];

  if (!title) return null;

  const pageUrl =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text&page=" +
    encodeURIComponent(title);

  const page = await fetch(pageUrl).then((r) => r.json());
  const html = page?.parse?.text?.["*"];

  if (!html) return null;

  const cleanText = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title,
    text: cleanText,
  };
}

function makeParts(text, size = 1800) {
  const parts = [];
  let i = 0;

  while (i < text.length) {
    let part = text.slice(i, i + size);
    const lastDot = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?")
    );

    if (lastDot > 700) {
      part = part.slice(0, lastDot + 1);
    }

    parts.push(part.trim());
    i += part.length;
  }

  return parts.filter(Boolean);
}

async function readStream(chatId, title, text) {
  const parts = makeParts(text);

  sessions.set(chatId, { stop: false });

  await sendText(chatId, `Нашёл: ${title}\nНачинаю читать потоком.`);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || session.stop) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    const audio = await elevenLabs(parts[i]);
    await sendAudio(chatId, audio, `book_part_${i + 1}.mp3`);
  }

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

    if (text === "/stop") {
      sessions.set(chatId, { stop: true });
      return;
    }

    if (text === "/start") {
      await sendText(
        chatId,
        "Напиши название книги. Я найду её в интернете и начну читать голосом."
      );
      return;
    }

    await sendText(chatId, "Ищу книгу в интернете...");

    const book = await searchWikisource(text);

    if (!book || !book.text || book.text.length < 1000) {
      await sendText(
        chatId,
        "Не нашёл нормальный текст книги в легальном открытом источнике. Попробуй: Пушкин, Гоголь, Толстой, Достоевский."
      );
      return;
    }

    await readStream(chatId, book.title, book.text);
  } catch (error) {
    console.log("ERROR:", error.message);
    if (req.body.message?.chat?.id) {
      await sendText(req.body.message.chat.id, "Ошибка:\n" + error.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
