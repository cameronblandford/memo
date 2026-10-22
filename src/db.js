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
      state TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'waiting' (the owner sent it back to the sender) | 'replied' | 'closed'
      impact INTEGER,                       -- 1 to 5, only for a memo to the owner
      effort TEXT,                          -- a key of WEIGHTS, only for a memo to the owner
      due TEXT,                             -- YYYY-MM-DD
      trusted INTEGER NOT NULL DEFAULT 0,   -- 1: the watcher checked that the owner wrote the message; 2: also forwarded
      acked INTEGER NOT NULL DEFAULT 0,     -- 1: the sender read the result
      seen INTEGER NOT NULL DEFAULT 0,      -- for a memo to the owner. 0: new; 1: the owner saw the text; 2: the text changed after that
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      impact INTEGER NOT NULL,              -- 1 to 5, as for a memo
      effort TEXT NOT NULL,                 -- a key of WEIGHTS
      days TEXT NOT NULL DEFAULT '',        -- 'mon,wed,fri'; empty: each day
      every INTEGER NOT NULL DEFAULT 1,     -- the tick comes back this many days after the owner did it
      after TEXT NOT NULL DEFAULT '',       -- 'HH:MM': not in the list before this time; empty: all day
      by TEXT NOT NULL DEFAULT '',          -- 'HH:MM': overdue after this time; empty: no time limit
      active INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tick_log (
      tick_id INTEGER NOT NULL,
      day TEXT NOT NULL,                    -- YYYY-MM-DD, the day of the owner
      state TEXT NOT NULL,                  -- 'done' | 'skip'
      at TEXT NOT NULL,
      PRIMARY KEY (tick_id, day)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memo_id INTEGER NOT NULL,
      author TEXT NOT NULL,                 -- the owner, or the sender of the memo
      text TEXT NOT NULL,
      created TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0       -- 1: the other party read the note
    );
    CREATE INDEX IF NOT EXISTS notes_memo ON notes (memo_id);
  `);
  // The event log of the Log page (src/events.js). It is append-only: the triggers refuse a change and a delete.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,                  -- the name that did the step
      memo_id INTEGER,                      -- NULL for a step with no memo, for example a status line
      kind TEXT NOT NULL,                   -- send, delivered, seen, ack, note, reply, close, edit, brief, postpone, ...
      detail TEXT NOT NULL DEFAULT ''       -- a title or the first 80 characters, never the full text
    );
    CREATE INDEX IF NOT EXISTS events_memo ON events (memo_id);
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `);
  // A database from before the overdue rule gets the column.
  if (!db.prepare('PRAGMA table_info(ticks)').all().some((c) => c.name === 'by')) {
    db.exec("ALTER TABLE ticks ADD COLUMN by TEXT NOT NULL DEFAULT ''");
  }
  // A database from before the "new" tag gets the column. The memos that are in it count as seen.
  if (!db.prepare('PRAGMA table_info(memos)').all().some((c) => c.name === 'seen')) {
    db.exec('ALTER TABLE memos ADD COLUMN seen INTEGER NOT NULL DEFAULT 1');
  }
  // Tags and postpone. The old memos get no tags and are not postponed.
  //   tags:  'money,work' (sorted; empty: no tags)
  //   until: the time (ISO, UTC) when a postponed memo comes back to the Inbox; NULL: not postponed
  //   back:  the time when a postponed memo came back. Until the owner sees it, it is at the top of the Inbox.
  const memoColumns = db.prepare('PRAGMA table_info(memos)').all().map((c) => c.name);
  if (!memoColumns.includes('tags')) db.exec("ALTER TABLE memos ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  if (!memoColumns.includes('until')) db.exec('ALTER TABLE memos ADD COLUMN until TEXT');
  if (!memoColumns.includes('back')) db.exec('ALTER TABLE memos ADD COLUMN back TEXT');
  // The brief of a memo for its card in the Inbox, written by the sender. NULL: no brief.
  //   title: a name for the memo, for example "Driver license address"
  //   next:  the next step of the owner, for example "Mail form MV-232"
  if (!memoColumns.includes('title')) db.exec('ALTER TABLE memos ADD COLUMN title TEXT');
  if (!memoColumns.includes('next')) db.exec('ALTER TABLE memos ADD COLUMN next TEXT');
  // The answer buttons of a memo to the owner, written by the sender: 'push,draft,skip' (empty: no buttons).
  // A tap on a button replies with that word. The old memos get no buttons.
  if (!memoColumns.includes('choices')) db.exec("ALTER TABLE memos ADD COLUMN choices TEXT NOT NULL DEFAULT ''");
  // The Desk (src/tickets.js): the ticket key of a memo, for example TFP-797. NULL: the memo has no ticket.
  if (!memoColumns.includes('ticket')) db.exec('ALTER TABLE memos ADD COLUMN ticket TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS memos_ticket ON memos (ticket) WHERE ticket IS NOT NULL');
  // One ticket is one task of an agent. The Linear part comes from the read-only sync (src/linear.js), or from the
  // agent that adds the ticket. Memo never writes to Linear. The Memo part is the work on the Desk.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      key TEXT PRIMARY KEY,                 -- the Linear identifier, for example TFP-797
      title TEXT NOT NULL,
      url TEXT,                             -- the address of the issue in Linear
      linear_state TEXT,                    -- the name of the Linear state, for example "In Progress". Read only.
      linear_type TEXT,                     -- the type of that state: triage, backlog, unstarted, started, completed, canceled
      team TEXT,                            -- the team key, for example TFP
      priority INTEGER,                     -- Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low
      assignee_is_owner INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,                      -- the last change in Linear
      synced_at TEXT,                       -- the last sync that brought the issue; NULL: not from the sync
      agent TEXT,                           -- the agent that works on the ticket; NULL: no agent
      desk_state TEXT,                      -- queued | working | needs_you | in_review | landing | done; NULL: not on the Desk
      desk_at TEXT,                         -- the time of the last change of the Memo part
      pr_url TEXT,
      pr_number INTEGER,
      summary TEXT,                         -- one line from the agent
      done_at TEXT,                         -- the time of the change to done
      created TEXT NOT NULL
    );
  `);
  return db;
}
