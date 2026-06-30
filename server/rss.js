const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; WeeklyLiveTool/3.0)" },
  customFields: { item: ["dc:subject"] },
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
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Scoring response contained no JSON array. Preview: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(match[0]);
  } catch {
    // Malformed JSON (e.g. unescaped quotes in a reason field) — recover num+score via regex
    const recovered = [];
    for (const m of text.matchAll(/"num"\s*:\s*(\d+)[\s\S]*?"score"\s*:\s*(\d+)/g)) {
      recovered.push({ num: parseInt(m[1]), score: parseInt(m[2]), breakdown: {}, reason: "" });
    }
    if (recovered.length > 0) {
      console.warn(`Scoring JSON was malformed; recovered ${recovered.length} scores without breakdown/reason`);
      return recovered;
    }
    throw new Error(`Failed to parse scoring response at position ${text.indexOf(match[0])}. Preview: ${match[0].slice(0, 300)}`);
  }
}

function extractTechmemeSourceUrl(content) {
  if (!content) return null;
  const match = content.match(/href="(https?:\/\/[^"]+)"/i);
  return match ? match[1] : null;
}

async function insertFromFeed(source) {
  const feed = await parser.parseURL(source.url);

  const batchResult = db.prepare("INSERT INTO rss_fetch_batches (source_id) VALUES (?)").run(source.id);
  const batchId = batchResult.lastInsertRowid;

  const insertArticle = db.prepare(`
    INSERT OR IGNORE INTO articles (url, headline, article_date, source, rss_source_id, fetch_batch_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // When a primary source sees a URL already attributed to Techmeme, re-attribute it.
  const claimFromTechmeme = source.name !== "Techmeme"
    ? db.prepare("UPDATE articles SET source = ?, rss_source_id = ? WHERE url = ? AND source = 'Techmeme'")
    : null;

  const newArticles = [];
  for (const item of feed.items || []) {
    const url = source.name === "Techmeme"
      ? (extractTechmemeSourceUrl(item.content) || item.link)
      : item.link;
    if (!url) continue;
    if (url.includes("www.bloomberg.com/news/videos")) continue;
    const subjects = [].concat(item["dc:subject"] || []);
    if (subjects.includes("Coupons")) continue;
    const date = item.pubDate
      ? new Date(item.pubDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const r = insertArticle.run(url, item.title || url, date, source.name, source.id, batchId);
    if (r.changes > 0) {
      newArticles.push({ id: r.lastInsertRowid, headline: item.title || item.link });
    } else if (claimFromTechmeme) {
      claimFromTechmeme.run(source.name, source.id, url);
    }
  }

  db.prepare("UPDATE rss_fetch_batches SET article_count = ? WHERE id = ?").run(newArticles.length, batchId);
  db.prepare("UPDATE rss_sources SET last_fetched_at = datetime('now') WHERE id = ?").run(source.id);
  return { newArticles, batchId };
}

async function translateHeadlinesBatch(articles, apiKey) {
  if (!apiKey || articles.length === 0) return;
  const client = new Anthropic({ apiKey });
  const numbered = articles.map((a, i) => `${i + 1}. ${a.headline}`).join("\n");
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: `Translate to Japanese. Return only numbered translations:\n\n${numbered}` }],
  });
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const update = db.prepare("UPDATE articles SET headline_jp = ? WHERE id = ?");
  let updated = 0;
  text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^\d+[\.\)]\s*(.+)/);
    if (m && i < articles.length) { update.run(m[1].trim(), articles[i].id); updated++; }
  });
  if (updated === 0) throw new Error(`Translation response matched no numbered lines. Preview: ${text.slice(0, 300)}`);
}

async function fetchAllSources(apiKey, sourceId = null, sessionId = null) {
  const sources = sourceId
    ? db.prepare("SELECT * FROM rss_sources WHERE id = ?").all(parseInt(sourceId))
    : db.prepare("SELECT * FROM rss_sources WHERE enabled = 1").all();

  const results = [];
  const allNewArticles = [];
  const allNewArticleIds = [];
  const allBatchIds = [];

  const updateScore = db.prepare(`
    UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ?
    WHERE id = ?
  `);

  for (const source of sources) {
    const sourceResult = { id: source.id, name: source.name, inserted: 0, error: null, scoringError: null };
    try {
      const { newArticles, batchId } = await insertFromFeed(source);
      sourceResult.inserted = newArticles.length;
      allNewArticles.push(...newArticles);
      allNewArticleIds.push(...newArticles.map((a) => a.id));
      allBatchIds.push(batchId);

      if (apiKey && newArticles.length > 0) {
        for (let i = 0; i < newArticles.length; i += BATCH_SIZE) {
          const batch = newArticles.slice(i, i + BATCH_SIZE);
          try {
            const scores = await scoreArticlesBatch(batch, apiKey);
            for (const s of scores) {
              const article = batch[s.num - 1];
              if (article) updateScore.run(s.score, JSON.stringify(s.breakdown), s.reason, article.id);
            }
          } catch (e) {
            sourceResult.scoringError = e.message;
            console.warn("Batch scoring failed:", e.message);
          }
        }
      }
    } catch (err) {
      sourceResult.error = err.message;
    }
    results.push(sourceResult);
  }

  const anyScoringError = results.some((r) => r.scoringError);

  // Skip translation if scoring already failed — API is likely unavailable.
  let translationError = null;
  if (!anyScoringError && apiKey && allNewArticles.length > 0) {
    for (let i = 0; i < allNewArticles.length; i += BATCH_SIZE) {
      const batch = allNewArticles.slice(i, i + BATCH_SIZE);
      try {
        await translateHeadlinesBatch(batch, apiKey);
      } catch (e) {
        translationError = e.message;
        console.warn("Batch translation failed:", e.message);
      }
    }
  }

  // Roll back all newly inserted articles if any Claude API call failed.
  if (anyScoringError || translationError) {
    const delArticle = db.prepare("DELETE FROM articles WHERE id = ?");
    const delBatch = db.prepare("DELETE FROM rss_fetch_batches WHERE id = ?");
    for (const id of allNewArticleIds) delArticle.run(id);
    for (const id of allBatchIds) delBatch.run(id);
    for (const r of results) { if (!r.error) r.inserted = 0; }
    return { results, totalInserted: 0, translationError };
  }

  if (sessionId && allNewArticles.length > 0) {
    const assign = db.prepare("UPDATE articles SET session_id = ? WHERE id = ?");
    for (const a of allNewArticles) assign.run(sessionId, a.id);
  }

  return { results, totalInserted: allNewArticles.length, translationError: null };
}

async function scoreUnscoredArticles(apiKey) {
  const unscored = db.prepare("SELECT id, headline FROM articles WHERE relevance_score IS NULL AND is_deleted != 1").all();
  if (unscored.length === 0) return 0;

  const updateScore = db.prepare(`
    UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ?
    WHERE id = ?
  `);

  let scored = 0;
  let scoringError = null;
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
      scoringError = e.message;
      console.warn("Score batch failed:", e.message);
    }
  }
  return { scored, error: scoringError };
}

module.exports = { fetchAllSources, scoreArticlesBatch, scoreUnscoredArticles };
