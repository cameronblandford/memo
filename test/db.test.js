import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createStore } from '../src/memos.js';

// Before 2026-10-09 a memo had the name "card". A database from then has the old table and column names.
test('a database with the old names keeps its rows under the new names', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'memo-db-')), 'memo.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, reply TEXT,
      state TEXT NOT NULL DEFAULT 'open', impact INTEGER, effort TEXT, due TEXT, trusted INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL, closed TEXT);
    CREATE TABLE corrections (card_id INTEGER NOT NULL, sender TEXT NOT NULL, old_impact INTEGER NOT NULL, new_impact INTEGER NOT NULL, at TEXT NOT NULL);
    INSERT INTO cards (sender, recipient, text, impact, effort, created) VALUES ('main', 'cam', 'An old card.', 4, 'micro', '2026-10-09T12:00:00.000Z');
    INSERT INTO corrections VALUES (1, 'main', 5, 4, '2026-10-09T12:01:00.000Z');
  `);
  old.close();
  const store = createStore(openDb(path), { owner: 'cam', names: ['cam', 'discord', 'main'] });
  assert.equal(store.get(1).text, 'An old card.');
  assert.deepEqual(store.list('cam').map((m) => m.id), [1]);
  assert.equal(store.corrections('main')[0].memo_id, 1);
  assert.equal(store.send({ from: 'main', to: 'cam', text: 'A new memo.', impact: 1, effort: 'micro' }).memo.id, 2);
  openDb(path); // a second start changes nothing
  assert.equal(store.list('cam').length, 2);
});
