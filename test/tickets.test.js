import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createStore, checkTicketKey } from '../src/memos.js';
import { createTickets, prNumber, DESK_STATES } from '../src/tickets.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
function make(now = () => NOW) {
  const db = openDb();
  const tickets = createTickets(db, { owner: 'cam', agents: ['main', 'mac'], now });
  const store = createStore(db, { owner: 'cam', names: ['cam', 'discord', 'main', 'mac'], now, ensureTicket: tickets.ensure });
  return { db, tickets, store };
}
const issue = (key, more = {}) => ({ key, title: `Title of ${key}`, url: `https://linear.app/example/issue/${key.toLowerCase()}`, linear_state: 'Todo', linear_type: 'unstarted', team: key.split('-')[0], priority: 3, updated_at: '2026-10-21T10:00:00.000Z', assignee_is_owner: true, ...more });
const group = (board, state) => board.groups.find((g) => g.state === state).tickets.map((t) => t.key);

test('a ticket key is the Linear identifier, in capitals', () => {
  assert.equal(checkTicketKey('tfp-797'), 'TFP-797');
  assert.equal(checkTicketKey(' TFP-797 '), 'TFP-797');
  assert.equal(checkTicketKey(''), null);
  for (const bad of ['TFP', '797', 'TFP-0', 'TFP-79a', 'TF P-1', 'A'.repeat(11) + '-1', 12]) assert.throws(() => checkTicketKey(bad), /ticket key/);
});

test('a database from before the Desk gets the tickets table and the ticket column of a memo', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'memo-db-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE memos (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, reply TEXT,
    state TEXT NOT NULL DEFAULT 'open', impact INTEGER, effort TEXT, due TEXT, trusted INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL, closed TEXT);
    INSERT INTO memos (sender, recipient, text, impact, effort, created) VALUES ('main', 'cam', 'An old question.', 3, 'micro', '2026-10-01T00:00:00.000Z');`);
  old.close();
  const db = openDb(path);
  const store = createStore(db, { owner: 'cam', names: ['cam', 'discord', 'main'] });
  assert.equal(store.get(1).ticket, null);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get());
  openDb(path); // a second start changes nothing
  assert.equal(store.send({ from: 'main', to: 'cam', text: 'New.', impact: 2, effort: 'micro', ticket: 'tfp-1' }).memo.ticket, 'TFP-1');
});

test('set adds a ticket, and an agent with no state makes it queued', () => {
  const { tickets } = make();
  const t = tickets.set('tfp-797', { agent: 'mac', title: 'Fix the paywall redirect' }, 'main');
  assert.equal(t.key, 'TFP-797');
  assert.equal(t.title, 'Fix the paywall redirect');
  assert.equal(t.desk_state, 'queued');
  assert.equal(t.desk_at, NOW.toISOString());
  const w = tickets.set('TFP-797', { state: 'working', summary: '  Reads   the redirect code.\n' });
  assert.equal(w.desk_state, 'working');
  assert.equal(w.summary, 'Reads the redirect code.');
  assert.equal(w.agent, 'mac');
});

test('set checks each field', () => {
  const { tickets } = make();
  assert.throws(() => tickets.set('TFP-1', {}), /one field or more/);
  assert.throws(() => tickets.set('TFP-1', { agent: 'nobody' }), /agent must be one of: main, mac/);
  assert.throws(() => tickets.set('TFP-1', { state: 'blocked' }), /state must be one of/);
  assert.throws(() => tickets.set('TFP-1', { pr: 'javascript:alert(1)' }), /https address/);
  assert.throws(() => tickets.set('TFP-1', { pr: 'http://github.com/a/b/pull/1' }), /https address/);
  assert.throws(() => tickets.set('TFP-1', { url: 'ftp://x' }), /https address/);
  assert.throws(() => tickets.set('TFP-1', { summary: 'x'.repeat(201) }), /200 characters/);
  assert.throws(() => tickets.set('TFP-1', { title: '  ' }), /title cannot be empty/);
  assert.throws(() => tickets.set('nokey', { state: 'working' }), /ticket key/);
});

test('the PR address gives the PR number; an empty value removes a field', () => {
  const { tickets } = make();
  assert.equal(prNumber('https://github.com/acme/web/pull/1234'), 1234);
  assert.equal(prNumber('https://github.com/acme/web/pull/12/files'), 12);
  assert.equal(prNumber('https://github.com/acme/web/issues/12'), null);
  const t = tickets.set('TFP-2', { state: 'in_review', pr: 'https://github.com/acme/web/pull/88' });
  assert.equal(t.pr_number, 88);
  const cleared = tickets.set('TFP-2', { pr: '', summary: '' });
  assert.equal(cleared.pr_url, null);
  assert.equal(cleared.pr_number, null);
  assert.equal(cleared.summary, null);
});

test('done gets a time, and the Desk shows a done ticket for 7 days', () => {
  let now = NOW;
  const { tickets } = make(() => now);
  tickets.set('TFP-3', { state: 'done' });
  assert.equal(tickets.get('TFP-3').done_at, NOW.toISOString());
  assert.deepEqual(group(tickets.board(), 'done'), ['TFP-3']);
  now = new Date(NOW.getTime() + 8 * 86400000);
  assert.deepEqual(group(tickets.board(), 'done'), []);
  // Out of done: the time goes away.
  assert.equal(tickets.set('TFP-3', { state: 'working' }).done_at, null);
});

test('the board groups the tickets in the order of the Desk', () => {
  const { tickets } = make();
  for (const [i, s] of DESK_STATES.entries()) tickets.set(`TFP-${10 + i}`, { state: s, agent: 'main' });
  const board = tickets.board();
  assert.deepEqual(board.groups.map((g) => g.state), ['needs_you', 'working', 'in_review', 'landing', 'queued', 'done']);
  assert.deepEqual(board.groups.map((g) => g.label), ['Needs you', 'Working', 'In review', 'Landing', 'Queued', 'Done']);
  assert.deepEqual(board.groups.map((g) => g.tickets.map((t) => t.key)), [['TFP-10'], ['TFP-11'], ['TFP-12'], ['TFP-13'], ['TFP-14'], ['TFP-15']]);
});

test('an open memo to the owner that names a ticket puts the ticket in Needs you', () => {
  const { tickets, store } = make();
  tickets.set('TFP-20', { state: 'working', agent: 'main' });
  const { memo } = store.send({ from: 'main', to: 'cam', text: 'Which redirect do you want?', impact: 3, effort: 'micro', ticket: 'TFP-20', title: 'Pick a redirect' });
  store.send({ from: 'main', to: 'cam', text: 'Second question.', impact: 5, effort: 'micro', ticket: 'TFP-20' });
  let board = tickets.board();
  assert.deepEqual(group(board, 'needs_you'), ['TFP-20']);
  assert.deepEqual(group(board, 'working'), []);
  const t = board.groups[0].tickets[0];
  assert.equal(t.questions, 2);
  assert.equal(t.question.title, 'Second question.', 'the highest impact first');
  // A memo from the owner to an agent is not a question. A reply ends the question.
  store.send({ from: 'cam', to: 'main', text: 'Work on TFP-21.', ticket: 'TFP-21' });
  store.reply(memo.id + 1, 'The first.');
  store.reply(memo.id, 'The first.');
  board = tickets.board();
  assert.deepEqual(group(board, 'needs_you'), []);
  assert.deepEqual(group(board, 'working'), ['TFP-20']);
  // A postponed question is not in Needs you.
  const p = store.send({ from: 'main', to: 'cam', text: 'Later.', impact: 2, effort: 'micro', ticket: 'TFP-20' }).memo;
  store.postpone(p.id, '2026-10-30');
  assert.deepEqual(group(tickets.board(), 'needs_you'), []);
});

test('a memo with a ticket that the Desk does not have adds a row with the key as its title', () => {
  const { tickets, store } = make();
  store.send({ from: 'main', to: 'mac', text: 'Look at this.', ticket: 'abc-5' });
  assert.equal(tickets.get('ABC-5').title, 'ABC-5');
  assert.throws(() => store.send({ from: 'main', to: 'mac', text: 'x', ticket: 'bad' }), /ticket key/);
});

test('compact keeps the ticket of the memo', () => {
  const { store } = make();
  const { memo } = store.send({ from: 'main', to: 'cam', text: 'Long text.', impact: 3, effort: 'micro', ticket: 'TFP-30' });
  assert.equal(store.compact(memo.id, 'main', { text: 'Short.' }).memo.ticket, 'TFP-30');
});

test('the Linear sync changes only the Linear part, and the Backlog has the open synced tickets with no agent', () => {
  const { tickets } = make();
  tickets.upsertLinear(issue('TFP-40', { priority: 0 }), NOW.toISOString());
  tickets.upsertLinear(issue('TFP-41', { priority: 1 }));
  tickets.upsertLinear(issue('TFP-42', { linear_state: 'Done', linear_type: 'completed' }));
  tickets.upsertLinear(issue('TFP-43'));
  tickets.set('TFP-43', { agent: 'mac', state: 'working', summary: 'Works.' });
  // A ticket that an agent added by hand is not from the sync, so it is not in the Backlog.
  tickets.ensure('TFP-44');
  let board = tickets.board();
  assert.deepEqual(board.backlog.map((t) => t.key), ['TFP-41', 'TFP-40'], 'urgent first; no priority last');
  assert.deepEqual(group(board, 'working'), ['TFP-43']);
  // A second sync: the title and the state change, the Memo part stays.
  const t = tickets.upsertLinear(issue('TFP-43', { title: 'New title', linear_state: 'In Review', linear_type: 'started' }));
  assert.equal(t.title, 'New title');
  assert.equal(t.linear_state, 'In Review');
  assert.equal(t.agent, 'mac');
  assert.equal(t.desk_state, 'working');
  assert.equal(t.summary, 'Works.');
  assert.equal(t.assignee_is_owner, 1);
  // A bad address from Linear is left out.
  assert.equal(tickets.upsertLinear(issue('TFP-45', { url: 'javascript:alert(1)' })).url, null);
  board = tickets.board();
  assert.ok(board.backlog.some((x) => x.key === 'TFP-45'));
});
