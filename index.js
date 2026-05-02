const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text;

    const voiceResponse = await fetch("https://api.elevenlabs.io/v1/text-to-speech/s0phbFBBp708ZeIy8oGx", {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2"
      })
    });

    const audioBuffer = await voiceResponse.buffer();

    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("voice", audioBuffer, {
      filename: "voice.mp3",
      contentType: "audio/mpeg"
    });

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendVoice`, {
      method: "POST",
      body: formData
    });

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
