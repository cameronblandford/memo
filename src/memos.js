import { EFFORTS, sortQueue } from './rank.js';
import { setCheckBox, summary } from '../ui/markdown.js';
import { createEvents } from './events.js';

export class MemoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_TEXT = 20000;
const MAX_NOTE = 4000;
// The brief of a memo is one short line for each part, so the compact view of the Inbox fits a phone.
const MAX_TITLE = 60;
const MAX_NEXT = 100;

// A tag is a short lowercase word, for example work, money, or home-repair. A memo has 8 tags or fewer.
const TAG = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_TAGS = 8;
export const POSTPONE_HOUR = 9;

// The time (ISO, UTC) of 9:00 on the date YYYY-MM-DD in the time zone. A postponed memo comes back then.
export function returnTime(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, POSTPONE_HOUR);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  // The difference between the clock in the zone and UTC at an instant.
  const offsetAt = (ms) => {
    const p = Object.fromEntries(format.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  // The offset at 9:00 UTC can differ from the offset at 9:00 in the zone, when a clock change falls between the two
  // (for example in Los Angeles on the day of the spring change). So the offset is read again at the first answer.
  const first = wanted - offsetAt(wanted);
  return new Date(wanted - offsetAt(first)).toISOString();
}

// forwardTo: the names that memo forward can send to (the long agents).
// owner: the name of the person who owns the queue (MEMO_OWNER). It is one of the names.
// timeZone: the zone of the owner. A postponed memo comes back at 9:00 there.
export function createStore(db, { names, owner = 'owner', forwardTo = names.filter((n) => n !== owner && n !== 'discord'), now = () => new Date(), timeZone = 'America/New_York' }) {
  const ts = () => now().toISOString();
  const plain = (row) => (row ? { ...row } : row);
  const events = createEvents(db, now);
  const log = events.add;
  // The last request of each agent for news (memo wait): the time, and the ids that the wait holds. Only in memory.
  const polls = new Map();

  function checkText(field, v, required = true) {
    if (v === undefined || v === null || v === '') {
      if (required) throw new MemoError(400, `${field} is necessary.`);
      return null;
    }
    if (typeof v !== 'string') throw new MemoError(400, `${field} must be text.`);
    if (v.length > MAX_TEXT) throw new MemoError(400, `${field} must have ${MAX_TEXT} characters or fewer.`);
    return v;
  }

  function checkParty(field, v, allowed) {
    if (!allowed.includes(v)) throw new MemoError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  }

  function checkDue(v) {
    if (v === undefined || v === null || v === '') return null;
    const ms = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    // The second check refuses a date such as 2026-02-30, which Date.parse moves to March.
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) {
      throw new MemoError(400, 'due must be a date in the form YYYY-MM-DD.');
    }
    return v;
  }

  // One part of a brief: one line, trimmed. Empty or missing: no value.
  function checkLine(field, v, max) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new MemoError(400, `${field} must be text.`);
    const line = v.trim();
    if (/[\r\n]/.test(line)) throw new MemoError(400, `${field} must be one line.`);
    if (line.length > max) throw new MemoError(400, `${field} must have ${max} characters or fewer.`);
    return line || null;
  }

  // One tag, or a list of tags, from a request. Gives the clean list, sorted and with no duplicates.
  function checkTags(v) {
    if (v === undefined || v === null || v === '') return [];
    const list = (Array.isArray(v) ? v : [v]).map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : t));
    for (const t of list) {
      if (typeof t !== 'string' || !TAG.test(t)) {
        throw new MemoError(400, 'A tag must be one lowercase word: a-z, 0-9 and "-", 24 characters or fewer, starting with a letter.');
      }
    }
    const tags = [...new Set(list)].sort();
    if (tags.length > MAX_TAGS) throw new MemoError(400, `A memo can have ${MAX_TAGS} tags or fewer.`);
    return tags;
  }

  // The notes of a memo, oldest first. A memo with no notes has no `notes` field, so an old client sees no change.
  // The tags column is text in the database and a list in each answer.
  const notesOf = (id) => db.prepare('SELECT id, author, text, created, read FROM notes WHERE memo_id = ? ORDER BY id').all(id).map(plain);
  function withNotes(row) {
    const notes = notesOf(row.id);
    const memo = { ...row, tags: row.tags ? row.tags.split(',') : [] };
    return notes.length ? { ...memo, notes } : memo;
  }

  function get(id) {
    const n = Number(id);
    const row = Number.isInteger(n) ? db.prepare('SELECT * FROM memos WHERE id = ?').get(n) : undefined;
    if (!row) throw new MemoError(404, `No memo has the id ${id}.`);
    return withNotes(row);
  }

  function getOpen(id) {
    const c = get(id);
    if (c.state !== 'open') throw new MemoError(409, `Memo ${c.id} is ${c.state}. It cannot change.`);
    return c;
  }

  function corrections(sender) {
    return db.prepare(
      `SELECT k.memo_id, k.old_impact, k.new_impact, k.at, substr(c.text, 1, 80) AS text
       FROM corrections k JOIN memos c ON c.id = k.memo_id
       WHERE k.sender = ? ORDER BY k.rowid DESC LIMIT 5`,
    ).all(sender).map(plain);
  }

  function send({ from, to, text, impact, effort, due, trusted, tags, title, next } = {}) {
    checkParty('from', from, names);
    checkParty('to', to, names.filter((n) => n !== 'discord'));
    const body = checkText('text', text);
    if (to === owner) {
      if (!Number.isInteger(impact) || impact < 1 || impact > 5) {
        throw new MemoError(400, `impact must be a whole number from 1 to 5 for a memo to ${owner}.`);
      }
      if (!EFFORTS.includes(effort)) {
        throw new MemoError(400, `effort must be one of: ${EFFORTS.join(', ')} for a memo to ${owner}.`);
      }
    } else {
      impact = null;
      effort = null;
    }
    const d = checkDue(due);
    const t = checkTags(tags);
    const name = checkLine('title', title, MAX_TITLE);
    const step = checkLine('next', next, MAX_NEXT);
    const r = db.prepare(
      // seen is 0 here and not from the column default: an older database has the default 1 for its old memos.
      'INSERT INTO memos (sender, recipient, text, impact, effort, due, trusted, created, seen, tags, title, next) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    ).run(from, to, body, impact, effort, d, trusted ? 1 : 0, ts(), t.join(','), name, step);
    const id = Number(r.lastInsertRowid);
    log(from, id, 'send', `to ${to}: ${name || body}`);
    return { memo: get(id), corrections: to === owner ? corrections(from) : [] };
  }

  function reply(id, text) {
    const c = getOpen(id);
    const body = checkText('text', text);
    db.prepare(`UPDATE memos SET reply = ?, state = 'replied', closed = ? WHERE id = ?`).run(body, ts(), c.id);
    log(c.recipient, c.id, 'reply', body);
    return get(c.id);
  }

  function close(id, text) {
    const c = getOpen(id);
    const body = checkText('text', text, false);
    db.prepare(`UPDATE memos SET reply = ?, state = 'closed', closed = ? WHERE id = ?`).run(body, ts(), c.id);
    log(c.recipient, c.id, 'close', body || '');
    return get(c.id);
  }

  // A new text for an open memo, for example to make it easier to read. The impact, the effort, and the place in the queue stay.
  function edit(id, text) {
    const c = getOpen(id);
    // A text that the owner saw and that changes shows as "updated" in the Inbox.
    db.prepare('UPDATE memos SET text = ?, seen = CASE seen WHEN 1 THEN 2 ELSE seen END WHERE id = ?').run(checkText('text', text), c.id);
    // The sender changes the text to do what a note of the owner asks. Thus the notes of the owner are read,
    // and memo wait does not give the same note again.
    db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author = ?').run(c.id, owner);
    log(c.sender, c.id, 'edit', text);
    return get(c.id);
  }

  // A new brief for an open memo: the title, the next step, or both. A part that is not given stays.
  // An empty part removes it. The memo does not show as "updated": the text is the same.
  function brief(id, { title, next } = {}) {
    const c = getOpen(id);
    if (title === undefined && next === undefined) throw new MemoError(400, 'Give title, next, or both.');
    const name = title === undefined ? c.title : checkLine('title', title, MAX_TITLE);
    const step = next === undefined ? c.next : checkLine('next', next, MAX_NEXT);
    db.prepare('UPDATE memos SET title = ?, next = ? WHERE id = ?').run(name, step, c.id);
    log(c.sender, c.id, 'brief', [name, step].filter(Boolean).join(' · next: '));
    return get(c.id);
  }

  // A note is a message in an open memo to the owner. The memo stays open and keeps its place in the queue.
  // The owner writes a note to ask for a change or for more data. The sender of the memo answers with a note.
  // A new note marks the notes of the other party as read.
  function note(id, from, text) {
    const c = getOpen(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} can have notes.`);
    if (from !== owner && from !== c.sender) throw new MemoError(403, `Only ${owner} and ${c.sender} can add a note to memo ${c.id}.`);
    const body = checkText('text', text);
    if (body.length > MAX_NOTE) throw new MemoError(400, `A note must have ${MAX_NOTE} characters or fewer.`);
    db.prepare('INSERT INTO notes (memo_id, author, text, created) VALUES (?, ?, ?, ?)').run(c.id, from, body, ts());
    db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author != ?').run(c.id, from);
    // A note of the sender shows as "updated" in the Inbox, as a changed text does.
    if (from !== owner) db.prepare('UPDATE memos SET seen = CASE seen WHEN 1 THEN 2 ELSE seen END WHERE id = ?').run(c.id);
    log(from, c.id, 'note', body);
    return get(c.id);
  }
  // The sender makes a short new memo from an open memo to the owner, when the owner asks for it (the Compact button).
  // The new memo has the new text and the impact, effort, due date, and tags of the old one. It shows as new.
  // The old memo closes with a link to the new one. It is acked, so the sender gets no result for it.
  function compact(id, from, { text, title, next } = {}) {
    const c = getOpen(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} can be compacted.`);
    if (from === owner || from !== c.sender) throw new MemoError(403, `Only ${c.sender} can compact memo ${c.id}.`);
    const { memo } = send({
      from, to: owner, text, impact: c.impact, effort: c.effort, due: c.due, tags: c.tags,
      title: title === undefined ? c.title : title, next: next === undefined ? c.next : next,
    });
    db.prepare(`UPDATE memos SET reply = ?, state = 'closed', closed = ?, acked = 1 WHERE id = ?`).run(`Compacted into memo #${memo.id}.`, ts(), c.id);
    db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author = ?').run(c.id, owner);
    log(from, c.id, 'compact', `into #${memo.id}`);
    return { memo, old: get(c.id) };
  }
  const unreadFromOwner = (id) => db.prepare('SELECT COUNT(*) AS n FROM notes WHERE memo_id = ? AND author = ? AND read = 0').get(id, owner).n;

  // The owner changes one check box of a memo ("- [ ] text"). The text changes only in that box, and the memo stays seen.
  function check(id, n, on) {
    const c = getOpen(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} has check boxes that change.`);
    if (!Number.isInteger(n) || typeof on !== 'boolean') throw new MemoError(400, 'n must be a whole number and on must be true or false.');
    const text = setCheckBox(c.text, n, on);
    if (text === null) throw new MemoError(404, `Memo ${c.id} has no check box ${n}.`);
    db.prepare('UPDATE memos SET text = ? WHERE id = ?').run(text, c.id);
    return get(c.id);
  }

  // The Inbox calls this when a memo was on the screen of the owner. The "new" or "updated" tag of the memo goes away.
  function seen(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((n) => Number.isInteger(n))) {
      throw new MemoError(400, 'ids must be a list of 1 to 500 memo ids.');
    }
    const mark = db.prepare('UPDATE memos SET seen = 1 WHERE id = ? AND recipient = ? AND seen != 1');
    let changed = 0;
    for (const id of ids) {
      const n = Number(mark.run(id, owner).changes);
      if (n) log(owner, id, 'seen', 'in the Inbox');
      changed += n;
    }
    return { seen: changed };
  }

  function adjust(id, delta) {
    const c = getOpen(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} has an impact.`);
    if (delta !== 1 && delta !== -1) throw new MemoError(400, 'delta must be 1 or -1.');
    const next = Math.min(5, Math.max(1, c.impact + delta));
    if (next !== c.impact) {
      db.prepare('UPDATE memos SET impact = ? WHERE id = ?').run(next, c.id);
      db.prepare('INSERT INTO corrections (memo_id, sender, old_impact, new_impact, at) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, c.sender, c.impact, next, ts());
    }
    return get(c.id);
  }

  function ack(id) {
    const c = get(id);
    // For an open memo, the sender marks the notes of the owner as read, when no answer is necessary.
    if (c.state === 'open' && unreadFromOwner(c.id)) {
      db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author = ?').run(c.id, owner);
      log(c.sender, c.id, 'ack', 'notes read');
      return get(c.id);
    }
    if (c.state === 'open') throw new MemoError(409, `Memo ${c.id} is open. It has no result.`);
    db.prepare('UPDATE memos SET acked = 1 WHERE id = ?').run(c.id);
    log(c.sender, c.id, 'ack', 'result read');
    return get(c.id);
  }

  // The liaison cannot write a memo from the owner. It can only pass on a message that the watcher marked
  // as written by the owner's own Discord account. The new memo has the text of that message, not text of the liaison.
  function forward(id, to) {
    const c = getOpen(id);
    if (c.sender !== 'discord' || !c.trusted) {
      throw new MemoError(403, `Memo ${c.id} is not a Discord message from the owner. It cannot go to an agent.`);
    }
    // trusted = 2: the message went on one time. A second forward would make the agent do the request again.
    if (c.trusted === 2) throw new MemoError(409, `Memo ${c.id} was already forwarded.`);
    checkParty('to', to, forwardTo);
    const sent = send({ from: owner, to, text: c.text });
    db.prepare('UPDATE memos SET trusted = 2 WHERE id = ?').run(c.id);
    log(c.recipient, c.id, 'forward', `to ${to} as #${sent.memo.id}`);
    return sent;
  }

  // Adds (on: true) or removes (on: false) one tag of a memo to the owner. The memo can be open or closed.
  function tag(id, name, on) {
    const c = get(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} has tags.`);
    if (typeof on !== 'boolean') throw new MemoError(400, 'on must be true or false.');
    const [t] = checkTags(name);
    if (!t) throw new MemoError(400, 'tag is necessary.');
    const tags = on ? checkTags([...c.tags, t]) : c.tags.filter((x) => x !== t);
    db.prepare('UPDATE memos SET tags = ? WHERE id = ?').run(tags.join(','), c.id);
    return get(c.id);
  }

  // Takes an open memo to the owner out of the Inbox until 9:00 on the date (YYYY-MM-DD) in the owner's zone.
  // date null: the memo comes back now. A postpone is not an answer: the sender gets no news from it.
  function postpone(id, date) {
    const c = getOpen(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} can be postponed.`);
    if (date === null) {
      db.prepare('UPDATE memos SET until = NULL WHERE id = ?').run(c.id);
      log(owner, c.id, 'postpone', 'back now');
      return get(c.id);
    }
    const day = checkDue(date);
    if (!day) throw new MemoError(400, 'date must be a date in the form YYYY-MM-DD, or null to bring the memo back now.');
    const until = returnTime(day, timeZone);
    if (until <= ts()) throw new MemoError(400, `The date must be in the future: 9:00 on ${day} has passed.`);
    db.prepare('UPDATE memos SET until = ? WHERE id = ?').run(until, c.id);
    log(owner, c.id, 'postpone', `until ${until}`);
    return get(c.id);
  }

  // A postponed memo whose time has come goes back to the Inbox as new, at the top until the owner sees it.
  // SET uses the old value of until for back.
  function wake() {
    const due = db.prepare('SELECT id FROM memos WHERE until IS NOT NULL AND until <= ?').all(ts());
    if (!due.length) return;
    db.prepare('UPDATE memos SET back = until, until = NULL, seen = 0 WHERE until IS NOT NULL AND until <= ?').run(ts());
    for (const { id } of due) log(owner, id, 'back', 'the postpone ended');
  }

  // The open memos to a name. For the owner, a postponed memo is not in the list, unless withPostponed.
  function list(to, { withPostponed = false } = {}) {
    checkParty('to', to, names);
    wake();
    const rows = db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'open' ORDER BY id`).all(to)
      .filter((r) => withPostponed || !r.until).map(withNotes);
    return to === owner ? sortQueue(rows, now()) : rows;
  }

  // The postponed memos of the owner, the first to come back first.
  function postponed() {
    wake();
    return db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'open' AND until IS NOT NULL ORDER BY until, id`)
      .all(owner).map(withNotes);
  }

  // hold: the ids that memo wait does not show (memo wait --hold). Each answer records a delivery for the memos
  // that the wait shows, and the time of the request and the held ids for the Log page.
  function news(who, { hold = [] } = {}) {
    const to_you = list(who);
    const results = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state != 'open' AND acked = 0 ORDER BY id`)
      .all(who).map(withNotes);
    // Open memos of this sender that have a note of the owner that the sender did not read.
    const noted = db.prepare(
      `SELECT * FROM memos WHERE sender = ? AND state = 'open'
       AND id IN (SELECT memo_id FROM notes WHERE author = ? AND read = 0) ORDER BY id`,
    ).all(who, owner).map(withNotes);
    polls.set(who, { at: ts(), hold: to_you.filter((c) => hold.includes(c.id)).map((c) => c.id) });
    delivered(who, [...to_you.filter((c) => !hold.includes(c.id)), ...results, ...noted], 'by memo wait');
    return { to_you, results, noted };
  }

  // The reader got these memos. Not for the owner: the Inbox records "seen" for the owner.
  function delivered(who, memos, how) {
    if (who === owner) return;
    for (const c of memos) events.delivered(who, c.id, how);
  }

  // For the Log page: for each agent, the memos that are on their way. stage:
  //   open:   an open memo to the agent;
  //   result: a memo from the agent with an answer that the agent did not ack;
  //   note:   an open memo from the agent with a note of the owner that the agent did not read.
  // delivered: the time when memo wait or memo list gave the memo to the agent after its last change, or null.
  // known: false for a memo from before the event log. held: memo wait holds the memo (--hold).
  function inflight() {
    const agents = names.filter((n) => n !== owner && n !== 'discord');
    const line = (c) => c.title || summary(c.text, 80);
    return agents.map((name) => {
      const poll = polls.get(name) || null;
      const item = (c, stage, since) => ({
        id: c.id, stage, sender: c.sender, recipient: c.recipient, state: c.state, line: line(c), since,
        ...events.deliveryOf(c.id, name), held: stage === 'open' && !!poll?.hold.includes(c.id),
      });
      const open = db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'open' ORDER BY id`).all(name);
      const results = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state != 'open' AND acked = 0 ORDER BY id`).all(name);
      const noted = db.prepare(
        `SELECT m.*, MIN(t.created) AS note_at FROM memos m JOIN notes t ON t.memo_id = m.id
         WHERE m.sender = ? AND m.state = 'open' AND t.author = ? AND t.read = 0 GROUP BY m.id ORDER BY m.id`,
      ).all(name, owner);
      return {
        name, poll,
        memos: [...open.map((c) => item(c, 'open', c.created)), ...results.map((c) => item(c, 'result', c.closed)),
          ...noted.map((c) => item(c, 'note', c.note_at))],
      };
    });
  }

  // owner_open: the work of the owner that waits for this agent. That is each open memo from the owner to the agent,
  // and each open memo from the agent with a note of the owner that the agent did not read.
  // owner_since: the time of the oldest of these memos or notes, or null. The Inbox compares it with the status time.
  function counts(name) {
    const n = (sql) => db.prepare(sql).get(name).n;
    const sent = db.prepare(`SELECT COUNT(*) AS n, MIN(created) AS since FROM memos WHERE sender = ? AND recipient = ? AND state = 'open'`).get(owner, name);
    const noted = db.prepare(
      `SELECT COUNT(DISTINCT m.id) AS n, MIN(t.created) AS since FROM notes t JOIN memos m ON m.id = t.memo_id
       WHERE m.sender = ? AND m.state = 'open' AND t.author = ? AND t.read = 0`,
    ).get(name, owner);
    const since = [sent.since, noted.since].filter(Boolean).sort()[0] ?? null;
    return {
      open_to: n(`SELECT COUNT(*) AS n FROM memos WHERE recipient = ? AND state = 'open'`),
      open_from: n(`SELECT COUNT(*) AS n FROM memos WHERE sender = ? AND state = 'open'`),
      owner_open: sent.n + noted.n,
      owner_since: since,
    };
  }

  return { get, send, reply, close, edit, brief, note, compact, seen, check, adjust, ack, forward, tag, postpone, postponed, list, news, delivered, inflight, events, corrections, counts, timeZone };
}
