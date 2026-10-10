// The Memo command-line client. The agents call it through Bash: scripts/memo <command> ...
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  memo send --from <name> --to <name> [--impact 1-5 --effort micro|short|hour|half-day|day] [--due YYYY-MM-DD] [--] <text>
  memo reply <id> <text>
  memo close <id> [<text>]
  memo edit <id> [--] <new text>
  memo ack <id> [<id> ...]
  memo forward <id> [--to <agent>]
  memo status --as <agent> <text>
  memo recap --as <agent> <text>
  memo list --to <name>
  memo prompt --as <agent>
  memo image <path> [<text that describes the image>]
  memo wait --as <agent> [--hold <id>,<id>] [<max_minutes>]
A memo to the owner needs --impact and --effort.`;

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
const base = process.env.MEMO_URL || `http://127.0.0.1:${file.PORT || 3280}`;

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

const OPTIONS = ['from', 'to', 'as', 'impact', 'effort', 'due', 'hold'];
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
      flags[key] = argv[++i];
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

function show(c) {
  const head = `#${c.id} from ${c.sender} to ${c.recipient}, ${when(c.created)}`
    + (c.impact != null ? `, impact ${c.impact}, effort ${c.effort}` : '')
    + (c.due ? `, due ${c.due}` : '')
    + (c.state !== 'open' ? `, ${c.state}` : '');
  return `${head}\n${c.text}\n${c.reply ? `Reply: ${c.reply}\n` : ''}`;
}

const commands = {
  async send() {
    const r = await call('/api/send', {
      from: need('from'), to: need('to'), text: rest.join(' '),
      impact: flags.impact === undefined ? undefined : Number(flags.impact),
      effort: flags.effort, due: flags.due,
    });
    console.log(`Memo ${r.memo.id} is sent to ${r.memo.recipient}.`);
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
    for (const c of memos) console.log(show(c));
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
        if (fresh.length || news.results.length) {
          if (fresh.length) console.log(`New memos to ${who}:\n\n${fresh.map(show).join('\n')}`);
          if (news.results.length) {
            console.log(`Results of memos from ${who}:\n\n${news.results.map(show).join('\n')}`);
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
