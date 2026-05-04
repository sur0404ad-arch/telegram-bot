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

const BOOK_KEY = "ru_crime_and_punishment_v9_real_chapters_safe_tts";
const BOOK_TITLE = "Преступление и наказание";

app.get("/", (req, res) => res.send("SERVER RUNNING — READER BOT V9"));

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

    if (text === "/stop" || text === "⏸ Пауза бота") {
      await pause(chatId);
      return sendMessage(chatId, "⏸ Бот остановлен.\n\nУже отправленное аудио останавливается кнопкой паузы в Telegram.");
    }

    if (text === "/resume" || text === "▶️ Продолжить") {
      await resume(chatId);
      return sendNextChapter(chatId);
    }

    if (text === "/next" || text === "▶️ Следующая глава") {
      return sendNextChapter(chatId);
    }

    await pause(chatId);
    await sendMessage(chatId, "🔎 Ищу книгу и готовлю главы...");

    const book = await prepareBook(text);

    await saveSession(chatId, {
      book_key: book.key,
      title: book.title,
      part_index: 0,
      stopped: false
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\nГотово.\nГлав: ${book.parts.length}\n\n▶️ Запускаю первую главу автоматически...`
    );

    return sendNextChapter(chatId);
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
  const cached = await getBookByKey(BOOK_KEY);
  if (cached) return cached;

  const pages = [];

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

      if (text.length > 900) {
        pages.push({
          title: detectTitle(text, pages.length + 1),
          text: removeTitleNoise(text)
        });
      }
    } catch (e) {
      console.log("PAGE LOAD STOP:", i, e.message);
      break;
    }
  }

  const parts = pages
    .filter(p => p.text && p.text.length > 800)
    .map((p, i) => ({
      title: p.title || `Глава ${i + 1}`,
      text: p.text
    }));

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [BOOK_KEY, BOOK_TITLE, JSON.stringify(parts)]
  );

  return { key: BOOK_KEY, title: BOOK_TITLE, parts };
}

function cleanILibrary(html) {
  let text = String(html || "");

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h1>/gi, "\n")
    .replace(/<\/h2>/gi, "\n")
    .replace(/<\/h3>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&#769;/g, "")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const start = text.search(/Федор Достоевский|Фёдор Достоевский|Преступление и наказание|ЧАСТЬ|ГЛАВА|I\.|II\.|III\.|IV\.|V\.|VI\./i);
  if (start > 0) text = text.slice(start);

  return text
    .replace(/Комментарии[\s\S]*$/i, "")
    .replace(/Все права защищены[\s\S]*$/i, "")
    .trim();
}

function detectTitle(text, number) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 20);

  let part = "";
  let chapter = "";

  for (const line of lines) {
    if (/^ЧАСТЬ\s+/i.test(line) || /^Часть\s+/i.test(line)) part = line;
    if (/^(ГЛАВА|Глава)\s+/i.test(line)) {
      chapter = line;
      break;
    }
    if (/^[IVXLCDM]{1,8}\.$/.test(line)) {
      chapter = `Глава ${line}`;
      break;
    }
  }

  if (part && chapter) return `${part}. ${chapter}`;
  if (chapter) return chapter;
  if (part) return `${part}. Глава ${number}`;
  return `Глава ${number}`;
}

function removeTitleNoise(text) {
  return String(text || "")
    .replace(/Федор Достоевский/gi, "")
    .replace(/Фёдор Достоевский/gi, "")
    .replace(/Преступление и наказание/gi, "")
    .replace(/^ЧАСТЬ\s+[^\n]+\n?/i, "")
    .replace(/^Часть\s+[^\n]+\n?/i, "")
    .replace(/^ГЛАВА\s+[^\n]+\n?/i, "")
    .replace(/^Глава\s+[^\n]+\n?/i, "")
    .replace(/^[IVXLCDM]{1,8}\.\s*/i, "")
    .trim();
}

async function sendNextChapter(chatId) {
  if (busy.has(chatId)) {
    return sendMessage(chatId, "⏳ Уже готовлю главу. Подожди.");
  }

  const session = await getSession(chatId);
  if (!session?.book_key) return sendMessage(chatId, "❌ Сначала напиши название книги.");
  if (session.stopped) return sendMessage(chatId, "⏸ Сейчас пауза. Нажми ▶️ Продолжить.");

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена.");

  const index = Number(session.part_index || 0);
  if (index >= book.parts.length) return sendMessage(chatId, "✅ Книга закончена.");

  const chapter = normalizeChapter(book.parts[index]);
  const jobId = `${Date.now()}_${Math.random()}`;

  activeJobs[chatId] = jobId;
  busy.add(chatId);

  try {
    await sendMessage(chatId, `🎙 ${chapter.title}\n${index + 1}/${book.parts.length}\n\nГотовлю аудио...`);

    let audio = await getCachedAudio(book.key, index);

    if (!audio) {
      const controller = new AbortController();
      controllers[chatId] = controller;

      audio = await buildAudioFromChunks(chatId, jobId, chapter.text, controller.signal);

      if (activeJobs[chatId] !== jobId) return;

      await saveAudioCache(book.key, index, audio);
    }

    if (activeJobs[chatId] !== jobId) return;

    await sendAudio(
      chatId,
      audio,
      `chapter_${index + 1}.mp3`,
      `📖 ${book.title}\n${chapter.title}\n${index + 1}/${book.parts.length}`
    );

    if (activeJobs[chatId] !== jobId) return;

    await saveSession(chatId, {
      part_index: index + 1,
      stopped: false
    });

    await sendMessage(chatId, "▶️ Глава отправлена. Нажми следующую главу.");
  } catch (e) {
    if (e.name !== "CanceledError" && e.code !== "ERR_CANCELED") {
      console.log("CHAPTER ERROR:", e.response?.data || e.message || e);
      await sendMessage(chatId, "❌ Ошибка озвучки. Попробуй ещё раз.");
    }
  } finally {
    delete controllers[chatId];
    busy.delete(chatId);
  }
}

function normalizeChapter(part) {
  if (typeof part === "string") {
    return { title: "Глава", text: part };
  }

  return {
    title: part.title || "Глава",
    text: part.text || ""
  };
}

async function buildAudioFromChunks(chatId, jobId, text, signal) {
  const chunks = splitForTTS(text, 2300);
  const buffers = [];

  for (let i = 0; i < chunks.length; i++) {
    if (activeJobs[chatId] !== jobId) {
      throw new Error("Canceled by user");
    }

    const audio = await elevenLabsTTS(chunks[i], signal);
    buffers.push(audio);
  }

  return Buffer.concat(buffers);
}

function splitForTTS(text, maxLength) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  const sentences = clean.match(/[^.!?…]+[.!?…]+/g) || [clean];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if ((current + " " + s).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(x => x.length > 20);
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
  const safeText = String(text || "").slice(0, 2500);

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: safeText,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        style: 0.30,
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
      keyboard: [
        ["▶️ Следующая глава"],
        ["⏸ Пауза бота", "▶️ Продолжить"]
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
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT} — V9`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
