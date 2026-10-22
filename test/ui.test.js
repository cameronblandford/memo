import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, ROOT } from './helpers.js';
import { enterSends, fieldHeight } from '../ui/keys.js';
import { MAX_BYTES, sendsAsIs, fit, withImage, imageNames } from '../ui/attach.js';

const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
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
  assert.match((await get('/ui/working.js')).type, /javascript/);
  assert.equal((await get('/')).status, 302);
});

test('the ui route gives only the two shared files', async () => {
  assert.equal((await get('/ui/inbox.html')).status, 404);
  assert.equal((await get('/ui/..%2F.env')).status, 404);
  assert.equal((await get('/ui/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await get('/ui/constructor')).status, 404);
});

test('each name that a page imports from a ui module is exported by that module', async () => {
  for (const name of readdirSync(join(ROOT, 'ui')).filter((n) => n.endsWith('.html') || n.endsWith('.js'))) {
    const source = readFileSync(join(ROOT, 'ui', name), 'utf8');
    for (const [, names, file] of source.matchAll(/import \{([^}]+)\} from '\/ui\/([a-z-]+\.js)'/g)) {
      const mod = await import(`../ui/${file}`).catch(() => null);
      if (!mod) continue; // a module with browser-only code cannot load in node
      for (const n of names.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(n in mod, `ui/${name} imports ${n}, but ui/${file} does not export it`);
      }
    }
  }
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

test('the pages can attach an image', async () => {
  assert.match((await get('/ui/attach.js')).type, /javascript/);
  const common = (await get('/ui/common.js')).text;
  assert.match(common, /accept: 'image\/png,image\/jpeg,image\/gif,image\/webp'/);
  assert.match((await get('/inbox')).text, /attach\(capture\.elements\.text/);
});

test('a small image goes as it is, and a large photo or an unknown type becomes a JPEG first', () => {
  assert.equal(sendsAsIs('image/png', 200_000), true);
  assert.equal(sendsAsIs('image/jpeg', 1_000_000), true);
  assert.equal(sendsAsIs('image/jpeg', 4_000_000), false, 'a large photo gets smaller');
  assert.equal(sendsAsIs('image/heic', 200_000), false);
  assert.equal(sendsAsIs('image/svg+xml', 2_000), false);
  assert.equal(sendsAsIs('image/gif', 4_000_000), true, 'a GIF can move, so it stays a GIF');
  assert.equal(sendsAsIs('image/gif', MAX_BYTES + 1), false);
});

test('an image that the browser makes smaller keeps its shape', () => {
  assert.deepEqual(fit(4032, 3024, 2400), { width: 2400, height: 1800 });
  assert.deepEqual(fit(3024, 4032, 2400), { width: 1800, height: 2400 });
  assert.deepEqual(fit(800, 600, 2400), { width: 800, height: 600 });
  assert.deepEqual(fit(0, 0, 2400), { width: 1, height: 1 });
});

test('an attached image is a Markdown line at the end of the text', () => {
  const name = '0123456789abcdef.jpg';
  assert.equal(withImage('', name), `![image](image:${name})\n`);
  assert.equal(withImage('The pain is here:\n', name), `The pain is here:\n\n![image](image:${name})\n`);
  const two = withImage(withImage('See', name), 'fedcba9876543210.png');
  assert.deepEqual(imageNames(two), [name, 'fedcba9876543210.png']);
  assert.deepEqual(imageNames(`${two}${two}`), [name, 'fedcba9876543210.png'], 'each name one time');
  assert.deepEqual(imageNames('![x](image:../../etc/passwd) ![y](https://example.com/a.png) ![z](image:0123.png)'), []);
  assert.deepEqual(imageNames(undefined), []);
});

test('the send buttons show a spinner, then a check mark, and do not send two times', async () => {
  const inbox = (await get('/inbox')).text;
  assert.match(inbox, /send\(sendButton, async \(\) => \{/);
  assert.match(inbox, /button\('Send', \(b\) => reply\(memo, area\.value, b\)/);
  // Each caller of reply and close gives a button: the key Command-Return gives the Send button.
  assert.match(inbox, /reply\(memo, area\.value, sendButtons\[0\]\)/);
  assert.doesNotMatch(inbox, /reply\(memo, area\.value\)/);
  assert.doesNotMatch(inbox, /addNote/, 'Send replaces Reply and Note');
  assert.doesNotMatch(inbox, /close\(memo\)/);
  assert.match((await get('/ui/feedback.js')).type, /javascript/);
  const css = (await get('/ui/common.css')).text;
  assert.match(css, /button\.sending::after/);
  assert.match(css, /button\.sent::after/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('a check box with the focus does not stop the keys and the refresh', async () => {
  assert.match((await get('/inbox')).text, /at\.type !== 'checkbox'/);
});

test('a click on a memo image opens the lightbox, not a new tab', async () => {
  assert.match((await get('/ui/lightbox.js')).type, /javascript/);
  const common = (await get('/ui/common.js')).text;
  assert.doesNotMatch(common, /window\.open/);
  assert.match(common, /import \{ openLightbox \} from '\/ui\/lightbox\.js'/);
  // The Inbox calls loadImages at each refresh: an image must not get a second listener.
  assert.match(common, /if \(img\.dataset\.zoom\) continue;/);
  // The keyboard can open it too.
  assert.match(common, /img\.tabIndex = 0;/);
  assert.match(common, /event\.key !== 'Enter' && event\.key !== ' '/);
});

test('the lightbox is a modal dialog with a caption, a close button, Escape, and a link to the original', async () => {
  const box = (await get('/ui/lightbox.js')).text;
  assert.match(box, /dialog\.showModal\(\)/);
  assert.match(box, /caption\.textContent = img\.alt/);
  assert.match(box, /'Open original'/);
  assert.match(box, /target: '_blank', rel: 'noopener'/);
  assert.match(box, /setAttribute\('aria-label', 'Close the image'\)/);
  // Escape closes a modal dialog in the browser. All the ways to close end in the close event, which gives the focus back.
  assert.match(box, /addEventListener\('close', \(\) => \{[^}]*opener\.focus\(\)/s);
  assert.match(box, /event\.target === dialog \|\| event\.target === figure/);
  assert.match(box, /'ArrowRight'/);
  assert.match(box, /'ArrowLeft'/);
});

test('the lightbox does not block pinch-zoom on a phone', async () => {
  const css = (await get('/ui/common.css')).text;
  const box = (await get('/ui/lightbox.js')).text;
  assert.doesNotMatch(css, /touch-action\s*:/);
  assert.doesNotMatch(box, /preventDefault/);
  assert.doesNotMatch((await get('/inbox')).text, /user-scalable|maximum-scale/);
  assert.match(css, /\.lightbox \{[^}]*var\(--bg\)/, 'the backdrop follows the light or dark page color');
});

test('the lightbox steps round the images of a memo, and a swipe must be long and sideways', async () => {
  const { stepIndex, swipeStep } = await import('../ui/lightbox.js');
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), 0);
  assert.equal(stepIndex(0, 3, -1), 2);
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(swipeStep(-80, 10), 1, 'a move to the left goes to the next image');
  assert.equal(swipeStep(80, -5), -1, 'a move to the right goes to the previous image');
  assert.equal(swipeStep(-30, 0), 0, 'a short move does nothing');
  assert.equal(swipeStep(-80, 70), 0, 'a move that is mostly down does nothing');
});

test('the Inbox keys do not act behind the lightbox, and draft thumbnails are not part of the memo images', async () => {
  const box = (await get('/ui/lightbox.js')).text;
  // The Inbox listens for its keys on the document. The dialog stops each key before it gets there.
  assert.match((await get('/inbox')).text, /document\.addEventListener\('keydown'/);
  assert.match(box, /addEventListener\('keydown', \(event\) => \{\s*(\/\/[^\n]*\n\s*)*event\.stopPropagation\(\);/);
  const common = (await get('/ui/common.js')).text;
  assert.match(common, /img\.closest\('\.thumbs'\) \|\| img\.closest\('\.memo, \.bubble'\)/);
  assert.match(common, /draft \|\| !i\.closest\('\.thumbs'\)/);
});

test('each card shows the name, the next step, the buttons, and the thread; the full text opens under Details', async () => {
  const page = (await get('/inbox')).text;
  const card = page.slice(page.indexOf('function view(memo) {'), page.indexOf('// The text of a memo, with its check boxes'));
  assert.ok(card.length > 100);
  assert.match(card, /el\('div', \{ className: 'name' \}, titleOf\(memo\)\),\n    nextOf\(memo\),/);
  assert.match(card, /choicesOf\(memo\),\n    detailsOf\(memo, asked\),\n    threadOf\(memo\),/);
  assert.doesNotMatch(card, /bodyOf\(|notesOf\(/, 'the text is only in Details');
  assert.match(page, /const titleOf = \(memo\) => memo\.title \|\| summary\(memo\.text\) \|\| `Memo \$\{memo\.id\}`;/);
  assert.match(page, /el\('details', \{ className: 'details', open: openDetails\.has\(memo\.id\) \},\n    el\('summary', \{\}, 'Details'/);
  assert.match(page, /el\('summary', \{\}, 'Details'\),\n    bodyOf\(memo, asked, readOnly\)\);/);
  assert.match(page, /const threadOf = \(memo\) => turnsOf\(memo, OWNER, markdown\);/);
  // The key o opens or closes the Details of the selected memo, in the list and on the card.
  assert.match(page, /else if \(event\.key === 'o'\) toggleDetails\(selected\);/);
  assert.match(page, /else if \(event\.key === 'o'\) toggleDetails\(cardId\);/);
});

test('Collapse, Shorten, and the compact view are gone', async () => {
  const page = (await get('/inbox')).text;
  for (const gone of ['id="compact"', 'Collapse', 'Shorten', 'briefView', 'COMPACT_KEY', 'collapseAll', "'memo-compact'", 'shownNotes']) {
    assert.ok(!page.includes(gone), `the Inbox must not have ${gone}`);
  }
  const filter = await import('../ui/filter.js');
  assert.equal(filter.COMPACT_NOTE, undefined);
  const css = (await get('/ui/common.css')).text;
  assert.doesNotMatch(css, /#compact|\.memo\.brief/);
  assert.doesNotMatch(read('README.md'), /memo compact|Shorten|Collapse/);
  for (const name of ['main.md', 'liaison.md']) assert.doesNotMatch(read('charters', name), /compact/);
});

test('the answer buttons: one button for each choice of the sender, and a tap sends that word (Send)', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /const choicesOf = \(memo, onDone\) => \(memo\.choices\?\.length \? el\('div', \{ className: 'choices'/);
  assert.match(page, /\.\.\.memo\.choices\.map\(\(word\) => button\(word, \(b\) => send\(b, async \(\) => \{ await api\('\/api\/note', \{ id: memo\.id, from: OWNER, text: word \}\);/);
  // On the card of the one-card view too, where the answer counts in the summary.
  const card = page.slice(page.indexOf('function cardView('), page.indexOf('function summaryView('));
  assert.match(card, /choicesOf\(memo, done\('Sent'\)\)/);
  // The free text stays.
  assert.match(page, /button\('Send', \(b\) => reply\(memo, area\.value, b\)/);
});

test('threads: Send is a note of the owner, Done is a close, and the memos that wait show in their own section', async () => {
  const page = (await get('/inbox')).text;
  const reply = page.slice(page.indexOf('const reply = '), page.indexOf('const close = '));
  assert.match(reply, /api\('\/api\/note', \{ id: memo\.id, from: OWNER, text \}\)/);
  assert.doesNotMatch(page, /'\/api\/reply'/, 'the Inbox never ends a memo with a reply');
  assert.match(page, /button\('Done', \(b\) => close\(memo, b\), 'End the memo\. The text in the field goes with it\.'\)/);
  assert.match(page, /<section id="waiting" hidden>/);
  assert.match(page, /waitingToggle\.textContent = `Waiting for agents \(\$\{waitingMemos\.length\}\)`;/);
  assert.match(page, /waitingMemos = data\.waiting \|\| \[\];/);
  // A memo that waits shows its thread read-only, with Done.
  const wait = page.slice(page.indexOf('function waitingView('), page.indexOf('function showWaiting('));
  assert.match(wait, /detailsOf\(memo, parseRule\(memo\.text\), true\)/);
  assert.match(wait, /threadOf\(memo\)/);
  assert.match(wait, /button\('Done', \(b\) => close\(memo, b\)/);
  const { stateText, lastTurnAt } = await import('../ui/chat.js');
  const m = { sender: 'main', recipient: 'cam', created: 'a' };
  assert.equal(stateText({ ...m, state: 'open' }, 'cam'), 'waits for you');
  assert.equal(stateText({ ...m, state: 'waiting' }, 'cam'), 'waits for main');
  assert.equal(stateText({ sender: 'cam', recipient: 'main', state: 'open' }, 'cam'), 'waits for main');
  assert.equal(stateText({ ...m, state: 'replied' }, 'cam'), 'answered', 'an old replied memo');
  assert.equal(stateText({ ...m, state: 'closed' }, 'cam'), 'closed');
  assert.equal(lastTurnAt(m), 'a');
  assert.equal(lastTurnAt({ ...m, notes: [{ created: 'b' }, { created: 'c' }] }), 'c');
  assert.match((await get('/ui/common.css')).text, /\.meta \.state\.away \{ border-color: var\(--warn\); color: var\(--warn\); \}/);
});

test('the fold: memos with no change for 5 days go to the bottom, and Close all asks in the page', async () => {
  const { isOld, splitOld, OLD_DAYS } = await import('../ui/filter.js');
  const now = Date.parse('2026-10-22T12:00:00Z');
  const day = 86400000;
  const at = (ms) => new Date(ms).toISOString();
  assert.equal(OLD_DAYS, 5);
  assert.equal(isOld({ created: at(now - 6 * day) }, now), true);
  assert.equal(isOld({ created: at(now - 4 * day) }, now), false);
  assert.equal(isOld({ created: at(now - 9 * day), updated: at(now - day) }, now), false, 'a new note or edit keeps the memo out of the fold');
  assert.equal(isOld({ created: at(now - 5 * day) }, now), true);
  assert.equal(isOld({}, now), false);
  const list = [{ id: 1, created: at(now - 7 * day) }, { id: 2, created: at(now) }, { id: 3, created: at(now - 8 * day) }, { id: 4, created: at(now - day) }];
  const { fresh, old } = splitOld(list, now);
  assert.deepEqual(fresh.map((m) => m.id), [2, 4]);
  assert.deepEqual(old.map((m) => m.id), [1, 3], 'each part keeps the order of the list');
  const page = (await get('/inbox')).text;
  assert.match(page, /queue\.replaceChildren\(\.\.\.fresh\.map\(view\), \.\.\.\(old\.length \? \[foldView\(old\)\] : \[\]\)\);/);
  assert.match(page, /`Older than \$\{OLD_DAYS\} days \(\$\{n\}\)`/);
  assert.match(page, /button\('Yes, close all', \(b\) => closeAll\(old\.map\(\(m\) => m\.id\), b\)/);
  assert.match(page, /button\('Close all', \(\) => \{ foldAsk = true; render\(\);/);
  assert.ok(!/\bconfirm\(/.test(page), 'no confirm() dialog');
  assert.match(page, /await api\('\/api\/close', \{ id \}\);/);
});

test('the selection marks a card in the fold too, and j and k go into the fold only while it is open', async () => {
  const page = (await get('/inbox')).text;
  const select = page.slice(page.indexOf('function select(id) {'), page.indexOf('\n}\n', page.indexOf('function select(id) {')));
  assert.match(select, /for \(const node of queue\.querySelectorAll\('\.memo'\)\) node\.classList\.toggle\('selected', Number\(node\.dataset\.id\) === id\);/);
  assert.doesNotMatch(select, /queue\.children/, 'the cards in the fold are not direct children of the queue');
  assert.match(page, /if \(!foldOpen && old\.some\(\(m\) => m\.id === selected\)\) selected = fresh\[0\]\?\.id \?\? null;/);
  assert.match(page, /const list = shown\(\)\.filter\(\(m\) => foldOpen \|\| !isOld\(m\)\);\n  if \(!list\.length\) return;\n  if \(event\.key === 'j' \|\| event\.key === 'k'\) \{/);
});

test('back from the one-card view, the list keeps the memo of the card, and opens the fold for an old memo', async () => {
  const page = (await get('/inbox')).text;
  const setView = page.slice(page.indexOf('function setView(card) {'), page.indexOf('\n}\n', page.indexOf('function setView(card) {')));
  assert.match(setView, /selected = cardId;\n[^\n]*\n    if \(memos\.some\(\(m\) => m\.id === cardId && isOld\(m\)\)\) foldOpen = true;/);
  // The fold opens before render, so render does not move the selection away from the old memo.
  assert.ok(setView.indexOf('foldOpen = true') < setView.indexOf('render()'));
  assert.match(setView, /if \(!card\) nodeOf\(selected\)\?\.scrollIntoView/);
});

test('a new or updated memo in the closed fold gets a toast, and the toast opens the fold and goes to the memo', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /const inClosedFold = \(memo\) => !oneCard && !foldOpen && isOld\(memo\) && shownMemos\(memos, filter\)\.some\(\(m\) => m\.id === memo\.id\);/);
  assert.match(page, /\(nodeOf\(m\.id\) \? !onScreen\(nodeOf\(m\.id\)\) : inClosedFold\(m\)\)/);
  const goTo = page.slice(page.indexOf('function goTo(id) {'), page.indexOf('\n}\n', page.indexOf('function goTo(id) {')));
  assert.match(goTo, /if \(!foldOpen && memos\.some\(\(c\) => c\.id === id && isOld\(c\)\)\) \{ foldOpen = true; render\(\); \}/);
  assert.ok(goTo.indexOf('foldOpen = true') < goTo.indexOf('const node = nodeOf(id)'), 'the fold opens before the toast looks for the card');
  assert.match(page, /node\.addEventListener\('click', \(\) => goTo\(memo\.id\)\);/);
});

test('one action in flight for each memo: a choice, Send, Done, and Approve rule lock the whole card', async () => {
  const page = (await get('/inbox')).text;
  const send = page.slice(page.indexOf('async function send('), page.indexOf('\n}\n', page.indexOf('async function send(')));
  assert.match(send, /if \(memoId !== null && inFlight\.has\(memoId\)\) return;/);
  assert.match(send, /if \(memoId !== null\) inFlight\.add\(memoId\);/);
  assert.match(send, /lockScope\(buttonNode\)\?\.querySelectorAll\('button'\)/);
  // After a success or a failure, the lock goes and the buttons come back.
  assert.match(send, /finally \{\n    if \(memoId !== null\) inFlight\.delete\(memoId\);\n    for \(const b of others\) b\.disabled = false;\n  \}/);
  // The scope is the whole card (the deck in the one-card view), not only the row of the button.
  assert.match(page, /const lockScope = \(buttonNode\) => buttonNode\?\.closest\('\.deck'\) \|\| buttonNode\?\.closest\('\.memo'\) \|\| buttonNode\?\.parentNode;/);
  assert.doesNotMatch(send, /buttonNode\?\.parentNode\?\.querySelectorAll/);
  // Each action of a memo gives its id.
  assert.match(page, /`Sent "\$\{word\}" to \$\{memo\.sender\}`, memo\.id\)/);
  assert.match(page, /`Sent to \$\{memo\.sender\}\. It comes back with the answer`, memo\.id\);/);
  assert.match(page, /drafts\.delete\(memo\.id\); onDone\?\.\(\); \}, '', memo\.id\);/);
  assert.match(page, /`Rule added for \$\{asked\.agent\}`, memo\.id\)/);
});

test('the postpone picker has Tomorrow, Next week, and In a month', async () => {
  const { inAMonth } = await import('../ui/filter.js');
  assert.equal(inAMonth('2026-10-22'), '2026-11-22');
  assert.equal(inAMonth('2026-12-15'), '2027-01-15');
  assert.equal(inAMonth('2026-01-31'), '2026-02-28');
  assert.equal(inAMonth('2028-01-31'), '2028-02-29');
  assert.equal(inAMonth('2026-03-31'), '2026-04-30');
  const page = (await get('/inbox')).text;
  for (const label of ['Tomorrow', 'Next week', 'In a month']) assert.match(page, new RegExp(`choice\\('${label}'`));
});

test('each memo in the Inbox shows its number in the corner, in the list and on the card', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /const numberOf = \(memo\) => el\('span', \{ className: 'num' \}, `#\$\{memo\.id\}`\);/);
  // The number comes first in the meta line and floats to the top right corner, with the new tag just left of it.
  assert.match(page, /className: 'meta' \}, numberOf\(memo\), tag, el\('span', \{ className: 'sender' \}, memo\.sender\), facts, stateOf\(memo\)\)/);
  assert.match(page, /className: 'meta' \}, numberOf\(memo\), tag, el\('span', \{ className: 'sender' \}, memo\.sender\), factsOf\(memo\), stateOf\(memo\)\)/);
  assert.match((await get('/ui/common.css')).text, /\.meta \.num \{ float: right;[^}]*tabular-nums/);
});

test('the one-card view keeps the card of a memo, and after a memo leaves, the memo in its place comes next', async () => {
  const { cardIndex, cardProgress } = await import('../ui/filter.js');
  const list = [{ id: 4 }, { id: 9 }, { id: 2 }];
  assert.equal(cardIndex(list, null, 0), 0, 'the first card at the start');
  assert.equal(cardIndex(list, 9, 0), 1, 'the memo of the card keeps its card when the list moves');
  assert.equal(cardIndex(list, 7, 1), 1, 'memo 7 left: the memo that took its place is next');
  assert.equal(cardIndex(list, 7, 5), 3, 'a place after the end is the summary');
  assert.equal(cardIndex([], 7, 2), 0);
  assert.equal(cardIndex(list, null, -3), 0);
  assert.equal(cardProgress(2, 12), '3 of 12');
  assert.equal(cardProgress(12, 12), '12 of 12');
});

test('the Inbox has a List / One card switch that the device keeps', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /<span id="view" role="group" aria-label="View"><button type="button" data-view="list" aria-pressed="true"[^>]*>List<\/button><button type="button" data-view="card" aria-pressed="false"[^>]*>One card<\/button><\/span>/);
  assert.match(page, /const VIEW_KEY = 'memo-view';/);
  assert.match(page, /try \{ oneCard = localStorage\.getItem\(VIEW_KEY\) === 'card'; \} catch/);
  assert.match(page, /try \{ localStorage\.setItem\(VIEW_KEY, card \? 'card' : 'list'\); \} catch/);
  // The cards have the order and the filter of the list.
  assert.match(page, /queue\.replaceChildren\(\.\.\.\(list\.length \|\| handled\.length \? \[deckView\(list\)\] : \[\]\)\)/);
  assert.match(page, /function render\(\) \{\n  const list = shown\(\);/);
});

test('a swipe and the arrow keys only go to another card; Answer, Done, and Later are buttons', async () => {
  const page = (await get('/inbox')).text;
  const swipe = page.slice(page.indexOf('function bindSwipe(card)'), page.indexOf('function deckButton('));
  assert.ok(swipe.length > 100);
  assert.doesNotMatch(swipe, /api\(|reply\(|close\(|later\(/, 'a swipe sends nothing to the server');
  assert.match(swipe, /if \(by\) cardMove\(by\);/);
  assert.match(swipe, /swipeStep\(dx, /);
  assert.match(page, /event\.key === 'ArrowRight' \|\| event\.key === 'j'\) \{ event\.preventDefault\(\); return cardMove\(1\); \}/);
  assert.match(page, /event\.key === 'ArrowLeft' \|\| event\.key === 'k'\) \{ event\.preventDefault\(\); return cardMove\(-1\); \}/);
  const card = page.slice(page.indexOf('function cardView('), page.indexOf('function summaryView('));
  for (const label of ['Answer', 'Send', 'Done', 'Later', 'Skip']) assert.match(card, new RegExp(`deckButton\\('${label}'`));
  assert.match(card, /close\(memo, b, done\('Done'\)\)/);
  assert.match(card, /reply\(memo, area\.value, b, done\('Sent'\)\)/);
  assert.match(card, /threadOf\(memo\)/);
  assert.match(card, /postponePicker\(memo, done\('Later'\)\)/);
  assert.match(card, /deckButton\('Skip', 'skip', \(\) => cardMove\(1\)/);
  // The card shows the memo as the list does: the text, check boxes, images, and notes under Details, and the rule box.
  assert.match(card, /detailsOf\(memo, asked\)/);
  assert.match(card, /ruleBox\(memo, asked\)/);
  assert.match(card, /numberOf\(memo\)/);
  assert.match(card, /nextOf\(memo\)/);
  assert.match(page, /const nextOf = \(memo\) => \(memo\.next \? el\('div', \{ className: 'next' \}, el\('b', \{\}, 'Next: '\), memo\.next\) : ''\);/);
});

test('the one-card view has a summary at the end, an undo for Later, and respects reduced motion', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /'That was the last card'/);
  assert.match(page, /deckButton\('Start over'/);
  assert.match(page, /await api\('\/api\/postpone', \{ id: back\.id, date: null \}\);/);
  const css = (await get('/ui/common.css')).text;
  assert.match(css, /\.deck \{[^}]*overflow-x: clip/, 'a moving card does not make the page wider');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.memo\.card, \.deck-bar i \{ transition: none; \}\n  \.memo\.card\.enter-next, \.memo\.card\.enter-prev \{ animation: none; \}/);
  // The one-card view uses only the colors of the page.
  const deckCss = css.slice(css.indexOf('/* The view switch'), css.indexOf('.memo { scroll-margin'));
  assert.ok(deckCss.length > 100);
  assert.doesNotMatch(deckCss.replace(/rgb\(0 0 0 \/ \.1\)/, ''), /#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
});

test('on a phone the work sign is in the page, not in the corner over the buttons of a card', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /const narrow = matchMedia\('\(max-width: 40rem\)'\);/);
  assert.match(page, /const placeWork = \(\) => \{ if \(narrow\.matches\) queue\.before\(workBox\); else corner\.append\(workBox\); \};/);
  assert.match(page, /document\.body\.style\.paddingBottom = `\$\{corner\.offsetHeight \+ 24\}px`/);
  assert.match((await get('/ui/common.css')).text, /body > #work \{ display: flex;/);
});

test('a long thread folds: the last turn of the owner and the last answer show, with the count of the earlier turns', async () => {
  const { foldTurns, foldLabel } = await import('../ui/chat.js');
  const turn = (author) => ({ author });
  const six = ['cam', 'main', 'cam', 'main', 'cam', 'main'].map(turn);
  assert.deepEqual(foldTurns(six, 'cam'), { keep: [false, false, false, false, true, true], folded: 4 });
  assert.equal(foldLabel(4, false), '4 earlier turns');
  assert.equal(foldLabel(4, true), 'Hide 4 earlier turns');
  assert.equal(foldLabel(1, false), '1 earlier turn');
  // A memo that waits for the agent: the last turn is of the owner.
  assert.deepEqual(foldTurns(six.slice(0, 5), 'cam'), { keep: [false, false, false, false, true], folded: 4 });
  // Two answers after the last turn of the owner: only the last answer shows.
  assert.deepEqual(foldTurns(['cam', 'main', 'main'].map(turn), 'cam'), { keep: [true, false, true], folded: 1 });
  // A short thread does not fold.
  assert.deepEqual(foldTurns(['cam', 'main'].map(turn), 'cam').folded, 0);
  assert.deepEqual(foldTurns([turn('main')], 'cam'), { keep: [true], folded: 0 });
  assert.deepEqual(foldTurns([], 'cam'), { keep: [], folded: 0 });
});

test('the fold button is a real button that shows the earlier turns in place, with aria-expanded', () => {
  const common = read('ui', 'common.js');
  const turns = common.slice(common.indexOf('export function turnsOf('));
  assert.match(common, /import \{ foldTurns, foldLabel \} from '\/ui\/chat\.js';/);
  assert.match(turns, /const toggle = button\('', \(\) => show\(!openThreads\.has\(memo\.id\)\)/);
  assert.match(turns, /toggle\.setAttribute\('aria-controls', list\.id\);/);
  assert.match(turns, /toggle\.setAttribute\('aria-expanded', String\(open\)\);/);
  // Expand: the hidden turns are in the page already, so no request goes to the server.
  assert.match(turns, /nodes\.forEach\(\(node, i\) => \{ node\.hidden = !open && !keep\[i\]; \}\);/);
  assert.doesNotMatch(turns, /api\(|fetch\(/);
  // The Inbox, the Chat page, and the Desk use the same thread.
  for (const page of ['inbox.html', 'chat.html', 'desk.html']) assert.match(read('ui', page), /turnsOf\(/, page);
});
