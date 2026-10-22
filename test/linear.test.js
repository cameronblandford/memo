// The Linear sync. Each test gives a fake fetch: no test sends a request to Linear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createTickets } from '../src/tickets.js';
import { linearQuery, fetchIssues, createLinearSync, ISSUES_QUERY, LINEAR_URL, RECENT_DAYS } from '../src/linear.js';
import { ROOT } from './helpers.js';

const KEY = 'lin-test-key';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const node = (identifier, more = {}) => ({
  identifier, title: `Title of ${identifier}`, url: `https://linear.app/example/issue/${identifier.toLowerCase()}`, priority: 2,
  updatedAt: '2026-10-21T09:00:00.000Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: identifier.split('-')[0] }, ...more,
});
// A fake fetch that answers with the pages in order, and records each request.
function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const page = pages[Math.min(calls.length - 1, pages.length - 1)];
    if (page instanceof Error) throw page;
    return { ok: page.status ? page.status < 400 : true, status: page.status || 200, json: async () => page.body };
  };
  fn.calls = calls;
  return fn;
}
const page = (nodes, next = null) => ({ body: { data: { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } } } } });

test('the client refuses a mutation and a subscription, before any request', async () => {
  const fetch = fakeFetch([page([])]);
  for (const doc of [
    'mutation { issueUpdate(id: "1", input: { title: "x" }) { success } }',
    'MUTATION { x }',
    'query { viewer { id } } mutation M { issueCreate(input: {}) { success } }',
    '  mutation\n{ x }',
    'query Q { viewer { id } } # a mutation in a comment is refused too',
    'subscription { issueUpdated { id } }',
  ]) {
    await assert.rejects(linearQuery({ apiKey: KEY, fetch }, doc), /only reads from Linear/, doc);
  }
  await assert.rejects(linearQuery({ apiKey: KEY, fetch }, ''), /empty/);
  await assert.rejects(linearQuery({ apiKey: KEY, fetch }, 'fragment F on Issue { id }'), /must be a query/);
  assert.equal(fetch.calls.length, 0);
});

test('the issue query of the sync is a query, and the source has no other GraphQL document', () => {
  assert.match(ISSUES_QUERY, /^query DeskIssues/);
  assert.doesNotMatch(ISSUES_QUERY, /mutation/i);
  // The only "mutation" in the module is the refusal in linearQuery.
  const source = readFileSync(join(ROOT, 'src', 'linear.js'), 'utf8');
  for (const line of source.split('\n').filter((l) => /mutation/i.test(l))) {
    assert.ok(/^\s*\/\/|refused|mutation\|subscription/.test(line), `src/linear.js: ${line.trim()}`);
  }
});

test('a query goes to Linear with the key in the Authorization header', async () => {
  const fetch = fakeFetch([{ body: { data: { viewer: { id: 'u1' } } } }]);
  assert.deepEqual(await linearQuery({ apiKey: KEY, fetch }, 'query { viewer { id } }', { a: 1 }), { viewer: { id: 'u1' } });
  const [call] = fetch.calls;
  assert.equal(call.url, LINEAR_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, KEY);
  assert.deepEqual(call.body, { query: 'query { viewer { id } }', variables: { a: 1 } });
});

test('a Linear error gives a short message with no key', async () => {
  const fetch = fakeFetch([{ status: 400, body: { errors: [{ message: 'Authentication required' }] } }]);
  await assert.rejects(linearQuery({ apiKey: KEY, fetch }, 'query { viewer { id } }'), (e) => /Authentication required/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(linearQuery({ apiKey: KEY, fetch: fakeFetch([new TypeError('fetch failed')]) }, 'query { viewer { id } }'), /did not answer/);
  await assert.rejects(linearQuery({ apiKey: '', fetch }, 'query { viewer { id } }'), /LINEAR_API_KEY/);
});

test('fetchIssues reads the open issues and the issues of the last 7 days, page by page', async () => {
  const fetch = fakeFetch([page([node('TFP-901')], 'c1'), page([node('TFP-902', { state: { name: 'Done', type: 'completed' } })])]);
  const issues = await fetchIssues({ apiKey: KEY, fetch, now: () => NOW });
  assert.deepEqual(issues.map((i) => i.key), ['TFP-901', 'TFP-902']);
  assert.equal(issues[1].linear_type, 'completed');
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.variables.since, new Date(NOW.getTime() - RECENT_DAYS * 86400000).toISOString());
  assert.equal(fetch.calls[0].body.variables.after, null);
  assert.equal(fetch.calls[1].body.variables.after, 'c1');
  assert.match(fetch.calls[0].body.query, /state: \{ type: \{ nin: \["completed", "canceled"\] \} \}/);
});

test('the sync puts the issues into the tickets and keeps the Memo part', async () => {
  const db = openDb();
  const tickets = createTickets(db, { owner: 'cam', agents: ['main', 'mac'], now: () => NOW });
  tickets.set('TFP-902', { agent: 'mac', state: 'in_review', pr: 'https://github.com/acme/web/pull/5' });
  const fetch = fakeFetch([page([node('TFP-901', { priority: 1 }), node('TFP-902', { title: 'Renamed' }), node('not a key')])]);
  const sync = createLinearSync({ tickets, apiKey: KEY, fetch, now: () => NOW, log: () => {} });
  const status = await sync.runOnce();
  assert.equal(status.ok, true);
  assert.equal(status.count, 2);
  assert.equal(status.last, NOW.toISOString());
  const t = tickets.get('TFP-902');
  assert.equal(t.title, 'Renamed');
  assert.equal(t.desk_state, 'in_review');
  assert.equal(t.pr_number, 5);
  assert.equal(t.synced_at, NOW.toISOString());
  assert.deepEqual(tickets.board().backlog.map((x) => x.key), ['TFP-901']);
});

test('a failed sync keeps the tickets and records the error with no key', async () => {
  const db = openDb();
  const tickets = createTickets(db, { owner: 'cam', agents: ['main'], now: () => NOW });
  const logged = [];
  const fetch = fakeFetch([{ status: 401, body: { errors: [{ message: `Bad key ${KEY}` }] } }]);
  const sync = createLinearSync({ tickets, apiKey: KEY, fetch, now: () => NOW, log: (m) => logged.push(m) });
  const status = await sync.runOnce();
  assert.equal(status.ok, false);
  assert.ok(!status.error.includes(KEY));
  assert.ok(!logged.join('\n').includes(KEY));
  assert.ok(!JSON.stringify(sync.status()).includes(KEY));
});

test('without a key the sync does nothing', async () => {
  const fetch = fakeFetch([page([node('TFP-1')])]);
  const sync = createLinearSync({ tickets: null, apiKey: '', fetch });
  sync.start();
  assert.equal((await sync.runOnce()).on, false);
  assert.equal(fetch.calls.length, 0);
});
