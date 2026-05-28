const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const http = require("http");
const PptxGenJS = require("pptxgenjs");
const db = require("./db");
const { fetchAllSources, scoreArticlesBatch, scoreUnscoredArticles } = require("./rss");

const app = express();
const PORT = 3002;

app.use(cors({
  origin: (origin, cb) => {
    const ok = !origin || /^http:\/\/localhost:(3000|5173)$/.test(origin);
    cb(null, ok ? true : false);
  },
}));
app.use(express.json({ limit: "2mb" }));

// ── URL fetcher for manual article submission ─────────────────────────────────
function fetchUrl(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("Too many redirects"));
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
      },
      timeout: 15000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchUrl(next, hops + 1).then(resolve).catch(reject);
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 800000) req.destroy(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&nbsp;/g, " ");
}

function extractMeta(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{3,})["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']{3,})["'][^>]+property=["']og:title["']/i)?.[1];
  const twitterTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{3,})["']/i)?.[1];
  const titleTag = html.match(/<title[^>]*>([^<]{3,})<\/title>/i)?.[1];
  const headline = decodeHtml((ogTitle || twitterTitle || titleTag || "").trim());

  const dateMeta =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i)?.[1] ||
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1] ||
    html.match(/datetime=["']([^"']+)["']/i)?.[1];

  let article_date = new Date().toISOString().slice(0, 10);
  if (dateMeta) {
    const d = new Date(dateMeta);
    if (!isNaN(d)) article_date = d.toISOString().slice(0, 10);
  }

  let bodyText = "";
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    try {
      const json = JSON.stringify(JSON.parse(nextData[1]));
      const paras = [];
      for (const m of json.matchAll(/"(?:body|content|text|description)":\s*"([^"]{80,})"/g)) {
        const t = decodeHtml(m[1].replace(/\\n/g, " ").replace(/\\\"/g, '"').replace(/<[^>]+>/g, " "));
        if (t.length > 80) paras.push(t);
      }
      if (paras.length > 0) bodyText = paras.join(" ").replace(/\s+/g, " ").trim().slice(0, 12000);
    } catch {}
  }

  if (!bodyText) {
    for (const block of (html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [])) {
      try {
        const ld = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi, ""));
        const body = ld.articleBody || ld.description || (Array.isArray(ld["@graph"]) && ld["@graph"].find((n) => n.articleBody)?.articleBody);
        if (body && body.length > 100) { bodyText = decodeHtml(body).replace(/\s+/g, " ").trim().slice(0, 12000); break; }
      } catch {}
    }
  }

  if (!bodyText) {
    bodyText = decodeHtml(
      html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000)
    );
  }

  return { headline, article_date, bodyText };
}

function parseArticle(a) {
  if (!a) return null;
  return {
    ...a,
    tags: a.tags ? JSON.parse(a.tags) : [],
    relevance_breakdown: a.relevance_breakdown ? JSON.parse(a.relevance_breakdown) : null,
  };
}

// ── Articles ──────────────────────────────────────────────────────────────────

app.get("/api/articles", (req, res) => {
  const { session_id, unassigned, source, min_score } = req.query;
  let q = "SELECT * FROM articles WHERE 1=1";
  const params = [];
  if (session_id) { q += " AND session_id = ?"; params.push(parseInt(session_id)); }
  if (unassigned === "true") { q += " AND session_id IS NULL"; }
  if (source) { q += " AND source = ?"; params.push(source); }
  if (min_score) { q += " AND relevance_score >= ?"; params.push(parseInt(min_score)); }
  q += " ORDER BY article_date DESC, source ASC, created_at DESC";
  res.json(db.prepare(q).all(...params).map(parseArticle));
});

app.post("/api/articles", async (req, res) => {
  const { url, notes } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const existing = db.prepare("SELECT * FROM articles WHERE url = ?").get(url);
  if (existing) return res.status(409).json({ error: "duplicate", article: parseArticle(existing) });

  let headline = url;
  let article_date = new Date().toISOString().slice(0, 10);
  try {
    const html = await fetchUrl(url);
    const meta = extractMeta(html);
    if (meta.headline) headline = meta.headline;
    article_date = meta.article_date;
  } catch (e) {
    console.warn("Meta fetch failed:", e.message);
  }

  const r = db.prepare(
    "INSERT INTO articles (url, headline, notes, article_date, source) VALUES (?, ?, ?, ?, 'Manual')"
  ).run(url, headline, notes || "", article_date);

  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    try {
      const scores = await scoreArticlesBatch([{ id: r.lastInsertRowid, headline }], apiKey);
      if (scores.length > 0) {
        db.prepare("UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ? WHERE id = ?")
          .run(scores[0].score, JSON.stringify(scores[0].breakdown), scores[0].reason, r.lastInsertRowid);
      }
    } catch {}
  }

  res.status(201).json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(r.lastInsertRowid)));
});

app.put("/api/articles/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { url, headline, notes } = req.body;
  if (!db.prepare("SELECT id FROM articles WHERE id = ?").get(id)) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE articles SET url = ?, headline = ?, notes = ? WHERE id = ?").run(url, headline, notes || "", id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.put("/api/articles/:id/headline-jp", (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare("SELECT id FROM articles WHERE id = ?").get(id)) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE articles SET headline_jp = ? WHERE id = ?").run(req.body.headline_jp || "", id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.put("/api/articles/:id/tags", (req, res) => {
  const id = parseInt(req.params.id);
  const { tags } = req.body;
  if (!db.prepare("SELECT id FROM articles WHERE id = ?").get(id)) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE articles SET tags = ? WHERE id = ?").run(JSON.stringify(Array.isArray(tags) ? tags : []), id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.delete("/api/articles/:id", (req, res) => {
  db.prepare("DELETE FROM articles WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post("/api/articles/:id/summary", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return res.status(404).json({ error: "Not found" });
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
    const bodyText = (req.body?.articleText || "").trim();
    const client = new Anthropic({ apiKey });
    const PRESET_TAGS = ["AdTech","AI","Enterprise","Mobility","Robotics","Semiconductors","Streaming","Social Media","Sustainability","Telecom","Electrification","SaaS"];

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are a research assistant for a Japanese telecom company's Silicon Valley team producing a weekly US Tech & News livestream.

Headline: "${article.headline}"
${article.notes ? `Reporter notes: ${article.notes}\n` : ""}Article text:
${bodyText || "(Article text unavailable — use the headline only.)"}

Produce your response in exactly this format:

BULLETS:
- <bullet 1>
- <bullet 2>
- <bullet 3>
- <bullet 4>
- <bullet 5 (optional)>

TAGS: <comma-separated tags>

Rules for BULLETS (4-5 total, each a clear sentence): core news, why it matters, telecom/AI/enterprise relevance, key companies/figures involved.
Rules for TAGS: 1-3 from this preset list (or a short custom tag): ${PRESET_TAGS.join(", ")}`,
      }],
    });

    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const bulletsBlock = text.match(/BULLETS:\s*([\s\S]*?)(?=\nTAGS:|$)/i)?.[1] || text;
    const bullets = bulletsBlock.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
    const tagsMatch = text.match(/TAGS:\s*(.+)/i);
    const tags = tagsMatch ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean) : [];

    db.prepare("UPDATE articles SET summary = ?, tags = ? WHERE id = ?")
      .run(JSON.stringify(bullets.length ? bullets : [text]), JSON.stringify(tags), id);
    res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/articles/:id/summary", (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE articles SET summary = NULL WHERE id = ?").run(id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.post("/api/articles/:id/score", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return res.status(404).json({ error: "Not found" });
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
    const scores = await scoreArticlesBatch([{ id, headline: article.headline }], apiKey);
    if (scores.length > 0) {
      db.prepare("UPDATE articles SET relevance_score = ?, relevance_breakdown = ?, relevance_reason = ? WHERE id = ?")
        .run(scores[0].score, JSON.stringify(scores[0].breakdown), scores[0].reason, id);
    }
    res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/articles/:id/star", (req, res) => {
  const id = parseInt(req.params.id);
  const article = db.prepare("SELECT is_starred FROM articles WHERE id = ?").get(id);
  if (!article) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE articles SET is_starred = ? WHERE id = ?").run(article.is_starred ? 0 : 1, id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.put("/api/articles/:id/read", (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE articles SET is_read = 1 WHERE id = ?").run(id);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(id)));
});

app.post("/api/articles/score-unscored", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
    const scored = await scoreUnscoredArticles(apiKey);
    res.json({ scored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/articles/unscored-count", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM articles WHERE relevance_score IS NULL").get().n;
  res.json({ count });
});

app.post("/api/translate-headlines", async (req, res) => {
  try {
    const { headlines } = req.body;
    if (!Array.isArray(headlines) || headlines.length === 0)
      return res.status(400).json({ error: "headlines array is required" });
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
    const client = new Anthropic({ apiKey });
    const numbered = headlines.map((h, i) => `${i + 1}. ${h.headline}`).join("\n");
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: `Translate to Japanese. Return only numbered translations:\n\n${numbered}` }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const translations = {};
    text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
      const m = line.match(/^\d+[\.\)]\s*(.+)/);
      if (m && i < headlines.length) translations[headlines[i].id] = m[1].trim();
    });
    const update = db.prepare("UPDATE articles SET headline_jp = ? WHERE id = ?");
    Object.entries(translations).forEach(([id, jp]) => update.run(jp, parseInt(id)));
    res.json(translations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

app.get("/api/sessions", (req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions ORDER BY session_index DESC").all();
  const counts = db.prepare("SELECT session_id, COUNT(*) as n FROM articles WHERE session_id IS NOT NULL GROUP BY session_id").all();
  const countMap = Object.fromEntries(counts.map((c) => [c.session_id, c.n]));
  res.json(sessions.map((s) => ({ ...s, article_count: countMap[s.id] || 0 })));
});

app.post("/api/sessions", (req, res) => {
  const { session_index, title, from_date, to_date } = req.body;
  if (session_index === undefined || !from_date || !to_date)
    return res.status(400).json({ error: "session_index, from_date, to_date are required" });
  const r = db.prepare("INSERT INTO sessions (session_index, title, from_date, to_date) VALUES (?, ?, ?, ?)")
    .run(parseInt(session_index), title || "", from_date, to_date);
  res.status(201).json(db.prepare("SELECT * FROM sessions WHERE id = ?").get(r.lastInsertRowid));
});

app.put("/api/sessions/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { session_index, title, from_date, to_date } = req.body;
  if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE sessions SET session_index = ?, title = ?, from_date = ?, to_date = ? WHERE id = ?")
    .run(parseInt(session_index), title || "", from_date, to_date, id);
  res.json(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id));
});

app.delete("/api/sessions/:id", (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE articles SET session_id = NULL WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.put("/api/sessions/:sessionId/articles/:articleId", (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  const articleId = parseInt(req.params.articleId);
  if (!db.prepare("SELECT id FROM articles WHERE id = ?").get(articleId))
    return res.status(404).json({ error: "Article not found" });
  db.prepare("UPDATE articles SET session_id = ? WHERE id = ?").run(sessionId, articleId);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(articleId)));
});

app.delete("/api/sessions/:sessionId/articles/:articleId", (req, res) => {
  const articleId = parseInt(req.params.articleId);
  db.prepare("UPDATE articles SET session_id = NULL WHERE id = ?").run(articleId);
  res.json(parseArticle(db.prepare("SELECT * FROM articles WHERE id = ?").get(articleId)));
});

app.post("/api/sessions/:id/export-pptx", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const sessionArticles = db.prepare(
      "SELECT * FROM articles WHERE session_id = ? AND is_starred = 1 ORDER BY article_date DESC, headline ASC"
    ).all(sessionId);

    const headlineMap = Object.fromEntries(sessionArticles.map((a) => [a.id, a.headline_jp || ""]));
    const needsTranslation = sessionArticles.filter((a) => !a.headline_jp);
    if (needsTranslation.length > 0) {
      try {
        const client = new Anthropic({ apiKey });
        const numbered = needsTranslation.map((a, i) => `${i + 1}. ${a.headline}`).join("\n");
        const msg = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{ role: "user", content: `Translate to Japanese. Return only numbered translations:\n\n${numbered}` }],
        });
        msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
          .split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
            const m = line.match(/^\d+[\.\)]\s*(.+)/);
            if (m && i < needsTranslation.length) headlineMap[needsTranslation[i].id] = m[1].trim();
          });
      } catch {}
    }

    const topArticles = [...sessionArticles]
      .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
      .slice(0, 10);

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    const COLS = ["Date", "Headline", "Japanese Headline", "URL"];
    const COL_W = [1.1, 4.2, 5.5, 0.8];
    const PER_SLIDE = 10;

    const buildSlide = (title, titleColor, headerColor, articles) => {
      const slide = pptx.addSlide();
      slide.addText(title, { x: 0.25, y: 0.1, w: 12.8, h: 0.35, fontSize: 14, bold: true, color: titleColor });
      const rows = [
        COLS.map((h) => ({ text: h, options: { bold: true, fill: { color: headerColor }, color: "FFFFFF", fontSize: 14, align: "center", valign: "middle" } })),
        ...articles.map((a, i) => {
          const dateStr = a.article_date
            ? new Date(a.article_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : "";
          const fill = i % 2 === 0 ? "F5F5F5" : "FFFFFF";
          return [
            { text: dateStr, options: { fontSize: 14, fill: { color: fill }, valign: "middle", wrap: true } },
            { text: a.headline || "", options: { fontSize: 14, fill: { color: fill }, valign: "middle", wrap: true } },
            { text: headlineMap[a.id] || "", options: { fontSize: 12, fill: { color: fill }, valign: "middle", wrap: true } },
            { text: "Link", options: { fontSize: 14, fill: { color: fill }, valign: "middle", align: "center", hyperlink: { url: a.url } } },
          ];
        }),
      ];
      slide.addTable(rows, {
        x: 0.25, y: 0.5, w: COL_W.reduce((s, v) => s + v, 0), h: 3.3,
        colW: COL_W, border: { type: "solid", pt: 0.5, color: "CCCCCC" },
      });
    };

    if (topArticles.length > 0) {
      const pages = Math.ceil(topArticles.length / PER_SLIDE);
      for (let p = 0; p < pages; p++) {
        const label = pages > 1 ? ` (${p + 1}/${pages})` : "";
        buildSlide(`Top Articles — Session #${session.session_index}${label}`, "7A3B00", "B8660B",
          topArticles.slice(p * PER_SLIDE, (p + 1) * PER_SLIDE));
      }
    }
    const allPages = Math.max(1, Math.ceil(sessionArticles.length / PER_SLIDE));
    for (let p = 0; p < allPages; p++) {
      const label = allPages > 1 ? ` (${p + 1}/${allPages})` : "";
      buildSlide(`Long List — Session #${session.session_index}${label}`, "1a1a2e", "1a1a2e",
        sessionArticles.slice(p * PER_SLIDE, (p + 1) * PER_SLIDE));
    }

    const dateStr = session.to_date.replace(/-/g, "");
    const buffer = await pptx.write("nodebuffer");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="long-list-session${session.session_index}-${dateStr}.pptx"`);
    res.send(buffer);
  } catch (err) {
    console.error("PPTX error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── RSS Sources ───────────────────────────────────────────────────────────────

app.get("/api/rss/sources", (req, res) => {
  const sources = db.prepare("SELECT * FROM rss_sources ORDER BY name ASC").all();
  const counts = db.prepare("SELECT rss_source_id, COUNT(*) as n FROM articles WHERE rss_source_id IS NOT NULL GROUP BY rss_source_id").all();
  const countMap = Object.fromEntries(counts.map((c) => [c.rss_source_id, c.n]));
  res.json(sources.map((s) => ({ ...s, article_count: countMap[s.id] || 0 })));
});

app.post("/api/rss/sources", (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name and url are required" });
  try {
    const r = db.prepare("INSERT INTO rss_sources (name, url) VALUES (?, ?)").run(name, url);
    res.status(201).json(db.prepare("SELECT * FROM rss_sources WHERE id = ?").get(r.lastInsertRowid));
  } catch {
    res.status(409).json({ error: "URL already exists" });
  }
});

app.put("/api/rss/sources/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { name, url, enabled } = req.body;
  if (!db.prepare("SELECT id FROM rss_sources WHERE id = ?").get(id)) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE rss_sources SET name = ?, url = ?, enabled = ? WHERE id = ?").run(name, url, enabled ? 1 : 0, id);
  res.json(db.prepare("SELECT * FROM rss_sources WHERE id = ?").get(id));
});

app.delete("/api/rss/sources/:id", (req, res) => {
  db.prepare("DELETE FROM rss_sources WHERE id = ?").run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post("/api/rss/fetch", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    const { source_id, session_id } = req.body || {};
    const result = await fetchAllSources(apiKey, source_id || null, session_id || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST export articles to Slack as sequential messages
app.post("/api/slack/export", async (req, res) => {
  const { webhookUrl, messages } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: "webhookUrl is required" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages array is required" });

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return res.status(400).json({ error: "Invalid webhook URL — paste just the https://hooks.slack.com/... URL." });
  }

  const lib = parsed.protocol === "https:" ? https : http;

  function postMessage(text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ text });
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      };
      const slackReq = lib.request(options, (proxyRes) => {
        let data = "";
        proxyRes.on("data", (chunk) => { data += chunk; });
        proxyRes.on("end", () => {
          if (proxyRes.statusCode === 200) resolve();
          else reject(new Error(`Slack returned ${proxyRes.statusCode}: ${data}`));
        });
      });
      slackReq.on("error", reject);
      slackReq.write(payload);
      slackReq.end();
    });
  }

  try {
    for (let i = 0; i < messages.length; i++) {
      await postMessage(messages[i]);
      if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 1000));
    }
    res.json({ ok: true, sent: messages.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✓ WeeklyLiveTool V3 → http://localhost:${PORT}`));
