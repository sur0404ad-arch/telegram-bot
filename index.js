console.log("FAST VERSION STARTED");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

// =====================
// TELEGRAM SEND
// =====================
async function sendText(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendAudio(chatId, buffer) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", buffer, "voice.mp3");

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    body: form,
  });
}

// =====================
// БЫСТРАЯ ЗАГРУЗКА ТЕКСТА (с таймаутом)
// =====================
async function getBookTextFast() {
  const controller = new AbortController();

  // ⛔ ограничение 10 секунд
  setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(
      "https://www.gutenberg.org/files/2554/2554-0.txt",
      { signal: controller.signal }
    );

    const text = await res.text();

    return text.slice(0, 3000); // ⚡ только начало
  } catch (e) {
    return null;
  }
}

// =====================
// ГОЛОС (БЫСТРЫЙ)
// =====================
async function generateVoice(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2", // ⚡ быстрее
      }),
    }
  );

  return await res.buffer();
}

// =====================
// WEBHOOK
// =====================
app.post("/", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  // STOP
  if (text === "/stop") {
    sessions.delete(chatId);
    await sendText(chatId, "Остановлено.");
    return res.sendStatus(200);
  }

  // СРАЗУ ОТВЕТ (убираем паузу)
  await sendText(chatId, "Ищу текст... готовлю голос (5–10 сек)");

  // ПАРАЛЛЕЛЬНО
  const bookText = await getBookTextFast();

  if (!bookText) {
    await sendText(chatId, "Ошибка загрузки. Попробуй позже.");
    return res.sendStatus(200);
  }

  const voice = await generateVoice(bookText);

  await sendAudio(chatId, voice);

  res.sendStatus(200);
});

// =====================
app.listen(3000, () => {
  console.log("FAST BOT RUNNING");
});
