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
    const text = msg.text.trim();

    console.log("USER MESSAGE:", text);

    if (text === "/start") {
      await sendMessage(chatId, "📚 Напиши книгу + автора");
      return;
    }

    if (isBlocked(text)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом");
      return;
    }

    await sendMessage(chatId, "🔎 Ищу в Викитеке...");

    const page = await findWikisourcePage(text);

    if (!page) {
      await sendMessage(chatId, "❌ Не нашёл книгу");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл: ${page.title}`);

    const rawText = await getWikisourceText(page);
    const cleanText = prepareText(rawText);

    const chunk = cleanText.slice(0, 1500);

    await sendMessage(chatId, "🎙 Озвучиваю...");

    const audio = await tts(chunk);

    await sendAudio(chatId, audio);

    await sendMessage(chatId, "✅ Готово");

  } catch (e) {
    console.log("ERROR:", e.message);
  }
});

function isBlocked(text) {
  const t = text.toLowerCase();
  return t.includes("гарри поттер") || t.includes("harry potter");
}

async function findWikisourcePage(query) {
  const url = `https://ru.wikisource.org/w/index.php?search=${encodeURIComponent(query)}`;

  const res = await axios.get(url);

  const match = res.data.match(/href="\/wiki\/([^"]+)"/);

  if (!match) return null;

  const title = decodeURIComponent(match[1]).replace(/_/g, " ");

  return {
    title,
    url: `https://ru.wikisource.org/wiki/${match[1]}`
  };
}

async function getWikisourceText(page) {
  const res = await axios.get(page.url);

  return res.data
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function prepareText(text) {
  return text
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function tts(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2"
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(res.data);
}

async function sendMessage(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text
  });
}

async function sendAudio(chatId, buffer) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("audio", buffer, {
    filename: "voice.mp3",
    contentType: "audio/mpeg"
  });

  await axios.post(`${TG_API}/sendAudio`, form, {
    headers: form.getHeaders()
  });
}

app.listen(3000, () => console.log("SERVER RUNNING"));
