import test from 'node:test';
import assert from 'node:assert/strict';
import { workState, workSigns, signText } from '../ui/working.js';

const MEMO_AT = '2026-10-19T10:00:00.000Z';
const agent = (fields) => ({ name: 'main', status: '', updated: '', owner_open: 1, owner_since: MEMO_AT, ...fields });

test('no work from the owner gives no sign', () => {
  assert.equal(workState(agent({ owner_open: 0, owner_since: null })), null);
  assert.equal(workState(undefined), null);
  assert.deepEqual(workSigns(undefined), []);
});

test('a status after the memo tells that the agent works on it', () => {
  const sign = workState(agent({ status: 'I fix the toast.', updated: '2026-10-19T10:00:05.000Z' }));
  assert.deepEqual(sign, { name: 'main', state: 'working', status: 'I fix the toast.', count: 1 });
  assert.equal(signText(sign), 'main · working: I fix the toast.');
});

test('a status from before the memo, or no status, tells that the memo is queued', () => {
  const old = workState(agent({ status: 'I fix the toast.', updated: '2026-10-19T09:59:00.000Z', owner_open: 2 }));
  assert.equal(old.state, 'queued');
  assert.equal(signText(old), 'main · queued (2)');
  assert.equal(workState(agent({})).state, 'queued');
});

test('a status "Waiting ..." after the memo is not work', () => {
  for (const status of ['Waiting for memos.', 'waiting', '  Waiting: nothing to do']) {
    assert.equal(workState(agent({ status, updated: '2026-10-19T10:01:00.000Z' })).state, 'queued', status);
  }
  // A status that only contains the word is work.
  assert.equal(workState(agent({ status: 'Waitlist page: I add tests.', updated: '2026-10-19T10:01:00.000Z' })).state, 'working');
});

test('the signs keep the order of the agents and leave out the agents with no work', () => {
  const signs = workSigns([
    agent({ name: 'main', status: 'Build.', updated: '2026-10-19T10:02:00.000Z' }),
    agent({ name: 'idle', owner_open: 0, owner_since: null }),
    agent({ name: 'mac' }),
  ]);
  assert.deepEqual(signs.map((s) => [s.name, s.state]), [['main', 'working'], ['mac', 'queued']]);
});
