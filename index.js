// ===== V10 STREAM-LIKE AUDIO (SEGMENTS) =====

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

const BOOK_KEY = "crime_v10_segments";
const BOOK_TITLE = "Преступление и наказание";

// =================== WEBHOOK ===================

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (!msg?.chat?.id) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  console.log("USER:", chatId, text);

  if (text === "/start") {
    return sendMessage(chatId, "📚 Напиши книгу");
  }

  if (text === "/stop") {
    await stop(chatId);
    return sendMessage(chatId, "⏸ Остановлено");
  }

  if (text === "/next") {
    return sendNext(chatId);
  }

  await stop(chatId);
  await sendMessage(chatId, "🔎 Готовлю книгу...");

  const book = await prepareBook();

  await saveSession(chatId, {
    book_key: book.key,
    part_index: 0,
    segment_index: 0,
    stopped: false
  });

  sendNext(chatId);
});

// =================== BOOK ===================

async function prepareBook() {
  const cached = await getBookByKey(BOOK_KEY);
  if (cached) return cached;

  let full = "";

  for (let i = 1; i <= 60; i++) {
    const url = `https://ilibrary.ru/text/69/p.${i}/index.html`;

    const res = await axios.get(url, { responseType: "arraybuffer" });
    const html = iconv.decode(Buffer.from(res.data), "win1251");

    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    full += "\n\n" + text;
  }

  const chapters = splitChapters(full);

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET parts=$3`,
    [BOOK_KEY, BOOK_TITLE, JSON.stringify(chapters)]
  );

  return { key: BOOK_KEY, title: BOOK_TITLE, parts: chapters };
}

function splitChapters(text) {
  const raw = text.split(/ГЛАВА|Глава/g);

  return raw
    .map((t, i) => ({
      title: `Глава ${i + 1}`,
      segments: splitSegments(t)
    }))
    .filter(x => x.segments.length);
}

function splitSegments(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  const segments = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > 2000) {
      segments.push(current);
      current = s;
    } else {
      current += " " + s;
    }
  }

  if (current) segments.push(current);

  return segments.filter(x => x.length > 50);
}

// =================== PLAY ===================

async function sendNext(chatId) {
  if (busy.has(chatId)) return;

  const session = await getSession(chatId);
  if (!session || session.stopped) return;

  const book = await getBookByKey(session.book_key);
  const chapter = book.parts[session.part_index];

  if (!chapter) return sendMessage(chatId, "✅ Конец");

  const segment = chapter.segments[session.segment_index];

  if (!segment) {
    await saveSession(chatId, {
      part_index: session.part_index + 1,
      segment_index: 0
    });
    return sendNext(chatId);
  }

  busy.add(chatId);

  const jobId = Date.now();
  activeJobs[chatId] = jobId;

  try {
    const audio = await tts(segment);

    if (activeJobs[chatId] !== jobId) return;

    await sendAudio(chatId, audio, `seg.mp3`, `${chapter.title}`);

    await saveSession(chatId, {
      segment_index: session.segment_index + 1
    });

    setTimeout(() => sendNext(chatId), 500);

  } catch (e) {
    console.log(e.message);
  } finally {
    busy.delete(chatId);
  }
}

// =================== TTS ===================

async function tts(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2"
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY
      },
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(res.data);
}

// =================== HELPERS ===================

async function stop(chatId) {
  activeJobs[chatId] = 0;

  const s = await getSession(chatId);
  if (s) await saveSession(chatId, { stopped: true });
}

async function sendMessage(chatId, text) {
  await axios.post(`${TG}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [["/next"], ["/stop"]],
      resize_keyboard: true
    }
  });
}

async function sendAudio(chatId, buffer, name, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", buffer, { filename: name });
  form.append("caption", caption);

  await axios.post(`${TG}/sendAudio`, form, {
    headers: form.getHeaders()
  });
}

async function getBookByKey(key) {
  const r = await pool.query("SELECT * FROM books WHERE key=$1", [key]);
  if (!r.rows.length) return null;
  return r.rows[0];
}

async function getSession(chatId) {
  const r = await pool.query("SELECT * FROM sessions WHERE chat_id=$1", [chatId]);
  return r.rows[0];
}

async function saveSession(chatId, data) {
  const cur = await getSession(chatId);

  const next = {
    book_key: data.book_key ?? cur?.book_key,
    part_index: data.part_index ?? cur?.part_index ?? 0,
    segment_index: data.segment_index ?? cur?.segment_index ?? 0,
    stopped: data.stopped ?? cur?.stopped ?? false
  };

  await pool.query(
    `INSERT INTO sessions (chat_id, book_key, part_index, stopped)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (chat_id)
     DO UPDATE SET book_key=$2, part_index=$3, stopped=$4`,
    [chatId, next.book_key, next.part_index, next.stopped]
  );
}

// =================== START ===================

app.get("/", (req, res) => res.send("OK"));

init();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      key TEXT PRIMARY KEY,
      title TEXT,
      parts JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      book_key TEXT,
      part_index INT,
      stopped BOOLEAN
    )
  `);

  app.listen(PORT, () => console.log("V10 RUNNING"));
}
