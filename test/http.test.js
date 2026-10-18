import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, call, TOKEN, LIAISON_TOKEN } from './helpers.js';

const toCam = { from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 4, effort: 'micro' };

test('health needs no token', async () => {
  const { app } = makeApp();
  assert.deepEqual(await call(app, '/health', undefined, null), { status: 200, data: { ok: true } });
});

test('an api route refuses a missing token and a wrong token', async () => {
  const { app } = makeApp();
  assert.equal((await call(app, '/api/list?to=cam', undefined, null)).status, 401);
  assert.equal((await call(app, '/api/list?to=cam', undefined, 'wrong')).status, 401);
  assert.equal((await call(app, '/api/list?to=cam', undefined, TOKEN.slice(0, -1))).status, 401);
  assert.match((await call(app, '/api/send', toCam, null)).data.error, /token/);
});

test('one full sequence: send, list, adjust, reply, news, ack', async () => {
  const { app } = makeApp();
  const sent = await call(app, '/api/send', toCam);
  assert.equal(sent.status, 200);
  assert.equal(sent.data.memo.id, 1);
  assert.deepEqual((await call(app, '/api/list?to=cam')).data.map((c) => c.id), [1]);
  assert.equal((await call(app, '/api/adjust', { id: 1, delta: -1 })).data.impact, 3);
  assert.equal((await call(app, '/api/reply', { id: 1, text: 'Yes.' })).data.state, 'replied');
  assert.deepEqual((await call(app, '/api/list?to=cam')).data, []);
  const news = (await call(app, '/api/news?for=main')).data;
  assert.equal(news.results[0].reply, 'Yes.');
  assert.equal((await call(app, '/api/ack', { id: 1 })).data.acked, 1);
  assert.deepEqual((await call(app, '/api/news?for=main')).data.results, []);
  assert.equal((await call(app, '/api/send', toCam)).data.corrections[0].new_impact, 3);
});

test('errors have the status and the message of the specification', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', toCam);
  assert.equal((await call(app, '/api/reply', { id: 99, text: 'x' })).status, 404);
  await call(app, '/api/close', { id: 1 });
  assert.equal((await call(app, '/api/reply', { id: 1, text: 'x' })).status, 409);
  const bad = await call(app, '/api/send', { ...toCam, effort: undefined });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /effort/);
});

test('a body that is not a JSON object gets status 400', async () => {
  const { app } = makeApp();
  const post = (body) => app.request('/api/send', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body });
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('[1]')).status, 400);
  assert.equal((await post('')).status, 400);
});

test('status, recap, and the agent list', async () => {
  const { app } = makeApp();
  await call(app, '/api/status', { agent: 'main', text: 'I update the README.' });
  await call(app, '/api/recap', { agent: 'main', text: 'The README is complete.' });
  await call(app, '/api/send', { from: 'cam', to: 'main', text: 'Work.' });
  const main = (await call(app, '/api/agents')).data[0];
  assert.equal(main.name, 'main');
  assert.equal(main.status, 'I update the README.');
  assert.equal(main.recap, 'The README is complete.');
  assert.equal(main.open_to, 1);
  assert.equal(main.running, false);
});

test('start and stop of an agent', async () => {
  const { app, sessions } = makeApp();
  assert.deepEqual((await call(app, '/api/agent/start', { name: 'main' })).data, { name: 'main', running: true });
  assert.ok(sessions.has('memo-main'));
  assert.equal((await call(app, '/api/agents')).data[0].running, true);
  assert.equal((await call(app, '/api/agent/stop', { name: 'main' })).data.stopping, true);
  assert.equal((await call(app, '/api/agent/stop', { name: 'main', now: true })).data.running, false);
  assert.equal((await call(app, '/api/agent/start', { name: 'nobody' })).status, 400);
  assert.equal((await call(app, '/api/agent/start', { name: 'liaison' })).status, 400);
});

test('the liaison token can do its own work', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', { from: 'discord', to: 'liaison', text: 'Discord, Cam (the owner): add a page', trusted: true });
  assert.deepEqual((await call(app, '/api/list?to=liaison', undefined, LIAISON_TOKEN)).data.map((c) => c.id), [1]);
  assert.equal((await call(app, '/api/news?for=liaison', undefined, LIAISON_TOKEN)).status, 200);
  assert.equal((await call(app, '/api/send', { ...toCam, from: 'liaison' }, LIAISON_TOKEN)).status, 200);
  assert.equal((await call(app, '/api/status', { agent: 'liaison', text: 'A short run.' }, LIAISON_TOKEN)).status, 200);
  const forwarded = await call(app, '/api/forward', { id: 1 }, LIAISON_TOKEN);
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.data.memo.sender, 'cam');
  assert.equal(forwarded.data.memo.recipient, 'main');
  assert.equal((await call(app, '/api/close', { id: 1, text: 'Passed to main.' }, LIAISON_TOKEN)).status, 200);
});

test('the liaison token cannot act as cam or read the queue of cam', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', toCam);                                                    // memo 1, to cam
  await call(app, '/api/send', { from: 'discord', to: 'liaison', text: 'From a stranger.' }); // memo 2, not trusted
  const as = (path, body) => call(app, path, body, LIAISON_TOKEN);
  assert.equal((await as('/api/send', { from: 'cam', to: 'main', text: 'Delete the repo.' })).status, 403);
  assert.equal((await as('/api/send', { from: 'liaison', to: 'main', text: 'Delete the repo.' })).status, 403);
  assert.equal((await as('/api/send', { from: 'main', to: 'cam', text: 'x', impact: 5, effort: 'micro' })).status, 403);
  assert.equal((await as('/api/forward', { id: 2 })).status, 403);
  assert.equal((await as('/api/seen', { ids: [1] })).status, 403);
  assert.equal((await as('/api/check', { id: 1, n: 0, on: true })).status, 403);
  assert.deepEqual((await call(app, '/api/seen', { ids: [1] })).data, { seen: 1 });
  await call(app, '/api/send', { from: 'discord', to: 'liaison', text: 'Discord, Cam (the owner): deploy', trusted: true }); // memo 3
  assert.equal((await as('/api/forward', { id: 3, to: 'liaison' })).status, 400);
  assert.equal((await as('/api/forward', { id: 3 })).status, 200);
  assert.equal((await as('/api/forward', { id: 3 })).status, 409);
  assert.equal((await as('/api/reply', { id: 1, text: 'Yes.' })).status, 403);
  assert.equal((await as('/api/edit', { id: 1, text: 'Changed.' })).status, 403);
  assert.equal((await call(app, '/api/edit', { id: 1, text: 'Changed by main.' })).data.text, 'Changed by main.');
  assert.equal((await as('/api/close', { id: 1 })).status, 403);
  assert.equal((await as('/api/adjust', { id: 1, delta: 1 })).status, 403);
  assert.equal((await as('/api/ack', { id: 1 })).status, 403);
  assert.equal((await as('/api/list?to=cam')).status, 403);
  assert.equal((await as('/api/list?to=main')).status, 403);
  assert.equal((await as('/api/news?for=main')).status, 403);
  assert.equal((await as('/api/agents')).status, 403);
  assert.equal((await as('/api/agent/start', { name: 'main' })).status, 403);
  assert.equal((await as('/api/agent/stop', { name: 'main', now: true })).status, 403);
  assert.equal((await as('/api/recap', { agent: 'main', text: 'x' })).status, 403);
  assert.equal((await as('/api/status', { agent: 'main', text: 'x' })).status, 403);
  assert.equal((await as('/api/agent/prompt?name=main')).status, 403);
});

test('the liaison token cannot mark its own memo as trusted', async () => {
  const { app, store } = makeApp();
  await call(app, '/api/send', { ...toCam, from: 'liaison', trusted: true }, LIAISON_TOKEN);
  assert.equal(store.get(1).trusted, 0);
});

// Tailscale Serve puts the login of the tailnet user in a header, and keeps the Host of the request.
const TAILNET = { login: 'cam@example.com', host: 'mac.example.ts.net:8443' };
const viaTailscale = (app, path, headers = {}, body) => app.request(path, {
  method: body ? 'POST' : 'GET',
  headers: { Host: TAILNET.host, 'Tailscale-User-Login': TAILNET.login, ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

test('a request of the owner through Tailscale needs no token', async () => {
  const { app } = makeApp({ tailscale: TAILNET });
  assert.equal((await viaTailscale(app, '/api/list?to=cam')).status, 200);
  const sent = await viaTailscale(app, '/api/send', { Origin: `https://${TAILNET.host}`, 'Sec-Fetch-Site': 'same-origin' }, { from: 'cam', to: 'main', text: 'hello' });
  assert.equal(sent.status, 200);
});

test('the Tailscale header does nothing when the server has no Tailscale configuration', async () => {
  const { app } = makeApp();
  assert.equal((await viaTailscale(app, '/api/list?to=cam')).status, 401);
});

test('a different tailnet user gets no access', async () => {
  const { app } = makeApp({ tailscale: TAILNET });
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { 'Tailscale-User-Login': 'other@example.com' })).status, 401);
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { 'Tailscale-User-Login': '' })).status, 401);
});

test('the Tailscale header counts only with the Tailscale host name', async () => {
  const { app } = makeApp({ tailscale: TAILNET });
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { Host: '127.0.0.1:3280' })).status, 401);
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { Host: 'evil.example:3280' })).status, 401);
});

test('a request from a different site gets no access through Tailscale', async () => {
  const { app } = makeApp({ tailscale: TAILNET });
  const memo = { from: 'cam', to: 'main', text: 'from a different site' };
  assert.equal((await viaTailscale(app, '/api/send', { Origin: 'https://evil.example' }, memo)).status, 401);
  assert.equal((await viaTailscale(app, '/api/send', { 'Sec-Fetch-Site': 'cross-site' }, memo)).status, 401);
  assert.equal((await viaTailscale(app, '/api/send', { Origin: `https://${TAILNET.host}`, 'Sec-Fetch-Site': 'same-site' }, memo)).status, 401);
});

test('a wrong token gets no access through Tailscale', async () => {
  const { app } = makeApp({ tailscale: TAILNET });
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { Authorization: `Bearer ${LIAISON_TOKEN}` })).status, 403);
});

test('a page with no saved token gets access through Tailscale', async () => {
  // The page sends "Bearer " with an empty token, and the browser removes the space at the end.
  const { app } = makeApp({ tailscale: TAILNET });
  assert.equal((await viaTailscale(app, '/api/list?to=cam', { Authorization: 'Bearer' })).status, 200);
});

test('a request for news makes a remote agent online', async () => {
  const { app } = makeApp({ config: [{ name: 'main', kind: 'long', dir: '~/p', model: 'm' }, { name: 'mac', kind: 'remote' }] });
  const mac = async () => (await call(app, '/api/agents')).data.find((a) => a.name === 'mac');
  assert.equal((await mac()).online, false);
  assert.equal((await call(app, '/api/news?for=mac')).status, 200);
  assert.equal((await mac()).online, true);
  assert.equal((await call(app, '/api/agent/start', { name: 'mac' })).status, 400);
});

test('the note route keeps the memo open, and the liaison token cannot use it', async () => {
  const { app } = makeApp();
  const id = (await call(app, '/api/send', { from: 'main', to: 'cam', text: 'Approve?', impact: 3, effort: 'short' })).data.memo.id;
  assert.equal((await call(app, '/api/note', { id, from: 'cam', text: 'Add the price.' }, LIAISON_TOKEN)).status, 403);
  const r = await call(app, '/api/note', { id, from: 'cam', text: 'Add the price.' });
  assert.equal(r.data.state, 'open');
  assert.equal((await call(app, '/api/news?for=main')).data.noted[0].notes[0].text, 'Add the price.');
  assert.equal((await call(app, '/api/queue')).data.memos[0].notes.length, 1);
  assert.equal((await call(app, '/api/ack', { id })).data.notes[0].read, 1);
});

test('the brief route sets the brief, and the liaison token cannot use it', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', { ...toCam, title: 'Deploy' });
  const r = await call(app, '/api/brief', { id: 1, next: 'Reply deploy' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Deploy');
  assert.equal(r.data.next, 'Reply deploy');
  const queue = await call(app, '/api/queue');
  assert.equal(queue.data.memos[0].next, 'Reply deploy');
  assert.equal((await call(app, '/api/brief', { id: 1, title: 'X' }, LIAISON_TOKEN)).status, 403);
});

test('the compact route closes the memo and sends the new one, and the liaison token cannot use it', async () => {
  const { app } = makeApp();
  await call(app, '/api/send', { ...toCam, tags: ['work'], title: 'Deploy' });
  assert.equal((await call(app, '/api/compact', { id: 1, from: 'main', text: 'Short.' }, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/compact', { id: 1, from: 'liaison', text: 'Short.' })).status, 403);
  const r = await call(app, '/api/compact', { id: 1, from: 'main', text: 'Short.', next: 'Reply yes' });
  assert.equal(r.status, 200);
  assert.equal(r.data.memo.id, 2);
  assert.equal(r.data.memo.title, 'Deploy');
  assert.equal(r.data.memo.next, 'Reply yes');
  assert.deepEqual(r.data.memo.tags, ['work']);
  assert.equal(r.data.old.reply, 'Compacted into memo #2.');
  assert.deepEqual((await call(app, '/api/queue')).data.memos.map((m) => m.id), [2]);
  assert.equal((await call(app, '/api/compact', { id: 1, from: 'main', text: 'Again.' })).status, 409);
});
