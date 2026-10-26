// Stories: the things that the owner cares about for a long time, for example "feel good in my body". A story is not a
// memo: it has no state, no place in the queue, and it never closes. An agent writes its summary from the memos and the
// ticks (and, if the charter permits, from other data of the computer). A memo is in a story when it has the tag that is
// the key of the story; the agent can also find memos with no tag. Memos do not depend on a story.
// A request for a new summary is a memo from the owner to the agent with the tag story-summary: one for each story from
// the Stories page, and one for all stories each week (weekly(), on SUMMARY_DAY at 9:00 in the zone of the owner).
import { MemoError, returnTime } from './memos.js';
import { summary as firstLine } from '../ui/markdown.js';

export const STORY_KEY = /^[a-z][a-z0-9-]{0,23}$/; // the same rule as a tag (src/memos.js)
export const SUMMARY_TAG = 'story-summary';
export const MAX_TITLE = 80;
export const MAX_ABOUT = 2000;
export const MAX_SUMMARY = 20000;
export const MAX_HISTORY_DAYS = 400;
export const SUMMARY_DAY = 'Sun';

export function createStories(db, { store, owner = 'owner', agent = 'main', timeZone = 'America/New_York', now = () => new Date() }) {
  const ts = () => now().toISOString();
  const key = (v) => {
    const k = String(v ?? '').trim().toLowerCase();
    if (!STORY_KEY.test(k)) throw new MemoError(400, 'The key of a story is a tag: a-z, 0-9 and "-", 24 characters or fewer, and it starts with a letter.');
    return k;
  };
  const row = (k) => db.prepare('SELECT * FROM stories WHERE key = ?').get(k);
  const plain = (r) => ({ ...r });
  // The memos with the tag of the story, newest first. Tags are a list with commas (memos.tags).
  const tagged = (k) => db.prepare(
    "SELECT id, sender, recipient, state, created, closed, title, text, tags FROM memos WHERE ',' || tags || ',' LIKE ? ORDER BY id DESC",
  ).all(`%,${k},%`).map((m) => ({
    id: m.id, sender: m.sender, recipient: m.recipient, state: m.state, created: m.created, closed: m.closed,
    title: m.title || firstLine(m.text, 100), tags: m.tags ? m.tags.split(',') : [],
  }));
  const count = (k) => db.prepare("SELECT COUNT(*) AS n FROM memos WHERE ',' || tags || ',' LIKE ?").get(`%,${k},%`).n;
  // The open request for a summary of this story (or of all stories, key null), if any.
  const openRequest = (k) => db.prepare(
    "SELECT id FROM memos WHERE sender = ? AND recipient = ? AND state IN ('open', 'waiting') AND ',' || tags || ',' LIKE ? AND text LIKE ? ORDER BY id DESC",
  ).get(owner, agent, `%,${SUMMARY_TAG},%`, k ? `%story ${k}:%` : '%all stories:%');

  function get(k) {
    const r = row(key(k));
    if (!r) throw new MemoError(404, `No story has the key ${k}.`);
    return { ...plain(r), count: count(r.key), memos: tagged(r.key), request: openRequest(r.key)?.id ?? null };
  }
  function list() {
    return db.prepare('SELECT * FROM stories ORDER BY created, key').all()
      .map((r) => ({ ...plain(r), count: count(r.key), request: openRequest(r.key)?.id ?? openRequest(null)?.id ?? null }));
  }
  // A new story, or a new title or text for a story. The key does not change: it is the tag on the memos.
  function set({ key: k, title, about } = {}) {
    const id = key(k);
    const name = String(title ?? '').trim();
    if (!name) throw new MemoError(400, 'A story needs a title.');
    if (name.length > MAX_TITLE || name.includes('\n')) throw new MemoError(400, `The title of a story is one line of ${MAX_TITLE} characters or fewer.`);
    const text = String(about ?? '').trim();
    if (text.length > MAX_ABOUT) throw new MemoError(400, `The text of a story must have ${MAX_ABOUT} characters or fewer.`);
    if (row(id)) db.prepare('UPDATE stories SET title = ?, about = ? WHERE key = ?').run(name, text, id);
    else db.prepare('INSERT INTO stories (key, title, about, created) VALUES (?, ?, ?, ?)').run(id, name, text, ts());
    return get(id);
  }
  // The agent writes the summary. It replaces the earlier one.
  function writeSummary(k, text) {
    const r = get(k);
    const body = String(text ?? '').trim();
    if (!body) throw new MemoError(400, 'The summary is empty.');
    if (body.length > MAX_SUMMARY) throw new MemoError(400, `A summary must have ${MAX_SUMMARY} characters or fewer.`);
    db.prepare('UPDATE stories SET summary = ?, summary_at = ? WHERE key = ?').run(body, ts(), r.key);
    return get(r.key);
  }

  const requestText = (stories, all) => [
    all ? `Write the summaries of all stories: ${stories.map((s) => s.key).join(', ')}.` : `Write the summary of the story ${stories[0].key}: ${stories[0].title}.`,
    '',
    'Follow "Stories" in your charter. Run `memo story show <key>` for each story and `memo history --days <n>` for the memos, then save each summary with `memo story summary <key>`. Close this memo when the summaries are saved.',
  ].join('\n');
  // The owner asks for a new summary of one story (k) or of all stories (k null). An open request is not sent again.
  function ask(k = null) {
    const stories = k ? [get(k)] : list();
    if (!stories.length) throw new MemoError(400, 'There is no story yet.');
    const open = openRequest(k ? stories[0].key : null);
    if (open) return { memo: open.id, sent: false };
    // The text names the stories in a fixed form, so openRequest finds it: "story <key>:" or "all stories:".
    const { memo } = store.send({ from: owner, to: agent, text: requestText(stories, !k), tags: [SUMMARY_TAG] });
    return { memo: memo.id, sent: true };
  }

  // Each SUMMARY_DAY at 9:00 in the zone of the owner, one request for all stories. The server calls this each hour.
  function weekly() {
    if (!list().length) return null;
    const at = now();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(at).map((x) => [x.type, x.value]));
    if (p.weekday !== SUMMARY_DAY) return null;
    const start = returnTime(`${p.year}-${p.month}-${p.day}`, timeZone);
    if (at.toISOString() < start) return null;
    const sent = db.prepare("SELECT 1 FROM memos WHERE sender = ? AND recipient = ? AND ',' || tags || ',' LIKE ? AND text LIKE '%all stories:%' AND created >= ?")
      .get(owner, agent, `%,${SUMMARY_TAG},%`, start);
    return sent ? null : ask(null);
  }

  // The memos of the last `days` days, for the agent that writes a summary: each memo that was sent, changed, or ended
  // in that time, oldest first, in a short form. The requests for summaries are not in it.
  function history(days = 30) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_DAYS) throw new MemoError(400, `days must be a whole number from 1 to ${MAX_HISTORY_DAYS}.`);
    const since = new Date(now().getTime() - n * 86400000).toISOString();
    return db.prepare(
      `SELECT id, sender, recipient, state, created, closed, title, text, reply, tags FROM memos
       WHERE (created >= ? OR closed >= ?) AND sender != 'discord' AND recipient != 'liaison'
         AND ',' || tags || ',' NOT LIKE ? ORDER BY id`,
    ).all(since, since, `%,${SUMMARY_TAG},%`).map((m) => ({
      id: m.id, sender: m.sender, recipient: m.recipient, state: m.state, created: m.created, closed: m.closed,
      title: m.title || firstLine(m.text, 120), tags: m.tags ? m.tags.split(',') : [], result: m.reply ? firstLine(m.reply, 200) : null,
    }));
  }

  return { list, get, set, writeSummary, ask, weekly, history };
}
