import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, ROOT } from './helpers.js';
import { isWork, shownMemos, step, countText } from '../ui/filter.js';

const get = async (path) => { const r = await makeApp().app.request(path); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };

test('the two pages and the two shared files need no token', async () => {
  const inbox = await get('/inbox');
  assert.equal(inbox.status, 200);
  assert.match(inbox.type, /text\/html/);
  assert.match(inbox.text, /<title>Memo Inbox<\/title>/);
  const agents = await get('/agents');
  assert.equal(agents.status, 200);
  assert.match(agents.text, /<title>Memo Agents<\/title>/);
  assert.match((await get('/ui/common.js')).type, /javascript/);
  assert.match((await get('/ui/common.css')).type, /text\/css/);
  assert.equal((await get('/')).status, 302);
});

test('the ui route gives only the two shared files', async () => {
  assert.equal((await get('/ui/inbox.html')).status, 404);
  assert.equal((await get('/ui/..%2F.env')).status, 404);
  assert.equal((await get('/ui/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await get('/ui/constructor')).status, 404);
});

test('the pages put text into the document only as text', () => {
  for (const name of readdirSync(join(ROOT, 'ui'))) {
    const source = readFileSync(join(ROOT, 'ui', name), 'utf8');
    for (const word of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!source.includes(word), `ui/${name} must not use ${word}`);
    }
  }
});

test('the pages load nothing from the internet', () => {
  for (const name of readdirSync(join(ROOT, 'ui'))) {
    const source = readFileSync(join(ROOT, 'ui', name), 'utf8');
    assert.ok(!/https?:\/\//.test(source), `ui/${name} must not contain a web address`);
  }
});

test('memo HTML can show only in a frame with no access to the page', () => {
  const source = readFileSync(join(ROOT, 'ui', 'markdown.js'), 'utf8');
  assert.equal(source.split("createElement('iframe')").length - 1, 1);
  assert.ok(source.includes("frame.setAttribute('sandbox', 'allow-scripts');"));
  for (const name of readdirSync(join(ROOT, 'ui'))) {
    const text = readFileSync(join(ROOT, 'ui', name), 'utf8');
    for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms']) assert.ok(!text.includes(word), `ui/${name} must not use ${word}`);
    if (name !== 'markdown.js') assert.ok(!text.includes('iframe') || name === 'common.js' || name === 'common.css', `ui/${name} must not make a frame`);
  }
  // The Inbox does not permit frames for memos that quote Discord text.
  assert.ok(readFileSync(join(ROOT, 'ui', 'inbox.html'), 'utf8').includes("html: !['liaison', 'discord'].includes(memo.sender)"));
  assert.ok(!readFileSync(join(ROOT, 'ui', 'agents.html'), 'utf8').includes('html:'));
});

test('the pages have a content rule that stops requests to other hosts', async () => {
  for (const path of ['/inbox', '/agents']) {
    const r = await makeApp().app.request(path);
    const rule = r.headers.get('content-security-policy') || '';
    for (const part of ["default-src 'self'", "connect-src 'self'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(rule.includes(part), `${path}: ${part}`);
  }
});

test('the Inbox links to the Agents page, and the Agents page links back', async () => {
  assert.match((await get('/inbox')).text, /href="\/agents"/);
  assert.match((await get('/agents')).text, /href="\/inbox"/);
});

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
