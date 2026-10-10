// A small Markdown reader for memo text. parse() gives plain data; render() makes DOM nodes from it.
// No text goes into the page as markup, so HTML in a memo stays text.
// Supported: paragraphs, # headings, - and 1. lists, > quotes, ``` code blocks, **bold**, *italic*, `code`,
// [text](link), bare web addresses, tables, and ![text](image:<name>) for an image that Memo stores (memo image).
// A link must start with http or https. An image on the internet becomes a link: the page loads nothing from there.
const TOKEN = /`(?<code>[^`\n]+)`|\*\*(?<bold>[^*\n]+)\*\*|\*(?<italic>[^\s*][^*\n]*)\*|!\[(?<alt>[^\]\n]*)\]\((?<src>[^)\s]+)\)|\[(?<label>[^\]\n]+)\]\((?<href>[^)\s]+)\)|(?<bare>https?:\/\/[^\s<>"'`]+)/g;
const isWeb = (href) => /^https?:\/\//i.test(href);
const STORED = /^image:([0-9a-f]{16}\.(?:png|jpg|gif|webp))$/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
// The cells of one table line. "\|" is a pipe inside a cell.
const TASK = /^\[([ xX])\]\s+(.*)$/s;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function inline(text) {
  const spans = [];
  const push = (span) => {
    const last = spans.at(-1);
    if (span.t === 'text' && last?.t === 'text') last.text += span.text;
    else if (span.t !== 'text' || span.text) spans.push(span);
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    push({ t: 'text', text: text.slice(at, m.index) });
    at = m.index + m[0].length;
    const g = m.groups;
    if (g.code !== undefined) push({ t: 'code', text: g.code });
    else if (g.bold !== undefined) push({ t: 'b', text: g.bold });
    else if (g.italic !== undefined) push({ t: 'i', text: g.italic });
    else if (g.src !== undefined) {
      const stored = g.src.match(STORED);
      if (stored) push({ t: 'img', alt: g.alt, name: stored[1] });
      else if (isWeb(g.src)) push({ t: 'a', text: g.alt ? `Image: ${g.alt}` : 'Image', href: g.src });
      else push({ t: 'text', text: m[0] });
    } else if (g.label !== undefined) push(isWeb(g.href) ? { t: 'a', text: g.label, href: g.href } : { t: 'text', text: m[0] });
    else {
      // Punctuation at the end of a bare address belongs to the sentence, not to the address.
      const href = g.bare.replace(/[.,;:!?)]+$/, '');
      push({ t: 'a', text: href, href });
      push({ t: 'text', text: g.bare.slice(href.length) });
    }
  }
  push({ t: 'text', text: text.slice(at) });
  return spans;
}

// The rule that the frame document starts with. Nothing in the frame can load from a network.
const FRAME_RULE = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:";
// The frame cannot be measured from outside, so it reports its own height to the page.
const FRAME_SIZER = "const send=()=>parent.postMessage({memoFrameHeight:document.documentElement.scrollHeight},'*');"
  + "new ResizeObserver(send).observe(document.documentElement);addEventListener('load',send);send();";

// The document of the frame for one html block. vars: the colors of the page as CSS variables ("--ink:#111;--bg:#fff").
export function frameDocument(html, vars = '') {
  const colors = /^[-\w\s#(),.%:;]*$/.test(vars) ? vars : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${FRAME_RULE}">`
    + `<style>:root{color-scheme:light dark;${colors}}html{margin:0}body{margin:0;padding:8px;background:transparent;color:var(--ink);`
    + 'font:15px/1.45 -apple-system,system-ui,sans-serif}svg,canvas,img,table{max-width:100%}</style></head><body>'
    + `${html}<script>${FRAME_SIZER}</script></body></html>`;
}

// html: true makes a block that starts with ```html a frame. Without it the block is code, as all other blocks.
export function parse(text, { html = false } = {}) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let tasks = 0; // the count of check boxes before this place in the text
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', spans: inline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flush();
      const body = [];
      const type = html && /^```html\s*$/i.test(line) ? 'html' : 'pre';
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ type, text: body.join('\n') });
    } else if (!line.trim()) {
      flush();
    } else if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'h', spans: inline(m[1]) });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      const body = [m[1]];
      while (i + 1 < lines.length && (m = lines[i + 1].match(/^>\s?(.*)$/))) { body.push(m[1]); i++; }
      blocks.push({ type: 'quote', spans: inline(body.join('\n')) });
    } else if (/^\s*[-*]\s+\S/.test(line) || /^\s*\d+[.)]\s+\S/.test(line)) {
      flush();
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      const item = type === 'ol' ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items = [];
      const at = []; // the line of each item
      for (; i < lines.length; i++) {
        const found = lines[i].match(item);
        if (found) { items.push(found[1]); at.push(i); }
        else if (/^\s+\S/.test(lines[i])) items[items.length - 1] += `\n${lines[i].trim()}`; // an indented line continues the item
        else break;
      }
      i--;
      // "- [ ] text" and "- [x] text" are items with a check box. checks has one entry for each item: null for a plain
      // item, or { n, on, line }: the number of the box in the text, its state, and its line.
      const boxes = type === 'ul' ? items.map((text) => text.match(TASK)) : [];
      if (boxes.some(Boolean)) {
        const checks = boxes.map((box, k) => (box ? { n: tasks++, on: box[1] !== ' ', line: at[k] } : null));
        blocks.push({ type, items: items.map((text, k) => inline(boxes[k] ? boxes[k][2] : text)), checks });
      } else blocks.push({ type, items: items.map(inline) });
    } else if (line.includes('|') && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|'); i++) {
        const row = cells(lines[i]).slice(0, head.length);
        while (row.length < head.length) row.push('');
        rows.push(row.map(inline));
      }
      i--;
      blocks.push({ type: 'table', head: head.map(inline), rows });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

// The check boxes of a text, in order: [{ n, on, line }]. The server uses this to change one box.
export function checkBoxes(text) {
  return parse(text).flatMap((block) => (block.checks || []).filter(Boolean));
}

// The text with box n set to on or off. null if the text has no box n.
export function setCheckBox(text, n, on) {
  const box = checkBoxes(text).find((b) => b.n === n);
  if (!box) return null;
  const lines = String(text).split('\n');
  lines[box.line] = lines[box.line].replace(/^(\s*[-*]\s+)\[[ xX]\]/, `$1[${on ? 'x' : ' '}]`);
  return lines.join('\n');
}

// el: the element function of common.js. Returns the list of nodes for the text.
// options.onCheck(n, on): called when the reader changes a check box. Without it the boxes are read-only.
// options.html: show html blocks in a frame. options.vars: the page colors for the frame.
export function render(text, el, { html = false, vars = '', onCheck = null } = {}) {
  const TAG = { b: 'strong', i: 'em', code: 'code' };
  const node = (span) => {
    if (span.t === 'text') return span.text;
    if (span.t === 'a') return el('a', { href: span.href, target: '_blank', rel: 'noopener noreferrer' }, span.text);
    if (span.t === 'code') return el('code', {}, span.text);
    if (span.t === 'img') {
      // The page gets the file with the token later (loadImages in common.js).
      const img = el('img', { alt: span.alt });
      img.dataset.image = span.name;
      return img;
    }
    // Bold and italic text can contain code and links, for example **the `--ax` hook**.
    return el(TAG[span.t], {}, ...inline(span.text).map(node));
  };
  return parse(text, { html }).map((block) => {
    if (block.type === 'html') {
      // The frame has its own empty origin: its script cannot read the page, the token, or the Memo API.
      // The sandbox is set before the document, so the document never runs without it.
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.className = 'frame';
      frame.title = 'Content from the memo';
      frame.srcdoc = frameDocument(block.text, vars);
      return frame;
    }
    if (block.type === 'pre') return el('pre', {}, el('code', {}, block.text));
    if (block.type === 'table') {
      const row = (tag, list) => el('tr', {}, ...list.map((spans) => el(tag, {}, ...spans.map(node))));
      // The wrapper lets a wide table scroll inside the memo on a phone.
      return el('div', { className: 'table' }, el('table', {}, el('thead', {}, row('th', block.head)), el('tbody', {}, ...block.rows.map((r) => row('td', r)))));
    }
    if (block.checks) {
      return el('ul', { className: 'tasks' }, ...block.items.map((spans, k) => {
        const check = block.checks[k];
        if (!check) return el('li', {}, ...spans.map(node));
        const box = el('input', { type: 'checkbox', checked: check.on, disabled: !onCheck });
        if (onCheck) box.addEventListener('change', () => onCheck(check.n, box.checked, box));
        return el('li', { className: 'task' }, el('label', {}, box, ' ', ...spans.map(node)));
      }));
    }
    if (block.type === 'ul' || block.type === 'ol') return el(block.type, {}, ...block.items.map((spans) => el('li', {}, ...spans.map(node))));
    return el({ p: 'p', h: 'h3', quote: 'blockquote' }[block.type], {}, ...block.spans.map(node));
  });
}
