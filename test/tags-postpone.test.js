import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { openDb } from '../src/db.js';
import { createStore, MemoError, returnTime } from '../src/memos.js';
import { makeApp, call, TOKEN, LIAISON_TOKEN, ROOT } from './helpers.js';

const NAMES = ['cam', 'discord', 'main', 'liaison'];
// A store with a clock that the test moves.
function makeStore(start = '2026-10-14T16:00:00Z') {
  const clock = { t: Date.parse(start) };
  const store = createStore(openDb(), { owner: 'cam', names: NAMES, forwardTo: ['main'], now: () => new Date(clock.t), timeZone: 'America/New_York' });
  return { store, clock };
}
const toCam = (more = {}) => ({ from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 2, effort: 'hour', ...more });
const refuses = (fn, status, part) =>
  assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));

// Tags

test('a memo can have tags: lowercase words, sorted, with no duplicates', () => {
  const { store } = makeStore();
  assert.deepEqual(store.send(toCam({ tags: ['work', 'Money', 'work'] })).memo.tags, ['money', 'work']);
  assert.deepEqual(store.send(toCam()).memo.tags, [], 'a memo with no tags has an empty list');
  assert.deepEqual(store.send(toCam({ tags: 'home' })).memo.tags, ['home'], 'one tag can come as text');
  refuses(() => store.send(toCam({ tags: ['two words'] })), 400, 'one lowercase word');
  refuses(() => store.send(toCam({ tags: ['9lives'] })), 400, 'starting with a letter');
  refuses(() => store.send(toCam({ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] })), 400, '8 tags or fewer');
});

test('tag and untag change the tags of a memo to the owner, also of a closed memo', () => {
  const { store } = makeStore();
  const { memo } = store.send(toCam({ tags: ['work'] }));
  assert.deepEqual(store.tag(memo.id, 'admin', true).tags, ['admin', 'work']);
  assert.deepEqual(store.tag(memo.id, 'admin', true).tags, ['admin', 'work'], 'a second add changes nothing');
  assert.deepEqual(store.tag(memo.id, 'work', false).tags, ['admin']);
  store.close(memo.id);
  assert.deepEqual(store.tag(memo.id, 'money', true).tags, ['admin', 'money']);
  const toMain = store.send({ from: 'cam', to: 'main', text: 'Do this.' }).memo;
  refuses(() => store.tag(toMain.id, 'work', true), 400, 'Only a memo to cam has tags');
  refuses(() => store.tag(memo.id, '', true), 400, 'tag is necessary');
});

test('an old database gets the new columns, and its memos keep their data with no tags and no postpone', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'memo-db-')), 'memo.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE memos (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    text TEXT NOT NULL, reply TEXT, state TEXT NOT NULL DEFAULT 'open', impact INTEGER, effort TEXT, due TEXT,
    trusted INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL, closed TEXT)`);
  old.prepare("INSERT INTO memos (sender, recipient, text, impact, effort, created, seen) VALUES ('main', 'cam', 'An old memo', 3, 'short', '2026-10-01T00:00:00Z', 1)").run();
  old.close();
  const store = createStore(openDb(path), { owner: 'cam', names: NAMES });
  const [memo] = store.list('cam');
  assert.equal(memo.text, 'An old memo');
  assert.equal(memo.impact, 3);
  assert.deepEqual(memo.tags, []);
  assert.equal(memo.until, null);
  assert.equal(memo.back, null);
});

// Postpone

test('a postponed memo comes back at 9:00 New York time, in summer and in winter', () => {
  assert.equal(returnTime('2026-10-19', 'America/New_York'), '2026-10-19T13:00:00.000Z');
  assert.equal(returnTime('2026-12-01', 'America/New_York'), '2026-12-01T14:00:00.000Z');
  assert.equal(returnTime('2026-12-01', 'UTC'), '2026-12-01T09:00:00.000Z');
});

test('on the day of a clock change, a postponed memo still comes back at 9:00 local time', () => {
  // The clocks change at 2:00 local time. At 9:00 UTC it is still winter time in Los Angeles and Anchorage,
  // but at 9:00 local time it is summer time.
  assert.equal(returnTime('2027-03-14', 'America/Los_Angeles'), '2027-03-14T16:00:00.000Z');
  assert.equal(returnTime('2027-03-14', 'America/Anchorage'), '2027-03-14T17:00:00.000Z');
  assert.equal(returnTime('2027-03-14', 'America/New_York'), '2027-03-14T13:00:00.000Z');
  assert.equal(returnTime('2026-11-01', 'America/Los_Angeles'), '2026-11-01T17:00:00.000Z', 'the autumn change');
  assert.equal(returnTime('2026-11-01', 'America/New_York'), '2026-11-01T14:00:00.000Z');
  for (const [date, zone] of [['2027-03-14', 'America/Los_Angeles'], ['2026-11-01', 'America/Anchorage'], ['2027-03-28', 'Europe/Berlin']]) {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(returnTime(date, zone)));
    assert.equal(Number(hour), 9, `${zone} on ${date}`);
  }
});

test('postpone takes a memo out of the Inbox; it comes back at the top as new on the date', () => {
  const { store, clock } = makeStore();
  const big = store.send(toCam({ text: 'Big', impact: 5, effort: 'micro' })).memo;
  const small = store.send(toCam({ text: 'Small', impact: 1, effort: 'day' })).memo;
  store.seen([big.id, small.id]);

  const later = store.postpone(small.id, '2026-10-19');
  assert.equal(later.until, '2026-10-19T13:00:00.000Z');
  assert.deepEqual(store.list('cam').map((m) => m.id), [big.id], 'the Inbox does not show it');
  assert.deepEqual(store.postponed().map((m) => m.id), [small.id]);
  assert.deepEqual(store.list('cam', { withPostponed: true }).map((m) => m.id), [big.id, small.id], 'memo list shows it');

  clock.t = Date.parse('2026-10-19T12:59:00Z');
  assert.equal(store.list('cam').length, 1, '8:59 in New York: not yet');
  clock.t = Date.parse('2026-10-19T13:00:00Z');
  const queue = store.list('cam');
  assert.deepEqual(queue.map((m) => m.id), [small.id, big.id], 'it is back, above the memo with the higher score');
  assert.equal(queue[0].seen, 0, 'as new');
  assert.equal(queue[0].until, null);
  assert.equal(store.postponed().length, 0);

  store.seen([small.id]);
  assert.deepEqual(store.list('cam').map((m) => m.id), [big.id, small.id], 'after the owner saw it, the normal order');
});

test('postpone refuses a past date and a memo that is not open or not to the owner; null brings it back now', () => {
  const { store } = makeStore();
  const { memo } = store.send(toCam());
  refuses(() => store.postpone(memo.id, '2026-10-14'), 400, 'must be in the future');
  refuses(() => store.postpone(memo.id, '2026-02-30'), 400, 'YYYY-MM-DD');
  store.postpone(memo.id, '2026-10-20');
  assert.equal(store.postpone(memo.id, null).until, null);
  assert.equal(store.list('cam').length, 1);
  const toMain = store.send({ from: 'cam', to: 'main', text: 'Do this.' }).memo;
  refuses(() => store.postpone(toMain.id, '2026-10-20'), 400, 'Only a memo to cam');
  store.close(memo.id);
  refuses(() => store.postpone(memo.id, '2026-10-20'), 409, 'closed');
});

test('a postpone is not an answer: the sender gets no news from it', () => {
  const { store } = makeStore();
  const { memo } = store.send(toCam());
  store.postpone(memo.id, '2026-10-20');
  const news = store.news('main');
  assert.deepEqual(news.results, []);
  assert.deepEqual(news.noted, []);
});

// The API

test('the API: tag, postpone, the postponed list, and the count in the queue; the liaison cannot do them', async () => {
  const { app } = makeApp();
  const { data: sent } = await call(app, '/api/send', toCam({ tags: ['work'] }));
  const id = sent.memo.id;
  assert.deepEqual((await call(app, '/api/tag', { id, tag: 'money', on: true })).data.tags, ['money', 'work']);
  const later = await call(app, '/api/postpone', { id, date: '2099-01-05' });
  assert.equal(later.status, 200);
  let queue = (await call(app, '/api/queue')).data;
  assert.equal(queue.memos.length, 0);
  assert.equal(queue.postponed, 1);
  assert.equal(queue.timeZone, 'America/New_York');
  assert.equal((await call(app, '/api/postponed')).data[0].id, id);
  assert.equal((await call(app, '/api/list?to=cam')).data[0].until, '2099-01-05T14:00:00.000Z');
  await call(app, '/api/postpone', { id, date: null });
  queue = (await call(app, '/api/queue')).data;
  assert.equal(queue.memos.length, 1);
  assert.equal(queue.postponed, 0);
  assert.equal((await call(app, '/api/tag', { id, tag: 'x', on: true }, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/postpone', { id, date: '2099-01-05' }, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/postponed', undefined, LIAISON_TOKEN)).status, 403);
});

// The client

const run = promisify(execFile);
const CLI = join(ROOT, 'scripts', 'memo.mjs');
async function withServer(fn) {
  const made = makeApp();
  const server = await new Promise((done) => { const s = serve({ fetch: made.app.fetch, hostname: '127.0.0.1', port: 0 }, () => done(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const memo = async (args) => {
    try {
      const { stdout, stderr } = await run('node', [CLI, ...args], { env: { ...process.env, MEMO_URL: url, MEMO_TOKEN: TOKEN } });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };
  try { await fn({ ...made, memo }); } finally { server.close(); }
}

test('the client: send --tag, tag, untag, postpone, and list shows the tags and the date', () => withServer(async ({ memo, store }) => {
  const sent = await memo(['send', '--from', 'main', '--to', 'cam', '--impact', '3', '--effort', 'short', '--tag', 'work', '--tag', 'code', 'Review', 'the PR']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /Memo 1 is sent to cam\. Tags: code work\./);
  assert.match((await memo(['tag', '1', 'money', 'home'])).stdout, /Memo 1 has the tags: code home money work\./);
  assert.match((await memo(['untag', '1', 'home'])).stdout, /Memo 1 has the tags: code money work\./);
  assert.match((await memo(['postpone', '1', '2099-01-05'])).stdout, /Memo 1 is postponed until 2099-01-05 14:00 UTC\./);
  const list = await memo(['list', '--to', 'cam']);
  assert.match(list.stdout, /tags code money work, postponed until 2099-01-05 14:00 UTC/);
  assert.match((await memo(['postpone', '1', 'now'])).stdout, /Memo 1 is back in the Inbox\./);
  assert.equal(store.get(1).until, null);
  const bad = await memo(['postpone', '1']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Give the date/);
}));
