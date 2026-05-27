const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; WeeklyLiveTool/3.0)" },
});

const BATCH_SIZE = 50;

async function scoreArticlesBatch(articles, apiKey) {
  if (!apiKey || articles.length === 0) return [];

  const client = new Anthropic({ apiKey });
  const numbered = articles.map((a, i) => `${i + 1}. ${a.headline}`).join("\n");

  const prompt = `You are a content curator for NTT Docomo's weekly US Technology Livestream from Silicon Valley. The show covers: AI (hardware & software), SaaS software, Mobility, Sustainability, Electrification, and Telecom.

Score the relevance of each headline to this livestream (0 = irrelevant to these topics, 100 = perfectly on-topic):

${numbered}

Return ONLY a JSON array, one object per article, in this exact shape:
[{"num":1,"score":75,"breakdown":{"AI":80,"SaaS":20,"Mobility":10,"Sustainability":40,"Electrification":30,"Telecom":60},"reason":"brief one-sentence reason"}, ...]`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

async function insertFromFeed(source) {
  const feed = await parser.parseURL(source.url);
  const insertArticle = db.prepare(`
    INSERT OR IGNORE INTO articles (url, headline, article_date, source, rss_source_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const newArticles = [];
  for (const item of feed.items || []) {
    if (!item.link) continue;
    const date = item.pubDate
      ? new Date(item.pubDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const r = insertArticle.run(item.link, item.title || item.link, date, source.name, source.id);
    if (r.changes > 0) {
      newArticles.push({ id: r.lastInsertRowid, headline: item.title || item.link });
    }
  }

  db.prepare("UPDATE rss_sources SET last_fetched_at = datetime('now') WHERE id = ?").run(source.id);
  return newArticles;
}

async function translateHeadlinesBatch(articles, apiKey) {
  if (!apiKey || articles.length === 0) return;
  const client = new Anthropic({ apiKey });
  const numbered = articles.map((a, i) => `${i + 1}. ${a.headline}`).join("\n");
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: `Translate to Japanese. Return only numbered translations:\n\n${numbered}` }],
  });
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const update = db.prepare("UPDATE articles SET headline_jp = ? WHERE id = ?");
  text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^\d+[\.\)]\s*(.+)/);
    if (m && i < articles.length) update.run(m[1].trim(), articles[i].id);
  });
}

async function fetchAllSources(apiKey, sourceId = null, sessionId = null) {
  const sources = sourceId
    ? db.prepare("SELECT * FROM rss_sources WHERE id = ?").all(parseInt(sourceId))
    : db.prepare("SELECT * FROM rss_sources WHERE enabled = 1").all();

  const results = [];
  const allNewArticles = [];

  for (const source of sources) {
    try {
      const newArticles = await insertFromFeed(source);
      results.push({ id: source.id, name: source.name, inserted: newArticles.length, error: null });
      allNewArticles.push(...newArticles);
    } catch (err) {
      results.push({ id: source.id, name: source.name, inserted: 0, error: err.message });
    }
  }

  if (apiKey && allNewArticles.length > 0) {
    const updateScore = db.prepare(`
      UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ?
      WHERE id = ?
    `);
    for (let i = 0; i < allNewArticles.length; i += BATCH_SIZE) {
      const batch = allNewArticles.slice(i, i + BATCH_SIZE);
      try {
        const scores = await scoreArticlesBatch(batch, apiKey);
        for (const s of scores) {
          const article = batch[s.num - 1];
          if (article) updateScore.run(s.score, JSON.stringify(s.breakdown), s.reason, article.id);
        }
      } catch (e) {
        console.warn("Batch scoring failed:", e.message);
      }
    }
  }

  if (apiKey && allNewArticles.length > 0) {
    for (let i = 0; i < allNewArticles.length; i += BATCH_SIZE) {
      const batch = allNewArticles.slice(i, i + BATCH_SIZE);
      try {
        await translateHeadlinesBatch(batch, apiKey);
      } catch (e) {
        console.warn("Batch translation failed:", e.message);
      }
    }
  }

  if (sessionId && allNewArticles.length > 0) {
    const assign = db.prepare("UPDATE articles SET session_id = ? WHERE id = ?");
    for (const a of allNewArticles) assign.run(sessionId, a.id);
  }

  return { results, totalInserted: allNewArticles.length };
}

async function scoreUnscoredArticles(apiKey) {
  const unscored = db.prepare("SELECT id, headline FROM articles WHERE relevance_score IS NULL").all();
  if (unscored.length === 0) return 0;

  const updateScore = db.prepare(`
    UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ?
    WHERE id = ?
  `);

  let scored = 0;
  for (let i = 0; i < unscored.length; i += BATCH_SIZE) {
    const batch = unscored.slice(i, i + BATCH_SIZE);
    try {
      const scores = await scoreArticlesBatch(batch, apiKey);
      for (const s of scores) {
        const article = batch[s.num - 1];
        if (article) {
          updateScore.run(s.score, JSON.stringify(s.breakdown), s.reason, article.id);
          scored++;
        }
      }
    } catch (e) {
      console.warn("Score batch failed:", e.message);
    }
  }
  return scored;
}

module.exports = { fetchAllSources, scoreArticlesBatch, scoreUnscoredArticles };
