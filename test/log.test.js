import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/memos.js';
import { makeApp, call, LIAISON_TOKEN } from './helpers.js';

const NAMES = ['cam', 'discord', 'main', 'liaison'];
function makeStore() {
  const db = openDb();
  let t = Date.parse('2026-10-09T12:00:00Z');
  return { db, s: createStore(db, { owner: 'cam', names: NAMES, forwardTo: ['main'], now: () => new Date((t += 1000)) }) };
}
const toCam = { from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 4, effort: 'micro' };
const kinds = (s, memo) => s.events.list({ memo }).reverse().map((e) => `${e.actor} ${e.kind}`);

test('the events table is append-only', () => {
  const { db, s } = makeStore();
  s.send({ from: 'cam', to: 'main', text: 'Work.' });
  assert.throws(() => db.prepare("UPDATE events SET kind = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events').run(), /append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('each step of a memo is an event, and a detail has no full text', () => {
  const { s } = makeStore();
  const long = `Approve the deploy? ${'x'.repeat(500)}`;
  s.send({ ...toCam, text: long });
  s.brief(1, { title: 'Deploy' });
  s.note(1, 'cam', 'Which branch?');
  s.news('main');
  s.note(1, 'main', 'The branch main.');
  s.edit(1, 'Approve the deploy of main?');
  s.seen([1]);
  s.reply(1, 'Yes.');
  s.news('main');
  s.ack(1);
  assert.deepEqual(kinds(s, 1), ['main send', 'main brief', 'cam note', 'main delivered', 'main note', 'main edit', 'cam seen', 'cam reply', 'main delivered', 'main ack']);
  for (const e of s.events.list()) assert.ok(e.detail.length <= 80, e.detail);
  assert.equal(s.events.list({ memo: 1 }).at(-1).detail, `to cam: ${long}`.slice(0, 79).concat('…'));
});

test('a wait that asks again records one delivery for each change, and none for a held memo', () => {
  const { s } = makeStore();
  s.send({ from: 'cam', to: 'main', text: 'One.' });
  s.send({ from: 'cam', to: 'main', text: 'Two.' });
  for (let i = 0; i < 3; i++) s.news('main', { hold: [2] });
  assert.deepEqual(kinds(s, 1), ['cam send', 'main delivered']);
  assert.deepEqual(kinds(s, 2), ['cam send']);
  const main = s.inflight().find((a) => a.name === 'main');
  assert.deepEqual(main.poll.hold, [2]);
  assert.deepEqual(main.memos.map((m) => [m.id, m.stage, !!m.delivered, m.held]), [[1, 'open', true, false], [2, 'open', false, true]]);
  s.close(1, 'Done.');
  assert.deepEqual(kinds(s, 1), ['cam send', 'main delivered', 'main close']);
});

test('in flight shows the answers that the agent did not ack and the notes that it did not read', () => {
  const { s } = makeStore();
  s.send(toCam);
  s.send({ ...toCam, text: 'Second.' });
  s.reply(1, 'Yes.');
  s.note(2, 'cam', 'More data, please.');
  const main = s.inflight().find((a) => a.name === 'main');
  assert.deepEqual(main.memos.map((m) => [m.id, m.stage, m.delivered]), [[1, 'result', null], [2, 'note', null]]);
  s.news('main'); // main gets the answer and the note
  s.ack(1);
  s.note(2, 'main', 'The price is $14.'); // the answer: memo 2 goes back to cam
  assert.deepEqual(s.inflight().find((a) => a.name === 'main').memos, []);
  assert.equal(s.inflight().some((a) => a.name === 'cam' || a.name === 'discord'), false);
});

test('forward and postpone are events', () => {
  const { s } = makeStore();
  s.send(toCam);
  s.send(toCam);
  s.postpone(2, '2026-10-20');
  assert.deepEqual(kinds(s, 2), ['main send', 'cam postpone']);
  s.send({ from: 'discord', to: 'liaison', text: 'Hi', trusted: true });
  s.forward(3, 'main');
  assert.deepEqual(kinds(s, 3), ['discord send', 'liaison forward']);
});

test('the log api needs the full token, filters, and the status line is an event', async () => {
  const { app } = makeApp();
  assert.equal((await call(app, '/api/log', undefined, null)).status, 401);
  assert.equal((await call(app, '/api/log', undefined, LIAISON_TOKEN)).status, 403);
  await call(app, '/api/send', { from: 'cam', to: 'main', text: 'Work.' });
  await call(app, '/api/send', { from: 'cam', to: 'main', text: 'More work.' });
  await call(app, '/api/status', { agent: 'main', text: 'I do the work.' });
  await call(app, '/api/news?for=main&hold=2');
  const all = (await call(app, '/api/log')).data;
  assert.deepEqual(all.events.map((e) => `${e.actor} ${e.kind} ${e.memo_id ?? ''}`), ['main delivered 1', 'main status ', 'cam send 2', 'cam send 1']);
  const main = all.inflight.find((a) => a.name === 'main');
  assert.deepEqual(main.memos.map((m) => [m.id, m.held]), [[1, false], [2, true]]);
  assert.deepEqual((await call(app, '/api/log?memo=2')).data.events.map((e) => e.kind), ['send']);
  assert.deepEqual((await call(app, '/api/log?agent=liaison')).data.events, []);
  assert.equal((await call(app, '/api/log?memo=x')).status, 400);
});

test('memo list records a delivery, and a peek does not', async () => {
  const { app, store } = makeApp();
  await call(app, '/api/send', { from: 'discord', to: 'liaison', text: 'Hi' });
  await call(app, '/api/list?to=liaison&peek=1');
  assert.deepEqual(store.events.list({ memo: 1 }).map((e) => e.kind), ['send']);
  await call(app, '/api/list?to=liaison', undefined, LIAISON_TOKEN);
  assert.deepEqual(store.events.list({ memo: 1 }).map((e) => `${e.actor} ${e.kind}`), ['liaison delivered', 'discord send']);
});

test('the log page needs no token, and the Inbox and the Agents page link to it', async () => {
  const { app } = makeApp();
  const page = await app.request('/log');
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /<title>Memo Log<\/title>/);
  assert.match(text, /setInterval\(load, 5000\)/);
  for (const path of ['/inbox', '/agents']) assert.match(await (await app.request(path)).text(), /href="\/log"/);
});
