const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const iconv = require("iconv-lite");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const controllers = {};
const activeJobs = {};
const busy = new Set();

app.get("/", (req, res) => res.send("SERVER RUNNING — READER BOT V6"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    console.log("USER:", chatId, text);

    if (text === "/start") {
      return sendMessage(chatId, "📚 Напиши название книги.\n\nПример:\nПреступление и наказание");
    }

    if (text === "⏸ Пауза" || text === "/stop") {
      await pause(chatId);
      return sendMessage(chatId, "⏸ Пауза включена. Позиция сохранена.");
    }

    if (text === "▶️ Продолжить" || text === "/resume") {
      await resume(chatId);
      return sendNextPart(chatId);
    }

    if (text === "▶️ Следующая глава" || text === "/next") {
      return sendNextPart(chatId);
    }

    await pause(chatId);
    await sendMessage(chatId, "🔎 Ищу и готовлю книгу...");

    const book = await prepareBook(text);

    await saveSession(chatId, {
      book_key: book.key,
      title: book.title,
      part_index: 0,
      stopped: false
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\nГотово.\nГлав/частей: ${book.parts.length}\n\nНажми: ▶️ Следующая глава`
    );

    preloadNext(book.key, 0).catch(() => {});
  } catch (e) {
    console.log("SERVER ERROR:", e.response?.data || e.message || e);
  }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      parts JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      book_key TEXT,
      title TEXT,
      part_index INT DEFAULT 0,
      stopped BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_cache (
      book_key TEXT NOT NULL,
      part_index INT NOT NULL,
      audio BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (book_key, part_index)
    );
  `);
}

function normalizeBookName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

async function prepareBook(userText) {
  const normalized = normalizeBookName(userText);

  if (
    normalized.includes("преступление") ||
    normalized.includes("наказание") ||
    normalized.includes("crime")
  ) {
    return prepareCrimeAndPunishment();
  }

  return prepareCrimeAndPunishment();
}

async function prepareCrimeAndPunishment() {
  const key = "ru_crime_and_punishment_v6";
  const cached = await getBookByKey(key);
  if (cached) return cached;

  let full = "";

  for (let i = 1; i <= 90; i++) {
    const url = `https://ilibrary.ru/text/69/p.${i}/index.html`;

    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: { "User-Agent": "BookVoiceAI/1.0" }
      });

      const html = iconv.decode(Buffer.from(res.data), "win1251");
      const text = cleanILibrary(html);

      if (text.length > 500) full += "\n\n" + text;
      if (full.length > 320000) break;
    } catch (e) {
      console.log("PAGE LOAD STOP:", i, e.message);
      break;
    }
  }

  const parts = splitByChapters(full);

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [key, "Преступление и наказание", JSON.stringify(parts)]
  );

  return { key, title: "Преступление и наказание", parts };
}

function cleanILibrary(html) {
  let text = String(html || "");

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const start = text.search(/Федор Достоевский|Фёдор Достоевский|Преступление и наказание/i);
  if (start > 0) text = text.slice(start);

  return text
    .replace(/Комментарии[\s\S]*$/i, "")
    .replace(/Все права защищены[\s\S]*$/i, "")
    .trim();
}

function splitByChapters(text) {
  const clean = String(text || "").replace(/\r/g, "").trim();

  let chunks = clean
    .split(/\n\s*(?=(ЧАСТЬ\s+[А-ЯA-ZЁ]+|Часть\s+[а-яa-zё]+|ГЛАВА\s+\d+|Глава\s+\d+|[IVXLCDM]{1,8}\.))/g)
    .map(x => x.trim())
    .filter(x => x.length > 1200);

  if (chunks.length < 5) {
    chunks = splitText(clean, 6500).filter(x => x.length > 1200);
  }

  const finalParts = [];

  for (const chunk of chunks) {
    if (chunk.length <= 7500) {
      finalParts.push(chunk);
    } else {
      finalParts.push(...splitText(chunk, 6500).filter(x => x.length > 1200));
    }
  }

  return finalParts;
}

function splitText(text, maxLength) {
  const sentences = String(text).match(/[^.!?…]+[.!?…]+/g) || [text];
  const parts = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

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

async function sendNextPart(chatId) {
  if (busy.has(chatId)) {
    return sendMessage(chatId, "⏳ Уже готовлю аудио. Подожди.");
  }

  const session = await getSession(chatId);
  if (!session?.book_key) return sendMessage(chatId, "❌ Сначала напиши название книги.");
  if (session.stopped) return sendMessage(chatId, "⏸ Сейчас пауза. Нажми ▶️ Продолжить.");

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена.");

  const index = Number(session.part_index || 0);
  if (index >= book.parts.length) return sendMessage(chatId, "✅ Книга закончена.");

  const jobId = `${Date.now()}_${Math.random()}`;
  activeJobs[chatId] = jobId;
  busy.add(chatId);

  try {
    await sendMessage(chatId, `🎙 Готовлю ${index + 1}/${book.parts.length}...`);

    let audio = await getCachedAudio(book.key, index);

    if (!audio) {
      const controller = new AbortController();
      controllers[chatId] = controller;

      audio = await elevenLabsTTS(book.parts[index], controller.signal);

      if (activeJobs[chatId] !== jobId) return;

      await saveAudioCache(book.key, index, audio);
    }

    if (activeJobs[chatId] !== jobId) return;

    await sendAudio(
      chatId,
      audio,
      `chapter_${index + 1}.mp3`,
      `📖 ${book.title}\n${index + 1}/${book.parts.length}`
    );

    if (activeJobs[chatId] !== jobId) return;

    await saveSession(chatId, {
      part_index: index + 1,
      stopped: false
    });

    preloadNext(book.key, index + 1).catch(() => {});

    await sendMessage(chatId, "▶️ Готово. Нажми следующую главу.");
  } catch (e) {
    if (e.name !== "CanceledError" && e.code !== "ERR_CANCELED") {
      console.log("PART ERROR:", e.response?.data || e.message || e);
      await sendMessage(chatId, "❌ Ошибка озвучки. Попробуй ещё раз.");
    }
  } finally {
    delete controllers[chatId];
    busy.delete(chatId);
  }
}

async function preloadNext(bookKey, partIndex) {
  const book = await getBookByKey(bookKey);
  if (!book) return;
  if (partIndex >= book.parts.length) return;

  const cached = await getCachedAudio(bookKey, partIndex);
  if (cached) return;

  console.log("PRELOAD:", bookKey, partIndex);

  const audio = await elevenLabsTTS(book.parts[partIndex]);
  await saveAudioCache(bookKey, partIndex, audio);
}

async function pause(chatId) {
  activeJobs[chatId] = `paused_${Date.now()}`;

  if (controllers[chatId]) {
    try { controllers[chatId].abort(); } catch {}
    delete controllers[chatId];
  }

  busy.delete(chatId);

  const s = await getSession(chatId);
  if (s) await saveSession(chatId, { stopped: true });
}

async function resume(chatId) {
  const s = await getSession(chatId);
  if (s) await saveSession(chatId, { stopped: false });
}

async function elevenLabsTTS(text, signal) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.85,
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
      timeout: 120000,
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
      keyboard: [
        ["▶️ Следующая глава"],
        ["⏸ Пауза", "▶️ Продолжить"]
      ],
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
    timeout: 120000
  });
}

async function getBookByKey(key) {
  const r = await pool.query("SELECT * FROM books WHERE key=$1", [key]);
  if (!r.rows.length) return null;

  return {
    key: r.rows[0].key,
    title: r.rows[0].title,
    parts: r.rows[0].parts
  };
}

async function getSession(chatId) {
  const r = await pool.query("SELECT * FROM sessions WHERE chat_id=$1", [chatId]);
  return r.rows[0] || null;
}

async function saveSession(chatId, data) {
  const current = await getSession(chatId);

  const next = {
    book_key: data.book_key ?? current?.book_key ?? null,
    title: data.title ?? current?.title ?? null,
    part_index: data.part_index ?? current?.part_index ?? 0,
    stopped: data.stopped ?? current?.stopped ?? false
  };

  await pool.query(
    `INSERT INTO sessions (chat_id, book_key, title, part_index, stopped, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (chat_id)
     DO UPDATE SET book_key=$2, title=$3, part_index=$4, stopped=$5, updated_at=NOW()`,
    [chatId, next.book_key, next.title, next.part_index, next.stopped]
  );
}

async function getCachedAudio(bookKey, partIndex) {
  const r = await pool.query(
    "SELECT audio FROM audio_cache WHERE book_key=$1 AND part_index=$2",
    [bookKey, partIndex]
  );

  return r.rows[0]?.audio || null;
}

async function saveAudioCache(bookKey, partIndex, audio) {
  await pool.query(
    `INSERT INTO audio_cache (book_key, part_index, audio)
     VALUES ($1,$2,$3)
     ON CONFLICT (book_key, part_index) DO NOTHING`,
    [bookKey, partIndex, audio]
  );
}

initDB()
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT} — V6`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
