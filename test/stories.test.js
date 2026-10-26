// Stories: the table, the requests for summaries to main, the weekly request, the history, and the routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore, MemoError } from '../src/memos.js';
import { createStories, SUMMARY_TAG } from '../src/stories.js';
import { makeApp, call, LIAISON_TOKEN } from './helpers.js';

function setup(at = '2026-10-21T12:00:00.000Z') {
  const clock = { now: new Date(at) };
  const now = () => clock.now;
  const db = openDb();
  const store = createStore(db, { owner: 'cam', names: ['cam', 'discord', 'main', 'liaison'], forwardTo: ['main'], now });
  const stories = createStories(db, { store, owner: 'cam', agent: 'main', timeZone: 'America/New_York', now });
  return { db, store, stories, clock };
}
const refuses = (fn, status, part) => assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));
const requests = (db) => db.prepare("SELECT * FROM memos WHERE ',' || tags || ',' LIKE ? ORDER BY id").all(`%,${SUMMARY_TAG},%`);

test('a story has a tag as its key, a title, and a text; set changes the title and the text, not the key', () => {
  const { stories } = setup();
  const s = stories.set({ key: 'Body', title: 'Feel good in my body', about: 'Strong, rested, no pain.' });
  assert.equal(s.key, 'body');
  assert.equal(s.summary, null);
  assert.equal(stories.set({ key: 'body', title: 'Feel good in my body!' }).title, 'Feel good in my body!');
  assert.equal(stories.list().length, 1);
  refuses(() => stories.set({ key: 'no space', title: 'x' }), 400, 'is a tag');
  refuses(() => stories.set({ key: 'sleep', title: '' }), 400, 'needs a title');
  refuses(() => stories.set({ key: 'sleep', title: 'a\nb' }), 400, 'one line');
  refuses(() => stories.get('missing'), 404, 'No story');
});

test('a memo with the tag of the story is in the story, also a closed memo and a request of the owner', () => {
  const { store, stories } = setup();
  stories.set({ key: 'body', title: 'Body' });
  const a = store.send({ from: 'main', to: 'cam', impact: 2, effort: 'short', text: 'Pick a gym', tags: ['body', 'money'] }).memo;
  const b = store.send({ from: 'cam', to: 'main', text: 'Find a physio' }).memo;
  store.send({ from: 'main', to: 'cam', impact: 2, effort: 'short', text: 'Not in the story', tags: ['bodywork'] });
  store.tag(b.id, 'body', true);
  store.close(a.id, 'Done');
  const s = stories.get('body');
  assert.equal(s.count, 2);
  assert.deepEqual(s.memos.map((m) => [m.id, m.state, m.title]), [[b.id, 'open', 'Find a physio'], [a.id, 'closed', 'Pick a gym']]);
});

test('the summary comes from the agent and replaces the earlier one', () => {
  const { stories, clock } = setup();
  stories.set({ key: 'sleep', title: 'Sleep well' });
  stories.writeSummary('sleep', 'First');
  clock.now = new Date('2026-10-22T12:00:00.000Z');
  const s = stories.writeSummary('sleep', '**Second**');
  assert.equal(s.summary, '**Second**');
  assert.equal(s.summary_at, '2026-10-22T12:00:00.000Z');
  refuses(() => stories.writeSummary('sleep', '  '), 400, 'empty');
});

test('ask sends main one request memo for a story, and not a second one while it is open', () => {
  const { db, store, stories } = setup();
  refuses(() => stories.ask(null), 400, 'no story');
  stories.set({ key: 'body', title: 'Feel good in my body' });
  stories.set({ key: 'work', title: 'Grow at work' });
  const first = stories.ask('body');
  assert.equal(first.sent, true);
  assert.deepEqual(stories.ask('body'), { memo: first.memo, sent: false });
  assert.equal(stories.get('body').request, first.memo);
  const all = stories.ask(null);
  assert.equal(all.sent, true);
  const memos = requests(db);
  assert.deepEqual(memos.map((m) => [m.sender, m.recipient]), [['cam', 'main'], ['cam', 'main']]);
  assert.match(memos[0].text, /^Write the summary of the story body: Feel good in my body\./);
  assert.match(memos[1].text, /^Write the summaries of all stories: body, work\./);
  store.close(first.memo, 'Saved.');
  assert.equal(stories.ask('body').sent, true, 'after the close, a new request goes out');
});

test('weekly sends one request for all stories on Sunday after 9:00 in the zone of the owner, one time', () => {
  const { db, stories, clock } = setup('2026-10-25T12:59:00.000Z'); // Sunday 8:59 in New York
  assert.equal(stories.weekly(), null, 'no story: no request');
  stories.set({ key: 'body', title: 'Body' });
  assert.equal(stories.weekly(), null, 'before 9:00');
  clock.now = new Date('2026-10-25T13:00:00.000Z');
  assert.equal(stories.weekly().sent, true);
  assert.equal(stories.weekly(), null, 'one time on the day');
  clock.now = new Date('2026-10-26T13:30:00.000Z'); // Monday
  assert.equal(stories.weekly(), null);
  assert.equal(requests(db).length, 1);
});

test('history gives the memos of the last days in a short form, with no Discord mail and no requests', () => {
  const { store, stories, clock } = setup('2026-10-01T12:00:00.000Z');
  store.send({ from: 'main', to: 'cam', impact: 1, effort: 'micro', text: 'Old memo' });
  clock.now = new Date('2026-10-20T12:00:00.000Z');
  const m = store.send({ from: 'cam', to: 'main', text: '# Run three times\nthis week' }).memo;
  store.close(m.id, 'Ran on Monday, Wednesday, and Friday.');
  store.send({ from: 'discord', to: 'liaison', text: 'Hi' });
  stories.set({ key: 'body', title: 'Body' });
  stories.ask('body');
  const h = stories.history(7);
  assert.deepEqual(h.map((x) => [x.id, x.title, x.result]), [[m.id, 'Run three times', 'Ran on Monday, Wednesday, and Friday.']]);
  assert.equal(stories.history(30).length, 2);
  refuses(() => stories.history(0), 400, 'days');
});

test('the routes need the full token', async () => {
  const { app } = makeApp();
  assert.equal((await call(app, '/api/story', { key: 'body', title: 'Body' })).status, 200);
  assert.equal((await call(app, '/api/stories')).data.length, 1);
  assert.equal((await call(app, '/api/story?key=body')).data.title, 'Body');
  assert.equal((await call(app, '/api/story/summary', { key: 'body', text: 'Good' })).data.summary, 'Good');
  assert.equal((await call(app, '/api/story/ask', { key: 'body' })).data.sent, true);
  assert.equal((await call(app, '/api/history?days=3')).status, 200);
  assert.equal((await call(app, '/api/stories', null, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/story/summary', { key: 'body', text: 'x' }, LIAISON_TOKEN)).status, 403);
});
