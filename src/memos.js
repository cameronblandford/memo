import { EFFORTS, sortQueue } from './rank.js';
import { setCheckBox } from '../ui/markdown.js';

export class MemoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_TEXT = 20000;

// forwardTo: the names that memo forward can send to (the long agents).
// owner: the name of the person who owns the queue (MEMO_OWNER). It is one of the names.
export function createStore(db, { names, owner = 'owner', forwardTo = names.filter((n) => n !== owner && n !== 'discord'), now = () => new Date() }) {
  const ts = () => now().toISOString();
  const plain = (row) => (row ? { ...row } : row);

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

  function get(id) {
    const n = Number(id);
    const row = Number.isInteger(n) ? db.prepare('SELECT * FROM memos WHERE id = ?').get(n) : undefined;
    if (!row) throw new MemoError(404, `No memo has the id ${id}.`);
    return plain(row);
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

  function send({ from, to, text, impact, effort, due, trusted } = {}) {
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
    const r = db.prepare(
      // seen is 0 here and not from the column default: an older database has the default 1 for its old memos.
      'INSERT INTO memos (sender, recipient, text, impact, effort, due, trusted, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
    ).run(from, to, body, impact, effort, d, trusted ? 1 : 0, ts());
    return { memo: get(Number(r.lastInsertRowid)), corrections: to === owner ? corrections(from) : [] };
  }

  function reply(id, text) {
    const c = getOpen(id);
    const body = checkText('text', text);
    db.prepare(`UPDATE memos SET reply = ?, state = 'replied', closed = ? WHERE id = ?`).run(body, ts(), c.id);
    return get(c.id);
  }

  function close(id, text) {
    const c = getOpen(id);
    const body = checkText('text', text, false);
    db.prepare(`UPDATE memos SET reply = ?, state = 'closed', closed = ? WHERE id = ?`).run(body, ts(), c.id);
    return get(c.id);
  }

  // A new text for an open memo, for example to make it easier to read. The impact, the effort, and the place in the queue stay.
  function edit(id, text) {
    const c = getOpen(id);
    // A text that the owner saw and that changes shows as "updated" in the Inbox.
    db.prepare('UPDATE memos SET text = ?, seen = CASE seen WHEN 1 THEN 2 ELSE seen END WHERE id = ?').run(checkText('text', text), c.id);
    return get(c.id);
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
    for (const id of ids) changed += Number(mark.run(id, owner).changes);
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
    if (c.state === 'open') throw new MemoError(409, `Memo ${c.id} is open. It has no result.`);
    db.prepare('UPDATE memos SET acked = 1 WHERE id = ?').run(c.id);
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
    return sent;
  }

  function list(to) {
    checkParty('to', to, names);
    const rows = db.prepare(`SELECT * FROM memos WHERE recipient = ? AND state = 'open' ORDER BY id`).all(to).map(plain);
    return to === owner ? sortQueue(rows, now()) : rows;
  }

  function news(who) {
    const to_you = list(who);
    const results = db.prepare(`SELECT * FROM memos WHERE sender = ? AND state != 'open' AND acked = 0 ORDER BY id`)
      .all(who).map(plain);
    return { to_you, results };
  }

  function counts(name) {
    const n = (sql) => db.prepare(sql).get(name).n;
    return {
      open_to: n(`SELECT COUNT(*) AS n FROM memos WHERE recipient = ? AND state = 'open'`),
      open_from: n(`SELECT COUNT(*) AS n FROM memos WHERE sender = ? AND state = 'open'`),
    };
  }

  return { get, send, reply, close, edit, seen, check, adjust, ack, forward, list, news, corrections, counts };
}
