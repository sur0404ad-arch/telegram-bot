const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT = process.env.PORT || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// память пользователей
const sessions = {};

app.get("/", (req, res) => res.send("OK"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    console.log("USER:", text);

    // --- STOP ---
    if (text === "/stop") {
      sessions[chatId] = { stopped: true };
      await sendMessage(chatId, "⏹ Остановлено");
      return;
    }

    // --- NEXT ---
    if (text === "▶️ Следующая часть") {
      return sendNextPart(chatId);
    }

    // --- START ---
    if (text === "/start") {
      await sendMessage(
        chatId,
        "📚 Напиши книгу\n\nПример:\nCrime and Punishment"
      );
      return;
    }

    // новая сессия
    sessions[chatId] = {
      stopped: false,
      parts: [],
      index: 0,
      title: ""
    };

    await sendMessage(chatId, "🔎 Ищу книгу...");

    const book = await findBook(text);

    if (!book) {
      await sendMessage(chatId, "❌ Не нашёл книгу");
      return;
    }

    sessions[chatId].title = book.title;

    await sendMessage(chatId, `📖 ${book.title}`);
    await sendMessage(chatId, "📥 Загружаю текст...");

    const raw = await loadText(book.url);

    if (raw.length < 1000) {
      await sendMessage(chatId, "❌ Ошибка загрузки текста");
      return;
    }

    const parts = split(raw, 1800)
      .filter(p => p.length > 300)
      .slice(0, 50);

    sessions[chatId].parts = parts;

    await sendMessage(chatId, "🎬 Начинаю...");
    await sendNextPart(chatId);

  } catch (e) {
    console.log("ERROR:", e.message);
  }
});

// --- SEND NEXT PART ---
async function sendNextPart(chatId) {
  const session = sessions[chatId];
  if (!session || session.stopped) return;

  const { parts, index, title } = session;

  if (index >= parts.length) {
    await sendMessage(chatId, "📕 Конец");
    return;
  }

  const text = parts[index];

  await sendMessage(chatId, `🎙 Часть ${index + 1}`);

  const audio = await tts(text);

  if (sessions[chatId]?.stopped) return; // 💣 моментальная остановка

  await sendAudio(chatId, audio, `part_${index}.mp3`);

  session.index++;

  await sendMessage(chatId, "▶️ Следующая часть", {
    keyboard: [["▶️ Следующая часть"], ["/stop"]],
    resize_keyboard: true
  });
}

// --- FIND BOOK ---
async function findBook(q) {
  const res = await axios.get(
    `https://gutendex.com/books/?search=${encodeURIComponent(q)}`
  );

  const book = res.data.results.find(b => !b.copyright);

  if (!book) return null;

  const url =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain"];

  return { title: book.title, url };
}

// --- LOAD TEXT ---
async function loadText(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    responseType: "text",
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  return clean(res.data);
}

// --- CLEAN ---
function clean(t) {
  return t
    .replace(/[\s\S]*?START OF (THIS|THE) PROJECT GUTENBERG EBOOK/i, "")
    .replace(/END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*/i, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- SPLIT ---
function split(text, max) {
  const out = [];
  let cur = "";

  for (let s of text.split(".")) {
    if ((cur + s).length > max) {
      out.push(cur);
      cur = s;
    } else {
      cur += s + ".";
    }
  }

  if (cur) out.push(cur);
  return out;
}

// --- TTS ---
async function tts(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    { text },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(res.data);
}

// --- SEND ---
async function sendMessage(chatId, text, extra = {}) {
  await axios.post(`${TG}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: extra.keyboard
      ? { keyboard: extra.keyboard }
      : undefined
  });
}

async function sendAudio(chatId, buffer, name) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", buffer, { filename: name });

  await axios.post(`${TG}/sendAudio`, form, {
    headers: form.getHeaders()
  });
}

app.listen(PORT, () => console.log("SERVER RUNNING"));
