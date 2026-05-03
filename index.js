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
      await sendMessage(chatId, "📚 Напиши название книги и автора.\n\nНапример:\nПреступление и наказание Достоевский");
      return;
    }

    if (isCopyrightBlocked(userText)) {
      await sendMessage(chatId, "❌ Книга защищена авторским правом.");
      return;
    }

    await sendMessage(chatId, "📖 Проверяю доступность книги (авторские права)...");
    await sendMessage(chatId, "🔎 Ищу текст в Викитеке...");

    const page = await findWikisourcePage(userText);

    if (!page) {
      await sendMessage(chatId, "❌ Не нашёл книгу в Викитеке.\n\nПопробуй точнее: название + автор.");
      return;
    }

    await sendMessage(chatId, `📖 Нашёл:\n${page.title}\n\n🎧 Готовлю озвучку...`);

    const rawText = await getWikisourceText(page.pageid);
    const cleanText = cleanBookText(rawText);

    if (!cleanText || cleanText.length < 700) {
      await sendMessage(chatId, "❌ Нашёл страницу, но там мало текста для озвучки.");
      return;
    }

    const chunks = splitText(cleanText, 1800).slice(0, 3);

    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(chatId, `🎙 Озвучиваю часть ${i + 1}/${chunks.length}...`);

      const audioBuffer = await elevenLabsTTS(narrationText(chunks[i]));

      await sendAudio(chatId, audioBuffer, `book_part_${i + 1}.mp3`, `📚 ${page.title}\nЧасть ${i + 1}`);
    }

    await sendMessage(chatId, "✅ Готово. Первые части отправлены.");

  } catch (error) {
    console.log("SERVER ERROR:", error.response?.data || error.message || error);
  }
});

function isCopyrightBlocked(text) {
  const t = text.toLowerCase();

  const blocked = [
    "гарри поттер",
    "harry potter",
    "джоан роулинг",
    "rowling",
    "j k rowling",
    "stephen king",
    "стивен кинг",
    "метро 2033",
    "лукьяненко",
    "пелевин",
    "акунин",
    "маринина"
  ];

  return blocked.some((x) => t.includes(x));
}

async function findWikisourcePage(query) {
  const response = await axios.get(WIKI_API, {
    params: {
      action: "query",
      list: "search",
      srsearch: query,
      format: "json",
      utf8: 1,
      srlimit: 10
    },
    timeout: 20000
  });

  const results = response.data.query?.search || [];

  console.log("WIKISOURCE FOUND:", results.length);

  const good = results.find((p) => {
    const title = p.title.toLowerCase();
    return (
      !title.includes("обсуждение") &&
      !title.includes("категория") &&
      !title.includes("автор:") &&
      !title.includes("викитека:")
    );
  });

  return good || null;
}

async function getWikisourceText(pageid) {
  const response = await axios.get(WIKI_API, {
    params: {
      action: "query",
      prop: "extracts",
      pageids: pageid,
      explaintext: 1,
      exsectionformat: "plain",
      format: "json",
      utf8: 1
    },
    timeout: 30000
  });

  const pages = response.data.query?.pages || {};
  const page = pages[pageid];

  return page?.extract || "";
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

function narrationText(text) {
  return cleanVoiceText(text)
    .replace(/([.!?])\s+/g, "$1...\n\n")
    .replace(/—/g, " — ")
    .trim();
}

function cleanVoiceText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
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
  const response = await axios.post(
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

  return Buffer.from(response.data);
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
