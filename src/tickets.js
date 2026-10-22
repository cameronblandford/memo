// The Desk: one ticket is one task of an agent. A ticket has a Linear part (from the read-only sync in linear.js, or
// from the agent that adds it) and a Memo part (the agent, the Desk state, the PR, and a one-line summary).
// Memo never writes to Linear. An agent proposes a Linear change in a memo to the owner with the tag linear-draft.
import { MemoError, checkTicketKey } from './memos.js';
import { createEvents } from './events.js';
import { summary as summaryOf } from '../ui/markdown.js';

// The Desk states, in the order of the Desk page.
export const DESK_STATES = ['needs_you', 'working', 'in_review', 'landing', 'queued', 'done'];
export const STATE_LABELS = { needs_you: 'Needs you', working: 'Working', in_review: 'In review', landing: 'Landing', queued: 'Queued', done: 'Done' };
// A done ticket shows on the Desk for this time after its change to done.
export const DONE_DAYS = 7;
// The Linear state types of a closed issue. A closed issue with no agent is not in the Backlog.
export const CLOSED_TYPES = ['completed', 'canceled'];
const MAX_TITLE = 200;
const MAX_SUMMARY = 200;
const MAX_URL = 500;

// An https address, or null for an empty value.
export function checkUrl(field, v) {
  if (v === undefined || v === null || v === '') return null;
  let u;
  try { u = new URL(String(v)); } catch { u = null; }
  if (!u || u.protocol !== 'https:' || String(v).length > MAX_URL) throw new MemoError(400, `${field} must be an https address of ${MAX_URL} characters or fewer.`);
  return u.href;
}

// The number of a GitHub pull request address (.../pull/123), or null.
export const prNumber = (url) => {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url || '');
  return m ? Number(m[1]) : null;
};

function oneLine(field, v, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new MemoError(400, `${field} must be text.`);
  const line = v.replace(/\s+/g, ' ').trim();
  if (line.length > max) throw new MemoError(400, `${field} must have ${max} characters or fewer.`);
  return line || null;
}

// agents: the names of the agents that can work on a ticket. owner: the name of the owner.
export function createTickets(db, { owner = 'owner', agents = [], now = () => new Date() } = {}) {
  const ts = () => now().toISOString();
  const events = createEvents(db, now);
  const row = (key) => db.prepare('SELECT * FROM tickets WHERE key = ?').get(key);

  function get(key) {
    const k = checkTicketKey(key, 'key');
    const r = k && row(k);
    if (!r) throw new MemoError(404, `No ticket has the key ${key}.`);
    return { ...r };
  }

  // A memo names a ticket that the Desk does not have yet (for example before the first sync): a row with the key as
  // its title. The next sync fills in the Linear part.
  function ensure(key) {
    const k = checkTicketKey(key, 'key');
    if (!k) throw new MemoError(400, 'key is necessary.');
    db.prepare('INSERT OR IGNORE INTO tickets (key, title, created) VALUES (?, ?, ?)').run(k, k, ts());
    return k;
  }

  // Changes the Memo part of a ticket, and adds the ticket if it is not there. An empty value removes a field.
  // A ticket that gets an agent and has no Desk state is queued. actor: the name for the event log.
  function set(key, fields = {}, actor = owner) {
    const k = checkTicketKey(key, 'key');
    if (!k) throw new MemoError(400, 'key is necessary.');
    const f = {};
    if (fields.agent !== undefined) {
      const a = fields.agent === '' || fields.agent === null ? null : fields.agent;
      if (a !== null && !agents.includes(a)) throw new MemoError(400, `agent must be one of: ${agents.join(', ')}.`);
      f.agent = a;
    }
    if (fields.state !== undefined) {
      const s = fields.state === '' || fields.state === null ? null : fields.state;
      if (s !== null && !DESK_STATES.includes(s)) throw new MemoError(400, `state must be one of: ${DESK_STATES.join(', ')}.`);
      f.desk_state = s;
    }
    if (fields.pr !== undefined) {
      f.pr_url = checkUrl('pr', fields.pr);
      f.pr_number = prNumber(f.pr_url);
    }
    if (fields.summary !== undefined) f.summary = oneLine('summary', fields.summary, MAX_SUMMARY);
    if (fields.title !== undefined) {
      const t = oneLine('title', fields.title, MAX_TITLE);
      if (!t) throw new MemoError(400, 'title cannot be empty.');
      f.title = t;
    }
    if (fields.url !== undefined) f.url = checkUrl('url', fields.url);
    if (!Object.keys(f).length) throw new MemoError(400, 'Give one field or more: agent, state, pr, summary, title, url.');

    const old = row(k);
    if (!old) db.prepare('INSERT INTO tickets (key, title, created) VALUES (?, ?, ?)').run(k, f.title || k, ts());
    const before = old || row(k);
    const state = f.desk_state !== undefined ? f.desk_state : before.desk_state;
    const agent = f.agent !== undefined ? f.agent : before.agent;
    if (agent && !state) f.desk_state = 'queued';
    const finalState = f.desk_state !== undefined ? f.desk_state : before.desk_state;
    if (finalState === 'done' && before.desk_state !== 'done') f.done_at = ts();
    if (finalState !== 'done') f.done_at = null;
    f.desk_at = ts();
    const cols = Object.keys(f);
    db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE key = ?`).run(...cols.map((c) => f[c]), k);
    const t = row(k);
    events.add(actor, null, 'ticket', [k, t.desk_state ? STATE_LABELS[t.desk_state] : 'off the Desk', t.agent ? `agent ${t.agent}` : '', t.summary || ''].filter(Boolean).join(' · '));
    return { ...t };
  }

  // An issue from the Linear sync. Only the Linear part changes: the Memo part stays.
  function upsertLinear(issue, at = ts()) {
    const k = checkTicketKey(issue.key, 'key');
    if (!k) throw new MemoError(400, 'key is necessary.');
    const title = oneLine('title', String(issue.title ?? '').slice(0, MAX_TITLE), MAX_TITLE) || k;
    let url = null;
    try { url = checkUrl('url', issue.url); } catch { url = null; }
    db.prepare(
      `INSERT INTO tickets (key, title, url, linear_state, linear_type, team, priority, assignee_is_owner, updated_at, synced_at, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET title = excluded.title, url = excluded.url, linear_state = excluded.linear_state,
         linear_type = excluded.linear_type, team = excluded.team, priority = excluded.priority,
         assignee_is_owner = excluded.assignee_is_owner, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
    ).run(k, title, url, issue.linear_state ?? null, issue.linear_type ?? null, issue.team ?? null,
      Number.isInteger(issue.priority) ? issue.priority : null, issue.assignee_is_owner === false ? 0 : 1, issue.updated_at ?? null, at, ts());
    return { ...row(k) };
  }

  // The open memos to the owner that name a ticket and are not postponed: the questions of the Desk.
  function questions() {
    const rows = db.prepare(
      `SELECT id, sender, title, text, next, impact, created, ticket, tags FROM memos
       WHERE recipient = ? AND state = 'open' AND until IS NULL AND ticket IS NOT NULL ORDER BY impact DESC, id`,
    ).all(owner);
    const map = new Map();
    for (const m of rows) {
      const q = { id: m.id, sender: m.sender, title: m.title || summaryOf(m.text, 80) || `Memo ${m.id}`, text: m.text, next: m.next, impact: m.impact, created: m.created, tags: m.tags ? m.tags.split(',') : [] };
      if (!map.has(m.ticket)) map.set(m.ticket, []);
      map.get(m.ticket).push(q);
    }
    return map;
  }

  // The Desk: the groups in their order, and the Backlog. A ticket with an open question to the owner is in
  // Needs you, whatever its state. A done ticket shows for DONE_DAYS. The Backlog has the synced tickets of the owner
  // with no agent and no Desk state, that are not closed in Linear.
  function board() {
    const open = questions();
    const cut = new Date(now().getTime() - DONE_DAYS * 86400000).toISOString();
    const groups = Object.fromEntries(DESK_STATES.map((s) => [s, []]));
    const backlog = [];
    for (const r of db.prepare('SELECT * FROM tickets').all()) {
      const qs = open.get(r.key) || [];
      const t = { ...r, question: qs[0] || null, questions: qs.length };
      if (qs.length) groups.needs_you.push(t);
      else if (r.desk_state === 'done') { if (r.done_at && r.done_at >= cut) groups.done.push(t); }
      else if (r.desk_state) groups[r.desk_state].push(t);
      else if (!r.agent && r.synced_at && r.assignee_is_owner && !CLOSED_TYPES.includes(r.linear_type)) backlog.push(t);
    }
    const newest = (a, b) => (b.desk_at || b.created).localeCompare(a.desk_at || a.created);
    groups.needs_you.sort((a, b) => {
      if (!!a.question !== !!b.question) return a.question ? -1 : 1;
      if (a.question) return (b.question.impact || 0) - (a.question.impact || 0) || a.question.created.localeCompare(b.question.created);
      return (a.desk_at || '').localeCompare(b.desk_at || '');
    });
    for (const s of ['working', 'in_review', 'landing', 'queued']) groups[s].sort(newest);
    groups.done.sort((a, b) => b.done_at.localeCompare(a.done_at));
    // Linear priority 0 is "no priority": it goes after low (4).
    const rank = (p) => (p >= 1 && p <= 4 ? p : 5);
    backlog.sort((a, b) => rank(a.priority) - rank(b.priority) || (b.updated_at || '').localeCompare(a.updated_at || '') || a.key.localeCompare(b.key));
    return {
      groups: DESK_STATES.map((s) => ({ state: s, label: STATE_LABELS[s], tickets: groups[s] })),
      backlog,
    };
  }

  return { get, ensure, set, upsertLinear, board };
}
