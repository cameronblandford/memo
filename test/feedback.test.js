import test from 'node:test';
import assert from 'node:assert/strict';
import { withFeedback, SENT_MS } from '../ui/feedback.js';

// A button for the test: only what withFeedback uses.
function fakeButton() {
  const classes = new Set();
  return { disabled: false, classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
}
const state = (b) => `${b.disabled ? 'off' : 'on'}:${[...b.classes].join(',')}`;

test('a send shows the spinner, then the check mark, then the button as it was', async () => {
  const button = fakeButton();
  const seen = [];
  let release;
  const waits = [];
  const done = withFeedback(button, async () => { seen.push(state(button)); await new Promise((r) => { release = r; }); },
    { wait: (ms) => { waits.push(ms); seen.push(state(button)); return Promise.resolve(); } });
  assert.equal(state(button), 'off:sending', 'the button is off at once');
  release();
  assert.equal(await done, true);
  assert.deepEqual(seen, ['off:sending', 'off:sent']);
  assert.deepEqual(waits, [SENT_MS]);
  assert.equal(state(button), 'on:');
});

test('a second tap while a memo goes out sends nothing', async () => {
  const button = fakeButton();
  let calls = 0;
  let release;
  const first = withFeedback(button, async () => { calls += 1; await new Promise((r) => { release = r; }); }, { wait: () => Promise.resolve() });
  assert.equal(await withFeedback(button, async () => { calls += 1; }, { wait: () => Promise.resolve() }), false);
  release();
  await first;
  assert.equal(calls, 1);
});

test('a send that fails gives the button back at once, with no check mark', async () => {
  const button = fakeButton();
  let waited = false;
  await assert.rejects(withFeedback(button, async () => { throw new Error('The server does not answer.'); }, { wait: () => { waited = true; return Promise.resolve(); } }), /does not answer/);
  assert.equal(state(button), 'on:');
  assert.equal(waited, false);
  // The next try works.
  assert.equal(await withFeedback(button, async () => {}, { wait: () => Promise.resolve() }), true);
});

test('with no button the action still runs, so a caller with no button cannot lose a memo', async () => {
  let calls = 0;
  assert.equal(await withFeedback(undefined, async () => { calls += 1; }), true);
  assert.equal(calls, 1);
  await assert.rejects(withFeedback(null, async () => { throw new Error('refused'); }), /refused/);
});
