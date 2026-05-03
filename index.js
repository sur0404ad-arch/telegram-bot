const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.ELEVEN_VOICE_ID;

// отправка текста
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
    }),
  });
}

// отправка голоса
async function sendVoice(chatId, audioBuffer) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("voice", audioBuffer, "voice.mp3");

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, {
    method: "POST",
    body: formData,
  });
}

// генерация голоса
async function generateVoice(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return await response.buffer();
}

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    await sendMessage(chatId, "Генерирую голос...");

    const audio = await generateVoice(text);
    await sendVoice(chatId, audio);

    res.sendStatus(200);
  } catch (error) {
    console.log("ERROR:", error.message);

    await sendMessage(
      req.body.message.chat.id,
      "Ошибка ElevenLabs:\n" + error.message
    );

    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
