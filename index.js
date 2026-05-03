import fetch from "node-fetch";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const query = msg.text;

  await bot.sendMessage(chatId, "Ищу книгу...");

  try {
    // ищем книгу (простая база — Gutenberg)
    const search = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(query)}`);
    const data = await search.json();

    if (!data.results.length) {
      return bot.sendMessage(chatId, "Не нашёл книгу");
    }

    const book = data.results[0];
    const textUrl = book.formats["text/plain; charset=utf-8"];

    const bookText = await fetch(textUrl).then(r => r.text());

    const part = bookText.slice(0, 2000); // кусок

    // ElevenLabs
    const voice = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: part,
        model_id: "eleven_multilingual_v2"
      })
    });

    const buffer = await voice.arrayBuffer();
    fs.writeFileSync("voice.mp3", Buffer.from(buffer));

    await bot.sendAudio(chatId, "voice.mp3");

  } catch (e) {
    console.log(e);
    bot.sendMessage(chatId, "Ошибка");
  }
});
