const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "20mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const PORT = process.env.PORT || 3000;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WIKI_API = "https://ru.wikisource.org/w/api.php";

const HEADERS = {
  "User-Agent": "BookVoiceAI/1.0 (Telegram bot; contact: book_voice_reader_bot)",
};

app.get("/", (req, res) => {
  res.send("SERVER RUNNING");
});

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id || !msg?.text) return;

    const chatId = msg.chat.id;
    const userText = msg.text.trim();

    console.log("USER MESSAGE:", userText);

    if (userText === "/start") {
      await sendMessage(
        chatId,
        "📚 Напиши название книги.\n\nНапример:\nПреступление и наказание"
      );
      return;
    }

    if (isBlocked(userText)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом.");
      return;
    }

    await sendMessage(chatId, "🔎 Ищу в Викитеке...");

    const page = await findWikisourcePage(userText);

    if (!page) {
      await sendMessage(chatId, "❌ Не нашёл книгу в Викитеке.");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл: ${page.title}`);
    await sendMessage(chatId, "📥 Загружаю текст...");

    const rawText = await getWikisourceText(page.title);
    const cleanText = cleanBookText(rawText);

    console.log("CLEAN TEXT LENGTH:", cleanText.length);

    if (cleanText.length < 700) {
      await sendMessage(chatId, "❌ Нашёл страницу, но текста мало для озвучки.");
      return;
    }

    const chunk = cleanText.slice(0, 1500);

    await sendMessage(chatId, "🎙 Озвучиваю первую часть...");

    const audioBuffer = await elevenLabsTTS(narrationText(chunk));

    await sendAudio(chatId, audioBuffer, "part_1.mp3", `📚 ${page.title}\nЧасть 1`);

    await sendMessage(chatId, "✅ Готово.");

  } catch (error) {
    console.log("SERVER ERROR:", error.response?.data || error.message || error);
  }
});

function isBlocked(text) {
  const t = text.toLowerCase();

  const blocked = [
    "гарри поттер",
    "harry potter",
    "rowling",
    "роулинг",
    "стивен кинг",
    "stephen king",
    "метро 2033",
    "лукьяненко",
    "пелевин",
    "акунин"
  ];

  return blocked.some((x) => t.includes(x));
}

async function findWikisourcePage(query) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "opensearch",
      search: query,
      limit: 5,
      namespace: 0,
      format: "json"
    },
    headers: HEADERS,
    timeout: 15000
  });

  console.log("WIKI OPENSEARCH:", JSON.stringify(res.data));

  const titles = res.data[1] || [];

  if (!titles.length) return null;

  return {
    title: titles[0]
  };
}

async function getWikisourceText(title) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "query",
      prop: "extracts",
      titles: title,
      explaintext: 1,
      exsectionformat: "plain",
      format: "json"
    },
    headers: HEADERS,
    timeout: 20000
  });

  const pages = res.data.query?.pages || {};
  const firstPage = Object.values(pages)[0];

  console.log("RAW TEXT LENGTH:", firstPage?.extract?.length || 0);

  return firstPage?.extract || "";
}

function cleanBookText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/↑/g, "")
    .replace(/См. также[\s\S]*$/i, "")
    .replace(/Примечания[\s\S]*$/i, "")
    .replace(/Источники[\s\S]*$/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanVoiceText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function narrationText(text) {
  return cleanVoiceText(text)
    .replace(/([.!?])\s+/g, "$1...\n\n")
    .replace(/—/g, " — ")
    .trim();
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
  await axios.post(`${TG_API}/sendMessage`, {
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

  await axios.post(`${TG_API}/sendAudio`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
}

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
