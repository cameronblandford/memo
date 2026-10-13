// The rules for the list of the Inbox. This file has no DOM code, so a test can import it.

// A work ticket is a memo whose text contains the work code and a number, for example SUB-6.
const WORK = /\bSUB-\d+\b/;
export const isWork = (memo) => WORK.test(memo.text || '');

// The memos that the list shows.
export const shownMemos = (memos, workOnly) => (workOnly ? memos.filter(isWork) : memos);

// The id that the j key (step 1) or the k key (step -1) selects. The selection stops at the two ends. If the
// selected memo is not in the list, the first memo is the start.
export function step(memos, selected, by) {
  if (!memos.length) return null;
  const index = memos.findIndex((c) => c.id === selected);
  return memos[Math.min(memos.length - 1, Math.max(0, (index < 0 ? 0 : index + by)))].id;
}

// The text of the counter.
export function countText(shown, all, workOnly) {
  const memos = (n) => (n === 1 ? '1 memo' : `${n} memos`);
  return workOnly ? `${shown} of ${memos(all)}` : memos(all);
}
