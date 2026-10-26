// The capture collector. Each test gives a fake capture page: no test sends a request to a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeApp } from './helpers.js';
import { createCaptureSync } from '../src/capture.js';

const URL = 'https://capture.example';
const PULL = 'pull-token-0123456789';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const PNG_NAME = `${createHash('sha256').update(PNG).digest('hex').slice(0, 16)}.png`;

// A fake page with the items in `items`. It records each request, and `done` deletes an item, as the real page does.
function fakePage(items, { images = {}, failDone = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body && JSON.parse(init.body) });
    const u = new globalThis.URL(url);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => body });
    if (init.headers?.Authorization !== `Bearer ${PULL}`) return reply(401, {});
    if (u.pathname === '/api/capture/pending') return reply(200, { items: [...items] });
    if (u.pathname === '/api/capture/image') {
      const bytes = images[u.searchParams.get('name')];
      return bytes ? reply(200, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) : reply(404, {});
    }
    if (u.pathname === '/api/capture/done') {
      if (failDone) return reply(500, {});
      const i = items.findIndex((x) => x.id === JSON.parse(init.body).id);
      if (i >= 0) items.splice(i, 1);
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  fn.calls = calls;
  return fn;
}
function setup(fetch) {
  const ctx = makeApp();
  const sync = createCaptureSync({ db: ctx.db, store: ctx.store, images: ctx.images, owner: 'cam', url: `${URL}/`, token: PULL, fetch, now: () => NOW, log: () => {} });
  return { ...ctx, sync };
}
const toMain = (db) => db.prepare("SELECT * FROM memos WHERE recipient = 'main' ORDER BY id").all();

test('without a URL or a token the collector is off and sends no request', async () => {
  const fetch = fakePage([]);
  const ctx = makeApp();
  for (const opts of [{ url: '', token: PULL }, { url: URL, token: '' }]) {
    const sync = createCaptureSync({ db: ctx.db, store: ctx.store, images: ctx.images, owner: 'cam', fetch, ...opts });
    assert.equal((await sync.runOnce()).on, false);
  }
  assert.equal(fetch.calls.length, 0);
});

test('each item becomes a memo from the owner to main, oldest first, with the time of the page', async () => {
  const items = [
    { id: 'b', at: '2026-10-26T09:30:00.000Z', text: 'Second item' },
    { id: 'a', at: '2026-10-26T08:00:00.000Z', text: 'Check that Alex has TSA PreCheck' },
  ];
  const fetch = fakePage(items);
  const { sync, db } = setup(fetch);
  const s = await sync.runOnce();
  assert.equal(s.ok, true);
  assert.equal(s.count, 2);
  const memos = toMain(db);
  assert.deepEqual(memos.map((m) => [m.sender, m.text, m.created, m.state]), [
    ['cam', 'Check that Alex has TSA PreCheck', '2026-10-26T08:00:00.000Z', 'open'],
    ['cam', 'Second item', '2026-10-26T09:30:00.000Z', 'open'],
  ]);
  assert.equal(items.length, 0, 'the page deleted the two items');
  assert.ok(fetch.calls.every((c) => c.auth === `Bearer ${PULL}` && c.url.startsWith(`${URL}/api/capture/`)));
});

test('an image of an item goes into the image store before the memo goes out', async () => {
  const text = `Look at this\n\n![image](image:${PNG_NAME})\n`;
  const { sync, db, images } = setup(fakePage([{ id: 'img', at: NOW.toISOString(), text }], { images: { [PNG_NAME]: PNG } }));
  await sync.runOnce();
  assert.ok(toMain(db)[0].text.startsWith('Look at this'));
  assert.ok(toMain(db)[0].text.includes(`(image:${PNG_NAME})`));
  assert.deepEqual(images.read(PNG_NAME).bytes, PNG);
});

test('an image that the page cannot give stops the item: no memo, no delete, and the next run tries again', async () => {
  const items = [{ id: 'x', at: NOW.toISOString(), text: `![image](image:${PNG_NAME})` }];
  const fetch = fakePage(items);
  const { sync, db } = setup(fetch);
  const s = await sync.runOnce();
  assert.equal(s.ok, false);
  assert.match(s.error, /status 404/);
  assert.equal(toMain(db).length, 0);
  assert.equal(items.length, 1);
  assert.ok(!fetch.calls.some((c) => c.url.endsWith('/done')));
});

test('an item never becomes two memos when the delete on the page fails', async () => {
  const items = [{ id: 'once', at: NOW.toISOString(), text: 'Only one memo' }];
  const failing = fakePage(items, { failDone: true });
  const { sync, db, store, images } = setup(failing);
  assert.equal((await sync.runOnce()).ok, false);
  assert.equal(toMain(db).length, 1);
  // The page still has the item. The next run only sends the delete again.
  const fetch = fakePage(items);
  const again = createCaptureSync({ db, store, images, owner: 'cam', url: URL, token: PULL, fetch, now: () => NOW, log: () => {} });
  assert.equal((await again.runOnce()).count, 0);
  assert.equal(toMain(db).length, 1);
  assert.equal(items.length, 0);
});

test('an error message never contains the pull token, and an item with a bad id is ignored', async () => {
  const fetch = async () => { throw new Error(`no route to ${PULL}`); };
  const { sync } = setup(fetch);
  const s = await sync.runOnce();
  assert.equal(s.ok, false);
  assert.ok(!s.error.includes(PULL));
  const { sync: other, db } = setup(fakePage([{ id: '../x', at: NOW.toISOString(), text: 'bad id' }]));
  assert.equal((await other.runOnce()).count, 0);
  assert.equal(toMain(db).length, 0);
});
