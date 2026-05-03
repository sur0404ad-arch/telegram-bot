const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

const BOOK_MAP = {
  "преступление и наказание": "Преступление и наказание (Достоевский)",
  "капитанская дочка": "Капитанская дочка (Пушкин)/1978 (СО)",
  "шинель": "Шинель (Гоголь)/ПСС 1938 (СО)",
  "война и мир": "Война и мир (Толстой)",
  "анна каренина": "Анна Каренина (Толстой)",
};

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
      }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function cleanText(text) {
  return text
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text, max = 1800) {
  const parts = [];
  let rest = text;

  while (rest.length > 0) {
    let part = rest.slice(0, max);
    const cut = Math.max(part.lastIndexOf("."), part.lastIndexOf("!"), part.lastIndexOf("?"));

    if (cut > 700) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter(Boolean);
}

async function getWikisourcePage(title) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text|links&page=" +
    encodeURIComponent(title);

  const data = await fetch(url).then((r) => r.json());

  if (!data.parse) return null;

  return {
    title: data.parse.title,
    html: data.parse.text?.["*"] || "",
    links: data.parse.links || [],
  };
}

async function findWikisourceTitle(query) {
  const key = query.toLowerCase().replace(/[«»"]/g, "").trim();

  if (BOOK_MAP[key]) return BOOK_MAP[key];

  const url =
    "https://ru.wikisource.org/w/api.php?action=opensearch&format=json&limit=10&search=" +
    encodeURIComponent(query);

  const data = await fetch(url).then((r) => r.json());
  return data?.[1]?.[0] || null;
}

async function findBook(query) {
  const title = await findWikisourceTitle(query);
  if (!title) return null;

  const main = await getWikisourcePage(title);
  if (!main) return null;

  let text = cleanText(main.html);

  if (text.length > 5000) {
    return { title: main.title, text };
  }

  const childTitles = main.links
    .map((l) => l["*"])
    .filter((x) => x && x.startsWith(main.title + "/"))
    .slice(0, 30);

  let fullText = "";

  for (const childTitle of childTitles) {
    const child = await getWikisourcePage(childTitle);
    if (!child) continue;

    const childText = cleanText(child.html);

    if (childText.length > 500) {
      fullText += "\n\n" + childText;
    }

    if (fullText.length > 40000) break;
  }

  if (fullText.length < 1000) return null;

  return {
    title: main.title,
    text: fullText,
  };
}

async function readBook(chatId, book) {
  const parts = splitText(book.text);

  sessions.set(chatId, { active: true });

  await sendText(chatId, `Нашёл: ${book.title}\nНачинаю читать потоком.\nОстановить: /stop`);

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);
    if (!session || !session.active) {
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    const audio = await makeVoice(parts[i]);
    await sendAudio(chatId, audio, `part_${i + 1}.mp3`);

    await new Promise((r) => setTimeout(r, 1000));
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
      await sendText(chatId, "Напиши название книги.");
      return;
    }

    if (text === "/stop") {
      const session = sessions.get(chatId);
      if (session) session.active = false;
      return;
    }

    if (sessions.get(chatId)?.active) {
      await sendText(chatId, "Уже читаю. Напиши /stop, чтобы остановить.");
      return;
    }

    await sendText(chatId, "Ищу книгу в интернете...");

    const book = await findBook(text);

    if (!book) {
      await sendText(chatId, "Не нашёл текст. Попробуй: Преступление и наказание, Капитанская дочка, Шинель.");
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
