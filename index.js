const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.post("/", (req, res) => {
  console.log(req.body);

  if (req.body.message) {
    console.log("Message:", req.body.message.text);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server started");
});
