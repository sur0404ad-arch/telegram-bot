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
  "User-Agent": "BookVoiceAI/1.0 TelegramBot"
};

app.get("/", (req, res) => res.send("SERVER RUNNING"));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    if (!msg?.chat?.id || !msg?.text) return;

    const chatId = msg.chat.id;
    const userText = msg.text.trim();

    console.log("USER MESSAGE:", userText);

    if (userText === "/start") {
      await sendMessage(chatId, "📚 Напиши название книги.\n\nНапример:\nПреступление и наказание");
      return;
    }

    if (isBlocked(userText)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом.");
      return;
    }

    await sendMessage(chatId, "🔎 Ищу книгу в Викитеке...");

    const bookTitle = await findBookTitle(userText);

    if (!bookTitle) {
      await sendMessage(chatId, "❌ Не нашёл книгу в Викитеке.");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл книгу:\n${bookTitle}`);
    await sendMessage(chatId, "📥 Загружаю текст...");

    const fullText = await getBookText(bookTitle);

    console.log("FULL TEXT LENGTH:", fullText.length);

    if (fullText.length < 500) {
      await sendMessage(chatId, "❌ Не удалось получить текст книги.");
      return;
    }

    const parts = splitText(fullText, 1800).slice(0, 10);

    await sendMessage(chatId, "🎬 Начинаю чтение как сериал...");

    for (let i = 0; i < parts.length; i++) {
      await sendMessage(chatId, `🎙 Часть ${i + 1}/${parts.length}`);

      const audio = await elevenLabsTTS(parts[i]);

      await sendAudio(
        chatId,
        audio,
        `part_${i + 1}.mp3`,
        `📖 ${bookTitle}\nЧасть ${i + 1}`
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
    "гарри поттер",
    "harry potter",
    "роулинг",
    "rowling",
    "стивен кинг",
    "stephen king",
    "пелевин",
    "акунин",
    "лукьяненко",
    "метро 2033"
  ].some(x => t.includes(x));
}

async function findBookTitle(query) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "query",
      list: "search",
      srsearch: query,
      format: "json",
      srlimit: 10
    },
    headers: HEADERS,
    timeout: 15000
  });

  const results = res.data.query?.search || [];

  console.log("SEARCH RESULTS:", results.map(r => r.title));

  const good = results.find(r =>
    !r.title.includes("Автор:") &&
    !r.title.includes("Категория:") &&
    !r.title.includes("Обсуждение:") &&
    !r.title.includes("Викитека:")
  );

  return good ? good.title : null;
}

async function getBookText(title) {
  let text = await getPageExtract(title);

  if (text.length > 1500) {
    return cleanText(text);
  }

  console.log("MAIN PAGE SHORT, TRY SUBPAGES");

  const res = await axios.get(WIKI_API, {
    params: {
      action: "query",
      list: "allpages",
      apprefix: title + "/",
      apnamespace: 0,
      aplimit: 50,
      format: "json"
    },
    headers: HEADERS,
    timeout: 20000
  });

  const pages = res.data.query?.allpages || [];

  console.log("SUBPAGES:", pages.map(p => p.title));

  let full = "";

  for (const p of pages) {
    const part = await getPageExtract(p.title);
    full += "\n\n" + part;

    if (full.length > 20000) break;
  }

  return cleanText(full || text);
}

async function getPageExtract(title) {
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
  const page = Object.values(pages)[0];

  const extract = page?.extract || "";

  console.log("EXTRACT:", title, extract.length);

  return extract;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/↑/g, "")
    .replace(/См. также[\s\S]*$/i, "")
    .replace(/Примечания[\s\S]*$/i, "")
    .replace(/Источники[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + " " + s).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
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
