// The rules for the list of the Inbox. This file has no DOM code, so a test can import it.

// A work ticket is a memo whose text contains the work code and a number, for example SUB-6, or a memo with the tag work.
const WORK = /\bSUB-\d+\b/;
export const isWork = (memo) => WORK.test(memo.text || '') || (memo.tags || []).includes('work');

// The tags that the Inbox suggests when the owner adds a tag. The owner can type any other tag.
export const STARTER_TAGS = ['work', 'admin', 'health', 'money', 'home', 'code', 'social'];

// The filters of the top bar: 'all', 'work', 'personal' (not work), or 'tag:<name>'.
export function matches(memo, filter) {
  if (filter === 'work') return isWork(memo);
  if (filter === 'personal') return !isWork(memo);
  if (filter.startsWith('tag:')) return (memo.tags || []).includes(filter.slice(4));
  return true;
}

// The memos that the list shows.
export const shownMemos = (memos, filter = 'all') => (filter === 'all' ? memos : memos.filter((m) => matches(m, filter)));

// The orders of the Inbox: 'rank' (the order of the server: returned, due soon, impact / effort) or 'updated' (the
// memo with the newest change first; the server gives `updated`, see updatedTime in src/rank.js). Equal times keep
// the rank order. A saved value that is not a choice gives 'rank'.
export const SORTS = [['rank', 'Rank'], ['updated', 'Recently updated']];
export const sortChoice = (value) => (SORTS.some(([v]) => v === value) ? value : 'rank');
export function sortedMemos(memos, sort = 'rank') {
  if (sort !== 'updated') return memos;
  const at = (m) => m.updated || m.created || '';
  return [...memos].sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? 1 : -1));
}

// The choices of the filter: All, Work, Personal, and each tag in use (not work, which has its own choice).
// A filter that is saved on the device and has no memo now stays in the list, so the choice does not jump.
export function filterChoices(memos, current = 'all') {
  const tags = new Set(memos.flatMap((m) => m.tags || []));
  tags.delete('work');
  if (current.startsWith('tag:')) tags.add(current.slice(4));
  return [['all', 'All'], ['work', 'Work'], ['personal', 'Personal'], ...[...tags].sort().map((t) => [`tag:${t}`, `#${t}`])];
}

// The tags to suggest for a memo: the starter tags and the tags in use, without the tags that the memo has.
export function tagSuggestions(memos, memo) {
  const all = new Set([...STARTER_TAGS, ...memos.flatMap((m) => m.tags || [])]);
  return [...all].filter((t) => !(memo.tags || []).includes(t)).sort();
}

// The id that the j key (step 1) or the k key (step -1) selects. The selection stops at the two ends. If the
// selected memo is not in the list, the first memo is the start.
export function step(memos, selected, by) {
  if (!memos.length) return null;
  const index = memos.findIndex((c) => c.id === selected);
  return memos[Math.min(memos.length - 1, Math.max(0, (index < 0 ? 0 : index + by)))].id;
}

// The text of the counter.
export function countText(shown, all, filtered) {
  const memos = (n) => (n === 1 ? '1 memo' : `${n} memos`);
  return filtered ? `${shown} of ${memos(all)}` : memos(all);
}

// Dates for the postpone picker, as YYYY-MM-DD in the owner's time zone.
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The next Monday after the date. On a Monday, that is 7 days later.
export function nextMonday(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday ... 6 Saturday
  return addDays(date, ((8 - day) % 7) || 7);
}
// The same day one month later, or the last day of that month (Jan 31 gives Feb 28 or 29).
export function inAMonth(date) {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // the number of days of the next month
  return new Date(Date.UTC(y, m, Math.min(d, last), 12)).toISOString().slice(0, 10);
}
// The warning for the picker: the memo is due before it comes back.
export const dueWarning = (memo, date) => (memo.due && date && memo.due < date ? `This memo is due ${memo.due}, before it comes back.` : '');

// The one-card view: the place of the card in the list. The memo of the card keeps its card when the list changes.
// When that memo left the list (reply, close, postpone), the memo that took its place comes next. The place
// list.length is the end of the cards: the summary.
export function cardIndex(memos, id, pos) {
  const at = memos.findIndex((m) => m.id === id);
  if (at >= 0) return at;
  return Math.max(0, Math.min(Number.isInteger(pos) ? pos : 0, memos.length));
}

// The text of the progress line of the one-card view, for example "3 of 12".
export const cardProgress = (at, total) => `${Math.min(at + 1, total)} of ${total}`;

// A memo with no change (send, note, edit, or return from a postpone) for this many days goes into the fold at the
// bottom of the Inbox. The server gives `updated`; a memo without it uses its send time.
export const OLD_DAYS = 5;
export function isOld(memo, now = Date.now()) {
  const at = Date.parse(memo.updated || memo.created || '');
  return Number.isFinite(at) && now - at >= OLD_DAYS * 86400000;
}
// The list of the Inbox in two parts: the memos with a recent change, and the old memos of the fold. Each part
// keeps the order of the list.
export function splitOld(memos, now = Date.now()) {
  const fresh = [];
  const old = [];
  for (const m of memos) (isOld(m, now) ? old : fresh).push(m);
  return { fresh, old };
}
