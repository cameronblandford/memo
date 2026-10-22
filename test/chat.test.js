import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, call, LIAISON_TOKEN, OWNER_TOKEN } from './helpers.js';
import { createLoads } from '../ui/chat.js';

const CONFIG = [
  { name: 'main', kind: 'long', dir: '~/p', model: 'm' },
  { name: 'mac', kind: 'remote' },
  { name: 'helper', kind: 'long', dir: '~/p', model: 'm' },
  { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
];
const toCam = (text) => ({ from: 'main', to: 'cam', text, impact: 3, effort: 'micro' });

function setup() {
  const made = makeApp({ config: CONFIG });
  const { store } = made;
  store.send({ from: 'cam', to: 'main', text: 'Update the README.' }); // 1
  store.send({ from: 'cam', to: 'helper', text: 'Not for main.' }); // 2
  store.send(toCam('Which branch?')); // 3
  store.note(3, 'cam', 'The branch main.');
  store.send({ from: 'helper', to: 'cam', text: 'From helper.', impact: 1, effort: 'micro' }); // 4
  store.close(1, 'Done: the README has the new page.');
  store.send({ from: 'discord', to: 'liaison', text: 'Hello' }); // 5
  return made;
}

test('the thread has the memos between the owner and one agent, in the two directions, oldest first', async () => {
  const { app } = setup();
  const r = await call(app, '/api/thread?agent=main');
  assert.equal(r.status, 200);
  assert.equal(r.data.agent, 'main');
  assert.deepEqual(r.data.memos.map((m) => m.id), [1, 3]);
  assert.equal(r.data.memos[0].reply, 'Done: the README has the new page.');
  assert.equal(r.data.memos[0].state, 'closed');
  assert.deepEqual(r.data.memos[1].notes.map((n) => n.text), ['The branch main.']);
  assert.equal(r.data.memos[1].state, 'waiting', 'the note of the owner sent the memo back to main');
  assert.equal(r.data.more, false);
  // The agents of the picker: the agents with a session, with their status lines. No short agent.
  assert.deepEqual(r.data.agents.map((a) => a.name), ['main', 'mac', 'helper']);
  assert.deepEqual((await call(app, '/api/thread?agent=helper')).data.memos.map((m) => m.id), [2, 4]);
});

test('the thread with no agent is the thread of the default agent', async () => {
  const { app } = setup();
  const r = await call(app, '/api/thread');
  assert.equal(r.data.agent, 'main');
  assert.deepEqual(r.data.memos.map((m) => m.id), [1, 3]);
});

test('the thread gives the newest memos up to the limit, and tells if older memos exist', async () => {
  const { app, store } = setup();
  for (let i = 0; i < 4; i += 1) store.send({ from: 'cam', to: 'main', text: `Task ${i}` }); // 6 to 9
  const r = await call(app, '/api/thread?agent=main&limit=3');
  assert.deepEqual(r.data.memos.map((m) => m.id), [7, 8, 9]);
  assert.equal(r.data.more, true);
  assert.equal((await call(app, '/api/thread?agent=main&limit=6')).data.more, false);
  for (const bad of ['0', '501', '2.5', 'x', '']) assert.equal((await call(app, `/api/thread?agent=main&limit=${bad}`)).status, 400, bad);
});

test('the thread refuses an agent with no session, the owner, discord, and an unknown name', async () => {
  const { app } = setup();
  for (const name of ['liaison', 'cam', 'discord', 'nobody']) {
    const r = await call(app, `/api/thread?agent=${name}`);
    assert.equal(r.status, 400, name);
    assert.match(r.data.error, /^agent must be one of: main, mac, helper\.$/);
  }
});

test('a read of the thread records no delivery and no seen', async () => {
  const { app, store } = setup();
  const before = store.events.list().length;
  await call(app, '/api/thread?agent=main');
  assert.equal(store.events.list().length, before);
  assert.equal(store.get(4).seen, 0);
});

test('only the full token and the owner can read the thread', async () => {
  const { app } = setup();
  assert.equal((await call(app, '/api/thread?agent=main', undefined, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/thread?agent=main', undefined, null)).status, 401);
  assert.equal((await call(app, '/api/thread?agent=main', undefined, 'wrong-token-0123456789')).status, 401);
  assert.equal((await call(app, '/api/thread?agent=main', undefined, OWNER_TOKEN)).status, 200);
});

test('a message of the chat is a memo from the owner to the agent, with no impact or effort', async () => {
  const { app } = setup();
  const r = await call(app, '/api/send', { from: 'cam', to: 'mac', text: 'Run the tests on the work computer.' }, OWNER_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.data.memo.impact, null);
  assert.deepEqual((await call(app, '/api/thread?agent=mac')).data.memos.map((m) => m.text), ['Run the tests on the work computer.']);
});

test('the Chat page needs no token, has the content rule, and each page links to it', async () => {
  const { app } = makeApp();
  const r = await app.request('/chat');
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /<title>Memo Chat<\/title>/);
  assert.ok(!page.includes('__OWNER__'));
  assert.ok((r.headers.get('content-security-policy') || '').includes("connect-src 'self'"));
  // The page renders memo text only with the Markdown renderer of the Inbox, with no html frames.
  assert.ok(page.includes("import { render as markdown } from '/ui/markdown.js'"));
  assert.ok(!page.includes('html:'));
  for (const path of ['/inbox', '/agents', '/log']) assert.match(await (await app.request(path)).text(), /href="\/chat"/, path);
});

test('only the newest load of the Chat page shows, and only for the agent that is selected now', () => {
  const loads = createLoads();
  // The refresh for main goes out, then the owner picks mac and a new load goes out. The late answer for main is old.
  const refresh = loads.start('main');
  const picked = loads.start('mac');
  assert.equal(loads.fresh(refresh, 'mac', 'main'), false);
  assert.equal(loads.fresh(picked, 'mac', 'mac'), true);
  // The newest request, but the owner changed the agent before its answer came.
  const late = loads.start('main');
  assert.equal(loads.fresh(late, 'mac', 'main'), false);
  // With no agent selected, the answer of the server (its default agent) can show.
  const first = loads.start('');
  assert.equal(loads.fresh(first, '', 'main'), true);
  // An answer for a different agent than the one that the request asked for never shows.
  const odd = loads.start('mac');
  assert.equal(loads.fresh(odd, 'mac', 'main'), false);
});

test('the Chat page sends to the agent of the picker, and its images open in the lightbox with their memo', async () => {
  const { app } = makeApp();
  const page = await (await app.request('/chat')).text();
  assert.ok(page.includes('const to = picker.value;'));
  assert.ok(page.includes("api('/api/send', { from: OWNER, to, text: field.value })"));
  assert.ok(page.includes('if (!loads.fresh(ticket, agent, data.agent)) return;'));
  // A load that shows uses up the stick request before the check for an unchanged thread, and scrolls if it was asked.
  const body = page.slice(page.indexOf('async function load('));
  assert.ok(body.indexOf('stickWanted = false;') < body.indexOf('if (next === shown'));
  assert.ok(page.includes('if (next === shown && thread.children.length) { if (wanted) toBottom(); return; }'));
  assert.match((await app.request('/ui/chat.js')).headers.get('content-type'), /javascript/);
  assert.ok((await (await app.request('/ui/common.js')).text()).includes("img.closest('.memo, .bubble')"));
  // The field is fixed at the bottom of the window, and the body keeps room for it.
  assert.match(page, /#say \{ position: fixed;[^}]*bottom: 0;/);
  assert.ok(page.includes('document.body.style.paddingBottom'));
});
