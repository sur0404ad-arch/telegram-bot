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
const WIKI_API = "https://ru.wikisource.org/w/api.php";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const jobs = {};
const controllers = {};

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
      stopJob(chatId);
      await saveSession(chatId, { stopped: true });
      return sendMessage(chatId, "⏹ Остановлено. Позиция сохранена.");
    }

    if (text === "/resume") {
      const session = await getSession(chatId);
      if (!session?.book_key) return sendMessage(chatId, "❌ Нет сохранённой книги.");

      const jobId = newJob(chatId);
      await saveSession(chatId, { stopped: false, job_id: jobId });

      return autoplay(chatId, jobId);
    }

    if (isBlocked(text)) {
      return sendMessage(chatId, "❌ Книга защищена авторским правом.");
    }

    stopJob(chatId);

    const jobId = newJob(chatId);

    await saveSession(chatId, {
      query: text,
      book_key: null,
      title: null,
      part_index: 0,
      stopped: false,
      job_id: jobId
    });

    await sendMessage(chatId, "🔎 Ищу книгу...");

    const book = await getOrCreateBook(text);

    if (!isAlive(chatId, jobId)) return;

    if (!book || !book.parts.length) {
      return sendMessage(chatId, "❌ Не удалось найти или подготовить книгу.");
    }

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
      `📖 Нашёл:\n${book.title}\n\n🎬 Начинаю автоплей.\nЧастей: ${book.parts.length}\n\n/stop — остановить\n/resume — продолжить`
    );

    return autoplay(chatId, jobId);

  } catch (e) {
    console.log("SERVER ERROR:", e.response?.data || e.message || e);
  }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      key TEXT PRIMARY KEY,
      query TEXT,
      title TEXT,
      source TEXT,
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
}

function newJob(chatId) {
  const jobId = String(Date.now()) + "_" + Math.random().toString(16).slice(2);
  jobs[chatId] = jobId;
  return jobId;
}

function stopJob(chatId) {
  jobs[chatId] = "stopped_" + Date.now();

  if (controllers[chatId]) {
    try {
      controllers[chatId].abort();
    } catch {}
    delete controllers[chatId];
  }
}

function isAlive(chatId, jobId) {
  return jobs[chatId] === jobId;
}

async function autoplay(chatId, jobId) {
  const session = await getSession(chatId);
  if (!session?.book_key || !isAlive(chatId, jobId)) return;

  const book = await getBookByKey(session.book_key);
  if (!book || !book.parts.length) return sendMessage(chatId, "❌ Книга не найдена в кэше.");

  let index = session.part_index || 0;

  while (index < book.parts.length) {
    if (!isAlive(chatId, jobId)) return;

    await sendMessage(chatId, `🎙 Часть ${index + 1}/${book.parts.length}`);

    const controller = new AbortController();
    controllers[chatId] = controller;

    let audio;
    try {
      audio = await elevenLabsTTS(book.parts[index], controller.signal);
    } catch (e) {
      if (e.name === "CanceledError" || e.code === "ERR_CANCELED") return;
      throw e;
    }

    delete controllers[chatId];

    if (!isAlive(chatId, jobId)) return;

    await sendAudio(
      chatId,
      audio,
      `part_${index + 1}.mp3`,
      `📖 ${book.title}\nЧасть ${index + 1}/${book.parts.length}`
    );

    index++;

    await saveSession(chatId, {
      part_index: index,
      stopped: false,
      job_id: jobId
    });

    await sleep(800);
  }

  if (isAlive(chatId, jobId)) {
    await sendMessage(chatId, "✅ Книга закончена.");
  }
}

async function getOrCreateBook(query) {
  const key = hash(query.toLowerCase().trim());

  const cached = await getBookByKey(key);
  if (cached) {
    console.log("BOOK CACHE HIT:", cached.title);
    return cached;
  }

  console.log("BOOK CACHE MISS:", query);

  let book = await loadFromWikisource(query);

  if (!book || !book.text || book.text.length < 1000) {
    console.log("WIKISOURCE FAILED, TRY GUTENBERG");
    book = await loadFromGutenberg(normalizeForGutenberg(query));
  }

  if (!book || !book.text || book.text.length < 1000) return null;

  const parts = splitText(book.text, 1700)
    .filter(p => p.length > 250)
    .slice(0, 120);

  if (!parts.length) return null;

  await pool.query(
    `INSERT INTO books (key, query, title, source, parts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE SET title=$3, source=$4, parts=$5`,
    [key, query, book.title, book.source, JSON.stringify(parts)]
  );

  return {
    key,
    title: book.title,
    source: book.source,
    parts
  };
}

async function loadFromWikisource(query) {
  const title = await findWikiTitle(query);
  if (!title) return null;

  const mainText = await getWikiPlainText(title);

  let fullText = cleanWikiText(mainText);

  if (fullText.length < 2000) {
    const chapters = await getWikiLinks(title);

    for (const ch of chapters.slice(0, 20)) {
      const t = await getWikiPlainText(ch);
      fullText += "\n\n" + cleanWikiText(t);

      if (fullText.length > 60000) break;
    }
  }

  return {
    title,
    source: "wikisource",
    text: fullText
  };
}

async function findWikiTitle(query) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "opensearch",
      search: query,
      limit: 5,
      namespace: 0,
      format: "json"
    },
    timeout: 15000,
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  const titles = res.data?.[1] || [];
  return titles[0] || null;
}

async function getWikiLinks(title) {
  try {
    const res = await axios.get(WIKI_API, {
      params: {
        action: "parse",
        page: title,
        prop: "links",
        format: "json"
      },
      timeout: 20000,
      headers: {
        "User-Agent": "BookVoiceAI/1.0"
      }
    });

    const links = res.data?.parse?.links || [];

    return links
      .filter(l => l.ns === 0)
      .map(l => l["*"])
      .filter(t =>
        /глава|часть|^[IVXLCDM]+$|^\d+$/i.test(t) ||
        t.includes(title + "/")
      )
      .slice(0, 50);

  } catch {
    return [];
  }
}

async function getWikiPlainText(title) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "query",
      prop: "extracts",
      titles: title,
      explaintext: 1,
      exsectionformat: "plain",
      format: "json"
    },
    timeout: 20000,
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  const pages = res.data?.query?.pages || {};
  const page = Object.values(pages)[0];

  return page?.extract || "";
}

async function loadFromGutenberg(query) {
  const res = await axios.get("https://gutendex.com/books/", {
    params: { search: query },
    timeout: 15000,
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  const books = res.data.results || [];
  const book = books.find(b => b.copyright !== true);

  if (!book) return null;

  const url =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain; charset=us-ascii"] ||
    book.formats["text/plain"];

  if (!url) return null;

  const txt = await axios.get(url, {
    timeout: 25000,
    responseType: "text",
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  return {
    title: book.title,
    source: "gutenberg",
    text: cleanGutenbergText(txt.data)
  };
}

function normalizeForGutenberg(text) {
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

function cleanWikiText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/↑/g, "")
    .replace(/См. также[\s\S]*$/i, "")
    .replace(/Примечания[\s\S]*$/i, "")
    .replace(/Источники[\s\S]*$/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 200000);
}

function cleanGutenbergText(text) {
  let t = String(text || "");

  t = t.replace(/[\s\S]*?\*\*\* START OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i, "");
  t = t.replace(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*/i, "");

  return t
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/_/g, "")
    .trim()
    .slice(0, 200000);
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

async function getBookByKey(key) {
  const r = await pool.query("SELECT * FROM books WHERE key=$1", [key]);
  if (!r.rows.length) return null;

  const row = r.rows[0];

  return {
    key: row.key,
    title: row.title,
    source: row.source,
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

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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
  ].some(x => t.includes(x));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
