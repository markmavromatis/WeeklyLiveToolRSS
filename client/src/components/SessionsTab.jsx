import { useState } from "react";
import { createSession, updateSession, deleteSession, exportPptx, getArticles } from "../api";

function nextFriday() {
  const d = new Date();
  const day = d.getDay();
  const add = day === 5 ? 7 : (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

function prevMonday(fridayStr) {
  const d = new Date(fridayStr + "T12:00:00");
  d.setDate(d.getDate() - 4);
  return d.toISOString().slice(0, 10);
}

function fmtDate(str) {
  if (!str) return "";
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SessionModal({ session, onClose, onSave }) {
  const friday = nextFriday();
  const monday = prevMonday(friday);
  const [form, setForm] = useState(
    session
      ? { session_index: session.session_index, title: session.title || "", from_date: session.from_date, to_date: session.to_date }
      : { session_index: "", title: "", from_date: monday, to_date: friday }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleToDateChange = (v) => {
    set("to_date", v);
    if (!session) set("from_date", prevMonday(v));
  };

  const save = async () => {
    if (!form.session_index || !form.from_date || !form.to_date) {
      setError("Session #, From date, and To date are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fn = session ? updateSession(session.id, form) : createSession(form);
      await fn;
      onSave();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{session ? "Edit Session" : "New Session"}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label className="form-label">Session #</label>
          <input className="form-input" type="number" value={form.session_index} onChange={(e) => set("session_index", e.target.value)} placeholder="42" />
        </div>
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label className="form-label">Title (optional)</label>
          <input className="form-input" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. AI Week" />
        </div>
        <div className="form-row" style={{ marginBottom: 14 }}>
          <div className="form-group">
            <label className="form-label">Coverage From</label>
            <input className="form-input" type="date" value={form.from_date} onChange={(e) => set("from_date", e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Recording Date (To)</label>
            <input className="form-input" type="date" value={form.to_date} onChange={(e) => handleToDateChange(e.target.value)} />
          </div>
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

export default function SessionsTab({ apiKey, sessions, onSessionsChange }) {
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [msg, setMsg] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
  const [sessionArticles, setSessionArticles] = useState([]);

  const flash = (text, type = "success") => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };

  const handleDelete = async (s) => {
    if (!confirm(`Delete Session #${s.session_index}? Articles will be unassigned but not deleted.`)) return;
    await deleteSession(s.id);
    onSessionsChange();
    flash(`Session #${s.session_index} deleted.`);
  };

  const handleExport = async (s) => {
    if (!apiKey) { flash("API key required for export.", "error"); return; }
    setExporting(s.id);
    try {
      const resp = await exportPptx(s.id, apiKey);
      if (!resp.ok) { flash("Export failed.", "error"); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `session-${s.session_index}.pptx`; a.click();
      URL.revokeObjectURL(url);
      flash("PPTX exported.");
    } catch (e) {
      flash(e.message, "error");
    } finally {
      setExporting(null);
    }
  };

  const viewArticles = async (s) => {
    if (viewingSession?.id === s.id) { setViewingSession(null); return; }
    const articles = await getArticles({ session_id: s.id });
    setSessionArticles(articles);
    setViewingSession(s);
  };

  return (
    <div>
      <div className="card-header" style={{ marginBottom: 16 }}>
        <span className="card-title">Livestream Sessions</span>
        <button className="btn btn-primary" onClick={() => { setEditTarget(null); setShowModal(true); }}>
          + New Session
        </button>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      {sessions.length === 0 && (
        <div className="empty-state">No sessions yet. Create your first session to get started.</div>
      )}

      {sessions.map((s) => (
        <div key={s.id}>
          <div className="session-card">
            <div className="session-index">#{s.session_index}</div>
            <div className="session-details">
              {s.title && <div className="session-title">{s.title}</div>}
              <div className="session-dates">
                {fmtDate(s.to_date)}
              </div>
            </div>
            <div className="session-count"># {s.article_count} · ★ {s.starred_count}</div>
            <div className="session-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => viewArticles(s)}>
                {viewingSession?.id === s.id ? "Hide Articles" : "View Articles"}
              </button>
              <button className="btn btn-warning btn-sm" onClick={() => handleExport(s)} disabled={exporting === s.id}>
                {exporting === s.id ? <span className="spinner" /> : "Export PPTX"}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setEditTarget(s); setShowModal(true); }}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s)}>Delete</button>
            </div>
          </div>

          {viewingSession?.id === s.id && (
            <div style={{ marginLeft: 24, marginBottom: 16 }}>
              {sessionArticles.length === 0 ? (
                <div className="empty-state" style={{ padding: 20 }}>No articles assigned to this session.</div>
              ) : (
                sessionArticles.map((a) => (
                  <div key={a.id} style={{ padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, marginBottom: 6, display: "flex", gap: 10, alignItems: "center" }}>
                    <ScoreBadge score={a.relevance_score} />
                    <div style={{ flex: 1 }}>
                      <a className="article-headline" href={a.url} target="_blank" rel="noreferrer">{a.headline}</a>
                      <div className="article-info">
                        <span>{a.article_date}</span>
                        <span className={`source-chip${a.source === "Manual" ? " manual" : ""}`}>{a.source}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}

      {showModal && (
        <SessionModal
          session={editTarget}
          onClose={() => setShowModal(false)}
          onSave={onSessionsChange}
        />
      )}
    </div>
  );
}

function ScoreBadge({ score }) {
  if (score == null) return <span className="score-badge score-gray">--</span>;
  const cls = score >= 70 ? "score-green" : score >= 40 ? "score-yellow" : "score-red";
  return <span className={`score-badge ${cls}`}>{score}</span>;
}
