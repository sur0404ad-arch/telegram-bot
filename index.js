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

const BOOK_KEY = "crime_v11_fast_segments";
const BOOK_TITLE = "Преступление и наказание";

app.get("/", (req, res) => res.send("SERVER RUNNING — V11 FAST READER"));

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

    if (text === "/stop" || text === "⏸ Пауза") {
      await stop(chatId);
      return sendMessage(chatId, "⏸ Остановлено. Уже отправленное аудио останавливается кнопкой паузы в Telegram.");
    }

    if (text === "/resume" || text === "▶️ Продолжить") {
      await resume(chatId);
      return sendNextSegment(chatId);
    }

    if (text === "/next" || text === "▶️ Следующий сегмент") {
      return sendNextSegment(chatId);
    }

    await stop(chatId);
    await sendMessage(chatId, "🔎 Готовлю книгу быстро...");

    const book = await prepareBook(text);

    await saveSession(chatId, {
      book_key: book.key,
      title: book.title,
      part_index: 0,
      stopped: false
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\nГотово.\nАудио-сегментов: ${book.parts.length}\n\n▶️ Запускаю первый сегмент автоматически.`
    );

    return sendNextSegment(chatId);
  } catch (e) {
    console.log("WEBHOOK ERROR:", e.response?.data || e.message || e);
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

  const segments = [];

  for (let page = 1; page <= 90; page++) {
    try {
      const url = `https://ilibrary.ru/text/69/p.${page}/index.html`;

      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 10000,
        headers: { "User-Agent": "BookVoiceAI/1.0" }
      });

      const html = iconv.decode(Buffer.from(res.data), "win1251");
      const clean = cleanILibrary(html);

      if (clean.length < 500) continue;

      const chapterTitle = detectChapterTitle(clean, page);
      const textOnly = removeBookNoise(clean);
      const smallSegments = splitForTTS(textOnly, 1600);

      for (let i = 0; i < smallSegments.length; i++) {
        segments.push({
          title: chapterTitle,
          segment_title: `${chapterTitle} — сегмент ${i + 1}`,
          text: smallSegments[i]
        });
      }
    } catch (e) {
      console.log("PAGE ERROR:", page, e.message);
      break;
    }
  }

  const finalSegments = segments.filter(s => s.text && s.text.length > 80);

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [BOOK_KEY, BOOK_TITLE, JSON.stringify(finalSegments)]
  );

  return { key: BOOK_KEY, title: BOOK_TITLE, parts: finalSegments };
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

function detectChapterTitle(text, pageNumber) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 20);

  let part = "";
  let chapter = "";

  for (const line of lines) {
    if (/^ЧАСТЬ\s+/i.test(line) || /^Часть\s+/i.test(line)) {
      part = line;
    }

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
  if (part) return `${part}`;
  return `Глава / страница ${pageNumber}`;
}

function removeBookNoise(text) {
  return String(text || "")
    .replace(/Федор Достоевский/gi, "")
    .replace(/Фёдор Достоевский/gi, "")
    .replace(/Преступление и наказание/gi, "")
    .replace(/^ЧАСТЬ\s+[^\n]+\n?/i, "")
    .replace(/^Часть\s+[^\n]+\n?/i, "")
    .replace(/^ГЛАВА\s+[^\n]+\n?/i, "")
    .replace(/^Глава\s+[^\n]+\n?/i, "")
    .replace(/^[IVXLCDM]{1,8}\.\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitForTTS(text, maxLength) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
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

  return chunks.filter(x => x.length > 50);
}

async function sendNextSegment(chatId) {
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

  const part = normalizePart(book.parts[index]);
  const jobId = `${Date.now()}_${Math.random()}`;

  activeJobs[chatId] = jobId;
  busy.add(chatId);

  try {
    await sendMessage(chatId, `🎙 ${part.segment_title}\n${index + 1}/${book.parts.length}\n\nГотовлю короткое аудио...`);

    let audio = await getCachedAudio(book.key, index);

    if (!audio) {
      const controller = new AbortController();
      controllers[chatId] = controller;

      audio = await elevenLabsTTS(part.text, controller.signal);

      if (activeJobs[chatId] !== jobId) return;

      await saveAudioCache(book.key, index, audio);
    }

    if (activeJobs[chatId] !== jobId) return;

    await sendAudio(
      chatId,
      audio,
      `segment_${index + 1}.mp3`,
      `📖 ${book.title}\n${part.segment_title}\n${index + 1}/${book.parts.length}`
    );

    if (activeJobs[chatId] !== jobId) return;

    await saveSession(chatId, {
      part_index: index + 1,
      stopped: false
    });

    await sendMessage(chatId, "▶️ Готово. Нажми следующий сегмент.");

  } catch (e) {
    console.log("SEGMENT ERROR:", e.response?.data || e.message || e);
    await sendMessage(chatId, "❌ Озвучка не прошла за 20 секунд. Нажми ▶️ Следующий сегмент или попробуй позже.");
  } finally {
    delete controllers[chatId];
    busy.delete(chatId);
  }
}

function normalizePart(part) {
  if (typeof part === "string") {
    return {
      title: "Глава",
      segment_title: "Сегмент",
      text: part
    };
  }

  return {
    title: part.title || "Глава",
    segment_title: part.segment_title || part.title || "Сегмент",
    text: part.text || ""
  };
}

async function elevenLabsTTS(text, signal) {
  const safeText = String(text || "").slice(0, 1800);

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: safeText,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.88,
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
      timeout: 20000,
      signal
    }
  );

  return Buffer.from(res.data);
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

async function sendMessage(chatId, text) {
  await axios.post(`${TG}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [
        ["▶️ Следующий сегмент"],
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
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT} — V11 FAST READER`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
