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
  assert.match(inbox, /button\('Reply', \(b\) => reply\(memo, area\.value, b\)/);
  // Each caller of reply, addNote, and close gives a button: the key Command-Return gives the Reply button.
  assert.match(inbox, /reply\(memo, area\.value, sendButtons\[0\]\)/);
  assert.doesNotMatch(inbox, /reply\(memo, area\.value\)/);
  assert.doesNotMatch(inbox, /addNote\(memo, area\.value\)/);
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

test('each card shows the name, the next step, and the buttons; the full text and the notes open under Details', async () => {
  const page = (await get('/inbox')).text;
  const card = page.slice(page.indexOf('function view(memo) {'), page.indexOf('// The text of a memo, with its check boxes'));
  assert.ok(card.length > 100);
  assert.match(card, /el\('div', \{ className: 'name' \}, titleOf\(memo\)\),\n    nextOf\(memo\),/);
  assert.match(card, /choicesOf\(memo\),\n    detailsOf\(memo, asked\),/);
  assert.doesNotMatch(card, /bodyOf\(|notesOf\(/, 'the text and the notes are only in Details');
  assert.match(page, /const titleOf = \(memo\) => memo\.title \|\| summary\(memo\.text\) \|\| `Memo \$\{memo\.id\}`;/);
  assert.match(page, /el\('details', \{ className: 'details', open: openDetails\.has\(memo\.id\) \},\n    el\('summary', \{\}, 'Details'/);
  assert.match(page, /bodyOf\(memo, asked\),\n    notesOf\(memo\)\);/);
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

test('the answer buttons: one button for each choice of the sender, and a tap replies with that word', async () => {
  const page = (await get('/inbox')).text;
  assert.match(page, /const choicesOf = \(memo, onDone\) => \(memo\.choices\?\.length \? el\('div', \{ className: 'choices'/);
  assert.match(page, /\.\.\.memo\.choices\.map\(\(word\) => button\(word, \(b\) => send\(b, async \(\) => \{ await api\('\/api\/reply', \{ id: memo\.id, text: word \}\);/);
  // On the card of the one-card view too, where the reply counts in the summary.
  const card = page.slice(page.indexOf('function cardView('), page.indexOf('function summaryView('));
  assert.match(card, /choicesOf\(memo, done\('Replied'\)\)/);
  // The free reply stays.
  assert.match(page, /button\('Reply', \(b\) => reply\(memo, area\.value, b\)/);
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
  assert.match(page, /className: 'meta' \}, numberOf\(memo\), tag, el\('span', \{ className: 'sender' \}, memo\.sender\), facts\)/);
  assert.match(page, /className: 'meta' \}, numberOf\(memo\), tag, el\('span', \{ className: 'sender' \}, memo\.sender\), factsOf\(memo\)\)/);
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

test('a swipe and the arrow keys only go to another card; Reply, Close, and Later are buttons', async () => {
  const page = (await get('/inbox')).text;
  const swipe = page.slice(page.indexOf('function bindSwipe(card)'), page.indexOf('function deckButton('));
  assert.ok(swipe.length > 100);
  assert.doesNotMatch(swipe, /api\(|reply\(|close\(|later\(/, 'a swipe sends nothing to the server');
  assert.match(swipe, /if \(by\) cardMove\(by\);/);
  assert.match(swipe, /swipeStep\(dx, /);
  assert.match(page, /event\.key === 'ArrowRight' \|\| event\.key === 'j'\) \{ event\.preventDefault\(\); return cardMove\(1\); \}/);
  assert.match(page, /event\.key === 'ArrowLeft' \|\| event\.key === 'k'\) \{ event\.preventDefault\(\); return cardMove\(-1\); \}/);
  const card = page.slice(page.indexOf('function cardView('), page.indexOf('function summaryView('));
  for (const label of ['Reply', 'Close', 'Later', 'Skip']) assert.match(card, new RegExp(`deckButton\\('${label}'`));
  assert.match(card, /close\(memo, b, done\('Closed'\)\)/);
  assert.match(card, /reply\(memo, area\.value, b, done\('Replied'\)\)/);
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
