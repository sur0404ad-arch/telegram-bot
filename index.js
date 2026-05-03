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

  
     const gTTS = require("gtts");
const fs = require("fs");

const gtts = new gTTS(text, "ru");
const filePath = "./voice.mp3";

gtts.save(filePath, async function (err) {
  if (err) {
    console.log(err);
    return;
  }

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("audio", fs.createReadStream(filePath));

  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendAudio`, {
    method: "POST",
    body: formData,
  });
});

   

      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
        
        })
      });

      return res.sendStatus(200);
    }

  

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
