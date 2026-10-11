import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { MemoError } from '../src/memos.js';
import { createTicks, placeTicks, MAX_ACTIVE } from '../src/ticks.js';
import { sortQueue, dueSoon } from '../src/rank.js';
import { makeApp, call, LIAISON_TOKEN } from './helpers.js';

// The tests use UTC and a day that starts at 03:00. 2026-10-12 is a Monday.
function make(start = '2026-10-12T12:00:00Z') {
  const clock = { at: Date.parse(start) };
  const ticks = createTicks(openDb(), { now: () => new Date(clock.at), dayStart: 3, timeZone: 'UTC' });
  const go = (iso) => { clock.at = Date.parse(iso); };
  return { ticks, go };
}
const refuses = (fn, status, part) => assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));
const SHOWER = { text: 'Shower', impact: 3, effort: 'short' };
const ids = (ticks) => ticks.due().map((t) => t.id);

test('a new tick is due each day until the owner does it', () => {
  const { ticks, go } = make();
  const t = ticks.add(SHOWER);
  assert.deepEqual(ticks.due(), [{ id: t.id, text: 'Shower', impact: 3, effort: 'short', overdue: false }]);
  ticks.done(t.id);
  assert.deepEqual(ids(ticks), []);
  go('2026-10-13T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
});

test('a tick that the owner did not do makes no backlog', () => {
  const { ticks, go } = make();
  ticks.add(SHOWER);
  go('2026-10-20T12:00:00Z');
  assert.equal(ticks.due().length, 1);
});

test('a skip removes the tick for today only, and undo brings it back', () => {
  const { ticks, go } = make();
  const t = ticks.add(SHOWER);
  assert.equal(ticks.skip(t.id).state, 'skip');
  assert.deepEqual(ids(ticks), []);
  ticks.undo(t.id);
  assert.deepEqual(ids(ticks), [t.id]);
  ticks.skip(t.id);
  go('2026-10-13T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
});

test('the day starts at 03:00, so a tick of the evening is still there after midnight', () => {
  const { ticks, go } = make('2026-10-12T23:00:00Z');
  const t = ticks.add(SHOWER);
  assert.equal(ticks.today().day, '2026-10-12');
  go('2026-10-13T02:59:00Z');
  assert.equal(ticks.today().day, '2026-10-12');
  ticks.done(t.id);
  go('2026-10-13T03:00:00Z');
  assert.equal(ticks.today().day, '2026-10-13');
  assert.deepEqual(ids(ticks), [t.id]);
});

test('a tick for some days of the week is due only on those days', () => {
  const { ticks, go } = make();
  const t = ticks.add({ ...SHOWER, days: 'Wed, mon' });
  assert.equal(t.days, 'mon,wed');
  assert.deepEqual(ids(ticks), [t.id]);
  go('2026-10-13T12:00:00Z');
  assert.deepEqual(ids(ticks), []);
  go('2026-10-14T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
  // 02:00 on Thursday is still the Wednesday of the owner.
  go('2026-10-15T02:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
});

test('a tick with "every" comes back that many days after the owner did it, and waits until then', () => {
  const { ticks, go } = make();
  const t = ticks.add({ text: 'Water the plants', impact: 2, effort: 'micro', every: 3 });
  assert.deepEqual(ids(ticks), [t.id], 'a tick that was never done is due');
  ticks.done(t.id);
  go('2026-10-14T12:00:00Z');
  assert.deepEqual(ids(ticks), []);
  go('2026-10-15T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
  go('2026-10-17T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id], 'it stays due on the next days, with no mark for the days between');
  ticks.done(t.id);
  go('2026-10-19T12:00:00Z');
  assert.deepEqual(ids(ticks), []);
  go('2026-10-20T12:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
});

test('a tick with "after" is not in the list before that time', () => {
  const { ticks, go } = make('2026-10-12T16:59:00Z');
  const t = ticks.add({ ...SHOWER, after: '17:00' });
  assert.deepEqual(ids(ticks), []);
  go('2026-10-12T17:00:00Z');
  assert.deepEqual(ids(ticks), [t.id]);
  go('2026-10-13T01:30:00Z');
  assert.deepEqual(ids(ticks), [t.id], 'after midnight is still the evening of the same day');
  go('2026-10-13T03:30:00Z');
  assert.deepEqual(ids(ticks), [], 'the next day starts before the time');
});

test('the time zone gives the day of the owner, not the day of the server', () => {
  const clock = Date.parse('2026-10-13T03:30:00Z'); // 23:30 on Monday in New York
  const ticks = createTicks(openDb(), { now: () => new Date(clock), dayStart: 3, timeZone: 'America/New_York' });
  assert.deepEqual(ticks.today(), { day: '2026-10-12', weekday: 'mon', minutes: 20 * 60 + 30 });
});

test('the limit is 5 active ticks, and a removed tick makes room', () => {
  const { ticks } = make();
  const made = Array.from({ length: MAX_ACTIVE }, (_, i) => ticks.add({ ...SHOWER, text: `Tick ${i}` }));
  refuses(() => ticks.add(SHOWER), 409, 'limit');
  assert.deepEqual(ticks.remove(made[0].id), { id: made[0].id, removed: true });
  assert.equal(ticks.add(SHOWER).text, 'Shower');
  refuses(() => ticks.done(made[0].id), 404, 'No tick');
});

test('add refuses wrong fields', () => {
  const { ticks } = make();
  refuses(() => ticks.add({ ...SHOWER, text: ' ' }), 400, 'text');
  refuses(() => ticks.add({ ...SHOWER, text: 'x'.repeat(81) }), 400, '80');
  refuses(() => ticks.add({ ...SHOWER, impact: 6 }), 400, 'impact');
  refuses(() => ticks.add({ ...SHOWER, effort: 'tiny' }), 400, 'effort');
  refuses(() => ticks.add({ ...SHOWER, days: 'monday' }), 400, 'days');
  refuses(() => ticks.add({ ...SHOWER, every: 0 }), 400, 'every');
  refuses(() => ticks.add({ ...SHOWER, after: '25:00' }), 400, 'after');
  assert.equal(ticks.add({ ...SHOWER, text: '  Take a\n shower ' }).text, 'Take a shower');
});

test('adjust changes the impact for the next days and stays in 1 to 5', () => {
  const { ticks, go } = make();
  const t = ticks.add({ ...SHOWER, impact: 4 });
  assert.equal(ticks.adjust(t.id, 1).impact, 5);
  assert.equal(ticks.adjust(t.id, 1).impact, 5);
  go('2026-10-13T12:00:00Z');
  assert.equal(ticks.due()[0].impact, 5);
  assert.equal(ticks.adjust(t.id, -1).impact, 4);
  refuses(() => ticks.adjust(t.id, 3), 400, 'delta');
});

test('set changes only the fields that it gets', () => {
  const { ticks } = make();
  const t = ticks.add({ ...SHOWER, days: 'mon' });
  const next = ticks.set(t.id, { text: 'Cold shower', after: '7:30' });
  assert.deepEqual([next.text, next.after, next.days, next.impact], ['Cold shower', '07:30', 'mon', 3]);
  assert.equal(ticks.set(t.id, { days: '' }).days, '');
  refuses(() => ticks.set(t.id, {}), 400, 'one field');
});

test('the log shows the marks of the last days, the newest day last', () => {
  const { ticks, go } = make();
  const t = ticks.add(SHOWER);
  ticks.done(t.id);
  go('2026-10-13T12:00:00Z');
  ticks.skip(t.id);
  go('2026-10-15T12:00:00Z');
  ticks.done(t.id);
  const [row] = ticks.log(5);
  assert.deepEqual(row.states, [null, 'done', 'skip', null, 'done']);
  assert.deepEqual([row.from, row.to, row.done, row.skipped], ['2026-10-11', '2026-10-15', 2, 1]);
  refuses(() => ticks.log(0), 400, 'days');
});

const memo = (id, impact, effort, due = null) => ({ id, impact, effort, due });
const tick = (id, impact, effort, overdue = false) => ({ id, impact, effort, overdue, text: `t${id}` });
const now = new Date(2026, 9, 12, 12);
const place = (memos, ticks) => placeTicks(sortQueue(memos, now), ticks, dueSoon(now)).map((t) => [t.id, t.before]);

test('a tick goes above the first memo that has a lower score', () => {
  // The scores of the memos: 4, 2, 1. The score of the tick: 3 / 2 = 1.5.
  const memos = [memo(1, 4, 'micro'), memo(2, 4, 'short'), memo(3, 3, 'hour')];
  assert.deepEqual(place(memos, [tick(9, 3, 'short')]), [[9, 3]]);
});

test('with an equal score the memo goes above the tick', () => {
  assert.deepEqual(place([memo(1, 4, 'short'), memo(2, 2, 'micro'), memo(3, 1, 'micro')], [tick(9, 2, 'micro')]), [[9, 3]]);
});

test('a tick below all memos goes to the end, and ticks keep their own order', () => {
  const memos = [memo(1, 5, 'micro')];
  assert.deepEqual(place(memos, [tick(8, 1, 'short'), tick(9, 2, 'short')]), [[9, null], [8, null]]);
});

test('a tick never goes above a memo with a due date that is near', () => {
  const memos = [memo(1, 1, 'day', '2026-10-13'), memo(2, 2, 'short')];
  assert.deepEqual(place(memos, [tick(9, 5, 'micro')]), [[9, 2]]);
});

test('the queue route gives the memos and the ticks with their places', async () => {
  const { app, ticks } = makeApp();
  await call(app, '/api/send', { from: 'main', to: 'cam', text: 'High?', impact: 5, effort: 'micro' });
  await call(app, '/api/send', { from: 'main', to: 'cam', text: 'Low?', impact: 1, effort: 'day' });
  const t = (await call(app, '/api/tick/add', { text: 'Shower', impact: 3, effort: 'short' })).data;
  let q = (await call(app, '/api/queue')).data;
  assert.deepEqual(q.memos.map((m) => m.text), ['High?', 'Low?']);
  assert.deepEqual(q.ticks, [{ id: t.id, text: 'Shower', impact: 3, effort: 'short', overdue: false, before: q.memos[1].id }]);
  assert.equal((await call(app, '/api/tick/adjust', { id: t.id, delta: 1 })).data.impact, 4);
  assert.equal((await call(app, '/api/tick/done', { id: t.id })).data.state, 'done');
  q = (await call(app, '/api/queue')).data;
  assert.deepEqual(q.ticks, []);
  assert.equal((await call(app, '/api/tick/undo', { id: t.id })).status, 200);
  assert.equal(ticks.due().length, 1);
  assert.equal((await call(app, '/api/ticks?log=3')).data[0].states.length, 3);
  assert.equal((await call(app, '/api/tick/remove', { id: t.id })).data.removed, true);
  assert.deepEqual((await call(app, '/api/ticks')).data, []);
});

test('the liaison token cannot read or change ticks', async () => {
  const { app } = makeApp();
  for (const path of ['/api/queue', '/api/ticks']) assert.equal((await call(app, path, undefined, LIAISON_TOKEN)).status, 403);
  for (const path of ['add', 'set', 'adjust', 'remove', 'done', 'skip', 'undo']) {
    assert.equal((await call(app, `/api/tick/${path}`, { id: 1, text: 'x', impact: 1, effort: 'micro' }, LIAISON_TOKEN)).status, 403);
  }
});

const late = (ticks) => ticks.due().map((t) => t.overdue);

test('a tick that the owner did not do on its last day is overdue', () => {
  const { ticks, go } = make();
  const t = ticks.add(SHOWER);
  assert.deepEqual(late(ticks), [false], 'a new tick is not overdue');
  go('2026-10-13T12:00:00Z');
  assert.deepEqual(late(ticks), [true]);
  ticks.done(t.id);
  go('2026-10-14T12:00:00Z');
  assert.deepEqual(late(ticks), [false]);
});

test('a skip is a decision, so the tick is not overdue on the next day', () => {
  const { ticks, go } = make();
  const t = ticks.add(SHOWER);
  ticks.skip(t.id);
  go('2026-10-13T12:00:00Z');
  assert.deepEqual(late(ticks), [false]);
});

test('for some days of the week, the last day of the schedule counts', () => {
  const { ticks, go } = make(); // Monday
  const t = ticks.add({ ...SHOWER, days: 'mon,wed' });
  go('2026-10-14T12:00:00Z'); // Wednesday: Monday has no mark
  assert.deepEqual(late(ticks), [true]);
  ticks.done(t.id);
  go('2026-10-19T12:00:00Z'); // the next Monday: Wednesday is done
  assert.deepEqual(late(ticks), [false]);
});

test('a tick with "every" is overdue after the day on which it came back', () => {
  const { ticks, go } = make();
  const t = ticks.add({ text: 'Call family', impact: 3, effort: 'short', every: 7 });
  ticks.done(t.id);
  go('2026-10-19T12:00:00Z'); // 7 days later: it is back
  assert.deepEqual(late(ticks), [false]);
  go('2026-10-20T12:00:00Z');
  assert.deepEqual(late(ticks), [true]);
  ticks.skip(t.id);
  go('2026-10-21T12:00:00Z');
  assert.deepEqual(late(ticks), [false], 'a skip gives one more day');
  go('2026-10-22T12:00:00Z');
  assert.deepEqual(late(ticks), [true]);
});

test('a tick with "by" is overdue after that time of the day', () => {
  const { ticks, go } = make('2026-10-12T09:59:00Z');
  ticks.add({ ...SHOWER, by: '10:00' });
  assert.deepEqual(late(ticks), [false]);
  go('2026-10-12T10:00:00Z');
  assert.deepEqual(late(ticks), [true]);
});

test('an overdue tick goes to the top of the list, above a memo with a due date', () => {
  const memos = [memo(1, 1, 'day', '2026-10-13'), memo(2, 5, 'micro'), memo(3, 2, 'short')];
  assert.deepEqual(place(memos, [tick(8, 3, 'short'), tick(9, 1, 'day', true)]), [[9, 1], [8, 3]]);
  assert.deepEqual(place([], [tick(9, 1, 'day', true)]), [[9, null]]);
});
