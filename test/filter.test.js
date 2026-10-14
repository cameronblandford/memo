import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { isWork, shownMemos, step, countText, matches, filterChoices, tagSuggestions, STARTER_TAGS, todayIn, addDays, nextMonday, dueWarning } from '../ui/filter.js';

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
  assert.deepEqual(shownMemos(memos, 'all'), memos);
  const work = shownMemos(memos, 'work');
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

test('the Inbox has the filter in the top bar, and j and k scroll with no animation', async () => {
  const inbox = (await get('/inbox')).text;
  assert.match(inbox, /<select id="filter" aria-label="Filter"/);
  // A device that had "Work only" on starts with the Work filter.
  assert.match(inbox, /localStorage\.getItem\('memo-work-only'\) === '1' \? 'work' : 'all'/);
  assert.match(inbox, /setFilter\(filter === 'work' \? 'all' : 'work'\)/);
  assert.match(inbox, /scrollIntoView\(\{ behavior: 'instant', block: 'nearest' \}\)/);
  assert.match((await get('/ui/filter.js')).type, /javascript/);
  assert.doesNotMatch((await get('/ui/common.css')).text, /scroll-behavior/);
});

test('the filter has All, Work, Personal, and each tag in use; a memo with the tag work is a work memo', () => {
  const memos = [
    { id: 1, text: 'SUB-4 the review', tags: [] },
    { id: 2, text: 'the dentist', tags: ['health'] },
    { id: 3, text: 'the rent', tags: ['money', 'work'] },
    { id: 4, text: 'a photo', tags: [] },
  ];
  assert.equal(isWork(memos[2]), true, 'the tag work makes a work memo');
  assert.deepEqual(shownMemos(memos, 'work').map((m) => m.id), [1, 3]);
  assert.deepEqual(shownMemos(memos, 'personal').map((m) => m.id), [2, 4]);
  assert.deepEqual(shownMemos(memos, 'tag:money').map((m) => m.id), [3]);
  assert.equal(matches(memos[3], 'tag:money'), false);
  assert.deepEqual(filterChoices(memos), [['all', 'All'], ['work', 'Work'], ['personal', 'Personal'], ['tag:health', '#health'], ['tag:money', '#money']]);
  // A saved tag filter with no memo now stays a choice, so the menu does not change under the owner.
  assert.deepEqual(filterChoices([], 'tag:home').at(-1), ['tag:home', '#home']);
  assert.deepEqual(tagSuggestions(memos, memos[2]), [...new Set([...STARTER_TAGS, 'health'])].filter((t) => !['money', 'work'].includes(t)).sort());
});

test('the postpone dates are in the owner\'s zone, and the picker warns when the memo is due before it comes back', () => {
  // 03:00 UTC on Thursday 15 October is still Wednesday 14 October in New York.
  const now = new Date('2026-10-15T03:00:00Z');
  assert.equal(todayIn('America/New_York', now), '2026-10-14');
  assert.equal(todayIn('UTC', now), '2026-10-15');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(nextMonday('2026-10-14'), '2026-10-19', 'Wednesday to the next Monday');
  assert.equal(nextMonday('2026-10-18'), '2026-10-19', 'Sunday to the next day');
  assert.equal(nextMonday('2026-10-19'), '2026-10-26', 'a Monday goes to the Monday after');
  assert.match(dueWarning({ due: '2026-10-16' }, '2026-10-19'), /due 2026-10-16/);
  assert.equal(dueWarning({ due: '2026-10-20' }, '2026-10-19'), '');
  assert.equal(dueWarning({}, '2026-10-19'), '');
});
