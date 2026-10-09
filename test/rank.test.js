import test from 'node:test';
import assert from 'node:assert/strict';
import { sortQueue, WEIGHTS, EFFORTS, DUE_SOON_DAYS } from '../src/rank.js';

const now = new Date(2026, 9, 9, 12); // 9 October 2026, 12:00 local time
const memo = (id, impact, effort, due = null) => ({ id, impact, effort, due });
const ids = (memos) => sortQueue(memos, now).map((c) => c.id);

test('the constants are those of the specification', () => {
  assert.deepEqual(WEIGHTS, { micro: 1, short: 2, hour: 3, 'half-day': 5, day: 8 });
  assert.deepEqual(EFFORTS, ['micro', 'short', 'hour', 'half-day', 'day']);
  assert.equal(DUE_SOON_DAYS, 2);
});

test('the highest impact for each unit of effort goes first', () => {
  const memos = [memo(1, 1, 'micro'), memo(2, 5, 'half-day'), memo(3, 5, 'hour'), memo(4, 5, 'short'), memo(5, 4, 'micro'), memo(6, 3, 'day')];
  assert.deepEqual(ids(memos), [5, 4, 3, 1, 2, 6]);
});

test('with equal scores, the older memo goes first', () => {
  assert.deepEqual(ids([memo(9, 2, 'short'), memo(3, 1, 'micro'), memo(7, 5, 'half-day')]), [3, 7, 9]);
});

test('a memo with a due date in the next 2 days goes above all others', () => {
  assert.deepEqual(ids([memo(1, 5, 'micro'), memo(2, 1, 'day', '2026-10-11')]), [2, 1]);
});

test('a due date after the next 2 days does not change the order', () => {
  assert.deepEqual(ids([memo(1, 5, 'micro'), memo(2, 1, 'day', '2026-10-12')]), [1, 2]);
});

test('an overdue memo goes first, and the earliest due date leads', () => {
  assert.deepEqual(ids([memo(1, 5, 'micro'), memo(2, 1, 'day', '2026-10-10'), memo(3, 1, 'day', '2026-10-01')]), [3, 2, 1]);
});

test('two memos with the same near due date sort by score', () => {
  assert.deepEqual(ids([memo(1, 1, 'day', '2026-10-10'), memo(2, 5, 'micro', '2026-10-10')]), [2, 1]);
});

test('a memo with no impact or effort goes last and causes no error', () => {
  assert.deepEqual(ids([memo(1, null, null), memo(2, 1, 'day')]), [2, 1]);
});

test('the input array does not change', () => {
  const memos = [memo(1, 1, 'day'), memo(2, 5, 'micro')];
  sortQueue(memos, now);
  assert.deepEqual(memos.map((c) => c.id), [1, 2]);
});
