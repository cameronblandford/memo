// The Memo command-line client. The agents call it through Bash: scripts/memo <command> ...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageNames } from '../ui/attach.js';
import { summary } from '../ui/markdown.js';
import { ruleProblem, ruleText } from '../ui/rule.js';

const USAGE = `Usage:
  memo send --from <name> --to <name> [--impact 1-5 --effort micro|short|hour|half-day|day] [--due YYYY-MM-DD] [--tag <tag> ...] [--title <name>] [--next <step>] [--choices <a>,<b>,...] [--ticket <KEY>] [--] <text>
  memo tag <id> <tag> [<tag> ...]
  memo untag <id> <tag> [<tag> ...]
  memo postpone <id> <YYYY-MM-DD> | memo postpone <id> now
  memo reply <id> <text>
  memo close <id> [<text>]
  memo edit <id> [--] <new text>
  memo brief <id> [--title <name>] [--next <step>]
  memo note <id> --from <name> [--text <new memo text>] [--] <text>      (a turn in the thread; on a memo that waits for you, it is your answer)
  memo ack <id> [<id> ...]
  memo rule --from <agent> --rule '<permission rule>' --why '<one line>' [--impact 1-5] [--to <owner>]
  memo forward <id> [--to <agent>]
  memo status --as <agent> <text>
  memo recap --as <agent> <text>
  memo list --to <name>
  memo prompt --as <agent>
  memo ping --as <agent>
  memo screen --as <agent> < <screen text>
  memo image <path> [<text that describes the image>]
  memo wait --as <agent> [--hold <id>,<id>] [<max_minutes>]
  memo tick add --impact 1-5 --effort <effort> [--days mon,wed,fri] [--every <days>] [--after HH:MM] [--by HH:MM] [--] <text>
  memo tick set <id> [--impact ...] [--effort ...] [--days ...] [--every ...] [--after ...] [--by ...] [<new text>]
  memo tick list | memo tick remove <id> | memo tick log [<days>]
  memo ticket set <KEY> [--agent <name>] [--state queued|working|needs_you|in_review|landing|done] [--pr <url>] [--summary <one line>] [--title <title>] [--url <Linear url>] [--as <name>]
  memo ticket list
  memo story list | memo story show <key>
  memo story set <key> --title <title> [--] [<what the story means>]
  memo story summary <key> [--] <Markdown>      (use - in the place of the text to read it from stdin)
  memo story ask [<key>]                         (a request to main for a new summary; no key: all stories)
  memo history [--days <n>]                      (the memos of the last n days, default 30, in a short form)
A memo to the owner needs --impact and --effort (memo rule has impact 4 and effort micro). --title and --next are the brief on the card of the Inbox.
--choices gives the owner one answer button for each word (for example push,draft,skip); a tap replies with that word.
memo note --text changes the memo text and adds the note in one step: the memo text is the current state, and the note is the short answer.`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function fileEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no .env: the environment must give the values */ }
  return out;
}
const file = fileEnv();
const token = process.env.MEMO_TOKEN || file.MEMO_TOKEN;
// MEMO_URL is for a server on a different computer, for example https://memo.your-tailnet.ts.net
const base = (process.env.MEMO_URL || file.MEMO_URL || `http://127.0.0.1:${file.PORT || 3280}`).replace(/\/+$/, '');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// soft: a server that does not answer, or an answer that is not from Memo, gives null and not an exit. memo wait uses it.
async function call(path, body, { soft = false } = {}) {
  let r;
  try {
    r = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (soft) return null;
    fail(`The Memo server does not answer at ${base}.`);
  }
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (!r.ok) {
    // A failure with no JSON body is not from Memo: for example a different program that has the port
    // while the server starts again. memo wait tries again.
    if (soft && (r.status >= 500 || data === null || typeof data !== 'object')) return null;
    fail(data?.error || raw || `The request failed with status ${r.status}.`);
  }
  return data;
}

const OPTIONS = ['from', 'to', 'as', 'impact', 'effort', 'due', 'hold', 'days', 'every', 'after', 'by', 'tag', 'title', 'next', 'choices', 'rule', 'why', 'ticket', 'agent', 'state', 'pr', 'summary', 'url', 'text'];
// An option that can come more than one time. Its value is a list.
const REPEATED = ['tag'];
function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!OPTIONS.includes(key)) fail(`${a} is not a known option. Put -- before text that starts with two hyphens.`);
      if (i + 1 >= argv.length) fail(`${a} needs a value.`);
      if (REPEATED.includes(key)) (flags[key] ||= []).push(argv[++i]);
      else flags[key] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parse(argv);
// --text is the new memo text of memo note. With another command it would take a word of the text silently.
if (flags.text !== undefined && command !== 'note') fail('--text is only for memo note. Put -- before text that starts with two hyphens.');
const need = (key) => flags[key] ?? fail(`--${key} is necessary.`);
const memoId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`The memo id must be a number. Found: ${v ?? 'nothing'}.`);
  return n;
};
const query = (v) => encodeURIComponent(v);
const when = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

// The images in the text that a memo brings to the reader: the memo text (not for a memo that the reader sent),
// the notes, and the reply.
const broughtImages = (c, own) => imageNames([own ? '' : c.text, c.reply || '', ...(c.notes || []).map((n) => n.text)].join('\n'));

// An agent cannot see an image in the text, so the client gets each file and gives its local path. The agent
// opens the path with its Read tool. The first directory that the client can write to holds the files.
const imageDirs = [process.env.MEMO_IMAGE_DIR, process.env.MEMO_WORK_DIR && join(process.env.MEMO_WORK_DIR, 'images'), join(root, 'work', 'images'), join(tmpdir(), 'memo-images')].filter(Boolean);
async function localImage(name) {
  for (const dir of imageDirs) if (existsSync(join(dir, name))) return join(dir, name);
  let r;
  try { r = await fetch(`${base}/api/image/${name}`, { headers: { Authorization: `Bearer ${token}` } }); } catch { return null; }
  if (!r.ok) return null;
  const bytes = Buffer.from(await r.arrayBuffer());
  for (const dir of imageDirs) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), bytes, { mode: 0o600 });
      return join(dir, name);
    } catch { /* try the next directory */ }
  }
  return null;
}
// own: the reader sent this memo.
async function shown(c, own = false) {
  const lines = [];
  for (const name of broughtImages(c, own)) {
    const path = await localImage(name);
    lines.push(path ? `Image ${name} is the file ${path}. Open the file to see the image.` : `Image ${name}: memo could not get the file. Run the command again.`);
  }
  return (own ? showOwn(c) : show(c)) + (lines.length ? `${lines.join('\n')}\n` : '');
}
async function showAll(memos, own = false) {
  const out = [];
  for (const c of memos) out.push(await shown(c, own));
  return out.join('\n');
}

function show(c) {
  const head = `#${c.id} from ${c.sender} to ${c.recipient}, ${when(c.created)}`
    + (c.impact != null ? `, impact ${c.impact}, effort ${c.effort}` : '')
    + (c.due ? `, due ${c.due}` : '')
    + (c.tags?.length ? `, tags ${c.tags.join(' ')}` : '')
    + (c.choices?.length ? `, choices ${c.choices.join(' | ')}` : '')
    + (c.ticket ? `, ticket ${c.ticket}` : '')
    + (c.until ? `, postponed until ${when(c.until)}` : '')
    + (c.state !== 'open' ? `, ${c.state}` : '');
  return `${head}\n${c.text}\n${notesOf(c)}${c.reply ? `Reply: ${c.reply}\n` : ''}`;
}

const STATES = { waiting: 'waits for your answer' };
const headOf = (c) => `#${c.id} from ${c.sender} to ${c.recipient}, ${when(c.created)}` + (c.state !== 'open' ? `, ${STATES[c.state] || c.state}` : '');
const notesOf = (c) => (c.notes || []).map((n) => `Note from ${n.author}, ${when(n.created)}${n.read ? '' : ' (not read)'}: ${n.text}\n`).join('');
// A memo that the reader sent: only the name of the memo (the reader knows its own text), then the thread in
// order (the notes, oldest first), then the reply or the close text that ended the memo.
function showOwn(c) {
  return `${headOf(c)}\nYour memo: ${c.title || summary(c.text, 100) || '(no text)'}\n${notesOf(c)}${c.reply ? `${c.state === 'closed' ? 'Closed with' : 'Reply'}: ${c.reply}\n` : ''}`;
}

// The most characters that memo wait prints. A tool can cut a longer output in the middle, and the agent
// must not ack an answer that it did not see. A memo that does not fit comes in the next memo wait.
const WAIT_MAX = Number(process.env.MEMO_WAIT_MAX_CHARS || 20000);

async function setTags(on) {
  const id = memoId(rest[0]);
  const names = rest.slice(1);
  if (!names.length) fail('Give one tag or more.');
  let memo;
  for (const tag of names) memo = await call('/api/tag', { id, tag, on });
  console.log(`Memo ${id} has the tags: ${memo.tags.length ? memo.tags.join(' ') : 'none'}.`);
}

const commands = {
  async send() {
    const r = await call('/api/send', {
      from: need('from'), to: need('to'), text: rest.join(' '),
      impact: flags.impact === undefined ? undefined : Number(flags.impact),
      effort: flags.effort, due: flags.due, tags: flags.tag, title: flags.title, next: flags.next, choices: flags.choices, ticket: flags.ticket,
    });
    console.log(`Memo ${r.memo.id} is sent to ${r.memo.recipient}.${r.memo.tags?.length ? ` Tags: ${r.memo.tags.join(' ')}.` : ''}${r.memo.ticket ? ` Ticket: ${r.memo.ticket}.` : ''}`);
    if (r.corrections.length) {
      console.log('The owner changed the impact of your last memos. Use this when you select an impact:');
      for (const k of r.corrections) console.log(`  memo ${k.memo_id}: ${k.old_impact} to ${k.new_impact} ("${k.text.replace(/\s+/g, ' ')}")`);
    }
  },
  // Asks the owner for a Claude Code permission rule. The owner approves it in the Inbox, and the server adds it to the
  // settings file of the agent. The answer comes with memo wait. The agent cannot write the rule itself.
  async rule() {
    const from = need('from');
    const rule = need('rule');
    const why = need('why').replace(/\s+/g, ' ').trim();
    const problem = ruleProblem(rule);
    if (problem) fail(problem);
    if (!why) fail('--why needs a reason in one line.');
    const r = await call('/api/send', {
      from, to: flags.to || process.env.MEMO_OWNER || file.MEMO_OWNER || 'owner', text: ruleText({ agent: from, rule, why }), impact: flags.impact === undefined ? 4 : Number(flags.impact), effort: 'micro',
      title: `Permission rule for ${from}`.slice(0, 60), next: 'Approve rule, or write a reason and Done to refuse it.',
    });
    console.log(`Memo ${r.memo.id} asks the owner for the rule ${rule}. Run memo wait for the answer. After an approval, the rule applies when the session starts again.`);
  },
  async reply() {
    const id = memoId(rest[0]);
    await call('/api/reply', { id, text: rest.slice(1).join(' ') });
    console.log(`Memo ${id} has the reply.`);
  },
  async edit() {
    const id = memoId(rest[0]);
    await call('/api/edit', { id, text: rest.slice(1).join(' ') });
    console.log(`Memo ${id} has the new text.`);
  },
  // The brief of an open memo for its card in the Inbox. An empty value removes that part.
  async brief() {
    const id = memoId(rest[0]);
    if (rest.length > 1) fail('Give the brief with --title and --next.');
    const m = await call('/api/brief', { id, title: flags.title, next: flags.next });
    console.log(`Memo ${id} has the brief: ${m.title || '(no title)'} · next: ${m.next || '(no next step)'}.`);
  },
  // A turn in the thread of a memo to the owner. From the sender of a memo that waits for it: the answer, and the
  // memo goes back to the Inbox of the owner. --text: the new memo text (the current state), in the same request.
  async note() {
    const id = memoId(rest[0]);
    const m = await call('/api/note', { id, from: need('from'), text: rest.slice(1).join(' '), memo_text: flags.text });
    const what = flags.text === undefined ? 'the note' : 'the new text and the note';
    console.log(m.state === 'waiting' ? `Memo ${id} has ${what}. It waits for ${m.sender}.` : `Memo ${id} has ${what}. It is in the Inbox of ${m.recipient} again.`);
  },
  async close() {
    const id = memoId(rest[0]);
    await call('/api/close', { id, text: rest.slice(1).join(' ') || undefined });
    console.log(`Memo ${id} is closed.`);
  },
  async ack() {
    const ids = (rest.length ? rest : [undefined]).map(memoId);
    for (const id of ids) await call('/api/ack', { id });
    console.log(`Marked as read: ${ids.join(', ')}.`);
  },
  async forward() {
    const id = memoId(rest[0]);
    const r = await call('/api/forward', { id, to: flags.to });
    console.log(`Memo ${r.memo.id} is sent to ${r.memo.recipient} with the text of memo ${id}.`);
  },
  // Tags of a memo to the owner, for the filter of the Inbox. For example: memo tag 42 work money
  async tag() { await setTags(true); },
  async untag() { await setTags(false); },
  // Takes a memo out of the Inbox until 9:00 (the owner's time) on the date. "now" brings it back.
  // The sender gets no news from a postpone.
  async postpone() {
    const id = memoId(rest[0]);
    const date = rest[1];
    if (!date) fail('Give the date (YYYY-MM-DD), or now.');
    const r = await call('/api/postpone', { id, date: date === 'now' ? null : date });
    console.log(r.until ? `Memo ${id} is postponed until ${when(r.until)}.` : `Memo ${id} is back in the Inbox.`);
  },
  async status() {
    await call('/api/status', { agent: need('as'), text: rest.join(' ') });
    console.log('The status is saved.');
  },
  async recap() {
    await call('/api/recap', { agent: need('as'), text: rest.join(' ') });
    console.log('The recap is saved.');
  },
  async list() {
    const memos = await call(`/api/list?to=${query(need('to'))}`);
    if (!memos.length) console.log(`No open memos to ${flags.to}.`);
    if (memos.length) console.log(await showAll(memos));
    // The memos of this agent that the owner sent back. A read only: peek records no delivery.
    const news = await call(`/api/news?for=${query(flags.to)}&peek=1`);
    const waits = news.waiting || [];
    if (waits.length) {
      console.log(`\nMemos from ${flags.to} that wait for your answer:\n\n${await showAll(waits, true)}`);
      console.log(`Answer each one in the memo: memo note <id> --from ${flags.to} -- "<text>".`);
    }
  },
  // Stores an image file in Memo and prints the Markdown that shows it. Put the printed text into a memo.
  async image() {
    if (!rest[0]) fail('Give the path of the image file.');
    let bytes;
    try { bytes = readFileSync(rest[0]); } catch { fail(`memo cannot read the file ${rest[0]}.`); }
    let r;
    try {
      r = await fetch(`${base}/api/image`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bytes });
    } catch { fail(`The Memo server does not answer at ${base}.`); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) fail(data.error || `The request failed with status ${r.status}.`);
    console.log(`![${rest.slice(1).join(' ').replace(/[\[\]\n]/g, ' ') || 'image'}](image:${data.name})`);
  },
  async prompt() {
    process.stdout.write(await call(`/api/agent/prompt?name=${query(need('as'))}`));
  },
  // A sign of life from the computer of a remote agent. The Agents page shows the agent online also while it works
  // and does not wait. It only reads, and prints nothing. scripts/remote-agent.sh runs it each minute.
  async ping() {
    await call(`/api/news?for=${query(need('as'))}`, undefined, { soft: true });
  },
  // The tail of the session of a remote agent, from stdin, for the Agents page. It prints the keys that the owner
  // sent from the page (Escape or Enter), one on each line. scripts/remote-agent.sh sends them to the session.
  async screen() {
    const name = need('as');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const r = await call('/api/agent/screen', { name, text: Buffer.concat(chunks).toString('utf8') });
    for (const k of r.keys || []) console.log(k);
  },
  // A tick is a small action of the owner that comes back. See "Ticks" in README.md.
  async tick() {
    const [action, ...words] = rest;
    const schedule = (t) => [t.days ? `on ${t.days}` : 'each day', t.every > 1 ? `${t.every} days after the last time` : '', t.after ? `after ${t.after}` : '', t.by ? `by ${t.by}` : ''].filter(Boolean).join(', ');
    const line = (t) => `#${t.id} impact ${t.impact}, effort ${t.effort}, ${schedule(t)}: ${t.text}`;
    const fields = (text) => ({
      text: text || undefined, effort: flags.effort, days: flags.days, after: flags.after, by: flags.by,
      impact: flags.impact === undefined ? undefined : Number(flags.impact),
      every: flags.every === undefined ? undefined : Number(flags.every),
    });
    if (action === 'add') console.log(`The tick is added. ${line(await call('/api/tick/add', fields(words.join(' '))))}`);
    else if (action === 'set') console.log(`The tick has the change. ${line(await call('/api/tick/set', { id: memoId(words[0]), ...fields(words.slice(1).join(' ')) }))}`);
    else if (action === 'remove') { await call('/api/tick/remove', { id: memoId(words[0]) }); console.log(`Tick ${words[0]} is removed.`); }
    else if (action === 'list') {
      const ticks = await call('/api/ticks');
      console.log(ticks.length ? ticks.map(line).join('\n') : 'No ticks are active.');
    } else if (action === 'log') {
      const days = words[0] === undefined ? 7 : Number(words[0]);
      const ticks = await call(`/api/ticks?log=${query(days)}`);
      if (!ticks.length) console.log('No ticks are active.');
      // One letter for each day, the newest day last. d: done. s: skipped. A point: no mark.
      for (const t of ticks) console.log(`${line(t)}\n  ${t.from} to ${t.to}: ${t.states.map((s) => (s === 'done' ? 'd' : s === 'skip' ? 's' : '.')).join('')}  done ${t.done}, skipped ${t.skipped}`);
    } else fail(USAGE);
  },
  // The Desk: one ticket is one task. See "The Desk" in README.md. Memo never writes to Linear.
  async ticket() {
    const [action, key, ...words] = rest;
    const line = (t) => `${t.key} ${t.title}`
      + (t.linear_state ? ` [Linear: ${t.linear_state}]` : '')
      + (t.agent ? ` · ${t.agent}` : '')
      + (t.pr_url ? ` · PR ${t.pr_number ? `#${t.pr_number}` : t.pr_url}` : '')
      + (t.summary ? `\n    ${t.summary}` : '')
      + (t.question ? `\n    Open memo #${t.question.id} from ${t.question.sender}: ${t.question.title}${t.questions > 1 ? ` (+${t.questions - 1} more)` : ''}` : '');
    if (action === 'set') {
      if (!key) fail('Give the ticket key, for example: memo ticket set TFP-797 --state working');
      if (words.length) fail('Give the fields with --agent, --state, --pr, --summary, --title, and --url.');
      const t = await call('/api/ticket', { key, agent: flags.agent, state: flags.state, pr: flags.pr, summary: flags.summary, title: flags.title, url: flags.url, as: flags.as });
      console.log(`Ticket ${t.key}: ${t.desk_state ?? 'not on the Desk'}${t.agent ? `, agent ${t.agent}` : ''}${t.pr_url ? `, PR ${t.pr_url}` : ''}.`);
    } else if (action === 'list') {
      const d = await call('/api/tickets');
      const out = [];
      for (const g of d.groups) if (g.tickets.length) out.push(`${g.label} (${g.tickets.length}):\n${g.tickets.map((t) => `  ${line(t)}`).join('\n')}`);
      if (d.backlog.length) out.push(`Backlog, no agent (${d.backlog.length}):\n${d.backlog.map((t) => `  ${line(t)}`).join('\n')}`);
      console.log(out.length ? out.join('\n\n') : 'The Desk has no tickets.');
      if (d.sync?.on) console.log(`\nLinear sync: ${d.sync.last ? `${d.sync.ok ? 'ok' : `failed (${d.sync.error})`} at ${when(d.sync.last)}` : 'not run yet'}.`);
    } else fail(USAGE);
  },
  // Stories: the things that the owner cares about for a long time (src/stories.js).
  async story() {
    const [action, key, ...words] = rest;
    const text = async () => {
      if (words.length === 1 && words[0] === '-') {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      }
      return words.join(' ');
    };
    const head = (s) => `${s.key}: ${s.title}${s.summary_at ? ` (summary of ${when(s.summary_at)})` : ' (no summary yet)'}, ${s.count} memo${s.count === 1 ? '' : 's'} with the tag`;
    if (action === 'list') {
      const list = await call('/api/stories');
      console.log(list.length ? list.map(head).join('\n') : 'There is no story yet.');
    } else if (action === 'show') {
      if (!key) fail('Give the key of the story, for example: memo story show body');
      const s = await call(`/api/story?key=${query(key)}`);
      const memos = s.memos.map((m) => `  #${m.id} ${m.state} ${m.sender}->${m.recipient} ${m.created.slice(0, 10)}: ${m.title}`);
      const parts = [head(s)];
      if (s.about) parts.push(`What it means: ${s.about}`);
      parts.push('', memos.length ? `Memos with the tag ${s.key}:\n${memos.join('\n')}` : `No memo has the tag ${s.key}.`);
      parts.push('', s.summary ? `Current summary:\n${s.summary}` : 'No summary yet.');
      console.log(parts.join('\n'));
    } else if (action === 'set') {
      if (!key || !flags.title) fail('Give the key and the title, for example: memo story set body --title "Feel good in my body"');
      const s = await call('/api/story', { key, title: flags.title, about: await text() });
      console.log(`Story ${s.key}: ${s.title}.`);
    } else if (action === 'summary') {
      if (!key) fail('Give the key of the story, for example: memo story summary body -- "<Markdown>"');
      const s = await call('/api/story/summary', { key, text: await text() });
      console.log(`The summary of the story ${s.key} is saved.`);
    } else if (action === 'ask') {
      const r = await call('/api/story/ask', { key: key || null });
      console.log(r.sent ? `Memo ${r.memo} asks main for the summary.` : `Memo ${r.memo} asks for it already.`);
    } else fail(USAGE);
  },
  async history() {
    const list = await call(`/api/history?days=${query(flags.days ?? 30)}`);
    if (!list.length) return console.log('No memos in that time.');
    console.log(list.map((m) => `#${m.id} ${m.created.slice(0, 10)} ${m.sender}->${m.recipient} ${m.state}${m.tags.length ? ` [${m.tags.join(' ')}]` : ''}: ${m.title}`
      + (m.result ? `\n    Result: ${m.result}` : '')).join('\n'));
  },
  async wait() {
    const who = need('as');
    const minutes = rest[0] === undefined ? 10080 : Number(rest[0]);
    if (!(minutes > 0)) fail('The time must be a number of minutes that is more than 0.');
    const hold = (flags.hold || '').split(',').filter(Boolean).map(memoId);
    const interval = Number(process.env.MEMO_WAIT_INTERVAL_MS || 30000);
    const end = Date.now() + minutes * 60000;
    for (;;) {
      // The server gets the held ids too, so the Log page can show them.
      const news = await call(`/api/news?for=${query(who)}${hold.length ? `&hold=${hold.join(',')}` : ''}`, undefined, { soft: true });
      if (news) {
        const fresh = news.to_you.filter((c) => !hold.includes(c.id));
        const noted = news.noted || [];
        if (fresh.length || news.results.length || noted.length) {
          // The server gives each new turn of the owner (noted) one time, so these memos are always printed.
          // The answers come again until the agent acks them. The new memos stay until the agent answers them,
          // and --hold takes them out of the next memo wait.
          const items = [
            ...noted.map((c) => ({ kind: 'noted', c, own: true })),
            ...news.results.map((c) => ({ kind: 'result', c, own: true })),
            ...fresh.map((c) => ({ kind: 'fresh', c, own: false })),
          ];
          let size = 0;
          let full = false;
          const done = [];
          for (const item of items) {
            if (full && item.kind !== 'noted') continue;
            const text = await shown(item.c, item.own);
            // The first memo is always printed in full, so a memo that is longer than the limit cannot block the wait.
            if (item.kind !== 'noted' && done.length && size + text.length > WAIT_MAX) { full = true; continue; }
            size += text.length;
            done.push({ ...item, text });
          }
          const of = (kind) => done.filter((d) => d.kind === kind);
          const ids = (list) => list.map((d) => d.c.id).join(' ');
          if (of('result').length) {
            console.log(`Results of memos from ${who}:\n\n${of('result').map((d) => d.text).join('\n')}`);
            console.log(`After you read the results, run: memo ack ${ids(of('result'))}\n`);
          }
          if (of('noted').length) {
            console.log(`Memos from ${who} that wait for your answer. The owner sent each one back with a new note. The full thread is in order, oldest first:\n\n${of('noted').map((d) => d.text).join('\n')}`);
            console.log(`Do what the new note asks. Then answer in the same memo: memo note <id> --from ${who} -- "<text>". The memo then goes back to the owner. Do not send a new memo for the answer.`);
            console.log(`To change the memo text with the answer, add --text "<new memo text>" to memo note: the memo text is then the current state. memo edit <id> -- "<new text>" changes only the text, and it also sends the memo back. memo wait gives each note one time; memo list --to ${who} shows the memos that still wait for your answer.\n`);
          }
          if (of('fresh').length) console.log(`New memos to ${who}:\n\n${of('fresh').map((d) => d.text).join('\n')}`);
          const left = items.length - done.length;
          if (left) {
            const held = [...hold, ...of('fresh').map((d) => d.c.id)];
            console.log(`${left} more: the output has a limit of ${WAIT_MAX} characters. Run memo wait again${held.length ? ` with --hold ${held.join(',')}` : ''} after you handle these.`);
          }
          return;
        }
      }
      if (Date.now() + interval > end) {
        console.log(`No news for ${who} in ${minutes} minutes.`);
        process.exit(2);
      }
      await new Promise((done) => setTimeout(done, interval));
    }
  },
};

if (!Object.hasOwn(commands, command ?? '')) fail(USAGE);
if (!token) fail('MEMO_TOKEN is not set. See .env.example.');
await commands[command]();
