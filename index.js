const express = require("express");
const fetch = require("node-fetch");
const googleTTS = require("google-tts-api");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

function cleanText(text) {
  return text
    .replace(/\[[^\]]*\]/g, "")
    .replace(/==.*?==/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text, maxLength = 180) {
  const chunks = [];
  let current = "";

  for (const word of text.split(" ")) {
    if ((current + " " + word).length > maxLength) {
      chunks.push(current.trim());
      current = word;
    } else {
      current += " " + word;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function searchWikisource(query) {
  const searchUrl =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srsearch=" +
    encodeURIComponent(query);

  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();

  if (!searchData.query.search.length) {
    return null;
  }

  const title = searchData.query.search[0].title;

  const textUrl =
    "https://ru.wikisource.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&titles=" +
    encodeURIComponent(title);

  const textRes = await fetch(textUrl);
  const textData = await textRes.json();

  const pages = textData.query.pages;
  const page = Object.values(pages)[0];

  return {
    title,
    text: cleanText(page.extract || "")
  };
}

app.post("/", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userText = message.text.trim();

    if (!userText.toLowerCase().startsWith("прочитай")) {
      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Напиши так: «прочитай капитанская дочка»"
        })
      });

      return res.sendStatus(200);
    }

    const bookName = userText.replace(/^прочитай/i, "").trim();

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Ищу произведение: " + bookName
      })
    });

    const book = await searchWikisource(bookName);

    if (!book || !book.text) {
      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Не нашёл произведение в Викитеке."
        })
      });

      return res.sendStatus(200);
    }

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Нашёл: " + book.title + "\nНачинаю читать."
      })
    });

   const chunks = splitText(book.text, 900).slice(0, 10);

    for (const chunk of chunks) {
      const audioUrl = googleTTS.getAudioUrl(chunk, {
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
          title: book.title,
          performer: "AI Чтец"
        })
      });
    }

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
