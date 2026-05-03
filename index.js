const express = require("express");
const fetch = require("node-fetch");
const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;

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

app.get("/", (req, res) => {
  res.send("Book reader bot is running");
});

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendMessage(
        chatId,
        "Напиши название художественного произведения, которое хочешь слушать. Например: Преступление и наказание"
      );
    } else {
      await sendMessage(
        chatId,
        `Ищу произведение: "${text}"\n\nСледующий шаг — подключим поиск книги в интернете и чтение вслух.`
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.log("SERVER ERROR:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
