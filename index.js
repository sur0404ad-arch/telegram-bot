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
    await sendMessage(chatId, "📚 Ищу главы...");

    const chapters = await findChapters(bookTitle);

    if (!chapters.length) {
      await sendMessage(chatId, "❌ Нашёл книгу, но не нашёл главы.");
      return;
    }

    const firstChapter = chapters[0];

    await sendMessage(chatId, `🎬 Начинаю как сериал:\n\n${firstChapter}`);

    const chapterText = await getPageExtract(firstChapter);
    const clean = cleanText(chapterText);

    console.log("CHAPTER TEXT LENGTH:", clean.length);

    if (clean.length < 300) {
      await sendMessage(chatId, "❌ Глава найдена, но текста мало.");
      return;
    }

    const chunks = splitText(clean, 1600).slice(0, 5);

    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(chatId, `🎙 Глава 1 — часть ${i + 1}/${chunks.length}`);

      const audio = await elevenLabsTTS(chunks[i]);

      await sendAudio(
        chatId,
        audio,
        `chapter_1_part_${i + 1}.mp3`,
        `📖 ${bookTitle}\n🎬 Глава 1\nЧасть ${i + 1}`
      );
    }

    await sendMessage(chatId, "✅ Глава 1 отправлена. Потом сделаем кнопку «Следующая глава».");

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

async function findChapters(bookTitle) {
  const res = await axios.get(WIKI_API, {
    params: {
      action: "query",
      list: "allpages",
      apprefix: bookTitle + "/",
      apnamespace: 0,
      aplimit: 100,
      format: "json"
    },
    headers: HEADERS,
    timeout: 20000
  });

  const pages = res.data.query?.allpages || [];
  let titles = pages.map(p => p.title);

  titles = titles.filter(t =>
    !t.includes("Оглавление") &&
    !t.includes("Предисловие") &&
    !t.includes("Примечания") &&
    !t.includes("Комментарии")
  );

  titles.sort((a, b) => chapterNumber(a) - chapterNumber(b));

  console.log("CHAPTERS:", titles);

  return titles;
}

function chapterNumber(title) {
  const lower = title.toLowerCase();

  const map = {
    "i": 1,
    "ii": 2,
    "iii": 3,
    "iv": 4,
    "v": 5,
    "vi": 6,
    "vii": 7,
    "viii": 8,
    "ix": 9,
    "x": 10
  };

  const roman = lower.match(/\/([ivx]+)$/i);
  if (roman && map[roman[1].toLowerCase()]) return map[roman[1].toLowerCase()];

  const num = lower.match(/(\d+)/);
  if (num) return Number(num[1]);

  return 999;
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

  return page?.extract || "";
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
    if ((current + s).length > maxLength) {
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
