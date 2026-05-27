import { useState } from "react";

export default function ApiKeyModal({ currentKey, onSave, onClose }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);

  const save = () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    onSave(trimmed);
    onClose();
  };

  const handleKeyDown = (e) => { if (e.key === "Enter") save(); };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-title">Anthropic API Key</div>
        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 18, lineHeight: 1.6 }}>
          Required for AI scoring, article summaries, and translation.
          Your key is stored only in your browser's local storage.
        </p>
        <div className="form-group" style={{ marginBottom: 6 }}>
          <label className="form-label">API Key</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              autoFocus
              className="form-input"
              style={{ flex: 1 }}
              type={show ? "text" : "password"}
              placeholder="sk-ant-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="btn btn-secondary"
              style={{ padding: "7px 10px", fontSize: 16 }}
              onClick={() => setShow((v) => !v)}
              tabIndex={-1}
            >
              {show ? "🙈" : "👁"}
            </button>
          </div>
        </div>
        <div className="modal-footer">
          {currentKey ? (
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          ) : (
            <button
              className="btn"
              style={{ color: "#94a3b8", background: "none", padding: "7px 4px" }}
              onClick={onClose}
            >
              Skip for now
            </button>
          )}
          <button className="btn btn-primary" onClick={save} disabled={!key.trim()}>
            Save & Continue
          </button>
        </div>
      </div>
    </div>
  );
}
