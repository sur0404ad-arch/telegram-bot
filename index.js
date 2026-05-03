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
      await stop(chatId);
      return sendMessage(chatId, "⏹ Остановлено. Позиция сохранена.");
    }

    if (text === "/resume") {
      await resume(chatId);
      return sendMessage(chatId, "▶️ Продолжение включено. Напиши /next.");
    }

    if (text === "/next") {
      return sendNextPart(chatId);
    }

    await stop(chatId);
    await sendMessage(chatId, "🔎 Готовлю русский текст...");

    const book = await prepareCrimeAndPunishment();

    await saveSession(chatId, {
      book_key: book.key,
      title: book.title,
      part_index: 0,
      stopped: false
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\nГотово.\nЧастей: ${book.parts.length}\n\n/next — слушать следующую часть\n/stop — остановить\n/resume — продолжить`
    );

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

async function prepareCrimeAndPunishment() {
  const key = "ru_crime_and_punishment_v3";
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
      if (full.length > 260000) break;
    } catch (e) {
      console.log("PAGE LOAD STOP:", i, e.message);
      break;
    }
  }

  const parts = splitText(full, 5500).filter(p => p.length > 1500);

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

  const start = text.search(/Федор Достоевский|Преступление и наказание/i);
  if (start > 0) text = text.slice(start);

  return text
    .replace(/Комментарии[\s\S]*$/i, "")
    .replace(/Все права защищены[\s\S]*$/i, "")
    .trim();
}

async function sendNextPart(chatId) {
  if (busy.has(chatId)) {
    return sendMessage(chatId, "⏳ Уже готовлю часть. Подожди.");
  }

  const session = await getSession(chatId);
  if (!session?.book_key) return sendMessage(chatId, "❌ Сначала напиши название книги.");
  if (session.stopped) return sendMessage(chatId, "⏸ Остановлено. Напиши /resume.");

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена.");

  const index = Number(session.part_index || 0);
  if (index >= book.parts.length) return sendMessage(chatId, "✅ Книга закончена.");

  const jobId = `${Date.now()}_${Math.random()}`;
  activeJobs[chatId] = jobId;
  busy.add(chatId);

  try {
    await sendMessage(chatId, `🎙 Часть ${index + 1}/${book.parts.length}`);

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
      `part_${index + 1}.mp3`,
      `📖 ${book.title}\nЧасть ${index + 1}/${book.parts.length}`
    );

    if (activeJobs[chatId] !== jobId) return;

    await saveSession(chatId, {
      part_index: index + 1,
      stopped: false
    });

    await sendMessage(chatId, "▶️ Напиши /next для следующей части.");
  } catch (e) {
    if (e.name !== "CanceledError" && e.code !== "ERR_CANCELED") {
      console.log("PART ERROR:", e.response?.data || e.message || e);
      await sendMessage(chatId, "❌ Ошибка озвучки.");
    }
  } finally {
    delete controllers[chatId];
    busy.delete(chatId);
  }
}

async function stop(chatId) {
  activeJobs[chatId] = `stopped_${Date.now()}`;

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
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT}`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
