const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.ELEVEN_VOICE_ID;

async function sendVoice(chatId, text) {
  const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  const audioBuffer = await tts.buffer();

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", audioBuffer, { filename: "voice.ogg" });

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, {
    method: "POST",
    body: form,
  });
}

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text;

    if (text === "/start") {
      await sendVoice(chatId, "Назови произведение, и я начну читать");
    } else {
      await sendVoice(chatId, `Начинаю читать: ${text}`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.log(error);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Voice bot running");
});

app.listen(process.env.PORT || 3000);
