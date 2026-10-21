// The event log: one row for each step of a memo (send, delivered, ack, note, reply, close, edit, brief, compact, ...)
// and for each status line of an agent. The table is append-only (see db.js). The Log page reads it.
// A row has no token and no full text: the detail is a title or the first 80 characters.
import { summary } from '../ui/markdown.js';

// The first line of the text as plain text (no Markdown), 80 characters or fewer.
const MAX_DETAIL = 80;
export const snippet = (text) => summary(String(text ?? ''), MAX_DETAIL);

export function createEvents(db, now = () => new Date()) {
  const insert = db.prepare('INSERT INTO events (at, actor, memo_id, kind, detail) VALUES (?, ?, ?, ?, ?)');
  const last = db.prepare('SELECT actor, kind FROM events WHERE memo_id = ? ORDER BY id DESC LIMIT 1');

  function add(actor, memoId, kind, detail = '') {
    insert.run(now().toISOString(), String(actor), memoId ?? null, kind, snippet(detail));
  }

  // A memo that the reader got (from memo wait or memo list). The wait asks each 30 seconds, so a memo gets one
  // "delivered" row for each change: no new row while the last row of the memo is already a delivery to this reader.
  function delivered(actor, memoId, how) {
    const l = last.get(memoId);
    if (l && l.kind === 'delivered' && l.actor === actor) return;
    add(actor, memoId, 'delivered', how);
  }

  // The newest events first. agent: the events of the agent and of the memos to it or from it. memo: one memo.
  function list({ agent, memo, limit = 200 } = {}) {
    return db.prepare(
      `SELECT e.id, e.at, e.actor, e.memo_id, e.kind, e.detail FROM events e LEFT JOIN memos m ON m.id = e.memo_id
       WHERE (?1 IS NULL OR e.actor = ?1 OR m.sender = ?1 OR m.recipient = ?1) AND (?2 IS NULL OR e.memo_id = ?2)
       ORDER BY e.id DESC LIMIT ?3`,
    ).all(agent ?? null, memo ?? null, limit).map((r) => ({ ...r }));
  }

  // The last delivery of a memo to the reader, if it came after the last other step of the memo. Else null.
  // known: the memo has events (a memo from before the log has none).
  function deliveryOf(memoId, actor) {
    const rows = db.prepare('SELECT actor, kind, at FROM events WHERE memo_id = ? ORDER BY id DESC').all(memoId);
    const d = rows.find((r) => r.kind === 'delivered' && r.actor === actor);
    const change = rows.find((r) => r.kind !== 'delivered');
    const fresh = d && (!change || rows.indexOf(d) < rows.indexOf(change));
    return { known: rows.length > 0, delivered: fresh ? d.at : null };
  }

  return { add, delivered, list, deliveryOf };
}
