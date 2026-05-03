console.log("NETFLIX READER VERSION STARTED");

const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const sessions = new Map();

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), ms)
  );
}

async function sendText(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendAction(chatId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "upload_audio" }),
  });
}

async function sendAudio(chatId, buffer, filename, caption = "") {
  const form = new FormData();

  form.append("chat_id", chatId);
  form.append("audio", buffer, {
    filename,
    contentType: "audio/mpeg",
  });

  if (caption) form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });

  if (!res.ok) throw new Error(await res.text());
}

function cleanHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanVoiceText(text) {
  return text
    .replace(/Материал из Викитеки|Викитека|Содержание|Править|править код/gi, "")
    .replace(/Перейти к навигации|Перейти к поиску|Источник|См. также/gi, "")
    .replace(/Эта страница в последний раз была отредактирована[\s\S]*/gi, "")
    .replace(/[^\p{L}\p{N}\s.,!?;:—\-«»"()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addNarrationStyle(text) {
  let t = cleanVoiceText(text);

  t = t
    .replace(/([.!?])\s+/g, "$1...\n\n")
    .replace(/,\s+/g, ", ")
    .replace(/—/g, " — ")
    .replace(/«/g, "«")
    .replace(/»/g, "»")
    .replace(/\s+/g, " ")
    .trim();

  return `Читает спокойный тёплый мужской голос. Медленно. Атмосферно. С паузами. Без спешки.

${t}`;
}

function splitParts(text) {
  const clean = cleanVoiceText(text);
  const parts = [];

  let first = clean.slice(0, 500);
  let cut = Math.max(
    first.lastIndexOf("."),
    first.lastIndexOf("!"),
    first.lastIndexOf("?")
  );

  if (cut > 180) first = first.slice(0, cut + 1);
  parts.push(first.trim());

  let rest = clean.slice(first.length).trim();

  while (rest.length > 0 && parts.length < 12) {
    let part = rest.slice(0, 2100);

    cut = Math.max(
      part.lastIndexOf("."),
      part.lastIndexOf("!"),
      part.lastIndexOf("?")
    );

    if (cut > 850) part = part.slice(0, cut + 1);

    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }

  return parts.filter((p) => p.length > 80);
}

async function makeVoice(text) {
  const finalText = addNarrationStyle(text);

  const res = await Promise.race([
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: finalText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.8,
          style: 0.48,
          use_speaker_boost: true,
        },
      }),
    }),
    timeout(45000),
  ]);

  if (!res.ok) throw new Error(await res.text());
  return res.buffer();
}

function badTitle(title) {
  const t = title.toLowerCase();

  return (
    t.includes("эпилог") ||
    t.includes("обсуждение") ||
    t.includes("категория") ||
    t.includes("автор:") ||
    t.includes("комментар") ||
    t.includes("письмо")
  );
}

function linkPriority(title) {
  const t = title.toLowerCase();

  if (badTitle(t)) return 999;
  if (t.includes("часть первая")) return 1;
  if (t.includes("часть 1")) return 1;
  if (t.includes("глава i")) return 2;
  if (t.endsWith("/i")) return 2;
  if (t.endsWith("/1")) return 3;
  if (t.includes("часть вторая")) return 50;
  if (t.includes("часть 2")) return 50;

  return 10;
}

async function wikiSearch(query) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=12&srsearch=" +
    encodeURIComponent(query);

  const data = await Promise.race([
    fetch(url).then((r) => r.json()),
    timeout(12000),
  ]);

  return data?.query?.search?.map((x) => x.title).filter((x) => !badTitle(x)) || [];
}

async function getWikiPage(title) {
  const url =
    "https://ru.wikisource.org/w/api.php?action=parse&format=json&prop=text|links&page=" +
    encodeURIComponent(title);

  const data = await Promise.race([
    fetch(url).then((r) => r.json()),
    timeout(12000),
  ]);

  if (!data.parse) return null;

  return {
    title: data.parse.title,
    text: cleanHtml(data.parse.text?.["*"] || ""),
    links: data.parse.links || [],
  };
}

async function findBookStart(query) {
  const titles = await wikiSearch(query);
  if (!titles.length) return null;

  for (const title of titles.slice(0, 6)) {
    const page = await getWikiPage(title);
    if (!page) continue;

    const childTitles = page.links
      .map((l) => l["*"])
      .filter(Boolean)
      .filter((x) => x.startsWith(page.title + "/"))
      .filter((x) => !badTitle(x))
      .sort((a, b) => linkPriority(a) - linkPriority(b) || a.localeCompare(b, "ru"))
      .slice(0, 8);

    for (const childTitle of childTitles) {
      const child = await getWikiPage(childTitle);

      if (child && child.text.length > 1200 && !badTitle(child.title)) {
        return {
          title: child.title,
          text: child.text,
        };
      }
    }

    if (page.text.length > 2500 && !badTitle(page.title)) {
      return {
        title: page.title,
        text: page.text,
      };
    }
  }

  return null;
}

async function keepAlive(chatId) {
  const id = setInterval(() => {
    sendAction(chatId).catch(() => {});
  }, 4000);

  return () => clearInterval(id);
}

async function readBook(chatId, query) {
  sessions.set(chatId, { active: true });

  await sendText(
    chatId,
    "📖 Принял. Ищу начало книги. Сейчас отправлю короткое вступление, затем начну чтение."
  );

  const stopAlive = await keepAlive(chatId);

  try {
    const introAudio = await makeVoice(
      `Сегодня мы начинаем чтение книги: ${query}. Устройся поудобнее. Сейчас начнётся первая часть.`
    );

    await sendAudio(chatId, introAudio, "intro.mp3", "Вступление");
  } catch (e) {
    console.log("INTRO ERROR:", e.message);
  }

  const book = await findBookStart(query);

  if (!book) {
    stopAlive();
    sessions.delete(chatId);

    await sendText(chatId, "Не нашёл текст. Попробуй точнее: название плюс автор.");
    return;
  }

  const parts = splitParts(book.text);

  await sendText(
    chatId,
    `Нашёл: ${book.title}\n\nНачинаю чтение.\nОстановить: /stop`
  );

  for (let i = 0; i < parts.length; i++) {
    const session = sessions.get(chatId);

    if (!session || !session.active) {
      stopAlive();
      await sendText(chatId, "Чтение остановлено.");
      return;
    }

    const audio = await makeVoice(parts[i]);

    await sendAudio(chatId, audio, `part_${i + 1}.mp3`, `Часть ${i + 1}`);
  }

  stopAlive();
  sessions.delete(chatId);

  await sendText(chatId, "Глава закончилась.");
}

app.get("/", (req, res) => {
  res.send("Netflix style reader is running");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendText(
        chatId,
        "Напиши название книги и автора. Например: Преступление и наказание Достоевский"
      );
      return;
    }

    if (text === "/stop") {
      const session = sessions.get(chatId);
      if (session) session.active = false;

      await sendText(chatId, "Останавливаю чтение.");
      return;
    }

    if (sessions.get(chatId)?.active) {
      await sendText(chatId, "Уже читаю. Напиши /stop.");
      return;
    }

    readBook(chatId, text).catch(async (err) => {
      console.log("READ ERROR:", err.message);
      sessions.delete(chatId);

      await sendText(chatId, "Ошибка чтения:\n" + err.message);
    });
  } catch (err) {
    console.log("WEBHOOK ERROR:", err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("NETFLIX READER VERSION STARTED");
});
console.log("FORCE REDEPLOY 1");
