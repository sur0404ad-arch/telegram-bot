const express = require("express");
const fetch = require("node-fetch");
const googleTTS = require("google-tts-api");

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
    const text = message.text.slice(0, 200);

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Готовлю озвучку..."
      })
    });

    const audioUrl = googleTTS.getAudioUrl(text, {
      lang: "ru",
      slow: false,
      host: "https://translate.google.com"
    });

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        audio: audioUrl,
        title: "Озвучка",
        performer: "Book Voice AI"
      })
    });

    res.sendStatus(200);
  } catch (error) {
    console.log("SERVER ERROR:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});
