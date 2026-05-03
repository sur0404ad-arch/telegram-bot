const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.ELEVEN_VOICE_ID;

async function sendText(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });
}

async function sendAudio(chatId, text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.log("ELEVENLABS ERROR:", response.status, errorText);
    await sendText(chatId, "Ошибка ElevenLabs. Проверь ELEVEN_API_KEY и ELEVEN_VOICE_ID.");
    return;
  }

  const audioBuffer = await response.buffer();

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", audioBuffer, {
    filename: "voice.mp3",
    contentType: "audio/mpeg",
  });

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${TOKEN}/sendAudio`,
    {
      method: "POST",
      headers: form.getHeaders(),
      body: form,
    }
  );

  if (!telegramResponse.ok) {
    const telegramError = await telegramResponse.text();
    console.log("TELEGRAM AUDIO ERROR:", telegramResponse.status, telegramError);
    await sendText(chatId, "Ошибка отправки аудио в Telegram.");
  }
}

app.get("/", (req, res) => {
  res.send("Voice bot is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return;
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("MESSAGE:", text);

    if (text === "/start") {
      await sendText(chatId, "Сейчас отправлю тестовый голос...");
      await sendAudio(chatId, "Назови произведение, и я начну читать.");
    } else {
      await sendText(chatId, `Принял: ${text}`);
      await sendAudio(chatId, `Начинаю читать: ${text}`);
    }
  } catch (error) {
    console.log("SERVER ERROR:", error);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
