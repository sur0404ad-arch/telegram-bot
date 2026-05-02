const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});
app.post("/", async (req, res) => {
  if (req.body.message) {
    const chatId = req.body.message.chat.id;
    const text = req.body.message.text;

 const voiceResponse = await fetch("https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL", {
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

const audioBuffer = await voiceResponse.arrayBuffer();

const formData = new FormData();
formData.append("chat_id", chatId);
formData.append("voice", Buffer.from(audioBuffer), "voice.ogg");

await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendVoice`, {
  method: "POST",
  body: formData
});

  res.sendStatus(200);
});

 
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
