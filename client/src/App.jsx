import { useState, useEffect } from "react";
import SessionsTab from "./components/SessionsTab";
import ArticlesTab from "./components/ArticlesTab";
import RssTab from "./components/RssTab";
import ApiKeyModal from "./components/ApiKeyModal";
import ThursdayPrompt, { shouldShowThursdayPrompt, markThursdayPromptSeen } from "./components/ThursdayPrompt";
import { getSessions, setAuthErrorHandler } from "./api";

const TABS = ["Articles", "Sessions", "RSS Feeds"];

export default function App() {
  const [tab, setTab] = useState("Articles");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("anthropic_api_key") || "");
  const [showKeyModal, setShowKeyModal] = useState(!localStorage.getItem("anthropic_api_key"));
  const [showThursdayPrompt, setShowThursdayPrompt] = useState(false);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    setAuthErrorHandler(() => setShowKeyModal(true));
  }, []);

  const saveKey = (key) => {
    setApiKey(key);
    localStorage.setItem("anthropic_api_key", key);
  };

  const loadSessions = () => getSessions().then((data) => {
    setSessions(data);
    if (shouldShowThursdayPrompt(data)) {
      markThursdayPromptSeen();
      setShowThursdayPrompt(true);
    }
  }).catch(() => {});

  useEffect(() => { loadSessions(); }, []);

  const dismissThursdayPrompt = () => setShowThursdayPrompt(false);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-title">
          <span className="header-logo">NTT Docomo</span>
          <span className="header-subtitle">Weekly Livestream Tool</span>
        </div>
        <button
          className="key-btn"
          onClick={() => setShowKeyModal(true)}
          title={apiKey ? "API key configured — click to update" : "Set Anthropic API key"}
        >
          <span className="key-dot" style={{ background: apiKey ? "#22c55e" : "#f59e0b" }} />
          {apiKey ? "API Key Set" : "Set API Key"}
        </button>
      </header>

      <nav className="tab-nav">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab-btn${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {tab === "Sessions" && <SessionsTab apiKey={apiKey} sessions={sessions} onSessionsChange={loadSessions} />}
        {tab === "Articles" && <ArticlesTab apiKey={apiKey} sessions={sessions} />}
        {tab === "RSS Feeds" && <RssTab apiKey={apiKey} sessions={sessions} onSessionsChange={loadSessions} />}
      </main>

      {showThursdayPrompt && (
        <ThursdayPrompt
          sessions={sessions}
          onClose={dismissThursdayPrompt}
          onCreated={loadSessions}
        />
      )}

      {showKeyModal && (
        <ApiKeyModal
          currentKey={apiKey}
          onSave={saveKey}
          onClose={() => setShowKeyModal(false)}
        />
      )}
    </div>
  );
}
