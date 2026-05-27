import { useState } from "react";
import { createSession } from "../api";

function fmtDate(str) {
  if (!str) return "";
  return new Date(str + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

export function shouldShowThursdayPrompt(sessions) {
  const today = new Date();
  if (today.getDay() !== 4) return false; // not Thursday

  const key = `thursday_prompt_${today.toISOString().slice(0, 10)}`;
  if (sessionStorage.getItem(key)) return false; // already shown today

  // next Friday = Thursday + 8 days
  const nextFriday = new Date(today);
  nextFriday.setDate(today.getDate() + 8);
  const nextFridayStr = nextFriday.toISOString().slice(0, 10);

  return !sessions.some((s) => s.to_date === nextFridayStr);
}

export function markThursdayPromptSeen() {
  const key = `thursday_prompt_${new Date().toISOString().slice(0, 10)}`;
  sessionStorage.setItem(key, "1");
}

export default function ThursdayPrompt({ sessions, onClose, onCreated }) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const nextFriday = new Date(today);
  nextFriday.setDate(today.getDate() + 8);
  const nextFridayStr = nextFriday.toISOString().slice(0, 10);

  const maxIndex = sessions.length > 0 ? Math.max(...sessions.map((s) => s.session_index)) : 0;
  const newIndex = maxIndex + 1;

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      await createSession({
        session_index: newIndex,
        title: "",
        from_date: todayStr,
        to_date: nextFridayStr,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to create session.");
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-title">Create Next Session?</div>
        <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, marginBottom: 16 }}>
          Tomorrow is your weekly livestream recording day. Would you like to set up a new session for next week's content collection?
        </p>
        <div className="alert alert-info" style={{ marginBottom: 0 }}>
          <strong>Session #{newIndex}</strong>
          <br />
          {fmtDate(todayStr)} – {fmtDate(nextFridayStr)}
        </div>
        {error && <div className="alert alert-error" style={{ marginTop: 10 }}>{error}</div>}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Skip</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            {creating ? <><span className="spinner" /> Creating…</> : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
