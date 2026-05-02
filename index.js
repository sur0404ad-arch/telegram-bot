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

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🔊 Озвучка: " + text
      })
    });
  }

  res.sendStatus(200);
});

 
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
