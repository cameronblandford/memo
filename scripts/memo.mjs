// The Memo command-line client. The agents call it through Bash: scripts/memo <command> ...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageNames } from '../ui/attach.js';

const USAGE = `Usage:
  memo send --from <name> --to <name> [--impact 1-5 --effort micro|short|hour|half-day|day] [--due YYYY-MM-DD] [--tag <tag> ...] [--title <name>] [--next <step>] [--] <text>
  memo tag <id> <tag> [<tag> ...]
  memo untag <id> <tag> [<tag> ...]
  memo postpone <id> <YYYY-MM-DD> | memo postpone <id> now
  memo reply <id> <text>
  memo close <id> [<text>]
  memo edit <id> [--] <new text>
  memo brief <id> [--title <name>] [--next <step>]
  memo note <id> --from <name> [--] <text>
  memo compact <id> --from <name> [--title <name>] [--next <step>] [--] <new text>
  memo ack <id> [<id> ...]
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
A memo to the owner needs --impact and --effort. --title and --next are the brief for the compact view of the Inbox.`;

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

const OPTIONS = ['from', 'to', 'as', 'impact', 'effort', 'due', 'hold', 'days', 'every', 'after', 'by', 'tag', 'title', 'next'];
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
// own: the reader sent these memos.
async function showAll(memos, own = false) {
  const out = [];
  for (const c of memos) {
    const lines = [];
    for (const name of broughtImages(c, own)) {
      const path = await localImage(name);
      lines.push(path ? `Image ${name} is the file ${path}. Open the file to see the image.` : `Image ${name}: memo could not get the file. Run the command again.`);
    }
    out.push(show(c) + (lines.length ? `${lines.join('\n')}\n` : ''));
  }
  return out.join('\n');
}

function show(c) {
  const head = `#${c.id} from ${c.sender} to ${c.recipient}, ${when(c.created)}`
    + (c.impact != null ? `, impact ${c.impact}, effort ${c.effort}` : '')
    + (c.due ? `, due ${c.due}` : '')
    + (c.tags?.length ? `, tags ${c.tags.join(' ')}` : '')
    + (c.until ? `, postponed until ${when(c.until)}` : '')
    + (c.state !== 'open' ? `, ${c.state}` : '');
  const notes = (c.notes || []).map((n) => `Note from ${n.author}, ${when(n.created)}${n.read ? '' : ' (not read)'}: ${n.text}\n`).join('');
  return `${head}\n${c.text}\n${notes}${c.reply ? `Reply: ${c.reply}\n` : ''}`;
}

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
      effort: flags.effort, due: flags.due, tags: flags.tag, title: flags.title, next: flags.next,
    });
    console.log(`Memo ${r.memo.id} is sent to ${r.memo.recipient}.${r.memo.tags?.length ? ` Tags: ${r.memo.tags.join(' ')}.` : ''}`);
    if (r.corrections.length) {
      console.log('The owner changed the impact of your last memos. Use this when you select an impact:');
      for (const k of r.corrections) console.log(`  memo ${k.memo_id}: ${k.old_impact} to ${k.new_impact} ("${k.text.replace(/\s+/g, ' ')}")`);
    }
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
  // The brief of an open memo for the compact view of the Inbox. An empty value removes that part.
  async brief() {
    const id = memoId(rest[0]);
    if (rest.length > 1) fail('Give the brief with --title and --next.');
    const m = await call('/api/brief', { id, title: flags.title, next: flags.next });
    console.log(`Memo ${id} has the brief: ${m.title || '(no title)'} · next: ${m.next || '(no next step)'}.`);
  },
  // A message in an open memo to the owner. The memo stays open.
  async note() {
    const id = memoId(rest[0]);
    await call('/api/note', { id, from: need('from'), text: rest.slice(1).join(' ') });
    console.log(`Memo ${id} has the note. It stays open.`);
  },
  // The owner asked for a short memo: the old memo closes, and a new memo with the new text takes its place.
  async compact() {
    const id = memoId(rest[0]);
    const r = await call('/api/compact', { id, from: need('from'), text: rest.slice(1).join(' '), title: flags.title, next: flags.next });
    console.log(`Memo ${id} is compacted into memo ${r.memo.id}.`);
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
  async wait() {
    const who = need('as');
    const minutes = rest[0] === undefined ? 10080 : Number(rest[0]);
    if (!(minutes > 0)) fail('The time must be a number of minutes that is more than 0.');
    const hold = (flags.hold || '').split(',').filter(Boolean).map(memoId);
    const interval = Number(process.env.MEMO_WAIT_INTERVAL_MS || 30000);
    const end = Date.now() + minutes * 60000;
    for (;;) {
      const news = await call(`/api/news?for=${query(who)}`, undefined, { soft: true });
      if (news) {
        const fresh = news.to_you.filter((c) => !hold.includes(c.id));
        const noted = news.noted || [];
        if (fresh.length || news.results.length || noted.length) {
          if (fresh.length) console.log(`New memos to ${who}:\n\n${await showAll(fresh)}`);
          if (noted.length) {
            console.log(`Open memos from ${who} with a new note of the owner. Each memo stays open:\n\n${await showAll(noted, true)}`);
            console.log(`Do what each note asks. Answer in the memo with: memo note <id> --from ${who} "<text>". To change the memo text, use memo edit.`);
            console.log(`If no answer is necessary, run: memo ack ${noted.map((c) => c.id).join(' ')}\n`);
          }
          if (news.results.length) {
            console.log(`Results of memos from ${who}:\n\n${await showAll(news.results, true)}`);
            console.log(`After you read the results, run: memo ack ${news.results.map((c) => c.id).join(' ')}`);
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
