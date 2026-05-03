console.log("NETFLIX READER VERSION STARTED");

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("SERVER RUNNING ON", PORT);
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER STARTED ON PORT " + PORT);
});
app.post("/", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = message.text;

    console.log("USER:", text);

    await sendText(chatId, "Принял: " + text);

  } catch (e) {
    console.log("ERROR:", e);
  }

  res.sendStatus(200);
});
