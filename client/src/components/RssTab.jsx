import { useState, useEffect, useCallback } from "react";
import { getRssSources, createRssSource, updateRssSource, deleteRssSource, fetchRss, createSession, getRssFetchBatches, getRssBatchArticles, deleteRssFetchBatch } from "../api";

function fmtDate(str) {
  if (!str) return "";
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(str) {
  if (!str) return "Never";
  const utc = str.includes("T") || str.endsWith("Z") ? str : str.replace(" ", "T") + "Z";
  return new Date(utc).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getNextFriday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const daysUntilFriday = (5 - d.getDay() + 7) % 7; // 0 if today is Friday
  d.setDate(d.getDate() + daysUntilFriday);
  return d.toISOString().slice(0, 10);
}

function getMondayOfWeek(fridayStr) {
  const d = new Date(fridayStr + "T12:00:00");
  d.setDate(d.getDate() - 4);
  return d.toISOString().slice(0, 10);
}

const CREATE_NEW = "__new__";

function FetchSessionModal({ sessions, onConfirm, onClose }) {
  const nextFriday = getNextFriday();
  const nextFridaySession = sessions.find((s) => s.to_date === nextFriday);
  const maxIndex = sessions.length > 0 ? Math.max(...sessions.map((s) => s.session_index)) : 0;
  const newIndex = maxIndex + 1;
  const newFrom = getMondayOfWeek(nextFriday);

  const lastSession = sessions.length > 0 ? sessions.reduce((a, b) => a.session_index > b.session_index ? a : b) : null;
  const defaultSelected = lastSession ? String(lastSession.id) : CREATE_NEW;
  const [selected, setSelected] = useState(defaultSelected);

  const isNew = selected === CREATE_NEW;

  const handleConfirm = () => {
    if (isNew) {
      onConfirm({ newSession: { session_index: newIndex, title: "", from_date: newFrom, to_date: nextFriday } });
    } else {
      onConfirm({ sessionId: parseInt(selected) });
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-title">Fetch All Feeds</div>

        <div className="form-group" style={{ marginBottom: 16 }}>
          <label className="form-label">Assign fetched articles to</label>
          <select
            className="form-select"
            style={{ width: "100%" }}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value={CREATE_NEW}>+ Create new session (#{newIndex})</option>
            {[...sessions].sort((a, b) => b.session_index - a.session_index).map((s) => (
              <option key={s.id} value={String(s.id)}>
                #{s.session_index} — {fmtDate(s.from_date)} to {fmtDate(s.to_date)}
              </option>
            ))}
          </select>
        </div>

        {isNew && (
          <div className="alert alert-info" style={{ marginBottom: 0 }}>
            {!nextFridaySession && (
              <div style={{ marginBottom: 4 }}>
                No session found for <strong>{fmtDate(nextFriday)}</strong>.
              </div>
            )}
            A new session will be created: <strong>Session #{newIndex}</strong>
            <br />
            {fmtDate(newFrom)} – {fmtDate(nextFriday)}
          </div>
        )}

        {!isNew && selected && (() => {
          const s = sessions.find((x) => x.id === parseInt(selected));
          return s ? (
            <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
              Articles will be added to Session #{s.session_index} ({fmtDate(s.from_date)} – {fmtDate(s.to_date)})
            </p>
          ) : null;
        })()}

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm}>
            Fetch &amp; Assign
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceModal({ source, onClose, onSave }) {
  const [form, setForm] = useState(source ? { name: source.name, url: source.url } : { name: "", url: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim() || !form.url.trim()) { setError("Name and URL are required."); return; }
    setSaving(true);
    setError(null);
    try {
      if (source) await updateRssSource(source.id, { ...form, enabled: source.enabled });
      else await createRssSource(form);
      onSave();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to save source.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{source ? "Edit RSS Source" : "Add RSS Source"}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label className="form-label">Name</label>
          <input className="form-input" style={{ width: "100%" }} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="The Verge" />
        </div>
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label className="form-label">RSS Feed URL</label>
          <input className="form-input" style={{ width: "100%" }} value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://www.theverge.com/rss/index.xml" />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <><span className="spinner" /> Saving…</> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FetchHistory({ sourceId, onDeleted }) {
  const [batches, setBatches] = useState(null);
  const [expandedBatch, setExpandedBatch] = useState(null);
  const [batchArticles, setBatchArticles] = useState({});
  const [deleting, setDeleting] = useState(null);

  const loadBatches = useCallback(() => {
    getRssFetchBatches(sourceId).then(setBatches);
  }, [sourceId]);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  const toggleBatch = async (batchId) => {
    if (expandedBatch === batchId) { setExpandedBatch(null); return; }
    setExpandedBatch(batchId);
    if (!batchArticles[batchId]) {
      const arts = await getRssBatchArticles(batchId);
      setBatchArticles((prev) => ({ ...prev, [batchId]: arts }));
    }
  };

  const handleDelete = async (batch) => {
    const label = fmtDateTime(batch.fetched_at);
    if (!confirm(`Delete all ${batch.actual_count} articles from the fetch on ${label}? This cannot be undone.`)) return;
    setDeleting(batch.id);
    try {
      await deleteRssFetchBatch(batch.id);
      setBatches((prev) => prev.filter((b) => b.id !== batch.id));
      setBatchArticles((prev) => { const next = { ...prev }; delete next[batch.id]; return next; });
      if (expandedBatch === batch.id) setExpandedBatch(null);
      onDeleted?.();
    } finally {
      setDeleting(null);
    }
  };

  if (!batches) return <div style={{ padding: "10px 0", fontSize: 12, color: "#94a3b8" }}>Loading history…</div>;
  if (batches.length === 0) return <div style={{ padding: "10px 0", fontSize: 12, color: "#94a3b8" }}>No fetch history yet.</div>;

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
      {batches.map((batch, idx) => (
        <div key={batch.id} style={{ marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => toggleBatch(batch.id)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "#3b82f6", textDecoration: "underline" }}
            >
              {fmtDateTime(batch.fetched_at)}
            </button>
            <span style={{ fontSize: 11, color: "#64748b" }}>
              {batch.actual_count} article{batch.actual_count !== 1 ? "s" : ""}
            </span>
            {idx === 0 && <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>latest</span>}
            <button
              className="btn btn-danger btn-sm"
              style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px" }}
              onClick={() => handleDelete(batch)}
              disabled={deleting === batch.id || batch.actual_count === 0}
              title={batch.actual_count === 0 ? "No articles to delete" : "Delete articles from this fetch"}
            >
              {deleting === batch.id ? <span className="spinner" /> : "Delete"}
            </button>
          </div>
          {expandedBatch === batch.id && (
            <div style={{ marginTop: 4, marginLeft: 8, maxHeight: 180, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 4, background: "#f8fafc" }}>
              {!batchArticles[batch.id]
                ? <div style={{ padding: "6px 10px", fontSize: 11, color: "#94a3b8" }}>Loading…</div>
                : batchArticles[batch.id].length === 0
                  ? <div style={{ padding: "6px 10px", fontSize: 11, color: "#94a3b8" }}>No articles (may have been deleted or were duplicates).</div>
                  : batchArticles[batch.id].map((a) => (
                    <div key={a.id} style={{ padding: "4px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                      <a href={a.url} target="_blank" rel="noreferrer" style={{ color: "#1e293b", textDecoration: "none" }}>
                        {a.headline || a.url}
                      </a>
                      {a.relevance_score != null && (
                        <span style={{ marginLeft: 6, color: "#64748b" }}>({a.relevance_score})</span>
                      )}
                    </div>
                  ))
              }
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function RssTab({ apiKey, sessions = [], onSessionsChange }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(null);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [showFetchModal, setShowFetchModal] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [msg, setMsg] = useState(null);
  const [fetchResults, setFetchResults] = useState(null);
  const [showHistory, setShowHistory] = useState({});

  const flash = (text, type = "success") => { setMsg({ text, type }); setTimeout(() => setMsg(null), 6000); };

  const load = () => {
    setLoading(true);
    getRssSources().then(setSources).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleToggle = async (source) => {
    const updated = await updateRssSource(source.id, { ...source, enabled: source.enabled ? 0 : 1 });
    setSources((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
  };

  const handleDelete = async (source) => {
    if (!confirm(`Delete "${source.name}"? Articles from this source will remain.`)) return;
    await deleteRssSource(source.id);
    setSources((prev) => prev.filter((s) => s.id !== source.id));
  };

  const handleFetchOne = async (source) => {
    if (!apiKey) { flash("API key required for AI scoring.", "error"); return; }
    setFetching(source.id);
    setFetchResults(null);
    try {
      const result = await fetchRss(apiKey, source.id);
      if (result.error) { flash(`${source.name}: ${result.error}`, "error"); setFetchResults(result); return; }
      setFetchResults(result);
      const r = result.results?.[0];
      if (r?.error) {
        flash(`${source.name}: ${r.error}`, "error");
      } else if (r?.scoringError) {
        flash(`${source.name}: No articles loaded — scoring failed: ${r.scoringError}`, "error");
      } else if (result.translationError) {
        flash(`${source.name}: No articles loaded — translation failed: ${result.translationError}`, "error");
      } else {
        flash(`${source.name}: ${r?.inserted ?? 0} new articles added.`);
        load();
      }
    } catch (e) {
      flash(e.message, "error");
    } finally {
      setFetching(null);
    }
  };

  const executeFetchAll = async ({ sessionId, newSession }) => {
    setShowFetchModal(false);
    setFetchingAll(true);
    setFetchResults(null);
    try {
      let targetSessionId = sessionId;

      if (newSession) {
        const created = await createSession(newSession);
        if (created.error) { flash(`Could not create session: ${created.error}`, "error"); return; }
        targetSessionId = created.id;
        onSessionsChange?.();
      }

      const result = await fetchRss(apiKey, null, targetSessionId);
      if (result.error) { flash(`Fetch failed: ${result.error}`, "error"); return; }
      setFetchResults(result);
      const total = result.totalInserted || 0;
      const errors = result.results?.filter((r) => r.error) || [];
      const scoringErrors = result.results?.filter((r) => r.scoringError) || [];
      if (scoringErrors.length > 0 || result.translationError) {
        const reason = scoringErrors.length > 0
          ? `scoring failed: ${scoringErrors[0].scoringError}`
          : `translation failed: ${result.translationError}`;
        flash(`No articles loaded — ${reason}.`, "error");
      } else if (errors.length > 0) {
        flash(`${total} articles added. ${errors.length} source(s) had fetch errors.`, "error");
        load();
      } else {
        flash(`${total} new articles added, scored, and assigned to session.`);
        load();
      }
    } catch (e) {
      flash(e.message, "error");
    } finally {
      setFetchingAll(false);
    }
  };

  const handleFetchAllClick = () => {
    if (!apiKey) { flash("API key required for AI scoring during fetch.", "error"); return; }
    setShowFetchModal(true);
  };

  return (
    <div>
      <div className="card-header" style={{ marginBottom: 16 }}>
        <span className="card-title">RSS Feed Sources</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary" onClick={handleFetchAllClick} disabled={fetchingAll}>
            {fetchingAll ? <><span className="spinner" /> Fetching &amp; Scoring…</> : "Fetch All Feeds"}
          </button>
          <button className="btn btn-secondary" onClick={() => { setEditTarget(null); setShowSourceModal(true); }}>
            + Add Source
          </button>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      {!apiKey && (
        <div className="alert alert-info">
          Set your Anthropic API key (top-right) to enable AI scoring during RSS fetch.
        </div>
      )}

      {fetchResults && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>Last Fetch Results</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {fetchResults.results?.map((r) => (
              <div key={r.id} className="fetch-result" style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>{r.name}</span>
                {r.error
                  ? <span style={{ color: "#dc2626" }}>Error: {r.error}</span>
                  : r.scoringError
                    ? <span style={{ color: "#dc2626" }}>Not loaded — scoring failed: {r.scoringError}</span>
                    : <span>{r.inserted} new articles</span>
                }
              </div>
            ))}
            {fetchResults.translationError && (
              <div className="fetch-result" style={{ color: "#dc2626", marginTop: 4 }}>
                Translation failed: {fetchResults.translationError}
              </div>
            )}
            {fetchResults.error && (
              <div className="fetch-result" style={{ color: "#dc2626", marginTop: 4 }}>
                Error: {fetchResults.error}
              </div>
            )}
            <div className="fetch-result" style={{ marginTop: 4 }}>
              Total: <span>{fetchResults.totalInserted}</span> new articles
            </div>
          </div>
        </div>
      )}

      {loading && <div className="empty-state"><span className="spinner" /></div>}

      {!loading && sources.length === 0 && (
        <div className="empty-state">No RSS sources configured.</div>
      )}

      {sources.map((source) => (
        <div key={source.id} style={{ marginBottom: 8 }}>
          <div className={`rss-card${source.enabled ? "" : " disabled"}`} style={{ marginBottom: 0 }}>
            <div style={{ minWidth: 40 }}>
              <button
                className={`toggle${source.enabled ? " on" : ""}`}
                onClick={() => handleToggle(source)}
                title={source.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
              />
            </div>

            <div style={{ flex: 1 }}>
              <div className="rss-name">{source.name}</div>
              <div className="rss-url">{source.url}</div>
            </div>

            <div className="rss-meta">
              <span>{source.article_count} articles</span>
              <span>Last: {fmtDateTime(source.last_fetched_at)}</span>
            </div>

            <div className="rss-actions">
              <button
                className="btn btn-success btn-sm"
                onClick={() => handleFetchOne(source)}
                disabled={fetching === source.id || !source.enabled}
                title={!source.enabled ? "Enable source to fetch" : "Fetch this feed"}
              >
                {fetching === source.id ? <span className="spinner" /> : "Fetch"}
              </button>
              <button
                className={`btn btn-sm ${showHistory[source.id] ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setShowHistory((prev) => ({ ...prev, [source.id]: !prev[source.id] }))}
              >
                History
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setEditTarget(source); setShowSourceModal(true); }}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(source)}>Delete</button>
            </div>
          </div>

          {showHistory[source.id] && (
            <div style={{ border: "1px solid #e2e8f0", borderTop: "none", borderRadius: "0 0 8px 8px", padding: "8px 16px", background: "#f8fafc" }}>
              <FetchHistory sourceId={source.id} onDeleted={load} />
            </div>
          )}
        </div>
      ))}

      <div style={{ marginTop: 20, padding: "12px 16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
        <strong>How it works:</strong> Click "Fetch All Feeds" to pull the latest articles from all enabled sources.
        New articles are inserted, scored for relevance (0–100), and assigned to the selected session.
        Articles already in the database are skipped (no duplicates).
      </div>

      {showFetchModal && (
        <FetchSessionModal
          sessions={sessions}
          onConfirm={executeFetchAll}
          onClose={() => setShowFetchModal(false)}
        />
      )}

      {showSourceModal && (
        <SourceModal
          source={editTarget}
          onClose={() => setShowSourceModal(false)}
          onSave={load}
        />
      )}
    </div>
  );
}
