// The order of the owner's queue. Change the weights and the due limit here only.
export const WEIGHTS = { micro: 1, short: 2, hour: 3, 'half-day': 5, day: 8 };
export const EFFORTS = Object.keys(WEIGHTS);
export const DUE_SOON_DAYS = 2;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The score is impact / weight. The two parts stay whole numbers so that equal scores compare as equal.
const parts = (c) => (c.impact && WEIGHTS[c.effort] ? [c.impact, WEIGHTS[c.effort]] : [0, 1]);

// Gives the test for a memo with a due date in the next days. Such a memo goes above all others.
export function dueSoon(now = new Date()) {
  const limit = new Date(now);
  limit.setDate(limit.getDate() + DUE_SOON_DAYS);
  const last = localDate(limit);
  return (c) => !!c.due && c.due <= last;
}

export function sortQueue(memos, now = new Date()) {
  const soon = dueSoon(now);
  return [...memos].sort((a, b) => {
    if (soon(a) !== soon(b)) return soon(a) ? -1 : 1;
    if (soon(a) && a.due !== b.due) return a.due < b.due ? -1 : 1;
    const [ai, aw] = parts(a);
    const [bi, bw] = parts(b);
    return bi * aw - ai * bw || a.id - b.id;
  });
}
