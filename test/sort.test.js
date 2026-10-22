import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/memos.js';
import { updatedTime } from '../src/rank.js';
import { sortedMemos, sortChoice, SORTS } from '../ui/filter.js';
import { makeApp, call } from './helpers.js';

const NAMES = ['cam', 'discord', 'main', 'liaison'];
function makeStore(start = '2026-10-14T16:00:00Z') {
  const clock = { t: Date.parse(start) };
  const store = createStore(openDb(), { owner: 'cam', names: NAMES, forwardTo: ['main'], now: () => new Date(clock.t), timeZone: 'America/New_York' });
  return { store, clock };
}
const toCam = (more = {}) => ({ from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 2, effort: 'hour', ...more });
const at = (iso) => Date.parse(iso);

test('updatedTime is the newest of the send, the return from a postpone, the notes, and the last edit', () => {
  const memo = { created: '2026-10-01T10:00:00.000Z', back: null };
  assert.equal(updatedTime(memo), memo.created, 'only the send');
  assert.equal(updatedTime({ ...memo, back: '2026-10-03T13:00:00.000Z' }), '2026-10-03T13:00:00.000Z');
  const notes = [{ created: '2026-10-02T09:00:00.000Z' }, { created: '2026-10-04T09:00:00.000Z' }];
  assert.equal(updatedTime({ ...memo, notes }), '2026-10-04T09:00:00.000Z', 'the newest note');
  assert.equal(updatedTime({ ...memo, notes }, '2026-10-05T00:00:00.000Z'), '2026-10-05T00:00:00.000Z', 'an edit after the notes');
  assert.equal(updatedTime({ ...memo, notes }, '2026-09-01T00:00:00.000Z'), '2026-10-04T09:00:00.000Z', 'an older edit does not count');
});

test('the Inbox list gives each memo its updated time: a note from anyone, an edit, and a return from a postpone', () => {
  const { store, clock } = makeStore();
  const a = store.send(toCam({ text: 'A' })).memo;
  clock.t = at('2026-10-14T17:00:00Z');
  const b = store.send(toCam({ text: 'B' })).memo;
  clock.t = at('2026-10-14T18:00:00Z');
  const c = store.send(toCam({ text: 'C' })).memo;
  const updated = () => Object.fromEntries(store.list('cam').map((m) => [m.id, m.updated]));
  assert.deepEqual(updated(), { [a.id]: '2026-10-14T16:00:00.000Z', [b.id]: '2026-10-14T17:00:00.000Z', [c.id]: '2026-10-14T18:00:00.000Z' });

  clock.t = at('2026-10-14T19:00:00Z');
  store.note(a.id, 'cam', 'A question from the owner.');
  assert.equal(updated()[a.id], undefined, 'a note of the owner sends the memo back: it is not in the list');
  assert.equal(store.waiting()[0].id, a.id);
  clock.t = at('2026-10-14T20:00:00Z');
  store.note(a.id, 'main', 'The answer of the sender.');
  assert.equal(updated()[a.id], '2026-10-14T20:00:00.000Z', 'a note of the sender');

  clock.t = at('2026-10-14T21:00:00Z');
  store.edit(b.id, 'B, shorter');
  assert.equal(updated()[b.id], '2026-10-14T21:00:00.000Z', 'a text edit, from the event log');

  store.postpone(c.id, '2026-10-16');
  clock.t = at('2026-10-16T14:00:00Z');
  assert.equal(updated()[c.id], '2026-10-16T13:00:00.000Z', 'the return from the postpone (9:00 in New York)');

  // A memo to an agent has no updated time: only the Inbox uses it.
  store.send({ from: 'cam', to: 'main', text: 'x' });
  assert.equal(store.list('main')[0].updated, undefined);
});

test('the Recently updated order puts the newest change first; Rank keeps the order of the server', () => {
  const memos = [
    { id: 1, created: '2026-10-01T00:00:00Z', updated: '2026-10-02T00:00:00Z' },
    { id: 2, created: '2026-10-03T00:00:00Z', updated: '2026-10-03T00:00:00Z' },
    { id: 3, created: '2026-09-01T00:00:00Z', updated: '2026-10-05T00:00:00Z' },
    { id: 4, created: '2026-10-02T00:00:00Z', updated: '2026-10-02T00:00:00Z' },
  ];
  assert.equal(sortedMemos(memos, 'rank'), memos, 'Rank: the same list');
  assert.deepEqual(sortedMemos(memos, 'updated').map((m) => m.id), [3, 2, 1, 4], 'equal times keep the rank order');
  assert.deepEqual(memos.map((m) => m.id), [1, 2, 3, 4], 'the sort does not change the list of the page');
  assert.deepEqual(sortedMemos([{ id: 5, created: '2026-10-01T00:00:00Z' }, { id: 6, created: '2026-10-09T00:00:00Z' }], 'updated').map((m) => m.id), [6, 5],
    'a memo with no updated time uses its send time');
  assert.deepEqual(SORTS.map(([v]) => v), ['rank', 'updated']);
  assert.equal(sortChoice('updated'), 'updated');
  assert.equal(sortChoice(null), 'rank', 'no saved choice: Rank');
  assert.equal(sortChoice('oldest'), 'rank', 'an unknown saved value: Rank');
});

test('the queue API sends updated with each memo, and the Inbox has the order menu saved on the device', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', { from: 'main', to: 'cam', text: 'one', impact: 3, effort: 'micro' });
  const { data } = await call(app, '/api/queue');
  assert.equal(typeof data.memos[0].updated, 'string');
  assert.equal(data.memos[0].updated, data.memos[0].created);
  const inbox = await (await app.request('/inbox')).text();
  assert.match(inbox, /<select id="sort" aria-label="Order"[^>]*><option value="rank">Rank<\/option><option value="updated">Recently updated<\/option><\/select>/);
  assert.match(inbox, /const SORT_KEY = 'memo-sort';/);
  assert.match(inbox, /try \{ sort = sortChoice\(localStorage\.getItem\(SORT_KEY\)\); \} catch/);
  assert.match(inbox, /try \{ localStorage\.setItem\(SORT_KEY, sort\); \} catch/);
});
