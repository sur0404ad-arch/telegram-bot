const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.ELEVEN_VOICE_ID;

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function generateAudio(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return await response.buffer();
}

async function sendAudio(chatId, audioBuffer) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("audio", audioBuffer, {
    filename: "voice.mp3",
    contentType: "audio/mpeg",
  });

  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }
}

app.get("/", (req, res) => {
  res.send("Voice bot is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    await sendMessage(chatId, "Генерирую голос...");

    const audio = await generateAudio(text);
    await sendAudio(chatId, audio);
  } catch (error) {
    console.log("ERROR:", error.message);

    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, "Ошибка:\n" + error.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
