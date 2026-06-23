import { useState, useEffect, useCallback } from "react";
import {
  getArticles, createArticle, deleteArticle, assignArticle, unassignArticle,
  generateSummary, clearSummary, scoreArticle, scoreUnscored, setTags, translateHeadlines, exportToSlack,
  markArticleRead,
  toggleArticleStar,
} from "../api";

const PRESET_TAGS = ["AdTech","AI","Electrification","Enterprise","Mobility","Robotics","SaaS","Semiconductors","Social Media","Streaming","Sustainability","Telecom"];
const TOPICS = ["AI","SaaS","Mobility","Sustainability","Electrification","Telecom"];
const PAGE_SIZE = 30;

function ScoreBadge({ score }) {
  if (score == null) return <span className="score-badge score-gray" title="Not yet scored">--</span>;
  const cls = score >= 70 ? "score-green" : score >= 40 ? "score-yellow" : "score-red";
  return <span className={`score-badge ${cls}`} title={`Relevance: ${score}/100`}>{score}</span>;
}

function Breakdown({ breakdown, reason }) {
  if (!breakdown) return null;
  return (
    <div>
      <div className="breakdown-row">
        {TOPICS.map((t) => (
          <span key={t} className="breakdown-item">
            <span>{t}</span>
            <span className="breakdown-score">{breakdown[t] ?? "--"}</span>
          </span>
        ))}
      </div>
      {reason && <div className="reason-text">{reason}</div>}
    </div>
  );
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    ["script","style","nav","header","footer","aside","iframe","noscript"].forEach(
      (tag) => doc.querySelectorAll(tag).forEach((el) => el.remove())
    );
    const content = doc.querySelector("article") || doc.querySelector('[role="main"]') || doc.querySelector("main") || doc.body;
    return (content?.innerText || content?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  } catch {
    return "";
  }
}

function ArticleRow({ article, sessions, apiKey, onUpdate, onDelete, showJapanese }) {
  const [expanded, setExpanded] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [scoreLoading, setScoreLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const flash = (text, type = "success") => { setMsg({ text, type }); setTimeout(() => setMsg(null), 3000); };

  const handleSummary = async () => {
    if (article.summary) {
      setExpanded((v) => !v);
      return;
    }
    if (!apiKey) { flash("API key required.", "error"); return; }
    setSummaryLoading(true);
    try {
      const text = await fetchArticleText(article.url);
      const updated = await generateSummary(article.id, apiKey, text);
      onUpdate(updated);
      setExpanded(true);
    } catch (e) { flash(e.message, "error"); }
    finally { setSummaryLoading(false); }
  };

  const handleClearSummary = async (e) => {
    e.stopPropagation();
    const updated = await clearSummary(article.id);
    onUpdate(updated);
    setExpanded(false);
  };

  const handleScore = async () => {
    if (!apiKey) { flash("API key required.", "error"); return; }
    setScoreLoading(true);
    try {
      const updated = await scoreArticle(article.id, apiKey);
      onUpdate(updated);
    } catch (e) { flash(e.message, "error"); }
    finally { setScoreLoading(false); }
  };

  const handleAssign = async (e) => {
    const sessionId = parseInt(e.target.value);
    if (!sessionId) {
      if (article.session_id) await unassignArticle(article.session_id, article.id);
    } else {
      await assignArticle(sessionId, article.id);
    }
    onUpdate({ ...article, session_id: sessionId || null });
  };

  const summary = article.summary ? JSON.parse(article.summary) : null;
  const currentSession = sessions.find((s) => s.id === article.session_id);

  const thisYear = new Date().getFullYear();

  const dateLabel = (() => {
    if (!article.article_date) return null;
    const d = new Date(article.article_date + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      month: "short", day: "numeric",
      ...(d.getFullYear() !== thisYear ? { year: "numeric" } : {}),
    });
  })();

  const addedLabel = (() => {
    if (!article.created_at) return null;
    const d = new Date(article.created_at.replace(" ", "T") + "Z");
    if (isNaN(d)) return null;
    return d.toLocaleDateString("en-US", {
      month: "short", day: "numeric",
      ...(d.getFullYear() !== thisYear ? { year: "numeric" } : {}),
    });
  })();

  return (
    <div className={`article-row${article.is_read ? " is-read" : ""}`}>
      <div className="article-main">
        <div style={{ paddingTop: 2 }}>
          <ScoreBadge score={article.relevance_score} />
        </div>

        <div className="article-date-col">
          {addedLabel && <span className="article-date">Added {addedLabel}</span>}
          {dateLabel && <span style={{ fontSize: 11, color: "#64748b" }}>Published {dateLabel}</span>}
          <span className={`source-chip${article.source === "Manual" ? " manual" : ""}`}>{article.source || "Unknown"}</span>
        </div>

        <div className="article-meta">
          <a
            className={`article-headline${article.is_read ? " read" : ""}`}
            href={article.url}
            target="_blank"
            rel="noreferrer"
            onClick={() => { if (!article.is_read) markArticleRead(article.id).then(onUpdate); }}
          >
            {showJapanese && article.headline_jp ? article.headline_jp : (article.headline || article.url)}
          </a>
          {showJapanese && article.headline_jp && article.headline && (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{article.headline}</span>
          )}
          <div className="article-info">
            {!!article.is_read && <span className="read-chip">Read</span>}
            {currentSession && (
              <span style={{ color: "#6366f1", fontSize: 12 }}>Session #{currentSession.session_index}</span>
            )}
            {article.relevance_reason && (
              <span style={{ color: "#94a3b8", fontSize: 11, fontStyle: "italic" }}>{article.relevance_reason}</span>
            )}
          </div>
          {article.tags?.length > 0 && (
            <div className="tags-row">
              {article.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
            </div>
          )}
          {msg && <div className={`alert alert-${msg.type}`} style={{ marginTop: 6, padding: "6px 10px" }}>{msg.text}</div>}
        </div>

        <div className="article-actions">
          {summary && (
            <button className="btn btn-secondary btn-sm" onClick={handleSummary}>
              {expanded ? "Hide" : "Summary"}
            </button>
          )}

          {article.relevance_score == null && (
            <button className="btn btn-warning btn-sm" onClick={handleScore} disabled={scoreLoading}>
              {scoreLoading ? <span className="spinner" /> : "Score"}
            </button>
          )}

          <button
            className={`btn btn-sm star-btn${article.is_starred ? " starred" : ""}`}
            title={article.is_starred ? "Unstar" : "Star"}
            onClick={() => toggleArticleStar(article.id, apiKey).then(onUpdate)}
          >
            {article.is_starred ? "★" : "☆"}
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(article.id)} title="Delete article">
            <svg width="12" height="13" viewBox="0 0 12 13" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
              <path d="M1 3h10M4.5 3V2a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1M2 3l.75 7.5a.5.5 0 00.5.5h5.5a.5.5 0 00.5-.5L10 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M5 5.5v4M7 5.5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {expanded && summary && (
        <div className="summary-panel">
          <ul className="summary-bullets">
            {summary.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
          <Breakdown breakdown={article.relevance_breakdown} reason={article.relevance_reason} />
          <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={handleClearSummary}>Clear Summary</button>
          </div>
        </div>
      )}

      {expanded && !summary && article.relevance_breakdown && (
        <div className="summary-panel">
          <Breakdown breakdown={article.relevance_breakdown} reason={article.relevance_reason} />
        </div>
      )}
    </div>
  );
}

function SlackWebhookModal({ current, onClose, onSave }) {
  const [url, setUrl] = useState(current || "");
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-title">Slack Webhook URL</div>
        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 18, lineHeight: 1.6 }}>
          Paste a Slack Incoming Webhook URL to enable sharing articles to a channel.
          Stored in your browser's localStorage only.
        </p>
        <div className="form-group">
          <label className="form-label">Webhook URL</label>
          <input
            className="form-input"
            style={{ width: "100%" }}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/..."
            autoFocus
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (url.trim()) onSave(url.trim()); }} disabled={!url.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SlackExportModal({ articles, onClose, slackWebhookUrl, onNeedWebhook, onFlash }) {
  const today = new Date().toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [posting, setPosting] = useState(false);

  const matchingArticles = articles
    .filter((a) => {
      if (!a.is_starred) return false;
      if (!a.created_at) return false;
      const d = a.created_at.slice(0, 10);
      return d >= fromDate && d <= toDate;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const handleExport = async () => {
    if (!slackWebhookUrl) { onClose(); onNeedWebhook(); return; }

    const groups = {};
    for (const a of matchingArticles) {
      const d = a.created_at.slice(0, 10);
      if (!groups[d]) groups[d] = [];
      groups[d].push(a);
    }

    const messages = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([date, arts]) => [
        `*${fmtDate(date)}*`,
        ...arts.map((a) => {
          const lines = [`*${a.headline}* — <${a.url}|Link>`];
          if (a.summary) {
            try { JSON.parse(a.summary).forEach((b) => lines.push(`• ${b}`)); } catch {}
          }
          return lines.join("\n");
        }),
      ]);

    setPosting(true);
    try {
      for (let i = 0; i < messages.length; i++) {
        const result = await exportToSlack({ webhookUrl: slackWebhookUrl, message: messages[i] });
        if (result.error) throw new Error(result.error);
        if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 1000));
      }
      onFlash(`Posted ${messages.length} message${messages.length !== 1 ? "s" : ""} to Slack.`);
      onClose();
    } catch (err) {
      onFlash("Slack export failed: " + err.message, "error");
    } finally {
      setPosting(false);
    }
  };

  const noSummary = matchingArticles.filter((a) => !a.summary).length;

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-title">Export to Slack</div>
        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">From</label>
            <input className="form-input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">To</label>
            <input className="form-input" type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>
          {matchingArticles.length} starred article{matchingArticles.length !== 1 ? "s" : ""} in range
          {noSummary > 0 && <span style={{ color: "#f59e0b", marginLeft: 8 }}>{noSummary} without summary</span>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={posting}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={matchingArticles.length === 0 || posting}
            onClick={handleExport}
          >
            {posting ? <><span className="spinner" /> Posting…</> : "Post to Slack"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddArticleForm({ apiKey, onAdded }) {
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      const result = await createArticle({ url: url.trim(), notes }, apiKey);
      if (result.error === "duplicate") {
        setMsg({ text: "Article already exists.", type: "error" });
      } else if (result.error) {
        setMsg({ text: result.error, type: "error" });
      } else {
        setUrl(""); setNotes("");
        onAdded(result);
        setMsg({ text: "Article added.", type: "success" });
      }
    } catch (e) {
      setMsg({ text: e.message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ marginBottom: 12 }}>Add Article by URL</div>
      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}
      <form onSubmit={submit}>
        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <input
              className="form-input"
              style={{ width: "100%" }}
              placeholder="https://..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <input
              className="form-input"
              style={{ width: "100%" }}
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading || !url.trim()}>
            {loading ? <><span className="spinner" /> Adding…</> : "Add Article"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ArticlesTab({ apiKey, sessions }) {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ session_id: "", source: "", min_score: "" });
  const [sources, setSources] = useState([]);
  const [scoringAll, setScoringAll] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showJapanese, setShowJapanese] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(() => localStorage.getItem("wlt_slack_webhook") || "");
  const [showSlackExport, setShowSlackExport] = useState(false);
  const [showSlackWebhook, setShowSlackWebhook] = useState(false);

  const saveSlackWebhook = (url) => {
    localStorage.setItem("wlt_slack_webhook", url);
    setSlackWebhookUrl(url);
    setShowSlackWebhook(false);
    flash("Slack webhook saved.");
  };

  const flash = (text, type = "success") => { setMsg({ text, type }); setTimeout(() => setMsg(null), 5000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.session_id === "unassigned") params.unassigned = "true";
      else if (filters.session_id) params.session_id = filters.session_id;
      if (filters.source) params.source = filters.source;
      if (filters.min_score) params.min_score = filters.min_score;
      const data = await getArticles(params);
      setArticles(data);
      const uniqueSources = [...new Set(data.map((a) => a.source).filter(Boolean))].sort();
      setSources(uniqueSources);
      setPage(1);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("article-updated", (e) => {
      const updated = JSON.parse(e.data);
      setArticles((prev) => prev.map((a) => a.id === updated.id ? updated : a));
    });
    return () => es.close();
  }, []);

  const handleUpdate = (updated) => {
    setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this article?")) return;
    await deleteArticle(id);
    setArticles((prev) => prev.filter((a) => a.id !== id));
  };

  const handleAdded = (article) => {
    setArticles((prev) => [article, ...prev]);
  };

  const handleScoreAll = async () => {
    if (!apiKey) { flash("API key required.", "error"); return; }
    const unscored = articles.filter((a) => a.relevance_score == null).length;
    if (unscored === 0) { flash("All articles are already scored."); return; }
    setScoringAll(true);
    try {
      const { scored } = await scoreUnscored(apiKey);
      flash(`Scored ${scored} articles.`);
      await load();
    } catch (e) {
      flash(e.message, "error");
    } finally {
      setScoringAll(false);
    }
  };

  const handleTranslate = async () => {
    if (!apiKey) { flash("API key required.", "error"); return; }
    const untranslated = articles.filter((a) => !a.headline_jp && a.headline);
    if (untranslated.length === 0) { flash("All headlines already translated."); return; }
    setTranslating(true);
    try {
      const translations = await translateHeadlines(untranslated.map((a) => ({ id: a.id, headline: a.headline })), apiKey);
      if (translations.error) { flash(translations.error, "error"); return; }
      setArticles((prev) => prev.map((a) => translations[a.id] ? { ...a, headline_jp: translations[a.id] } : a));
      flash(`Translated ${Object.keys(translations).length} headlines.`);
    } catch (e) {
      flash(e.message, "error");
    } finally {
      setTranslating(false);
    }
  };

  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = search
    ? articles.filter((a) => (a.headline || a.url).toLowerCase().includes(search.toLowerCase()))
    : articles;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const unscoredCount = articles.filter((a) => a.relevance_score == null).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAddForm((v) => !v)}>
          {showAddForm ? "Cancel" : "+ Add Article"}
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => setShowSlackWebhook(true)}
            title={slackWebhookUrl ? "Slack webhook configured — click to update" : "Configure Slack webhook"}
          >
            <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: slackWebhookUrl ? "#22c55e" : "#f59e0b", marginRight: 5, verticalAlign: "middle" }} />
            {slackWebhookUrl ? "Slack" : "Set Slack Webhook"}
          </button>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: 12 }} onClick={() => setShowSlackExport(true)}>
            Export to Slack
          </button>
        </div>
      </div>

      {showAddForm && <AddArticleForm apiKey={apiKey} onAdded={(article) => { handleAdded(article); setShowAddForm(false); }} />}

      <div className="filter-bar">
        <div className="form-group" style={{ flex: 2, minWidth: 200 }}>
          <label className="form-label">Search</label>
          <input
            className="form-input"
            style={{ width: "100%" }}
            placeholder="Filter by headline…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Session</label>
          <select className="form-select" value={filters.session_id} onChange={(e) => setFilter("session_id", e.target.value)}>
            <option value="">All Sessions</option>
            <option value="unassigned">— Unassigned</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>#{s.session_index} ({s.to_date})</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Source</label>
          <select className="form-select" value={filters.source} onChange={(e) => setFilter("source", e.target.value)}>
            <option value="">All Sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Min Score</label>
          <input
            className="form-input"
            type="number" min="0" max="100"
            style={{ width: 80 }}
            placeholder="0"
            value={filters.min_score}
            onChange={(e) => setFilter("min_score", e.target.value)}
          />
        </div>
        <div className="form-group" style={{ justifyContent: "flex-end" }}>
          <label className="form-label">Japanese Headlines</label>
          <div className="toggle-wrap" style={{ marginTop: 2 }}>
            <button
              className={`toggle${showJapanese ? " on" : ""}`}
              type="button"
              onClick={() => setShowJapanese((v) => !v)}
            />
            <span style={{ fontSize: 12, color: "#64748b", cursor: "pointer" }} onClick={() => setShowJapanese((v) => !v)}>
              {showJapanese ? "On" : "Off"}
            </span>
          </div>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? <span className="spinner" /> : "Refresh"}
        </button>
        {showJapanese && (
          <button className="btn btn-secondary" onClick={handleTranslate} disabled={translating}>
            {translating ? <><span className="spinner" /> Translating…</> : `Translate Headlines`}
          </button>
        )}
        {unscoredCount > 0 && (
          <button className="btn btn-warning" onClick={handleScoreAll} disabled={scoringAll}>
            {scoringAll ? <><span className="spinner" /> Scoring…</> : `Score ${unscoredCount} Unscored`}
          </button>
        )}
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: "#64748b" }}>
          {filtered.length}{filtered.length !== articles.length ? ` of ${articles.length}` : ""} articles{filters.session_id || filters.source || filters.min_score || search ? " (filtered)" : ""}
        </span>
        {unscoredCount > 0 && (
          <span style={{ fontSize: 12, color: "#94a3b8" }}>{unscoredCount} unscored</span>
        )}
      </div>

      {loading && <div className="empty-state"><span className="spinner" /></div>}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          {search ? "No articles match your search." : "No articles found. Fetch RSS feeds or add articles by URL."}
        </div>
      )}

      {!loading && paged.map((article) => (
        <ArticleRow
          key={article.id}
          article={article}
          sessions={sessions}
          apiKey={apiKey}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          showJapanese={showJapanese}
        />
      ))}

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn btn-secondary btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>←</button>
          <span style={{ fontSize: 13, color: "#64748b" }}>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>→</button>
        </div>
      )}

      {showSlackExport && (
        <SlackExportModal
          articles={articles}
          onClose={() => setShowSlackExport(false)}
          slackWebhookUrl={slackWebhookUrl}
          onNeedWebhook={() => setShowSlackWebhook(true)}
          onFlash={flash}
        />
      )}
      {showSlackWebhook && (
        <SlackWebhookModal
          current={slackWebhookUrl}
          onClose={() => setShowSlackWebhook(false)}
          onSave={saveSlackWebhook}
        />
      )}
    </div>
  );
}
