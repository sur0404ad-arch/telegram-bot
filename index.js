const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
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
const jobs = {};

app.get("/", (req, res) => res.send("SERVER RUNNING"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id || !msg?.text) return;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    console.log("USER:", chatId, text);

    if (text === "/start") {
      return sendMessage(chatId, "📚 Напиши книгу.\n\nПример:\nПреступление и наказание");
    }

    if (text === "/stop") {
      await stopJob(chatId);
      return sendMessage(chatId, "⏹ Остановлено. Позиция сохранена.");
    }

    if (text === "/resume") {
      return resumeBook(chatId);
    }

    if (text === "/next") {
      return sendCurrentPart(chatId);
    }

    await stopJob(chatId);

    await sendMessage(chatId, "🔎 Ищу и готовлю книгу...");

    const book = await getOrCreateBook(text);

    if (!book) {
      return sendMessage(chatId, "❌ Сейчас стабильно подключена только книга: Преступление и наказание.");
    }

    const jobId = newJob(chatId);

    await saveSession(chatId, {
      query: text,
      book_key: book.key,
      title: book.title,
      part_index: 0,
      stopped: false,
      job_id: jobId
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\n🎬 Режим Netflix:\n/next — следующая часть\n/stop — остановить\n/resume — продолжить\n\nЧастей: ${book.parts.length}`
    );

    return sendCurrentPart(chatId);

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
      query TEXT,
      book_key TEXT,
      title TEXT,
      part_index INT DEFAULT 0,
      stopped BOOLEAN DEFAULT FALSE,
      job_id TEXT,
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

async function getOrCreateBook(query) {
  const detected = detectBook(query);
  if (!detected) return null;

  const cached = await getBookByKey(detected.key);
  if (cached) return cached;

  const text = await loadCrimeAndPunishment();
  if (!text || text.length < 5000) return null;

  const parts = splitText(text, 5000).filter(p => p.length > 1000);

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [detected.key, detected.title, JSON.stringify(parts)]
  );

  return {
    key: detected.key,
    title: detected.title,
    parts
  };
}

function detectBook(query) {
  const t = query.toLowerCase();

  if (t.includes("преступление") || t.includes("достоевский")) {
    return {
      key: "ru_crime_and_punishment",
      title: "Преступление и наказание"
    };
  }

  return null;
}

async function loadCrimeAndPunishment() {
  let full = "";

  for (let i = 1; i <= 90; i++) {
    const url = `https://ilibrary.ru/text/69/p.${i}/index.html`;

    try {
      const res = await axios.get(url, {
        timeout: 15000,
        responseType: "text",
        headers: { "User-Agent": "BookVoiceAI/1.0" }
      });

      const clean = cleanILibrary(res.data);

      if (clean.length > 500) {
        full += "\n\n" + clean;
      }

      if (full.length > 250000) break;
    } catch {
      break;
    }
  }

  return full.trim();
}

function cleanILibrary(html) {
  let text = String(html || "");

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/^[\s\S]*?Федор Достоевский/i, "Федор Достоевский")
    .replace(/Читать онлайн[\s\S]*?читать/i, "")
    .replace(/Все права защищены[\s\S]*$/i, "")
    .trim();

  return text;
}

async function sendCurrentPart(chatId) {
  const session = await getSession(chatId);

  if (!session?.book_key) {
    return sendMessage(chatId, "❌ Нет активной книги.");
  }

  if (session.stopped) {
    return sendMessage(chatId, "⏸ Остановлено. Напиши /resume.");
  }

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена в базе.");

  const index = Number(session.part_index || 0);

  if (index >= book.parts.length) {
    return sendMessage(chatId, "✅ Книга закончена.");
  }

  const jobId = newJob(chatId);

  await saveSession(chatId, {
    stopped: false,
    job_id: jobId
  });

  await sendMessage(chatId, `🎙 Часть ${index + 1}/${book.parts.length}`);

  let audio = await getCachedAudio(book.key, index);

  if (!audio) {
    const controller = new AbortController();
    controllers[chatId] = controller;

    try {
      audio = await elevenLabsTTS(book.parts[index], controller.signal);
      if (!(await isAlive(chatId, jobId))) return;
      await saveAudioCache(book.key, index, audio);
    } catch (e) {
      if (e.name === "CanceledError" || e.code === "ERR_CANCELED") return;
      console.log("TTS ERROR:", e.response?.data || e.message);
      return sendMessage(chatId, "❌ Ошибка озвучки.");
    } finally {
      delete controllers[chatId];
    }
  }

  if (!(await isAlive(chatId, jobId))) return;

  await sendAudio(
    chatId,
    audio,
    `part_${index + 1}.mp3`,
    `📖 ${book.title}\nЧасть ${index + 1}/${book.parts.length}`
  );

  if (!(await isAlive(chatId, jobId))) return;

  await saveSession(chatId, {
    part_index: index + 1,
    stopped: false,
    job_id: jobId
  });

  await sendMessage(chatId, "▶️ Напиши /next для следующей части или /stop для остановки.");
}

async function resumeBook(chatId) {
  const session = await getSession(chatId);

  if (!session?.book_key) {
    return sendMessage(chatId, "❌ Нет сохранённой книги.");
  }

  await saveSession(chatId, {
    stopped: false,
    job_id: newJob(chatId)
  });

  return sendCurrentPart(chatId);
}

async function stopJob(chatId) {
  jobs[chatId] = `stopped_${Date.now()}`;

  if (controllers[chatId]) {
    try {
      controllers[chatId].abort();
    } catch {}
    delete controllers[chatId];
  }

  const session = await getSession(chatId);

  if (session) {
    await saveSession(chatId, {
      stopped: true,
      job_id: jobs[chatId]
    });
  }
}

function newJob(chatId) {
  const jobId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  jobs[chatId] = jobId;
  return jobId;
}

async function isAlive(chatId, jobId) {
  const session = await getSession(chatId);
  return jobs[chatId] === jobId && session && !session.stopped && session.job_id === jobId;
}

function splitText(text, maxLength) {
  const sentences = String(text).match(/[^.!?…]+[.!?…]+/g) || [text];
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
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.25,
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
      timeout: 90000,
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
      keyboard: [["/next"], ["/stop", "/resume"]],
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
    timeout: 90000
  });
}

async function getBookByKey(key) {
  const r = await pool.query("SELECT * FROM books WHERE key=$1", [key]);
  if (!r.rows.length) return null;

  const row = r.rows[0];

  return {
    key: row.key,
    title: row.title,
    parts: row.parts
  };
}

async function getSession(chatId) {
  const r = await pool.query("SELECT * FROM sessions WHERE chat_id=$1", [chatId]);
  return r.rows[0] || null;
}

async function saveSession(chatId, data) {
  const current = await getSession(chatId);

  const next = {
    query: data.query ?? current?.query ?? null,
    book_key: data.book_key ?? current?.book_key ?? null,
    title: data.title ?? current?.title ?? null,
    part_index: data.part_index ?? current?.part_index ?? 0,
    stopped: data.stopped ?? current?.stopped ?? false,
    job_id: data.job_id ?? current?.job_id ?? null
  };

  await pool.query(
    `INSERT INTO sessions (chat_id, query, book_key, title, part_index, stopped, job_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (chat_id)
     DO UPDATE SET query=$2, book_key=$3, title=$4, part_index=$5, stopped=$6, job_id=$7, updated_at=NOW()`,
    [chatId, next.query, next.book_key, next.title, next.part_index, next.stopped, next.job_id]
  );
}

async function getCachedAudio(bookKey, partIndex) {
  const r = await pool.query(
    "SELECT audio FROM audio_cache WHERE book_key=$1 AND part_index=$2",
    [bookKey, partIndex]
  );

  if (!r.rows.length) return null;
  return r.rows[0].audio;
}

async function saveAudioCache(bookKey, partIndex, audio) {
  await pool.query(
    `INSERT INTO audio_cache (book_key, part_index, audio)
     VALUES ($1,$2,$3)
     ON CONFLICT (book_key, part_index) DO NOTHING`,
    [bookKey, partIndex, audio]
  );
}

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SERVER RUNNING ON ${PORT}`);
    });
  })
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
