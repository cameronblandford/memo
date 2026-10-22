// The Desk through HTTP, through the command memo, and the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { makeApp, call, TOKEN, LIAISON_TOKEN, OWNER_TOKEN, ROOT } from './helpers.js';

const CONFIG = [
  { name: 'main', kind: 'long', dir: '~/p', model: 'm' },
  { name: 'mac', kind: 'remote' },
  { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
];
const issue = (key, more = {}) => ({ key, title: `Title of ${key}`, url: `https://linear.app/example/issue/${key.toLowerCase()}`, linear_state: 'Todo', linear_type: 'unstarted', priority: 2, ...more });

test('the liaison token gets 403 on each ticket route and cannot link a memo to a ticket', async () => {
  const { app, tickets } = makeApp({ config: CONFIG });
  tickets.upsertLinear(issue('TFP-901'));
  assert.equal((await call(app, '/api/tickets', undefined, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/ticket', { key: 'TFP-901', state: 'working' }, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/ticket/start', { key: 'TFP-901', agent: 'main' }, LIAISON_TOKEN)).status, 403);
  assert.equal((await call(app, '/api/ticket/sync', {}, LIAISON_TOKEN)).status, 403);
  const send = await call(app, '/api/send', { from: 'liaison', to: 'cam', text: 'x', impact: 1, effort: 'micro', ticket: 'TFP-901' }, LIAISON_TOKEN);
  assert.equal(send.status, 403);
  assert.equal(tickets.get('TFP-901').desk_state, null);
  // With no token: 401.
  assert.equal((await call(app, '/api/tickets', undefined, null)).status, 401);
});

test('the full token sets a ticket and links a memo; the board shows it', async () => {
  const { app } = makeApp({ config: CONFIG });
  const set = await call(app, '/api/ticket', { key: 'tfp-902', agent: 'mac', state: 'working', summary: 'Writes the test.', title: 'Fix the redirect', as: 'mac' });
  assert.equal(set.status, 200);
  assert.equal(set.data.key, 'TFP-902');
  const sent = await call(app, '/api/send', { from: 'mac', to: 'cam', text: 'Keep the old route?', impact: 3, effort: 'micro', ticket: 'TFP-902' });
  assert.equal(sent.data.memo.ticket, 'TFP-902');
  const board = (await call(app, '/api/tickets')).data;
  assert.deepEqual(board.agents, ['main', 'mac']);
  assert.deepEqual(board.sync, { on: false });
  const needs = board.groups.find((g) => g.state === 'needs_you').tickets;
  assert.equal(needs[0].key, 'TFP-902');
  assert.equal(needs[0].question.id, sent.data.memo.id);
  assert.equal(needs[0].question.title, 'Keep the old route?');
  assert.equal((await call(app, '/api/ticket', { key: 'TFP-902', state: 'paused' })).status, 400);
  // The event log has the change.
  const events = (await call(app, '/api/log')).data.events;
  assert.ok(events.some((e) => e.kind === 'ticket' && e.actor === 'mac' && e.detail.startsWith('TFP-902 · Working')));
});

test('Start sends a memo from the owner to the agent and queues the ticket', async () => {
  const { app, tickets, store } = makeApp({ config: CONFIG });
  tickets.upsertLinear(issue('TFP-903', { title: 'Add the receipt page' }));
  assert.equal((await call(app, '/api/ticket/start', { key: 'TFP-903', agent: 'liaison' }, OWNER_TOKEN)).status, 400, 'a short agent has no session');
  assert.equal((await call(app, '/api/ticket/start', { key: 'TFP-999', agent: 'mac' }, OWNER_TOKEN)).status, 404);
  const r = await call(app, '/api/ticket/start', { key: 'TFP-903', agent: 'mac' }, OWNER_TOKEN);
  assert.equal(r.status, 200);
  const memo = store.get(r.data.memo.id);
  assert.equal(memo.sender, 'cam');
  assert.equal(memo.recipient, 'mac');
  assert.equal(memo.ticket, 'TFP-903');
  assert.equal(memo.text, 'Work on TFP-903: Add the receipt page https://linear.app/example/issue/tfp-903');
  assert.equal(r.data.ticket.desk_state, 'queued');
  assert.equal(r.data.ticket.agent, 'mac');
  const board = (await call(app, '/api/tickets', undefined, TOKEN)).data;
  assert.deepEqual(board.backlog, []);
  assert.deepEqual(board.groups.find((g) => g.state === 'queued').tickets.map((t) => t.key), ['TFP-903']);
});

test('Sync now runs the sync, and is refused when the sync is off', async () => {
  assert.equal((await call(makeApp().app, '/api/ticket/sync', {})).status, 400);
  let runs = 0;
  const linear = { status: () => ({ on: true, ok: true, count: runs }), runOnce: async () => { runs++; return { on: true, ok: true, count: runs }; } };
  const { app } = makeApp({ linear });
  assert.deepEqual((await call(app, '/api/ticket/sync', {})).data, { on: true, ok: true, count: 1 });
  assert.equal((await call(app, '/api/tickets')).data.sync.on, true);
});

const run = promisify(execFile);
async function withServer(fn) {
  const made = makeApp({ config: CONFIG });
  const server = await new Promise((done) => { const s = serve({ fetch: made.app.fetch, hostname: '127.0.0.1', port: 0 }, () => done(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const memo = async (args, env = {}) => {
    try {
      const { stdout, stderr } = await run('node', [join(ROOT, 'scripts', 'memo.mjs'), ...args], { env: { ...process.env, MEMO_URL: url, MEMO_TOKEN: TOKEN, ...env } });
      return { code: 0, stdout, stderr };
    } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  };
  try { await fn({ ...made, memo }); } finally { server.close(); }
}

test('memo ticket set, memo ticket list, and memo send --ticket', () => withServer(async ({ memo, store, tickets }) => {
  const set = await memo(['ticket', 'set', 'TFP-904', '--agent', 'main', '--state', 'in_review', '--pr', 'https://github.com/acme/web/pull/77', '--summary', 'The PR waits for CI.', '--title', 'Fix the footer', '--as', 'main']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Ticket TFP-904: in_review, agent main, PR https:\/\/github.com\/acme\/web\/pull\/77\./);
  const sent = await memo(['send', '--from', 'main', '--to', 'cam', '--impact', '3', '--effort', 'micro', '--ticket', 'tfp-904', 'Merge it?']);
  assert.match(sent.stdout, /Memo 1 is sent to cam\. Ticket: TFP-904\./);
  assert.equal(store.get(1).ticket, 'TFP-904');
  tickets.upsertLinear(issue('TFP-905'));
  const list = await memo(['ticket', 'list']);
  assert.match(list.stdout, /Needs you \(1\):\n {2}TFP-904 Fix the footer · main · PR #77\n {4}The PR waits for CI\.\n {4}Open memo #1 from main: Merge it\?/);
  assert.match(list.stdout, /Backlog, no agent \(1\):\n {2}TFP-905 Title of TFP-905 \[Linear: Todo\]/);
  assert.match((await memo(['list', '--to', 'cam'])).stdout, /, ticket TFP-904/);
  assert.match((await memo(['ticket', 'set', 'TFP-904'])).stderr, /one field or more/);
  assert.match((await memo(['ticket', 'set'])).stderr, /Give the ticket key/);
  assert.match((await memo(['ticket', 'set', 'TFP-904', '--state', 'nope'])).stderr, /state must be one of/);
  assert.match((await memo(['ticket', 'explode'])).stderr, /Usage/);
  // The liaison token cannot.
  const refused = await memo(['ticket', 'list'], { MEMO_TOKEN: LIAISON_TOKEN });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot do that/);
}));

test('the Desk page is served, and each page links to it', async () => {
  const { app } = makeApp();
  const r = await app.request('/desk');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /<title>Memo Desk<\/title>/);
  assert.ok((r.headers.get('content-security-policy') || '').includes("connect-src 'self'"));
  for (const page of ['/inbox', '/agents', '/log', '/chat']) {
    assert.match(await (await app.request(page)).text(), /<a href="\/desk">Desk<\/a>/, page);
  }
  // The page renders Markdown only with the shared renderer, and makes a link only from an https address.
  const source = readFileSync(join(ROOT, 'ui', 'desk.html'), 'utf8');
  assert.match(source, /import \{ render as markdown \} from '\/ui\/markdown\.js'/);
  assert.match(source, /x\.protocol === 'https:'/);
  for (const label of ['Needs you', 'Working', 'In review', 'Landing', 'Queued', 'Done']) assert.ok(source.includes(`'${label}'`) || source.includes(label), label);
});
