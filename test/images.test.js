import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { makeApp, TOKEN, LIAISON_TOKEN, ROOT } from './helpers.js';

const run = promisify(execFile);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
const GIF = Buffer.from('GIF89a fake gif body');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 fake')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const post = (app, body, token = TOKEN) => app.request('/api/image', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
const get = (app, name, token = TOKEN) => app.request(`/api/image/${name}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('an image goes in and comes back with its type', async () => {
  const { app } = makeApp();
  for (const [bytes, ext, type] of [[PNG, 'png', 'image/png'], [JPEG, 'jpg', 'image/jpeg'], [GIF, 'gif', 'image/gif'], [WEBP, 'webp', 'image/webp']]) {
    const r = await post(app, bytes);
    assert.equal(r.status, 200);
    const { name } = await r.json();
    assert.match(name, new RegExp(`^[0-9a-f]{16}\\.${ext}$`));
    const back = await get(app, name);
    assert.equal(back.status, 200);
    assert.equal(back.headers.get('content-type'), type);
    assert.equal(back.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), bytes);
  }
});

test('the same image two times gives the same name', async () => {
  const { app } = makeApp();
  assert.equal((await (await post(app, PNG)).json()).name, (await (await post(app, PNG)).json()).name);
});

test('a file that is not a PNG, JPEG, GIF, or WebP image is refused', async () => {
  const { app } = makeApp();
  for (const bytes of [SVG, Buffer.from('plain text'), Buffer.alloc(0), Buffer.from('RIFF1234WAVEfmt ')]) {
    const r = await post(app, bytes);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /PNG, JPEG, GIF, or WebP/);
  }
});

test('an image of more than 5 MB is refused', async () => {
  const { app } = makeApp();
  const r = await post(app, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /5 MB/);
});

test('an image needs the full token', async () => {
  const { app } = makeApp();
  const { name } = await (await post(app, PNG)).json();
  assert.equal((await get(app, name, null)).status, 401);
  assert.equal((await get(app, name, LIAISON_TOKEN)).status, 403);
  assert.equal((await post(app, PNG, LIAISON_TOKEN)).status, 403);
});

test('only a stored name gives a file', async () => {
  const { app } = makeApp();
  for (const name of ['0123456789abcdef.png', '..%2F..%2F.env', '%2e%2e%2f.env', 'x.png', '0123456789abcdef.svg']) {
    assert.equal((await get(app, name)).status, 404, name);
  }
});

test('memo image stores a file and prints the Markdown for it', async () => {
  const made = makeApp();
  const server = await new Promise((done) => { const s = serve({ fetch: made.app.fetch, hostname: '127.0.0.1', port: 0 }, () => done(s)); });
  const env = { ...process.env, MEMO_URL: `http://127.0.0.1:${server.address().port}`, MEMO_TOKEN: TOKEN };
  const dir = mkdtempSync(join(tmpdir(), 'memo-cli-image-'));
  writeFileSync(join(dir, 'shot.png'), PNG);
  writeFileSync(join(dir, 'notes.txt'), 'plain text');
  const memo = (args) => run('node', [join(ROOT, 'scripts', 'memo.mjs'), ...args], { env }).catch((e) => e);
  try {
    const ok = await memo(['image', join(dir, 'shot.png'), 'The', 'new', 'page']);
    assert.match(ok.stdout, /^!\[The new page\]\(image:[0-9a-f]{16}\.png\)\n$/);
    assert.match((await memo(['image', join(dir, 'shot.png')])).stdout, /^!\[image\]\(image:/);
    const bad = await memo(['image', join(dir, 'notes.txt')]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /PNG, JPEG, GIF, or WebP/);
    const missing = await memo(['image', join(dir, 'none.png')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /cannot read/);
    assert.match((await memo(['image'])).stderr, /path/);
  } finally { server.close(); }
});

// The client gets the images of a memo and prints a local path, because an agent cannot see an image in the text.
test('memo list and memo wait give the reader a local file for each image', async () => {
  const { app, store } = makeApp();
  const server = await new Promise((done) => { const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => done(s)); });
  const dir = mkdtempSync(join(tmpdir(), 'memo-got-'));
  const env = { ...process.env, MEMO_URL: `http://127.0.0.1:${server.address().port}`, MEMO_TOKEN: TOKEN, MEMO_IMAGE_DIR: dir, MEMO_WAIT_INTERVAL_MS: '50' };
  const memo = async (...args) => (await run('node', [join(ROOT, 'scripts', 'memo.mjs'), ...args], { env })).stdout;
  try {
    const png = (await (await post(app, PNG)).json()).name;
    const jpeg = (await (await post(app, JPEG)).json()).name;
    store.send({ from: 'cam', to: 'main', text: `The page shows this:\n\n![image](image:${png})\n` });
    const list = await memo('list', '--to', 'main');
    assert.match(list, new RegExp(`Image ${png.replace('.', '\\.')} is the file ${join(dir, png).replace(/[.\\/]/g, '\\$&')}\\.`));
    assert.deepEqual(readFileSync(join(dir, png)), PNG);
    assert.equal(statSync(join(dir, png)).mode & 0o777, 0o600);
    // The agent showed an image to the owner; the owner answers with a different image.
    const asked = store.send({ from: 'main', to: 'cam', impact: 2, effort: 'micro', text: `Is this the correct page?\n\n![shot](image:${png})` });
    store.reply(asked.memo.id, `No, this one: ![image](image:${jpeg})`);
    const wait = await memo('wait', '--as', 'main', '--hold', '1', '1');
    assert.match(wait, new RegExp(`Image ${jpeg.replace('.', '\\.')} is the file`));
    assert.doesNotMatch(wait, new RegExp(`Image ${png.replace('.', '\\.')} is the file`), 'not the image that the agent sent');
    assert.deepEqual(readFileSync(join(dir, jpeg)), JPEG);
    // An image that the server does not have gives a clear line and no failure.
    store.send({ from: 'cam', to: 'main', text: 'Gone: ![image](image:0000000000000000.png)' });
    assert.match(await memo('list', '--to', 'main'), /Image 0000000000000000\.png: memo could not get the file\./);
  } finally { server.close(); }
});
