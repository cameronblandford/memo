import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  // Before 2026-10-09 a memo had the name "card". A database from then gets the new table and column names.
  const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (has('cards') && !has('memos')) {
    db.exec('ALTER TABLE cards RENAME TO memos; ALTER TABLE corrections RENAME COLUMN card_id TO memo_id;');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      text TEXT NOT NULL,
      reply TEXT,
      state TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'replied' | 'closed'
      impact INTEGER,                       -- 1 to 5, only for a memo to the owner
      effort TEXT,                          -- a key of WEIGHTS, only for a memo to the owner
      due TEXT,                             -- YYYY-MM-DD
      trusted INTEGER NOT NULL DEFAULT 0,   -- 1: the watcher checked that the owner wrote the message; 2: also forwarded
      acked INTEGER NOT NULL DEFAULT 0,     -- 1: the sender read the result
      created TEXT NOT NULL,
      closed TEXT
    );
    CREATE TABLE IF NOT EXISTS corrections (
      memo_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      old_impact INTEGER NOT NULL,
      new_impact INTEGER NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS status (
      agent TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL DEFAULT '',
      wanted INTEGER NOT NULL DEFAULT 0,    -- 1: the owner started the agent, so the server starts it again
      recap TEXT,
      recap_at TEXT,
      stopping_since TEXT,                  -- set while the server waits for the recap
      last_stop TEXT                        -- 'recap' | 'no_recap' | 'now'
    );
  `);
  return db;
}
