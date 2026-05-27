const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "../db");
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DB_DIR, "weeklylive.db"));

db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA foreign_keys=ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_index INTEGER NOT NULL,
    title TEXT DEFAULT '',
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rss_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    last_fetched_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    headline TEXT DEFAULT '',
    headline_jp TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    article_date TEXT,
    summary TEXT,
    tags TEXT DEFAULT '[]',
    relevance_score INTEGER,
    relevance_breakdown TEXT,
    relevance_reason TEXT,
    source TEXT DEFAULT '',
    rss_source_id INTEGER REFERENCES rss_sources(id) ON DELETE SET NULL,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const sourceCount = db.prepare("SELECT COUNT(*) as n FROM rss_sources").get().n;
if (sourceCount === 0) {
  const insert = db.prepare("INSERT OR IGNORE INTO rss_sources (name, url) VALUES (?, ?)");
  [
    ["Bloomberg Technology", "https://feeds.bloomberg.com/technology/news.rss"],
    ["The Verge", "https://www.theverge.com/rss/index.xml"],
    ["Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"],
    ["Wired", "https://www.wired.com/feed/rss"],
    ["Electrek", "https://electrek.co/feed/"],
  ].forEach(([name, url]) => insert.run(name, url));
}

module.exports = db;
