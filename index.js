const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT = process.env.PORT || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => res.send("SERVER RUNNING"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id || !msg?.text) return;

    const chatId = msg.chat.id;
    const query = msg.text.trim();

    console.log("USER:", query);

    if (query === "/start") {
      await sendMessage(
        chatId,
        "📚 Напиши название книги на английском.\n\nПример:\nCrime and Punishment"
      );
      return;
    }

    if (isBlocked(query)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом.");
      return;
    }

    await sendMessage(chatId, "🔎 Ищу книгу...");
    const book = await findBook(query);

    if (!book) {
      await sendMessage(chatId, "❌ Не нашёл книгу.");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл:\n${book.title}`);
    await sendMessage(chatId, "📥 Загружаю текст...");

    const fullText = await loadText(book.url);

    console.log("TEXT LENGTH:", fullText.length);

    if (fullText.length < 1000) {
      await sendMessage(chatId, "❌ Текст не загрузился нормально.");
      return;
    }

    const parts = splitText(fullText, 1800)
      .filter((p) => p.length > 300)
      .slice(0, 8);

    await sendMessage(chatId, `🎬 Начинаю чтение как Netflix.\nЧастей: ${parts.length}`);

    for (let i = 0; i < parts.length; i++) {
      await sendMessage(chatId, `🎙 Часть ${i + 1}/${parts.length}`);

      const audio = await elevenLabsTTS(parts[i]);

      await sendAudio(
        chatId,
        audio,
        `part_${i + 1}.mp3`,
        `📖 ${book.title}\n🎬 Часть ${i + 1}/${parts.length}`
      );
    }

    await sendMessage(chatId, "✅ Готово. Первые части отправлены.");

  } catch (error) {
    console.log("SERVER ERROR:", error.response?.data || error.message || error);
  }
});

function isBlocked(text) {
  const t = text.toLowerCase();

  return [
    "harry potter",
    "гарри поттер",
    "rowling",
    "роулинг",
    "stephen king",
    "стивен кинг"
  ].some((x) => t.includes(x));
}

async function findBook(query) {
  const res = await axios.get("https://gutendex.com/books/", {
    params: {
      search: query
    },
    timeout: 15000,
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  const books = res.data.results || [];
  const book = books.find((b) => b.copyright !== true);

  if (!book) return null;

  const url =
    book.formats["text/plain; charset=utf-8"] ||
    book.formats["text/plain; charset=us-ascii"] ||
    book.formats["text/plain"];

  if (!url) return null;

  return {
    title: book.title,
    url
  };
}

async function loadText(url) {
  const res = await axios.get(url, {
    timeout: 25000,
    responseType: "text",
    headers: {
      "User-Agent": "BookVoiceAI/1.0"
    }
  });

  return cleanBookText(res.data);
}

function cleanBookText(text) {
  let t = String(text || "");

  t = t.replace(/[\s\S]*?\*\*\* START OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i, "");
  t = t.replace(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK[\s\S]*/i, "");

  t = t
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/_/g, "")
    .trim();

  return t.slice(0, 60000);
}

function splitText(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const parts = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();

    if ((current + " " + s).length > maxLength) {
      if (current.trim()) parts.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }

  if (current.trim()) parts.push(current.trim());

  return parts;
}

async function elevenLabsTTS(text) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.35,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer",
      timeout: 60000
    }
  );

  return Buffer.from(res.data);
}

async function sendMessage(chatId, text) {
  await axios.post(`${TG}/sendMessage`, {
    chat_id: chatId,
    text
  });
}

async function sendAudio(chatId, audioBuffer, filename, caption) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg"
  });

  await axios.post(`${TG}/sendAudio`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000
  });
}

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
