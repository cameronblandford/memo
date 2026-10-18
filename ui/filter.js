// The rules for the list of the Inbox. This file has no DOM code, so a test can import it.

// A work ticket is a memo whose text contains the work code and a number, for example SUB-6, or a memo with the tag work.
const WORK = /\bSUB-\d+\b/;
export const isWork = (memo) => WORK.test(memo.text || '') || (memo.tags || []).includes('work');

// The tags that the Inbox suggests when the owner adds a tag. The owner can type any other tag.
export const STARTER_TAGS = ['work', 'admin', 'health', 'money', 'home', 'code', 'social'];

// The note of the Shorten button. The sender then closes the memo and sends a short new memo (memo compact).
export const COMPACT_NOTE = 'Shorten this memo: close it and send a new memo with a short summary, the open items (with check boxes), and the next step. Keep the impact, the effort, and the tags. Use: memo compact <id>';
// The memo has a Shorten note that the sender did not read yet: the button shows "Asked".
export const compactAsked = (memo) => (memo.notes || []).some((n) => n.text === COMPACT_NOTE && !n.read);

// The filters of the top bar: 'all', 'work', 'personal' (not work), or 'tag:<name>'.
export function matches(memo, filter) {
  if (filter === 'work') return isWork(memo);
  if (filter === 'personal') return !isWork(memo);
  if (filter.startsWith('tag:')) return (memo.tags || []).includes(filter.slice(4));
  return true;
}

// The memos that the list shows.
export const shownMemos = (memos, filter = 'all') => (filter === 'all' ? memos : memos.filter((m) => matches(m, filter)));

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
// The warning for the picker: the memo is due before it comes back.
export const dueWarning = (memo, date) => (memo.due && date && memo.due < date ? `This memo is due ${memo.due}, before it comes back.` : '');
