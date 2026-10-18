import { MemoError } from './memos.js';
import { EFFORTS, WEIGHTS } from './rank.js';

// A tick is a small action of the owner that comes back: each day, on some days of the week, or some days after
// the owner did it last. A tick is not a memo. It has no reply, no due date, and no backlog: a tick that the owner
// did not do goes away at the end of the day.
export const MAX_ACTIVE = 10;
const MAX_TEXT = 80;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const pad = (n) => String(n).padStart(2, '0');

// dayStart: the hour at which a new day starts, so that a tick of the evening is still there after midnight.
// timeZone: an IANA name, for a server that is not in the time zone of the owner. The default is that of the computer.
export function createTicks(db, { now = () => new Date(), dayStart = 3, timeZone } = {}) {
  if (!Number.isInteger(dayStart) || dayStart < 0 || dayStart > 23) throw new Error('The start of the day must be a whole hour from 0 to 23.');
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (date) => Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  // The day of the owner: its date, its day of the week, and the minutes since it started.
  function dayOf(at) {
    const d = local(new Date(at.getTime() - dayStart * 3600000));
    return { day: `${d.year}-${d.month}-${d.day}`, weekday: d.weekday.toLowerCase(), minutes: Number(d.hour) * 60 + Number(d.minute) };
  }
  const today = () => dayOf(now());
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const weekdayOf = (day) => DAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7];
  // A time of day as minutes since the start of the day of the owner.
  const sinceStart = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h * 60 + m - dayStart * 60 + 1440) % 1440; };
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  function checkFields(f, { partial = false } = {}) {
    const out = {};
    if (f.text !== undefined || !partial) {
      if (typeof f.text !== 'string' || !f.text.trim()) throw new MemoError(400, 'text is necessary.');
      const text = f.text.replace(/\s+/g, ' ').trim();
      if (text.length > MAX_TEXT) throw new MemoError(400, `The text of a tick must have ${MAX_TEXT} characters or fewer.`);
      out.text = text;
    }
    if (f.impact !== undefined || !partial) {
      if (!Number.isInteger(f.impact) || f.impact < 1 || f.impact > 5) throw new MemoError(400, 'impact must be a whole number from 1 to 5.');
      out.impact = f.impact;
    }
    if (f.effort !== undefined || !partial) {
      if (!EFFORTS.includes(f.effort)) throw new MemoError(400, `effort must be one of: ${EFFORTS.join(', ')}.`);
      out.effort = f.effort;
    }
    if (f.days !== undefined) {
      const list = String(f.days ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      if (list.some((d) => !DAYS.includes(d))) throw new MemoError(400, `days must be a list from: ${DAYS.join(', ')}.`);
      out.days = DAYS.filter((d) => list.includes(d)).join(',');
    }
    if (f.every !== undefined) {
      if (!Number.isInteger(f.every) || f.every < 1 || f.every > 365) throw new MemoError(400, 'every must be a whole number of days from 1 to 365.');
      out.every = f.every;
    }
    for (const key of ['after', 'by']) {
      if (f[key] === undefined) continue;
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(f[key] ?? ''));
      if (f[key] && !m) throw new MemoError(400, `${key} must be a time in the form HH:MM.`);
      out[key] = m ? `${pad(Number(m[1]))}:${m[2]}` : '';
    }
    return out;
  }

  function get(id) {
    const n = Number(id);
    const row = Number.isInteger(n) ? db.prepare('SELECT * FROM ticks WHERE id = ? AND active = 1').get(n) : undefined;
    if (!row) throw new MemoError(404, `No tick has the id ${id}.`);
    return { ...row };
  }
  const active = () => db.prepare('SELECT * FROM ticks WHERE active = 1 ORDER BY id').all().map((r) => ({ ...r }));
  const lastDone = (id) => db.prepare("SELECT MAX(day) AS day FROM tick_log WHERE tick_id = ? AND state = 'done'").get(id).day;

  function add(fields) {
    const f = checkFields(fields);
    if (active().length >= MAX_ACTIVE) throw new MemoError(409, `${MAX_ACTIVE} ticks are active, which is the limit. Remove one first.`);
    const r = db.prepare('INSERT INTO ticks (text, impact, effort, days, every, after, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.text, f.impact, f.effort, f.days ?? '', f.every ?? 1, f.after ?? '', f.by ?? '', now().toISOString());
    return get(Number(r.lastInsertRowid));
  }

  function set(id, fields) {
    const t = get(id);
    const f = checkFields(fields, { partial: true });
    const keys = Object.keys(f);
    if (!keys.length) throw new MemoError(400, 'Give one field or more to change.');
    db.prepare(`UPDATE ticks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), t.id);
    return get(t.id);
  }

  // The impact that the owner sets stays for the next days.
  function adjust(id, delta) {
    const t = get(id);
    if (delta !== 1 && delta !== -1) throw new MemoError(400, 'delta must be 1 or -1.');
    return set(t.id, { impact: Math.min(5, Math.max(1, t.impact + delta)) });
  }

  function remove(id) {
    const t = get(id);
    db.prepare('UPDATE ticks SET active = 0 WHERE id = ?').run(t.id);
    return { id: t.id, removed: true };
  }

  // Is the tick on the schedule on this day? The time of day is a different question (see due).
  function scheduled(t, { day, weekday }) {
    if (t.days && !t.days.split(',').includes(weekday)) return false;
    const last = lastDone(t.id);
    return t.every <= 1 || !last || daysBetween(last, day) >= t.every;
  }

  const markOn = (id, day) => db.prepare('SELECT state FROM tick_log WHERE tick_id = ? AND day = ?').get(id, day)?.state;

  // A tick is overdue, and goes to the top of the list, in three cases:
  // - it has a time "by" and that time of today is past;
  // - it has "every", and the day on which it came back is before today;
  // - the owner did not do it and did not skip it on the last day of its schedule before today.
  // A skip on that day is a decision of the owner, so the tick is not overdue after a skip.
  function overdue(t, t0) {
    if (t.by && t0.minutes >= sinceStart(t.by)) return true;
    const first = dayOf(new Date(t.created)).day;
    if (t.every > 1) {
      const last = lastDone(t.id);
      const back = last ? addDays(last, t.every) : first;
      return back < t0.day && markOn(t.id, addDays(t0.day, -1)) !== 'skip';
    }
    const allowed = t.days ? t.days.split(',') : DAYS;
    for (let n = 1; n <= 7; n++) {
      const day = addDays(t0.day, -n);
      if (day < first) return false;
      if (allowed.includes(weekdayOf(day))) return !markOn(t.id, day);
    }
    return false;
  }

  // The ticks that the owner can do now: on the schedule today, not done and not skipped today, and after their time.
  function due() {
    const t0 = today();
    return active().filter((t) => {
      if (markOn(t.id, t0.day)) return false;
      if (!scheduled(t, t0)) return false;
      return !t.after || t0.minutes >= sinceStart(t.after);
    }).map((t) => ({ id: t.id, text: t.text, impact: t.impact, effort: t.effort, overdue: overdue(t, t0) }));
  }

  function mark(id, state) {
    const t = get(id);
    db.prepare('INSERT INTO tick_log (tick_id, day, state, at) VALUES (?, ?, ?, ?) ON CONFLICT (tick_id, day) DO UPDATE SET state = excluded.state, at = excluded.at')
      .run(t.id, today().day, state, now().toISOString());
    return { id: t.id, day: today().day, state };
  }
  const done = (id) => mark(id, 'done');
  const skip = (id) => mark(id, 'skip');
  function undo(id) {
    const t = get(id);
    db.prepare('DELETE FROM tick_log WHERE tick_id = ? AND day = ?').run(t.id, today().day);
    return { id: t.id, day: today().day, state: null };
  }

  // For the review: each active tick with its marks of the last days. The newest day is last.
  function log(days = 7) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new MemoError(400, 'days must be a whole number from 1 to 90.');
    const end = today().day;
    const list = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
    return active().map((t) => {
      const marks = new Map(db.prepare('SELECT day, state FROM tick_log WHERE tick_id = ? AND day >= ?').all(t.id, list[0]).map((r) => [r.day, r.state]));
      const states = list.map((day) => marks.get(day) || null);
      return {
        ...t, from: list[0], to: end, states,
        done: states.filter((s) => s === 'done').length, skipped: states.filter((s) => s === 'skip').length,
      };
    });
  }

  return { add, set, adjust, remove, due, done, skip, undo, log, list: active, today };
}

// The place of each tick in the sorted queue of the owner. A tick has the same score as a memo: impact / weight.
// It goes above the first memo that has a lower score. With an equal score the memo goes first, because a memo waits
// for a decision. It never goes above a memo with a due date that is near, and its score does not change through the day.
// An overdue tick is the exception: it goes to the top of the list.
// `before` is the id of the memo below the tick, or null for the end.
export function placeTicks(sortedMemos, ticks, isSoon = () => false) {
  const score = (c) => [c.impact || 0, WEIGHTS[c.effort] || 1];
  return [...ticks]
    .sort((a, b) => { const [ai, aw] = score(a); const [bi, bw] = score(b); return !!b.overdue - !!a.overdue || bi * aw - ai * bw || a.id - b.id; })
    .map((t) => {
      if (t.overdue) return { ...t, before: sortedMemos.length ? sortedMemos[0].id : null };
      const [ti, tw] = score(t);
      const below = sortedMemos.find((m) => { if (isSoon(m)) return false; const [mi, mw] = score(m); return mi * tw < ti * mw; });
      return { ...t, before: below ? below.id : null };
    });
}
