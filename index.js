const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sendText(chatId, text) {
  return tg("sendMessage", { chat_id: chatId, text });
}

async function sendAudio(chatId, audioBuffer, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg",
  });

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });

  if (!res.ok) throw new Error(await res.text());
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
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.8,
        },
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .replace(/\*\*\* START[\s\S]*?\*\*\*/i, "")
    .replace(/\*\*\* END[\s\S]*/i, "")
    .trim();
}

function splitText(text, max = 1800) {
  const parts = [];
  let rest = text;

  while (rest.length > 0) {
    let part = rest.slice(0, max);
    const cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?"),
      part.lastIndexOf("\n")
    );

    if (cut > 800) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter(Boolean);
}

async function searchGutendex(query) {
  const url = `https://gutendex.com/books?search=${encodeURIComponent(query)}`;
  const data = await fetch(url).then((r) => r.json());

  if (!data.results || !data.results.length) return null;

  const book = data.results[0];
  const textUrl =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain; charset=us-ascii"] ||
    book.formats["text/plain"];

  if (!textUrl) return null;

  const raw = await fetch(textUrl).then((r) => r.text());

  return {
    title: book.title,
    source: "Project Gutenberg",
    text: cleanText(raw),
  };
}

async function searchWikisource(query) {
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

  const text = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 1000) return null;

  return {
    title,
    source: "Wikisource",
    text,
  };
}

async function findBook(query) {
  const sources = [
    () => searchWikisource(query),
    () => searchGutendex(query),
  ];

  for (const source of sources) {
    try {
      const book = await source();
      if (book && book.text && book.text.length > 1000) return book;
    } catch (e) {
      console.log("SOURCE ERROR:", e.message);
    }
  }

  return null;
}

async function readBookStream(chatId, book) {
  const parts = splitText(book.text, 1800);

  sessions.set(chatId, {
    active: true,
    title: book.title,
    index: 0,
  });

  await sendText(
    chatId,
    `Нашёл: ${book.title}\nИсточник: ${book.source}\nНачинаю читать потоком.\nКоманда остановки: /stop`
  );

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);

    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    session.index = i;

    const audio = await makeVoice(parts[i]);
    await sendAudio(chatId, audio, `part_${i + 1}.mp3`);

    await new Promise((resolve) => setTimeout(resolve, 1500));
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
        "Напиши название книги. Я найду легальный открытый текст и начну читать голосом."
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
      await sendText(chatId, "Сейчас уже идёт чтение. Напиши /stop, чтобы остановить.");
      return;
    }

    await sendText(chatId, "Ищу книгу в интернете...");

    const book = await findBook(text);

    if (!book) {
      await sendText(
        chatId,
        "Не нашёл легальный открытый текст этой книги.\n\nПопробуй:\n- Преступление и наказание\n- Война и мир\n- Капитанская дочка\n- Шинель\n- Анна Каренина\n\nЕсли книга современная или защищена авторским правом — пришли текст, и я озвучу."
      );
      return;
    }

    readBookStream(chatId, book).catch(async (error) => {
      console.log("STREAM ERROR:", error.message);
      await sendText(chatId, "Ошибка чтения:\n" + error.message);
      sessions.delete(chatId);
    });
  } catch (error) {
    console.log("ERROR:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
