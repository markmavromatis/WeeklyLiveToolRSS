import { useState, useEffect } from "react";
import { getRssSources, createRssSource, updateRssSource, deleteRssSource, fetchRss, createSession } from "../api";

function fmtDate(str) {
  if (!str) return "";
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(str) {
  if (!str) return "Never";
  return new Date(str).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

  const defaultSelected = nextFridaySession ? String(nextFridaySession.id) : CREATE_NEW;
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
    try {
      const result = await fetchRss(apiKey, source.id);
      const r = result.results?.[0];
      if (r?.error) {
        flash(`${source.name}: ${r.error}`, "error");
      } else {
        flash(`${source.name}: ${r?.inserted ?? 0} new articles added.`);
      }
      load();
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
      setFetchResults(result);
      const total = result.totalInserted || 0;
      const errors = result.results?.filter((r) => r.error) || [];
      if (errors.length > 0) {
        flash(`${total} articles added. ${errors.length} source(s) had errors.`, "error");
      } else {
        flash(`${total} new articles added, scored, and assigned to session.`);
      }
      load();
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
                  : <span><span>{r.inserted}</span> new articles</span>
                }
              </div>
            ))}
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
        <div key={source.id} className={`rss-card${source.enabled ? "" : " disabled"}`}>
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
            <button className="btn btn-secondary btn-sm" onClick={() => { setEditTarget(source); setShowSourceModal(true); }}>Edit</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(source)}>Delete</button>
          </div>
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
