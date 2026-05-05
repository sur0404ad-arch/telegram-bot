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

const BOOK_KEY = "crime_ready_audio_v1";
const BOOK_TITLE = "Преступление и наказание";

const activePrepare = new Set();

app.get("/", (req, res) => res.send("SERVER RUNNING — READY AUDIO PLAYER"));

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
      await saveSession(chatId, { stopped: true });
      return sendMessage(chatId, "⏸ Остановлено. Продолжить можно кнопкой ▶️ Продолжить.");
    }

    if (text === "/resume" || text === "▶️ Продолжить") {
      await saveSession(chatId, { stopped: false });
      return sendReadyChapter(chatId);
    }

    if (text === "/next" || text === "▶️ Следующая глава") {
      await moveNextChapter(chatId);
      return sendReadyChapter(chatId);
    }

    if (text === "/prepare") {
      prepareAudioBook(chatId).catch(e => console.log("PREPARE ERROR:", e.message));
      return sendMessage(chatId, "🛠 Начал заранее готовить аудиокнигу. Это делается один раз. Потом главы будут отправляться мгновенно.");
    }

    await prepareBookStructure();

    await saveSession(chatId, {
      book_key: BOOK_KEY,
      title: BOOK_TITLE,
      chapter_index: 0,
      stopped: false
    });

    return sendReadyChapter(chatId);
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
      chapter_index INT DEFAULT 0,
      stopped BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chapter_audio_cache (
      book_key TEXT NOT NULL,
      chapter_index INT NOT NULL,
      title TEXT NOT NULL,
      audio BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (book_key, chapter_index)
    );
  `);
}

async function prepareBookStructure() {
  const cached = await getBookByKey(BOOK_KEY);
  if (cached) return cached;

  const chapters = [];

  for (let page = 1; page <= 90; page++) {
    try {
      const url = `https://ilibrary.ru/text/69/p.${page}/index.html`;

      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: { "User-Agent": "BookVoiceAI/1.0" }
      });

      const html = iconv.decode(Buffer.from(res.data), "win1251");
      const text = cleanILibrary(html);

      if (text.length < 700) continue;

      chapters.push({
        title: detectChapterTitle(text, chapters.length + 1),
        text: removeNoise(text)
      });
    } catch (e) {
      console.log("BOOK LOAD STOP:", page, e.message);
      break;
    }
  }

  await pool.query(
    `INSERT INTO books (key, title, parts)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title=$2, parts=$3`,
    [BOOK_KEY, BOOK_TITLE, JSON.stringify(chapters)]
  );

  return { key: BOOK_KEY, title: BOOK_TITLE, parts: chapters };
}

async function prepareAudioBook(chatId) {
  if (activePrepare.has(BOOK_KEY)) {
    return sendMessage(chatId, "⏳ Подготовка уже идёт.");
  }

  activePrepare.add(BOOK_KEY);

  try {
    const book = await prepareBookStructure();

    await sendMessage(chatId, `🛠 Начинаю подготовку аудио.\nГлав: ${book.parts.length}\n\nСначала готовлю первые 3 главы.`);

    const limit = Math.min(3, book.parts.length);

    for (let i = 0; i < limit; i++) {
      const cached = await getReadyAudio(BOOK_KEY, i);
      if (cached) continue;

      const chapter = book.parts[i];

      await sendMessage(chatId, `🎙 Готовлю заранее:\n${chapter.title}`);

      const audio = await buildChapterAudio(chapter.text);

      await saveReadyAudio(BOOK_KEY, i, chapter.title, audio);

      await sendMessage(chatId, `✅ Готово:\n${chapter.title}`);
    }

    await sendMessage(chatId, "✅ Первые главы готовы.\nТеперь напиши: Преступление и наказание");
  } catch (e) {
    console.log("PREPARE AUDIO ERROR:", e.response?.data || e.message || e);
    await sendMessage(chatId, "❌ Ошибка подготовки аудио. Проверь ElevenLabs лимиты/ключ.");
  } finally {
    activePrepare.delete(BOOK_KEY);
  }
}

async function sendReadyChapter(chatId) {
  const session = await getSession(chatId);
  if (!session?.book_key) return sendMessage(chatId, "❌ Сначала напиши название книги.");
  if (session.stopped) return sendMessage(chatId, "⏸ Сейчас пауза. Нажми ▶️ Продолжить.");

  const book = await getBookByKey(session.book_key);
  if (!book) return sendMessage(chatId, "❌ Книга не найдена.");

  const index = Number(session.chapter_index || 0);

  if (index >= book.parts.length) {
    return sendMessage(chatId, "✅ Книга закончена.");
  }

  const chapter = book.parts[index];
  const readyAudio = await getReadyAudio(book.key, index);

  if (!readyAudio) {
    return sendMessage(
      chatId,
      `⏳ Эта глава ещё не подготовлена:\n${chapter.title}\n\nСначала нажми /prepare и дождись готовности первых глав.`
    );
  }

  await sendAudio(
    chatId,
    readyAudio.audio,
    `chapter_${index + 1}.mp3`,
    `📖 ${book.title}\n${readyAudio.title || chapter.title}`
  );
}

async function buildChapterAudio(text) {
  const chunks = splitForVoice(text, 1400);
  const buffers = [];

  for (let i = 0; i < chunks.length; i++) {
    const audio = await elevenLabsTTS(chunks[i]);
    buffers.push(audio);
  }

  return Buffer.concat(buffers);
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
    .trim();
}

function detectChapterTitle(text, fallbackNumber) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 25);

  let part = "";
  let chapter = "";

  for (const line of lines) {
    if (/^Часть\s+/i.test(line)) part = normalizePart(line);

    if (/^Глава\s+/i.test(line)) {
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
  if (part) return part;

  return `Глава ${fallbackNumber}`;
}

function normalizePart(line) {
  const s = String(line || "").toLowerCase();

  if (s.includes("первая")) return "Часть первая";
  if (s.includes("вторая")) return "Часть вторая";
  if (s.includes("третья")) return "Часть третья";
  if (s.includes("четвертая") || s.includes("четвёртая")) return "Часть четвертая";
  if (s.includes("пятая")) return "Часть пятая";
  if (s.includes("шестая")) return "Часть шестая";

  return line.trim();
}

function removeNoise(text) {
  return String(text || "")
    .replace(/Федор Достоевский/gi, "")
    .replace(/Фёдор Достоевский/gi, "")
    .replace(/Преступление и наказание/gi, "")
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

async function elevenLabsTTS(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: String(text || "").slice(0, 1500),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.9,
        style: 0.5,
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
      timeout: 60000
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

async function getReadyAudio(bookKey, chapterIndex) {
  const r = await pool.query(
    "SELECT title, audio FROM chapter_audio_cache WHERE book_key=$1 AND chapter_index=$2",
    [bookKey, chapterIndex]
  );

  return r.rows[0] || null;
}

async function saveReadyAudio(bookKey, chapterIndex, title, audio) {
  await pool.query(
    `INSERT INTO chapter_audio_cache (book_key, chapter_index, title, audio)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (book_key, chapter_index)
     DO UPDATE SET title=$3, audio=$4, created_at=NOW()`,
    [bookKey, chapterIndex, title, audio]
  );
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
    stopped: data.stopped ?? current?.stopped ?? false
  };

  await pool.query(
    `INSERT INTO sessions (chat_id, book_key, title, chapter_index, stopped, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (chat_id)
     DO UPDATE SET book_key=$2, title=$3, chapter_index=$4, stopped=$5, updated_at=NOW()`,
    [chatId, next.book_key, next.title, next.chapter_index, next.stopped]
  );
}

async function moveNextChapter(chatId) {
  const s = await getSession(chatId);
  if (!s) return;

  await saveSession(chatId, {
    chapter_index: Number(s.chapter_index || 0) + 1,
    stopped: false
  });
}

initDB()
  .then(() => app.listen(PORT, () => console.log(`SERVER RUNNING ON ${PORT} — READY AUDIO PLAYER`)))
  .catch(err => {
    console.log("DB INIT ERROR:", err.message);
    process.exit(1);
  });
