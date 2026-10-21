import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, call, TOKEN, LIAISON_TOKEN, OWNER_TOKEN } from './helpers.js';
import { parseRule, ruleMarker, ruleProblem, ruleText, withoutMarker } from '../ui/rule.js';
import { refusal, addRule } from '../src/rules.js';
import { loadConfig } from '../src/agents.js';

// A project directory with .claude/settings.local.json in a temporary directory. Never a real settings file.
function project(content) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-rule-'));
  mkdirSync(join(dir, '.claude'));
  const file = join(dir, '.claude', 'settings.local.json');
  if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { dir, file };
}
function setup(content, { settings = true } = {}) {
  const p = project(content);
  const config = [
    { name: 'main', kind: 'long', dir: '~/p', model: 'm', ...(settings ? { settings: p.file } : {}) },
    { name: 'other', kind: 'long', dir: '~/p', model: 'm' },
    { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
  ];
  return { ...makeApp({ config }), ...p };
}
const ask = (store, rule, { from = 'main', agent = from, why = 'To run the tests.' } = {}) =>
  store.send({ from, to: 'cam', text: ruleText({ agent, rule, why }), impact: 4, effort: 'micro' }).memo.id;
const approve = (app, id, rule, token = OWNER_TOKEN) => call(app, '/api/rule/approve', { id, rule }, token);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('the marker is the last line, and parse gives the agent and the rule', () => {
  const text = ruleText({ agent: 'main', rule: 'Bash(npm test:*)', why: 'To run the tests.' });
  assert.equal(text.split('\n').at(-1), '<!-- memo-rule: {"agent":"main","rule":"Bash(npm test:*)"} -->');
  assert.match(text, /```\nBash\(npm test:\*\)\n```/);
  assert.deepEqual(parseRule(text), { agent: 'main', rule: 'Bash(npm test:*)' });
  assert.ok(!withoutMarker(text).includes('memo-rule'));
  // A rule with --> cannot end the comment early.
  const odd = ruleMarker('main', 'Bash(echo -->x<y&z)');
  assert.ok(!odd.slice(0, -4).includes('-->'));
  assert.deepEqual(parseRule(`x\n${odd}`), { agent: 'main', rule: 'Bash(echo -->x<y&z)' });
});

test('parse gives null with no marker, a marker that is not last, two markers, or bad JSON', () => {
  const m = ruleMarker('main', 'WebSearch');
  assert.equal(parseRule('Just text.'), null);
  assert.equal(parseRule(`${m}\nmore text`), null);
  assert.equal(parseRule(`${m}\n${ruleMarker('main', 'Bash(rm:*)')}`), null);
  assert.equal(parseRule('<!-- memo-rule: {"agent":"main"} -->'), null);
  assert.equal(parseRule('<!-- memo-rule: {nope} -->'), null);
  assert.deepEqual(parseRule(`text\n${m}\n\n`), { agent: 'main', rule: 'WebSearch' });
});

test('the form of a rule', () => {
  for (const ok of ['WebSearch', 'Bash(npm test:*)', 'Edit(src/**)', 'mcp__github__get_issue', 'WebFetch(domain:example.com)']) assert.equal(ruleProblem(ok), '', ok);
  for (const bad of ['', 'Bash(a)\nBash(b)', ' Bash(x)', 'Bash(', 'Bash()', '(x)', 'x'.repeat(301), 'Bash(x) trailing']) assert.ok(ruleProblem(bad), JSON.stringify(bad));
});

test('the rules that would widen the limits of an agent are refused', () => {
  const settings = '/h/work/.claude/settings.local.json';
  const home = '/h';
  const refused = [
    '*', 'Bash', 'Bash(*)', 'Bash(:*)', 'Bash( * )',
    'Bash(cat ~/work/.claude/settings.local.json)', 'Bash(cp x /h/work/.claude/settings.local.json)', 'Bash(rm .claude/x)', 'Bash(vim settings.json)',
    'Bash(python3:*)', 'Bash(bash -c:*)', 'Bash(sh *)', 'Bash(node:*)', 'Bash(env:*)', 'Bash(sudo:*)', 'Bash(xargs:*)',
    'Edit', 'Write', 'Edit(*)', 'Edit(**)', 'Write(/**)', 'Edit(//**)', 'Edit(~/**)', 'Edit(~/)',
    'Edit(~/work/**)', 'Write(//h/work/**)', 'Edit(/**)', 'Edit(*.json)', 'Write(**/*.json)', 'MultiEdit(~/work/.claude/**)',
    'Edit(/.claude/settings.local.json)', 'Edit(~/work/.cl?ude/*)', 'Edit(~/work/.claud[e]/*)', 'Edit(~/x/../work/*)', 'Write(~/work/*/settings.local.json)',
  ];
  for (const rule of refused) assert.ok(refusal(rule, { settings, home }), `${rule} must be refused`);
  const permitted = ['Bash(npm test:*)', 'Bash(git status)', 'WebSearch', 'Edit(src/**)', 'Write(~/work/memo-dev/notes/**)', 'Edit(//tmp/scratch/**)', 'Read(~/**)', 'WebFetch(domain:example.com)'];
  for (const rule of permitted) assert.equal(refusal(rule, { settings, home }), '', rule);
});

test('approve writes the rule, keeps a backup, adds a note, and closes the memo for the agent', async () => {
  const before = { permissions: { allow: ['WebSearch'], deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'], defaultMode: 'acceptEdits' }, model: 'x' };
  const { app, store, file, dir } = setup(before);
  const id = ask(store, 'Bash(npm test:*)');
  const r = await approve(app, id, 'Bash(npm test:*)');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, true);
  const after = read(file);
  assert.deepEqual(after, { permissions: { ...before.permissions, allow: ['WebSearch', 'Bash(npm test:*)'] }, model: 'x' });
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(after, null, 2)}\n`);
  const backups = readdirSync(join(dir, '.claude')).filter((n) => n.startsWith('settings.local.json.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude', backups[0]), 'utf8')), before);
  assert.deepEqual(readdirSync(join(dir, '.claude')).filter((n) => n.includes('.tmp-')), []);
  const memo = store.get(id);
  assert.equal(memo.state, 'closed');
  assert.equal(memo.acked, 0);
  assert.equal(memo.notes.at(-1).author, 'cam');
  assert.equal(memo.notes.at(-1).text, `Approved: rule added to ${file}. Restart the agent for it to apply.`);
  // The agent gets the result with memo wait.
  assert.deepEqual((await call(app, '/api/news?for=main')).data.results.map((m) => m.id), [id]);
  assert.ok(store.events.list({ memo: id }).some((e) => e.kind === 'rule' && e.detail.includes('npm test')));
});

test('approve makes the settings file when it is missing, with no backup', async () => {
  const { app, store, file, dir } = setup();
  const id = ask(store, 'WebSearch');
  const r = await approve(app, id, 'WebSearch');
  assert.equal(r.status, 200);
  assert.equal(r.data.backup, null);
  assert.deepEqual(read(file), { permissions: { allow: ['WebSearch'] } });
  assert.deepEqual(readdirSync(join(dir, '.claude')), ['settings.local.json']);
});

test('a rule that is already there is not added two times', async () => {
  const { app, store, file } = setup({ permissions: { allow: ['WebSearch'] } });
  const id = ask(store, 'WebSearch');
  const r = await approve(app, id, 'WebSearch');
  assert.equal(r.status, 200);
  assert.equal(r.data.added, false);
  assert.deepEqual(read(file).permissions.allow, ['WebSearch']);
  assert.match(store.get(id).notes.at(-1).text, /already in/);
  assert.equal(store.get(id).state, 'closed');
});

test('only the owner can approve: the agent token and the liaison token get 403', async () => {
  const { app, store, file } = setup({ permissions: { allow: [] } });
  const id = ask(store, 'WebSearch');
  for (const token of [TOKEN, LIAISON_TOKEN]) {
    const r = await approve(app, id, 'WebSearch', token);
    assert.equal(r.status, 403);
  }
  assert.equal((await approve(app, id, 'WebSearch', 'wrong-token-0123456789')).status, 401);
  assert.deepEqual(read(file).permissions.allow, []);
  assert.equal(store.get(id).state, 'open');
});

test('the owner through Tailscale can approve', async () => {
  const tailnet = { login: 'cam@example.com', host: 'mac.example.ts.net:8443' };
  const p = project({});
  const { app, store } = makeApp({ tailscale: tailnet, config: [{ name: 'main', kind: 'long', dir: '~/p', model: 'm', settings: p.file }] });
  const id = ask(store, 'WebSearch');
  const r = await app.request('/api/rule/approve', {
    method: 'POST', headers: { Host: tailnet.host, 'Tailscale-User-Login': tailnet.login, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, rule: 'WebSearch' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(read(p.file).permissions.allow, ['WebSearch']);
});

test('a rule that changed after the owner looked gets 409', async () => {
  const { app, store, file } = setup({});
  const id = ask(store, 'WebSearch');
  store.edit(id, ruleText({ agent: 'main', rule: 'Bash(curl:*)', why: 'x' }));
  const r = await approve(app, id, 'WebSearch');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /changed/);
  assert.deepEqual(read(file), {});
});

test('approve refuses a dangerous rule, a memo with no rule, a wrong sender, and a closed memo', async () => {
  const { app, store, file } = setup({});
  const bash = ask(store, 'Bash(*)');
  const r = await approve(app, bash, 'Bash(*)');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /cannot be approved/);
  const edit = ask(store, 'Edit(~/**)');
  assert.equal((await approve(app, edit, 'Edit(~/**)')).status, 400);
  const own = ask(store, `Edit(${file})`);
  assert.equal((await approve(app, own, `Edit(${file})`)).status, 400);
  const plain = store.send({ from: 'main', to: 'cam', text: 'Hello.', impact: 1, effort: 'micro' }).memo.id;
  assert.equal((await approve(app, plain, 'WebSearch')).status, 400);
  const other = ask(store, 'WebSearch', { from: 'other', agent: 'main' });
  assert.match((await approve(app, other, 'WebSearch')).data.error, /is from other/);
  const fromLiaison = ask(store, 'WebSearch', { from: 'liaison', agent: 'liaison' });
  assert.equal((await approve(app, fromLiaison, 'WebSearch')).status, 403);
  const closed = ask(store, 'WebSearch');
  store.close(closed);
  assert.equal((await approve(app, closed, 'WebSearch')).status, 409);
  assert.deepEqual(read(file), {});
  assert.equal(store.get(bash).state, 'open');
});

test('an agent with no settings field gets 400', async () => {
  const { app, store, file } = setup({}, { settings: false });
  const id = ask(store, 'WebSearch');
  const r = await approve(app, id, 'WebSearch');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no "settings" file/);
  assert.deepEqual(read(file), {});
  const agents = (await call(app, '/api/agents')).data;
  assert.equal(agents.find((a) => a.name === 'main').rules, false);
});

test('a settings file that is not valid JSON does not change', async () => {
  const { app, store, file } = setup('{ not json');
  const id = ask(store, 'WebSearch');
  assert.equal((await approve(app, id, 'WebSearch')).status, 409);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.throws(() => addRule(project({ permissions: { allow: 'x' } }).file, 'WebSearch'), /not a list/);
});

test('agents.json: settings must be a path, and a remote agent cannot have it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-config-'));
  const write = (list) => { writeFileSync(join(dir, 'a.json'), JSON.stringify(list)); return join(dir, 'a.json'); };
  assert.equal(loadConfig(write([{ name: 'main', kind: 'long', dir: '~', model: 'm', settings: '~/work/.claude/settings.local.json' }]))[0].settings, '~/work/.claude/settings.local.json');
  assert.throws(() => loadConfig(write([{ name: 'main', kind: 'long', dir: '~', model: 'm', settings: 5 }])), /must be a file path/);
  assert.throws(() => loadConfig(write([{ name: 'mac', kind: 'remote', settings: '~/x.json' }])), /remote agent/);
  assert.ok(!existsSync(join(dir, '.claude')));
});

test('the Inbox loads rule.js, hides the marker, and sends the shown rule to the approve route', async () => {
  const { app } = makeApp();
  assert.match((await app.request('/ui/rule.js')).headers.get('content-type'), /javascript/);
  const page = readFileSync(join(import.meta.dirname, '..', 'ui', 'inbox.html'), 'utf8');
  assert.ok(page.includes("import { parseRule, withoutMarker } from '/ui/rule.js';"));
  assert.ok(page.includes("api('/api/rule/approve', { id: memo.id, rule: asked.rule })"));
  assert.ok(page.includes('asked ? withoutMarker(memo.text) : memo.text'));
});
