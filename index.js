const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT = process.env.PORT || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_FILE = "./sessions.json";

let sessions = loadDB();

app.get("/", (req, res) => res.send("SERVER RUNNING"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg?.chat?.id || !msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  console.log("USER:", chatId, text);

  try {
    if (text === "/start") {
      return sendMessage(chatId, "📚 Напиши книгу.\n\nПример:\nПреступление и наказание");
    }

    if (text === "/stop") {
      stopSession(chatId);
      return sendMessage(chatId, "⏹ Остановлено. Позиция сохранена.");
    }

    if (text === "/resume") {
      if (!sessions[chatId]?.parts?.length) {
        return sendMessage(chatId, "❌ Нет сохранённой книги.");
      }

      sessions[chatId].stopped = false;
      saveDB();
      return autoplay(chatId);
    }

    if (isBlocked(text)) {
      return sendMessage(chatId, "❌ Книга защищена авторским правом.");
    }

    stopSession(chatId);

    sessions[chatId] = {
      title: "",
      parts: [],
      index: 0,
      stopped: false,
      controller: null
    };

    await sendMessage(chatId, "🔎 Ищу книгу...");

    const searchQuery = normalizeQuery(text);
    const book = await findBook(searchQuery);

    if (!book) {
      return sendMessage(chatId, "❌ Не нашёл книгу в public domain.");
    }

    await sendMessage(chatId, `📖 Нашёл:\n${book.title}`);
    await sendMessage(chatId, "📥 Загружаю текст...");

    const fullText = await loadText(book.url);

    if (fullText.length < 1000) {
      return sendMessage(chatId, "❌ Текст не загрузился нормально.");
    }

    const parts = splitText(fullText, 1800)
      .filter((p) => p.length > 300)
      .slice(0, 80);

    sessions[chatId] = {
      title: book.title,
      parts,
      index: 0,
      stopped: false,
      controller: null
    };

    saveDB();

    await sendMessage(chatId, `🎬 Начинаю автоплей.\nЧастей: ${parts.length}\n\n/stop — остановить\n/resume — продолжить`);

    await autoplay(chatId);

  } catch (e) {
    console.log("ERROR:", e.response?.data || e.message || e);
    await sendMessage(chatId, "❌ Ошибка. Проверь Railway Logs.");
  }
});

function stopSession(chatId) {
  const s = sessions[chatId];

  if (s) {
    s.stopped = true;

    if (s.controller) {
      try {
        s.controller.abort();
      } catch {}
    }

    saveDB();
  }
}

async function autoplay(chatId) {
  const s = sessions[chatId];
  if (!s || s.stopped) return;

  while (s.index < s.parts.length) {
    if (s.stopped) return;

    const partNumber = s.index + 1;
    const total = s.parts.length;

    await sendMessage(chatId, `🎙 Часть ${partNumber}/${total}`);

    const controller = new AbortController();
    s.controller = controller;
    saveDB();

    let audio;

    try {
      audio = await elevenLabsTTS(s.parts[s.index], controller.signal);
    } catch (e) {
      if (s.stopped || e.name === "CanceledError" || e.code === "ERR_CANCELED") {
        return;
      }

      throw e;
    }

    if (s.stopped) return;

    await sendAudio(
      chatId,
      audio,
      `part_${partNumber}.mp3`,
      `📖 ${s.title}\nЧасть ${partNumber}/${total}`
    );

    s.index++;
    s.controller = null;
    saveDB();

    await sleep(1500);
  }

  await sendMessage(chatId, "✅ Книга закончена.");
}

function normalizeQuery(text) {
  const t = text.toLowerCase();

  const map = [
    ["преступление", "Crime and Punishment"],
    ["анна каренина", "Anna Karenina"],
    ["война и мир", "War and Peace"],
    ["идиот", "The Idiot"],
    ["братья карамазовы", "The Brothers Karamazov"],
    ["отцы и дети", "Fathers and Sons"],
    ["евгений онегин", "Eugene Onegin"],
    ["мертвые души", "Dead Souls"]
  ];

  for (const [ru, en] of map) {
    if (t.includes(ru)) return en;
  }

  return text;
}

function isBlocked(text) {
  const t = text.toLowerCase();

  return [
    "гарри поттер",
    "harry potter",
    "rowling",
    "роулинг",
    "стивен кинг",
    "stephen king",
    "метро 2033",
    "пелевин",
    "акунин",
    "лукьяненко"
  ].some((x) => t.includes(x));
}

async function findBook(query) {
  const res = await axios.get("https://gutendex.com/books/", {
    params: { search: query },
    timeout: 15000,
    headers: { "User-Agent": "BookVoiceAI/1.0" }
  });

  const books = res.data.results || [];
  const book = books.find((b) => b.copyright !== true);

  if (!book) return null;

  const url =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain; charset=us-ascii"] ||
    book.formats["text/plain"];

  if (!url) return null;

  return {
    title: book.title,
    url
  };
}

async function loadText(url) {
  const res = await axios.get(url, {
    timeout: 25000,
    responseType: "text",
    headers: { "User-Agent": "BookVoiceAI/1.0" }
  });

  return cleanBookText(res.data);
}

function cleanBookText(text) {
  let t = String(text || "");

  t = t.replace(/[\s\S]*?\*\*\* START OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i, "");
  t = t.replace(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*/i, "");

  return t
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/_/g, "")
    .trim()
    .slice(0, 160000);
}

function splitText(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const parts = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();

    if ((current + " " + s).length > maxLength) {
      if (current.trim()) parts.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }

  if (current.trim()) parts.push(current.trim());

  return parts;
}

async function elevenLabsTTS(text, signal) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.35,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer",
      timeout: 60000,
      signal
    }
  );

  return Buffer.from(res.data);
}

async function sendMessage(chatId, text) {
  await axios.post(`${TG}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [["/stop", "/resume"]],
      resize_keyboard: true
    }
  });
}

async function sendAudio(chatId, audioBuffer, filename, caption) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg"
  });

  await axios.post(`${TG}/sendAudio`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000
  });
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDB() {
  const clean = {};

  for (const chatId of Object.keys(sessions)) {
    clean[chatId] = {
      title: sessions[chatId].title,
      parts: sessions[chatId].parts,
      index: sessions[chatId].index,
      stopped: sessions[chatId].stopped
    };
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(clean, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
