import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, inline, frameDocument } from '../ui/markdown.js';
import { makeApp } from './helpers.js';

test('plain text is one paragraph and keeps its line breaks', () => {
  assert.deepEqual(parse('Line one.\nLine two.'), [{ type: 'p', spans: [{ t: 'text', text: 'Line one.\nLine two.' }] }]);
});

test('a blank line starts a new paragraph', () => {
  assert.deepEqual(parse('One.\n\n\nTwo.').map((b) => b.spans[0].text), ['One.', 'Two.']);
});

test('bold, italic, and code', () => {
  assert.deepEqual(inline('A **bold** and *italic* and `code` word.'), [
    { t: 'text', text: 'A ' }, { t: 'b', text: 'bold' }, { t: 'text', text: ' and ' }, { t: 'i', text: 'italic' },
    { t: 'text', text: ' and ' }, { t: 'code', text: 'code' }, { t: 'text', text: ' word.' },
  ]);
});

test('marks inside code stay as text', () => {
  assert.deepEqual(inline('`a **b** c`'), [{ t: 'code', text: 'a **b** c' }]);
});

test('a lone asterisk and snake_case stay as text', () => {
  assert.deepEqual(inline('2 * 3 and my_file_name'), [{ t: 'text', text: '2 * 3 and my_file_name' }]);
});

test('a link with text, and a bare web address', () => {
  assert.deepEqual(inline('See [the page](https://example.org/a) or https://example.com/x?y=1.'), [
    { t: 'text', text: 'See ' }, { t: 'a', text: 'the page', href: 'https://example.org/a' }, { t: 'text', text: ' or ' },
    { t: 'a', text: 'https://example.com/x?y=1', href: 'https://example.com/x?y=1' }, { t: 'text', text: '.' },
  ]);
});

test('a link that is not http or https stays as text', () => {
  for (const text of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/inbox)']) {
    assert.ok(inline(text).every((s) => s.t === 'text'), text);
  }
});

test('bullet lists and numbered lists', () => {
  assert.deepEqual(parse('Options:\n- Keep **it**\n- Remove it\n\n1. First\n2) Second'), [
    { type: 'p', spans: [{ t: 'text', text: 'Options:' }] },
    { type: 'ul', items: [[{ t: 'text', text: 'Keep ' }, { t: 'b', text: 'it' }], [{ t: 'text', text: 'Remove it' }]] },
    { type: 'ol', items: [[{ t: 'text', text: 'First' }], [{ t: 'text', text: 'Second' }]] },
  ]);
});

test('an indented line continues the list item before it', () => {
  assert.deepEqual(parse('- One\n  more\n- Two')[0].items.map((i) => i[0].text), ['One\nmore', 'Two']);
});

test('headings, a quote, and a code block', () => {
  assert.deepEqual(parse('## Decision\n> quoted *text*\n> more\n```sh\nnpm test **x**\n\n- not a list\n```\nAfter.'), [
    { type: 'h', spans: [{ t: 'text', text: 'Decision' }] },
    { type: 'quote', spans: [{ t: 'text', text: 'quoted ' }, { t: 'i', text: 'text' }, { t: 'text', text: '\nmore' }] },
    { type: 'pre', text: 'npm test **x**\n\n- not a list' },
    { type: 'p', spans: [{ t: 'text', text: 'After.' }] },
  ]);
});

test('a code block with no end takes the rest of the text', () => {
  assert.deepEqual(parse('```\nline'), [{ type: 'pre', text: 'line' }]);
});

test('HTML in the text stays text', () => {
  assert.deepEqual(parse("<b>x</b> <script>alert(1)</script>"), [{ type: 'p', spans: [{ t: 'text', text: "<b>x</b> <script>alert(1)</script>" }] }]);
});

test('empty text gives no blocks', () => assert.deepEqual(parse(''), []));

test('the server gives the markdown file to the pages', async () => {
  const r = await makeApp().app.request('/ui/markdown.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

test('a table with a header row', () => {
  assert.deepEqual(parse('Before.\n| Option | Cost |\n|---|:--:|\n| **A** | 5 |\n| B \\| C | `x` | extra |\n| short |\nAfter.'), [
    { type: 'p', spans: [{ t: 'text', text: 'Before.' }] },
    { type: 'table',
      head: [[{ t: 'text', text: 'Option' }], [{ t: 'text', text: 'Cost' }]],
      rows: [
        [[{ t: 'b', text: 'A' }], [{ t: 'text', text: '5' }]],
        [[{ t: 'text', text: 'B | C' }], [{ t: 'code', text: 'x' }]],
        [[{ t: 'text', text: 'short' }], []],
      ] },
    { type: 'p', spans: [{ t: 'text', text: 'After.' }] },
  ]);
});

test('a table needs no pipes at the ends of its lines', () => {
  const [table] = parse('a | b\n--- | ---\n1 | 2');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.rows, [[[{ t: 'text', text: '1' }], [{ t: 'text', text: '2' }]]]);
});

test('a line with a pipe and no separator line stays a paragraph', () => {
  assert.deepEqual(parse('a | b\nc | d').map((b) => b.type), ['p']);
  assert.deepEqual(parse('yes | no\n---').map((b) => b.type), ['p']);
});

test('an image that Memo stores', () => {
  assert.deepEqual(inline('See ![the new page](image:0123456789abcdef.png) here.'), [
    { t: 'text', text: 'See ' }, { t: 'img', alt: 'the new page', name: '0123456789abcdef.png' }, { t: 'text', text: ' here.' },
  ]);
});

test('an image on the internet becomes a link and does not load', () => {
  assert.deepEqual(inline('![chart](https://example.com/c.png)'), [{ t: 'a', text: 'Image: chart', href: 'https://example.com/c.png' }]);
  assert.deepEqual(inline('![](https://example.com/c.png)'), [{ t: 'a', text: 'Image', href: 'https://example.com/c.png' }]);
});

test('an image with a wrong name or address stays text', () => {
  for (const text of ['![x](image:../../.env)', '![x](image:abc.svg)', '![x](file:///etc/passwd)', '![x](javascript:alert(1))']) {
    assert.ok(inline(text).every((s) => s.t === 'text'), text);
  }
});

test('an html block becomes a frame only when the caller permits it', () => {
  const text = 'A chart:\n```html\n<svg><rect width="10" height="10"/></svg>\n<script>draw()</script>\n```\nEnd.';
  const html = '<svg><rect width="10" height="10"/></svg>\n<script>draw()</script>';
  assert.deepEqual(parse(text, { html: true }).map((b) => b.type), ['p', 'html', 'p']);
  assert.equal(parse(text, { html: true })[1].text, html);
  assert.deepEqual(parse(text)[1], { type: 'pre', text: html });
  assert.deepEqual(parse(text, { html: false })[1], { type: 'pre', text: html });
});

test('HTML outside an html block stays text also when frames are permitted', () => {
  assert.deepEqual(parse('<script>alert(1)</script>', { html: true }), [{ type: 'p', spans: [{ t: 'text', text: '<script>alert(1)</script>' }] }]);
  assert.equal(parse('```js\n<b>x</b>\n```', { html: true })[0].type, 'pre');
});

test('the frame document puts the network rule before the memo HTML', () => {
  const doc = frameDocument('<p id="memo">hi</p><meta http-equiv="Content-Security-Policy" content="default-src *">', '--ink:#111;--bg:#fff');
  const rule = doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:">`);
  assert.ok(rule > 0 && rule < doc.indexOf('<p id="memo">'), 'the rule must be first');
  assert.ok(doc.includes('--ink:#111;--bg:#fff'));
  assert.ok(doc.includes('memoFrameHeight'));
});

test('the frame document refuses theme text that is not a list of colors', () => {
  const doc = frameDocument('<p>hi</p>', '--ink:#111}</style><script>alert(1)</script>');
  assert.ok(!doc.includes('alert(1)'));
});
