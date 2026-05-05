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

const BOOK_KEY = "crime_v13_instant_start";
const BOOK_TITLE = "Преступление и наказание";
const SOURCE_PAGES = 90;
const FAST_TTS_CHARS = 850;
const NORMAL_TTS_CHARS = 1300;

app.get("/", (req, res) => res.send("SERVER RUNNING — V13 INSTANT READER"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id) return;

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    console.log("USER:", chatId, text);

    if (text === "/start") {
      return sendMessage(
        chatId,
        "📚 Напиши название книги.\n\nПример:\nПреступление и наказание"
      );
    }

    if (text === "/stop" || text === "⏸ Пауза") {
      await stop(chatId);
      return sendMessage(chatId, "⏸ Остановлено. Продолжить можно кнопкой ▶️ Продолжить.");
    }

    if (text === "/resume" || text === "▶️ Продолжить") {
      await resume(chatId);
      return playNext(chatId);
    }

    if (text === "/next" || text === "▶️ Следующая глава") {
      await moveToNextChapter(chatId);
      return playNext(chatId);
    }

    await stop(chatId);

    const book = await prepareFastBook(text);

    await saveSession(chatId, {
      book_key: book.key,
      title: book.title,
      chapter_index: 0,
      chunk_index: 0,
      stopped: false
    });

    await sendMessage(
      chatId,
      `📖 ${book.title}\n\nЗапускаю чтение сразу.\nОстальная книга будет догружаться в фоне.`
    );

    playNext(chatId).catch(e => console.log("AUTO PLAY ERROR:", e.message));

    prepareFullBookInBackground().catch(e => console.log("BACKGROUND BOOK ERROR:", e.message));
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
      chat_id TEXT PRIMARY KEY
    );
  `);

  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS book_key TEXT;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS part_index INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chapter_index INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chunk_index INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stopped BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_cache (
      book_key TEXT NOT NULL,
      chapter_index INT NOT NULL,
      chunk_index INT NOT NULL,
      audio BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (book_key, chapter_index, chunk_index)
    );
  `);
}

async function prepareFastBook(userText) {
  const cached = await getBookByKey(BOOK_KEY);
  if (cached) return cached;

  const firstPages = [];

  for (let page = 1; page <= 3; page++) {
    const text = await loadILibraryPage(page);
    if (text.length > 500) firstPages.push(text);
  }

  const firstText = firstPages.join("\n\n");
  const firstChapter = {
    title: "Часть первая. Глава I",
    chunks: splitForVoice(firstText, FAST_TTS_CHARS)
  };

  const book = {
    key: BOOK_KEY,
    title: BOOK_TITLE,
    parts: [firstChapter]
  };

  await saveBook(book);
  return book;
}

async function prepareFullBookInBackground() {
  const existing = await getBookByKey(BOOK_KEY);
  if (existing && existing.parts && existing.parts.length > 20) return;

  const pages = [];

  for (let page = 1; page <= SOURCE_PAGES; page++) {
    try {
      const text = await loadILibraryPage(page);
      if (text.length > 500) pages.push({ page, text });
    } catch (e) {
      console.log("PAGE LOAD STOP:", page, e.message);
      break;
    }
  }

  const chapters = buildChaptersFromPages(pages);

  if (chapters.length > 0) {
    await saveBook({
      key: BOOK_KEY,
      title: BOOK_TITLE,
      parts: chapters
    });
    console.log("FULL BOOK READY:", chapters.length);
  }
}

async function loadILibraryPage(page) {
  const url = `https://ilibrary.ru/text/69/p.${page}/index.html`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: { "User-Agent": "BookVoiceAI/1.0" }
  });

  const html = iconv.decode(Buffer.from(res.data), "win1251");
  return cleanILibrary(html);
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

  const start = text.search(/Федор Достоевский|Фёдор Достоевский|Преступление и наказание|Часть|Глава|I\.|II\./i);
  if (start > 0) text = text.slice(start);

  return text
    .replace(/Комментарии[\s\S]*$/i, "")
    .replace(/Все права защищены[\s\S]*$/i, "")
    .replace(/Федор Достоевский/gi, "")
    .replace(/Фёдор Достоевский/gi, "")
    .replace(/Преступление и наказание/gi, "")
    .trim();
}

function buildChaptersFromPages(pages) {
  const chapters = [];
  let currentPart = "Часть первая";

  for (let i = 0; i < pages.length; i++) {
    const raw = pages[i].text;
    const title = detectChapterTitle(raw, i + 1, currentPart);

    const partMatch = raw.match(/Часть\s+(первая|вторая|третья|четвертая|пятая|шестая|седьмая|восьмая)/i);
    if (partMatch) currentPart = normalizePartTitle(partMatch[0]);

    const cleaned = removeHeaderNoise(raw);
    const chunks = splitForVoice(cleaned, NORMAL_TTS_CHARS);

    if (chunks.length > 0) {
      chapters.push({
        title,
        chunks
      });
    }
  }

  return chapters;
}

function detectChapterTitle(text, index, fallbackPart) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 18);

  let part = fallbackPart || "";
  let chapter = "";

  for (const line of lines) {
    if (/^Часть\s+/i.test(line)) part = normalizePartTitle(line);

    if (/^(Глава)\s+/i.test(line)) {
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
  return `${fallbackPart || "Глава"} ${index}`;
}

function normalizePartTitle(line) {
  const s = String(line || "").toLowerCase();
  if (s.includes("первая")) return "Часть первая";
  if (s.includes("вторая")) return "Часть вторая";
  if (s.includes("третья")) return "Часть третья";
  if (s.includes("четвертая") || s.includes("четвёртая")) return "Часть четвертая";
  if (s.includes("пятая")) return "Часть пятая";
  if (s.includes("шестая")) return "Часть шестая";
  return line.trim();
}

function removeHeaderNoise(text) {
  return String(text || "")
    .replace(/^Часть\s+[^\n]+\n?/i, "")
    .replace(/^Глава\s+[^\n]+\n?/i, "")
    .replace(/^[IVXLCDM]{1,8}\.\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitForVoice(text, maxLength) {
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

  return chunks.filter(x => x.length > 80);
}

async function playNext(chatId) {
  if (busy.has(chatId)) return;

  const session = await getSession(chatId);
  if (!session?.book_key) return sendMessage(chatId, "❌ Сначала напиши название книги.");
  if (session.stopped) return sendMessage(chatId, "⏸ Сейчас пауза. Нажми ▶️ Продолжить.");

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена.");

  const chapterIndex = Number(session.chapter_index || 0);
  const chunkIndex = Number(session.chunk_index || 0);

  const chapter = book.parts[chapterIndex];
  if (!chapter) return sendMessage(chatId, "✅ Книга закончена.");

  const chunks = Array.isArray(chapter.chunks) ? chapter.chunks : splitForVoice(chapter.text || "", NORMAL_TTS_CHARS);
  const chunk = chunks[chunkIndex];

  if (!chunk) {
    await saveSession(chatId, {
      chapter_index: chapterIndex + 1,
      chunk_index: 0,
      stopped: false
    });
    return sendMessage(chatId, "✅ Глава закончена. Нажми ▶️ Следующая глава.");
  }

  const jobId = `${Date.now()}_${Math.random()}`;
  activeJobs[chatId] = jobId;
  busy.add(chatId);

  try {
    if (chunkIndex === 0) {
      await sendMessage(chatId, `🎙 ${chapter.title}\n\nНачинаю читать...`);
    }

    let audio = await getCachedAudio(book.key, chapterIndex, chunkIndex);

    if (!audio) {
      const controller = new AbortController();
      controllers[chatId] = controller;

      audio = await elevenLabsTTS(chunk, controller.signal);

      if (activeJobs[chatId] !== jobId) return;

      await saveAudioCache(book.key, chapterIndex, chunkIndex, audio);
    }

    if (activeJobs[chatId] !== jobId) return;

    await sendAudio(chatId, audio, `chapter_${chapterIndex + 1}.mp3`, `📖 ${book.title}\n${chapter.title}`);

    if (activeJobs[chatId] !== jobId) return;

    await saveSession(chatId, {
      chapter_index: chapterIndex,
      chunk_index: chunkIndex + 1,
      stopped: false
    });

    const fresh = await getSession(chatId);
    if (!fresh?.stopped) {
      setTimeout(() => {
        playNext(chatId).catch(e => console.log("AUTO NEXT ERROR:", e.message));
      }, 700);
    }
  } catch (e) {
    console.log("PLAY ERROR:", e.response?.data || e.message || e);
    await sendMessage(chatId, "⚠️ Озвучка не ответила быстро. Нажми ▶️ Продолжить ещё раз.");
  } finally {
    delete controllers[chatId];
    busy.delete(chatId);
  }
}

async function elevenLabsTTS(text, signal) {
  const safeText = String(text || "").slice(0, NORMAL_TTS_CHARS);

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: safeText,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.36,
        similarity_boost: 0.9,
        style: 0.45,
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
      timeout: 18000,
      signal
    }
  );

  return Buffer.from(res.data);
}

async function moveToNextChapter(chatId) {
  const s = await getSession(chatId);
  if (!s) return;

  await saveSession(chatId, {
    chapter_index: Number(s.chapter_index || 0) + 1,
    chunk_index: 0,
    stopped: false
  });
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
    timeout: 90000
  });
}

async function saveBook(book) {
  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [book.key, book.title, JSON.stringify(book.parts)]
  );
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
    chapter_index: data.chapter_index ?? current?.chapter_index ?? 0,
    chunk_index: data.chunk_index ?? current?.chunk_index ?? 0,
    stopped: data.stopped ?? current?.stopped ?? false
  };

  await pool.query(
    `INSERT INTO sessions (chat_id, book_key, title, chapter_index, chunk_index, stopped, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (chat_id)
     DO UPDATE SET book_key=$2, title=$3, chapter_index=$4, chunk_index=$5, stopped=$6, updated_at=NOW()`,
    [chatId, next.book_key, next.title, next.chapter_index, next.chunk_index, next.stopped]
  );
}

async function getCachedAudio(bookKey, chapterIndex, chunkIndex) {
  const r = await pool.query(
    "SELECT audio FROM audio_cache WHERE book_key=$1 AND chapter_index=$2 AND chunk_index=$3",
    [bookKey, chapterIndex, chunkIndex]
  );

  return r.rows[0]?.audio || null;
}

async function saveAudioCache(bookKey, chapterIndex, chunkIndex, audio) {
  await pool.query(
    `INSERT INTO audio_cache (book_key, chapter_index, chunk_index, audio)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (book_key, chapter_index, chunk_index) DO NOTHING`,
    [bookKey, chapterIndex, chunkIndex, audio]
  );
}

initDB()
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT} — V13 INSTANT READER`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
