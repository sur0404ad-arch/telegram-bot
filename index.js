const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) console.log("❌ BOT_TOKEN missing");
if (!ELEVENLABS_API_KEY) console.log("❌ ELEVENLABS_API_KEY missing");
if (!ELEVENLABS_VOICE_ID) console.log("❌ ELEVENLABS_VOICE_ID missing");

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => {
  res.send("SERVER RUNNING");
});

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg || !msg.chat || !msg.text) return;

    const chatId = msg.chat.id;
    const userText = msg.text.trim();

    console.log("USER MESSAGE:", userText);

    if (userText === "/start") {
      await sendMessage(
        chatId,
        "📚 Напиши название книги и автора.\n\nНапример:\nПреступление и наказание Достоевский"
      );
      return;
    }

    await sendMessage(chatId, "📖 Проверяю доступность книги (авторские права)...");

    const book = await findPublicDomainBook(userText);

    if (!book) {
      await sendMessage(
        chatId,
        "❌ Книга не найдена в public domain.\n\nВозможно, она защищена авторским правом."
      );
      return;
    }

    if (book.copyright === true) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом.");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл книгу:\n${book.title}\n\n🎧 Читаю...`);

    const textUrl = getTextUrl(book);
    if (!textUrl) {
      await sendMessage(chatId, "❌ У этой книги нет текстового формата для чтения.");
      return;
    }

    console.log("TEXT URL:", textUrl);

    const rawText = await downloadBookText(textUrl);
    const cleanText = cleanBookText(rawText);

    if (!cleanText || cleanText.length < 500) {
      await sendMessage(chatId, "❌ Не удалось получить нормальный текст книги.");
      return;
    }

    const chunks = splitText(cleanText, 2200).slice(0, 3);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`VOICE CHUNK ${i + 1}/${chunks.length}`);

      const audioBuffer = await elevenLabsTTS(narrationText(chunks[i]));

      await sendAudio(chatId, audioBuffer, `part_${i + 1}.mp3`, `Часть ${i + 1}`);
    }

    await sendMessage(chatId, "✅ Готово. Отправил первые части книги.");

  } catch (error) {
    console.log("SERVER ERROR:", error.response?.data || error.message || error);
  }
});

async function findPublicDomainBook(query) {
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
  const response = await axios.get(url, { timeout: 20000 });

  const books = response.data.results || [];

  console.log("BOOKS FOUND:", books.length);

  const publicBooks = books.filter((b) => b.copyright !== true);

  return publicBooks[0] || null;
}

function getTextUrl(book) {
  const formats = book.formats || {};

  return (
    formats["text/plain; charset=utf-8"] ||
    formats["text/plain; charset=us-ascii"] ||
    formats["text/plain"] ||
    null
  );
}

async function downloadBookText(url) {
  const response = await axios.get(url, {
    timeout: 30000,
    responseType: "text",
  });

  return response.data;
}

function cleanBookText(text) {
  let t = String(text || "");

  const startMarkers = [
    "*** START OF THE PROJECT GUTENBERG EBOOK",
    "*** START OF THIS PROJECT GUTENBERG EBOOK",
    "*** START OF PROJECT GUTENBERG",
  ];

  const endMarkers = [
    "*** END OF THE PROJECT GUTENBERG EBOOK",
    "*** END OF THIS PROJECT GUTENBERG EBOOK",
    "*** END OF PROJECT GUTENBERG",
  ];

  for (const marker of startMarkers) {
    const index = t.indexOf(marker);
    if (index !== -1) {
      t = t.slice(index + marker.length);
      break;
    }
  }

  for (const marker of endMarkers) {
    const index = t.indexOf(marker);
    if (index !== -1) {
      t = t.slice(0, index);
      break;
    }
  }

  return t
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanVoiceText(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/_/g, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function narrationText(text) {
  return cleanVoiceText(text)
    .replace(/([.!?])\s+/g, "$1...\n\n")
    .replace(/—/g, " — ")
    .trim();
}

function splitText(text, maxLength) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    const paragraph = p.trim();
    if (!paragraph) continue;

    if ((current + "\n" + paragraph).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += "\n" + paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

async function elevenLabsTTS(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.35,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 60000,
    }
  );

  return Buffer.from(response.data);
}

async function sendMessage(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

async function sendAudio(chatId, audioBuffer, filename, caption) {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("audio", audioBuffer, {
    filename,
    contentType: "audio/mpeg",
  });

  await axios.post(`${TG_API}/sendAudio`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
