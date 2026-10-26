// The capture collector. A capture page on a different host (for example on Vercel) keeps the memos that the owner
// writes while this computer is off. Each MEMO_CAPTURE_SECONDS (default 60) the server gets the waiting items, makes
// each one a memo from the owner, the same as the capture field of the Inbox, and then tells the page to delete it.
// The page must give these three routes, each with the pull token (Bearer):
//   GET  <url>/api/capture/pending       -> { items: [{ id, at, text }] }
//   GET  <url>/api/capture/image?name=<name> -> the bytes of an image that a text shows as ![image](image:<name>)
//   POST <url>/api/capture/done { id }   -> the page deletes the item and its images
// The table captures records each item that became a memo, so an item never becomes two memos.

export const DEFAULT_SECONDS = 60;
const IMAGE_LINK = /!\[[^\]\n]*\]\(image:([0-9a-f]{16}\.(?:png|jpg|gif|webp))\)/g;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export class CaptureError extends Error {}

export function createCaptureSync({ db, store, images, url, token, owner, to = 'main', fetch = globalThis.fetch, seconds = DEFAULT_SECONDS, now = () => new Date(), log = console.error }) {
  const base = String(url || '').replace(/\/+$/, '');
  const on = !!(base && token);
  const state = { on, to, seconds, last: null, ok: null, count: 0, error: null };
  let timer = null;
  let running = null;

  async function request(path, init = {}) {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new CaptureError(`${init.method || 'GET'} ${path.split('?')[0]} gave the status ${r.status}.`);
    return r;
  }
  const done = (id) => request('/api/capture/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });

  // One item: its images go into the image store, then the memo goes out and the table records it in one step.
  async function collect(item) {
    let text = String(item.text ?? '');
    for (const name of new Set([...text.matchAll(IMAGE_LINK)].map((m) => m[1]))) {
      const r = await request(`/api/capture/image?name=${encodeURIComponent(name)}`);
      const saved = images.save(new Uint8Array(await r.arrayBuffer())).name;
      // The page names an image as the server does, so the name is the same. If not, the text gets the stored name.
      if (saved !== name) text = text.replaceAll(`(image:${name})`, `(image:${saved})`);
    }
    const at = Number.isNaN(Date.parse(item.at)) ? null : new Date(item.at).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const { memo } = store.send({ from: owner, to, text });
      // The memo keeps the time that the owner wrote it on the page, not the time that this computer collected it.
      if (at && at < memo.created) db.prepare('UPDATE memos SET created = ? WHERE id = ?').run(at, memo.id);
      db.prepare('INSERT INTO captures (id, memo_id, at, collected) VALUES (?, ?, ?, ?)').run(item.id, memo.id, at, now().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  async function runOnce() {
    if (!on) return status();
    if (running) return running;
    running = (async () => {
      const at = now().toISOString();
      try {
        const data = await (await request('/api/capture/pending')).json();
        const items = (Array.isArray(data?.items) ? data.items : []).filter((i) => ID.test(String(i?.id)));
        items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        let n = 0;
        for (const item of items) {
          // An item that became a memo before, but the page did not delete it: only the delete goes again.
          if (!db.prepare('SELECT 1 FROM captures WHERE id = ?').get(item.id)) { await collect(item); n++; }
          await done(item.id);
        }
        Object.assign(state, { last: at, ok: true, count: n, error: null });
      } catch (e) {
        Object.assign(state, { last: at, ok: false, error: String(e?.message || e).replaceAll(token, '[token]') });
        log(`Capture: ${state.error}`);
      } finally { running = null; }
      return status();
    })();
    return running;
  }

  function start() {
    if (!on || timer) return;
    runOnce();
    timer = setInterval(runOnce, Math.max(10, seconds) * 1000);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  const status = () => ({ ...state });

  return { runOnce, start, stop, status };
}
