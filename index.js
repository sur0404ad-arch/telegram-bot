const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => res.send("OK"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const text = msg.text;

    console.log("USER:", text);

    if (text === "/start") {
      await sendMessage(chatId, "📚 Напиши книгу на английском\n\nПример:\nCrime and Punishment");
      return;
    }

    if (isBlocked(text)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом");
      return;
    }

    await sendMessage(chatId, "🔎 Ищу книгу...");

    const book = await findBook(text);

    if (!book) {
      await sendMessage(chatId, "❌ Не нашёл книгу");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл: ${book.title}`);

    const raw = await axios.get(book.url);
    const clean = cleanText(raw.data);

    const parts = splitText(clean, 1800).slice(0, 10);

    await sendMessage(chatId, "🎬 Начинаю чтение...");

    for (let i = 0; i < parts.length; i++) {
      await sendMessage(chatId, `🎙 Часть ${i + 1}`);

      const audio = await tts(parts[i]);

      await sendAudio(chatId, audio, `part_${i}.mp3`);
    }

  } catch (e) {
    console.log(e.message);
  }
});

function isBlocked(t) {
  t = t.toLowerCase();
  return t.includes("harry potter");
}

async function findBook(q) {
  const res = await axios.get(`https://gutendex.com/books/?search=${encodeURIComponent(q)}`);

  const book = res.data.results[0];

  if (!book) return null;

  return {
    title: book.title,
    url: book.formats["text/plain; charset=utf-8"]
  };
}

function cleanText(t) {
  return t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
}

function splitText(text, max) {
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

async function sendMessage(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text });
}

async function sendAudio(chatId, buffer, name) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", buffer, { filename: name });

  await axios.post(`${TG_API}/sendAudio`, form, {
    headers: form.getHeaders()
  });
}

app.listen(3000);
