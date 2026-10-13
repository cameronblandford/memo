import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { isWork, shownMemos, step, countText } from '../ui/filter.js';

const get = async (path) => { const r = await makeApp().app.request(path); return { type: r.headers.get('content-type') || '', text: await r.text() }; };

test('a work ticket is a memo with the work code and a number', () => {
  assert.equal(isWork({ text: '**SUB-9: Work task 3: merge the pull request.**' }), true);
  assert.equal(isWork({ text: 'See SUB-10 for the details.' }), true);
  assert.equal(isWork({ text: 'The SUBJECT is ready. SUB- 4. ADM-3. sub-6.' }), false);
  assert.equal(isWork({ text: 'XSUB-6' }), false);
  assert.equal(isWork({}), false);
});

test('the work filter shows only work tickets, and the keys move through the memos that the list shows', () => {
  const memos = [{ id: 5, text: 'SUB-1 a' }, { id: 3, text: 'the tax form' }, { id: 9, text: 'SUB-2 b' }, { id: 4, text: 'a photo' }];
  assert.deepEqual(shownMemos(memos, false), memos);
  const work = shownMemos(memos, true);
  assert.deepEqual(work.map((c) => c.id), [5, 9]);
  assert.equal(step(work, 5, 1), 9, 'j goes over the hidden memo 3');
  assert.equal(step(work, 9, 1), 9, 'j stops at the end');
  assert.equal(step(work, 9, -1), 5);
  assert.equal(step(work, 5, -1), 5, 'k stops at the start');
  assert.equal(step(work, 3, 1), 5, 'a selection that is not in the list starts at the first memo');
  assert.equal(step(memos, 5, 1), 3);
  assert.equal(step([], 5, 1), null);
  assert.equal(countText(4, 4, false), '4 memos');
  assert.equal(countText(1, 1, false), '1 memo');
  assert.equal(countText(2, 4, true), '2 of 4 memos');
});

test('the Inbox has the work toggle, and j and k scroll with no animation', async () => {
  const inbox = (await get('/inbox')).text;
  assert.match(inbox, /<button id="work-only" type="button" aria-pressed="false"/);
  assert.match(inbox, /scrollIntoView\(\{ behavior: 'instant', block: 'nearest' \}\)/);
  assert.match((await get('/ui/filter.js')).type, /javascript/);
  assert.doesNotMatch((await get('/ui/common.css')).text, /scroll-behavior/);
});
