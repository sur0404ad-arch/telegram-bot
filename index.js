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
    console.log("UPDATE:", req.body);

    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text;

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Готовлю озвучку..."
      })
    });

    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVEN_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!elevenResponse.ok) {
      const errorText = await elevenResponse.text();
      console.log("ElevenLabs error:", errorText);

      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Ошибка ElevenLabs: " + errorText
        })
      });

      return res.sendStatus(200);
    }

    const audioBuffer = await elevenResponse.buffer();

    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("audio", audioBuffer, {
      filename: "reading.mp3",
      contentType: "audio/mpeg"
    });

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: formData.getHeaders(),
      body: formData
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
