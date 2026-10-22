import { EFFORTS, sortQueue, updatedTime } from './rank.js';
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
// The brief of a memo is one short line for each part, so the card of the Inbox fits a phone.
const MAX_TITLE = 60;
const MAX_NEXT = 100;
// The Chat page shows this many memos at most.
const MAX_THREAD = 500;

// A tag is a short lowercase word, for example work, money, or home-repair. A memo has 8 tags or fewer.
const TAG = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_TAGS = 8;
// An answer button is a short word or phrase with no comma. A memo has 6 buttons or fewer.
const MAX_CHOICE = 24;
const MAX_CHOICES = 6;
export const POSTPONE_HOUR = 9;

// A ticket key is the Linear identifier of an issue: the team key, "-", and the number, for example TFP-797.
const TICKET_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
// Gives the key in capitals, or a 400 error. Empty or missing: null.
export function checkTicketKey(v, field = 'ticket') {
  if (v === undefined || v === null || v === '') return null;
  const key = typeof v === 'string' ? v.trim().toUpperCase() : v;
  if (typeof key !== 'string' || !TICKET_KEY.test(key)) throw new MemoError(400, `${field} must be a ticket key such as TFP-797.`);
  return key;
}

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
// ensureTicket: called with the key of a memo that names a ticket, so the Desk has a row for it (src/tickets.js).
export function createStore(db, { names, owner = 'owner', forwardTo = names.filter((n) => n !== owner && n !== 'discord'), now = () => new Date(), timeZone = 'America/New_York', ensureTicket = () => {} }) {
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

  // The answer buttons from a request: a list, or one text with commas ('push,draft,skip'). Gives the clean list in
  // the order of the sender, with no duplicates.
  function checkChoices(v) {
    if (v === undefined || v === null || v === '') return [];
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!raw || raw.some((c) => typeof c !== 'string')) throw new MemoError(400, 'choices must be a list of words, or one text with commas.');
    const list = [...new Set(raw.map((c) => c.trim()).filter(Boolean))];
    for (const c of list) {
      if (c.length > MAX_CHOICE || /[,\r\n]/.test(c)) throw new MemoError(400, `A choice must be one line of ${MAX_CHOICE} characters or fewer, with no comma.`);
    }
    if (list.length > MAX_CHOICES) throw new MemoError(400, `A memo can have ${MAX_CHOICES} choices or fewer.`);
    return list;
  }

  // The notes of a memo, oldest first. A memo with no notes has no `notes` field, so an old client sees no change.
  // The tags and choices columns are text in the database and lists in each answer.
  const notesOf = (id) => db.prepare('SELECT id, author, text, created, read FROM notes WHERE memo_id = ? ORDER BY id').all(id).map(plain);
  function withNotes(row) {
    const notes = notesOf(row.id);
    const memo = { ...row, tags: row.tags ? row.tags.split(',') : [], choices: row.choices ? row.choices.split(',') : [] };
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

  // A memo that is not ended: open (the turn of the recipient) or waiting (the owner sent it back: the turn of the sender).
  function getActive(id) {
    const c = get(id);
    if (c.state !== 'open' && c.state !== 'waiting') throw new MemoError(409, `Memo ${c.id} is ${c.state}. It cannot change.`);
    return c;
  }

  function corrections(sender) {
    return db.prepare(
      `SELECT k.memo_id, k.old_impact, k.new_impact, k.at, substr(c.text, 1, 80) AS text
       FROM corrections k JOIN memos c ON c.id = k.memo_id
       WHERE k.sender = ? ORDER BY k.rowid DESC LIMIT 5`,
    ).all(sender).map(plain);
  }

  function send({ from, to, text, impact, effort, due, trusted, tags, title, next, choices, ticket } = {}) {
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
    const ask = checkChoices(choices);
    if (ask.length && to !== owner) throw new MemoError(400, `Only a memo to ${owner} can have choices.`);
    const key = checkTicketKey(ticket);
    if (key) ensureTicket(key);
    const r = db.prepare(
      // seen is 0 here and not from the column default: an older database has the default 1 for its old memos.
      'INSERT INTO memos (sender, recipient, text, impact, effort, due, trusted, created, seen, tags, title, next, choices, ticket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    ).run(from, to, body, impact, effort, d, trusted ? 1 : 0, ts(), t.join(','), name, step, ask.join(','), key);
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

  // Done in the Inbox. A memo that waits for its sender can close too.
  function close(id, text) {
    const c = getActive(id);
    const body = checkText('text', text, false);
    db.prepare(`UPDATE memos SET reply = ?, state = 'closed', closed = ? WHERE id = ?`).run(body, ts(), c.id);
    log(c.recipient, c.id, 'close', body || '');
    return get(c.id);
  }

  // A new text for an open memo, for example to make it easier to read. The impact, the effort, and the place in the queue stay.
  // An edit of a memo that waits for its sender is an answer: the memo goes back to the owner.
  function edit(id, text) {
    const c = getActive(id);
    // A text that the owner saw and that changes shows as "updated" in the Inbox.
    db.prepare("UPDATE memos SET text = ?, state = 'open', seen = CASE seen WHEN 1 THEN 2 ELSE seen END WHERE id = ?").run(checkText('text', text), c.id);
    // The sender changes the text to do what a note of the owner asks: an answer. All notes of the owner are read.
    answered(c.id);
    log(c.sender, c.id, 'edit', text);
    return get(c.id);
  }

  // A new brief for an open memo: the title, the next step, or both. A part that is not given stays.
  // An empty part removes it. The memo does not show as "updated": the text is the same.
  function brief(id, { title, next } = {}) {
    const c = getActive(id);
    if (title === undefined && next === undefined) throw new MemoError(400, 'Give title, next, or both.');
    const name = title === undefined ? c.title : checkLine('title', title, MAX_TITLE);
    const step = next === undefined ? c.next : checkLine('next', next, MAX_NEXT);
    db.prepare('UPDATE memos SET title = ?, next = ? WHERE id = ?').run(name, step, c.id);
    log(c.sender, c.id, 'brief', [name, step].filter(Boolean).join(' · next: '));
    return get(c.id);
  }

  // A note is one turn in the thread of a memo to the owner. The memo keeps its id and its place in the queue.
  //   A note of the owner (Send in the Inbox) gives the turn to the sender: the state changes to 'waiting', and the
  //   memo leaves the Inbox. memo wait gives it to the sender one time.
  //   A note of the sender (memo note) is the answer: the state changes back to 'open', and the memo comes back to
  //   the Inbox as "updated". A note of the sender on an open memo also shows as "updated".
  // A new note marks the notes of the other party as read: for the owner (the Inbox shows all notes) all of them;
  // for the sender only the notes of the owner that memo wait or memo list gave to the sender.
  // memoText (optional, only for the sender): the new memo text, the current state of the work. The text and the note
  // change in one step: the two change, or nothing changes. The memo goes back to the owner one time.
  function note(id, from, text, { memoText } = {}) {
    const c = getActive(id);
    if (c.recipient !== owner) throw new MemoError(400, `Only a memo to ${owner} can have notes.`);
    if (from !== owner && from !== c.sender) throw new MemoError(403, `Only ${owner} and ${c.sender} can add a note to memo ${c.id}.`);
    const body = checkText('text', text);
    if (body.length > MAX_NOTE) throw new MemoError(400, `A note must have ${MAX_NOTE} characters or fewer.`);
    const newText = memoText === undefined || memoText === null ? null : checkText('memo text', memoText);
    if (newText !== null && from !== c.sender) throw new MemoError(403, `Only ${c.sender} can change the text of memo ${c.id}.`);
    db.exec('BEGIN IMMEDIATE');
    try {
      addNote(c, from, body, newText);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return get(c.id);
  }
  function addNote(c, from, body, newText) {
    if (newText !== null) {
      db.prepare('UPDATE memos SET text = ? WHERE id = ?').run(newText, c.id);
      log(from, c.id, 'edit', newText);
    }
    db.prepare('INSERT INTO notes (memo_id, author, text, created) VALUES (?, ?, ?, ?)').run(c.id, from, body, ts());
    if (from === owner) {
      db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author != ?').run(c.id, from);
      // The owner wrote the turn, so the owner saw the memo.
      db.prepare("UPDATE memos SET state = 'waiting', seen = 1 WHERE id = ?").run(c.id);
    } else {
      answered(c.id);
      // A note of the sender shows as "updated" in the Inbox, as a changed text does.
      db.prepare("UPDATE memos SET state = 'open', seen = CASE seen WHEN 1 THEN 2 ELSE seen END WHERE id = ?").run(c.id);
    }
    log(from, c.id, 'note', body);
  }
  const unreadFromOwner = (id) => db.prepare('SELECT COUNT(*) AS n FROM notes WHERE memo_id = ? AND author = ? AND read = 0').get(id, owner).n;
  // True if the memo has a note of the owner that is not read and that memo wait or memo list did not give to the
  // reader yet. memo wait gives each turn of the owner one time.
  function hasNewTurn(memoId, reader) {
    const newest = db.prepare('SELECT MAX(id) AS id FROM notes WHERE memo_id = ? AND author = ? AND read = 0').get(memoId, owner).id;
    return newest != null && newest > deliveredNoteCut(memoId, reader);
  }

  // The id of the newest note of the owner on the memo that memo wait or memo list gave to the reader, or 0.
  // The event log tells it, with no new column: each note of the owner has a "note" event, and each delivery
  // a "delivered" event, in order. The notes before the delivery are the notes that the reader got.
  // A note from before the event log has no event; it is older than every event of the log.
  function deliveredNoteCut(memoId, reader) {
    const d = db.prepare(`SELECT MAX(id) AS id FROM events WHERE memo_id = ? AND kind = 'delivered' AND actor = ?`).get(memoId, reader).id;
    if (d == null) return 0;
    const ids = db.prepare('SELECT id FROM notes WHERE memo_id = ? AND author = ? ORDER BY id').all(memoId, owner).map((r) => r.id);
    const logged = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE memo_id = ? AND kind = 'note' AND actor = ?`).get(memoId, owner).n;
    const before = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE memo_id = ? AND kind = 'note' AND actor = ? AND id < ?`).get(memoId, owner, d).n;
    const got = Math.max(0, ids.length - logged) + before;
    return got ? ids[Math.min(got, ids.length) - 1] : 0;
  }

  // The sender answered (a note or an edit), or acked an old note: each note of the owner that exists now is read,
  // also when the sender saw it only in memo list (a peek, with no delivery). Thus memo wait never gives a turn
  // again that has an answer.
  function answered(memoId) {
    db.prepare('UPDATE notes SET read = 1 WHERE memo_id = ? AND author = ? AND read = 0').run(memoId, owner);
  }

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
    // A memo that waits for its sender needs an answer, not an ack: else it waits for ever.
    if (c.state === 'waiting') {
      throw new MemoError(409, `Memo ${c.id} waits for your answer. Answer in the memo: memo note ${c.id} --from ${c.sender} -- "<text>". The memo then goes back to ${owner}.`);
    }
    // For an open memo, the sender marks the notes of the owner as read, when no answer is necessary.
    // An old note of the owner on an open memo (from before threads): the ack marks it read.
    if (c.state === 'open' && unreadFromOwner(c.id)) {
      answered(c.id);
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
    if (to !== owner) return rows;
    // updated: the time of the last change, for the "Recently updated" order of the Inbox. An edit has no column
    // in memos, so its time comes from the event log (an edit from before the log has no time).
    const lastEdit = db.prepare(`SELECT MAX(at) AS at FROM events WHERE memo_id = ? AND kind = 'edit'`);
    return sortQueue(rows.map((m) => ({ ...m, updated: updatedTime(m, lastEdit.get(m.id)?.at) })), now());
  }

  // The memos to the owner that wait for their senders (the owner sent them back), the oldest first.
  function waiting() {
    return db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'waiting' ORDER BY id`).all(owner).map(withNotes);
  }

  // The postponed memos of the owner, the first to come back first.
  function postponed() {
    wake();
    return db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'open' AND until IS NOT NULL ORDER BY until, id`)
      .all(owner).map(withNotes);
  }

  // The memos between the owner and one agent, in the two directions, for the Chat page: the newest `limit` memos,
  // oldest first, with their notes. This is a read only: it records no delivery and no "seen".
  // more: true if older memos exist.
  function thread(agent, { limit = 50 } = {}) {
    checkParty('agent', agent, names.filter((n) => n !== owner && n !== 'discord'));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_THREAD) throw new MemoError(400, `limit must be a whole number from 1 to ${MAX_THREAD}.`);
    const rows = db.prepare(
      `SELECT * FROM memos WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) ORDER BY id DESC LIMIT ?`,
    ).all(owner, agent, agent, owner, limit + 1);
    return { memos: rows.slice(0, limit).reverse().map(withNotes), more: rows.length > limit };
  }

  // hold: the ids that memo wait does not show (memo wait --hold). Each answer records a delivery for the memos
  // that the wait shows, and the time of the request and the held ids for the Log page.
  // peek: a check that is not a read by the agent (the Discord watcher). It records no delivery and no poll.
  // results: the ended memos of this sender (replied or closed) that it did not ack. They come again until the ack.
  // noted: the memos of this sender that wait for it, with a new turn of the owner (never an open memo). Each turn
  //   comes one time: a later memo wait does not give it again.
  // waiting: all memos of this sender that wait for its answer, also when memo wait gave them before (for memo list).
  function news(who, { hold = [], peek = false } = {}) {
    const to_you = list(who);
    const results = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state IN ('replied', 'closed') AND acked = 0 ORDER BY id`)
      .all(who).map(withNotes);
    const noted = db.prepare(
      `SELECT * FROM memos WHERE sender = ? AND state = 'waiting'
       AND id IN (SELECT memo_id FROM notes WHERE author = ? AND read = 0) ORDER BY id`,
    ).all(who, owner).filter((m) => hasNewTurn(m.id, who)).map(withNotes);
    const waits = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state = 'waiting' ORDER BY id`).all(who).map(withNotes);
    if (peek) return { to_you, results, noted, waiting: waits };
    polls.set(who, { at: ts(), hold: to_you.filter((c) => hold.includes(c.id)).map((c) => c.id) });
    delivered(who, [...to_you.filter((c) => !hold.includes(c.id)), ...results, ...noted], 'by memo wait');
    return { to_you, results, noted, waiting: waits };
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
      const results = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state IN ('replied', 'closed') AND acked = 0 ORDER BY id`).all(name);
      const noted = db.prepare(
        `SELECT m.*, MIN(t.created) AS note_at FROM memos m JOIN notes t ON t.memo_id = m.id
         WHERE m.sender = ? AND m.state = 'waiting' AND t.author = ? AND t.read = 0 GROUP BY m.id ORDER BY m.id`,
      ).all(name, owner);
      return {
        name, poll,
        memos: [...open.map((c) => item(c, 'open', c.created)), ...results.map((c) => item(c, 'result', c.closed)),
          ...noted.map((c) => item(c, 'note', c.note_at))],
      };
    });
  }

  // owner_open: the work of the owner that waits for this agent. That is each open memo from the owner to the agent,
  // and each memo from the agent with a note of the owner that the agent did not read (a memo that waits for the agent).
  // owner_since: the time of the oldest of these memos or notes, or null. The Inbox compares it with the status time.
  function counts(name) {
    const n = (sql) => db.prepare(sql).get(name).n;
    const sent = db.prepare(`SELECT COUNT(*) AS n, MIN(created) AS since FROM memos WHERE sender = ? AND recipient = ? AND state = 'open'`).get(owner, name);
    const noted = db.prepare(
      `SELECT COUNT(DISTINCT m.id) AS n, MIN(t.created) AS since FROM notes t JOIN memos m ON m.id = t.memo_id
       WHERE m.sender = ? AND m.state = 'waiting' AND t.author = ? AND t.read = 0`,
    ).get(name, owner);
    const since = [sent.since, noted.since].filter(Boolean).sort()[0] ?? null;
    return {
      open_to: n(`SELECT COUNT(*) AS n FROM memos WHERE recipient = ? AND state = 'open'`),
      open_from: n(`SELECT COUNT(*) AS n FROM memos WHERE sender = ? AND state = 'open'`),
      owner_open: sent.n + noted.n,
      owner_since: since,
    };
  }

  return { get, send, reply, close, edit, brief, note, seen, check, adjust, ack, forward, tag, postpone, postponed, waiting, list, thread, news, delivered, inflight, events, corrections, counts, timeZone };
}
