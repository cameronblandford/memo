import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, ROOT } from './helpers.js';
import { enterSends, fieldHeight } from '../ui/keys.js';

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

test('the capture field has many lines and the page loads its key rules', async () => {
  const inbox = (await get('/inbox')).text;
  assert.match(inbox, /<textarea name="text"[^>]*aria-label="Task"/);
  assert.doesNotMatch(inbox, /<input name="text"/);
  assert.match((await get('/ui/keys.js')).type, /javascript/);
});

test('in the capture field Enter sends and Shift+Enter adds a line', () => {
  const key = (more = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, ...more });
  assert.equal(enterSends(key(), false), true);
  assert.equal(enterSends(key({ shiftKey: true }), false), false);
  assert.equal(enterSends(key({ altKey: true }), false), false);
  assert.equal(enterSends(key({ isComposing: true }), false), false, 'Enter that confirms an input method text does not send');
  assert.equal(enterSends(key({ keyCode: 229 }), false), false, 'Safari: the Enter after the composition ends has the key code 229');
  assert.equal(enterSends(key({ repeat: true }), false), false, 'a held key does not send again');
  assert.equal(enterSends(key({ key: 'a' }), false), false);
  assert.equal(enterSends(key(), true), false, 'on a touch screen Enter adds a line');
});

test('the capture field grows to a limit', () => {
  assert.equal(fieldHeight(40.2, 300), 41);
  assert.equal(fieldHeight(900, 300), 300);
  assert.equal(fieldHeight(-5, 300), 0);
});

test('the capture form does not send again while a memo goes out', async () => {
  const inbox = (await get('/inbox')).text;
  assert.match(inbox, /if \(sending\) return;/);
  assert.match(inbox, /finally \{ sending = false; \}/);
});
