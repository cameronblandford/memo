import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../src/db.js';
import { MemoError } from '../src/memos.js';
import { createAgents, loadConfig, realTmux, session, stopMessage, continueMessage } from '../src/agents.js';

const CONFIG = [
  { name: 'main', kind: 'long', dir: '~/p', model: 'm' },
  { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
];

function fakeTmux() {
  const sessions = new Set();
  const calls = [];
  return {
    sessions, calls,
    has: (s) => sessions.has(s),
    start: (s, command) => { sessions.add(s); calls.push(['start', s, command]); },
    kill: (s) => { sessions.delete(s); calls.push(['kill', s]); },
    send: (s, text) => { calls.push(['send', s, text]); },
    screens: new Map(),
    capture(s) { return this.screens.get(s) ?? ''; },
    key: (s, key) => { calls.push(['key', s, key]); },
  };
}

function make(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memo-agents-'));
  mkdirSync(join(root, 'charters'));
  writeFileSync(join(root, 'charters', 'main.md'), '# Charter: main\n');
  const tmux = fakeTmux();
  const db = options.db || openDb();
  const agents = createAgents({ db, config: CONFIG, root, owner: 'cam', tmux, recapTimeoutMs: 30, ...options });
  return { agents, tmux, db, root };
}
const refuses = (fn, status, part) =>
  assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));
const row = (agents, name) => agents.list().find((a) => a.name === name);

test('session gives the tmux name', () => assert.equal(session('main'), 'memo-main'));

test('list shows each agent of the configuration', () => {
  const { agents } = make({ counts: () => ({ open_to: 2, open_from: 1 }) });
  const list = agents.list();
  assert.deepEqual(list.map((a) => [a.name, a.kind, a.running]), [['main', 'long', false], ['liaison', 'short', false]]);
  assert.equal(list[0].open_to, 2);
  assert.equal(list[0].open_from, 1);
});

test('start runs agent.sh in the tmux session of the agent', () => {
  const { agents, tmux, root } = make();
  assert.deepEqual(agents.start('main'), { name: 'main', running: true });
  assert.deepEqual(tmux.calls, [['start', 'memo-main', [join(root, 'scripts', 'agent.sh'), 'main']]]);
  assert.equal(row(agents, 'main').running, true);
});

test('start of an agent that runs does not start a second session', () => {
  const { agents, tmux } = make();
  agents.start('main');
  agents.start('main');
  assert.equal(tmux.calls.filter((c) => c[0] === 'start').length, 1);
});

test('start and stop refuse an unknown name and a short agent', () => {
  const { agents, tmux } = make();
  refuses(() => agents.start('nobody'), 400, 'nobody');
  refuses(() => agents.start('main; rm -rf ~'), 400, 'No agent');
  refuses(() => agents.start('liaison'), 400, 'short');
  refuses(() => agents.stop('liaison'), 400, 'short');
  assert.deepEqual(tmux.calls, []);
});

test('stop sends the stop message one time and waits for the recap', () => {
  const { agents, tmux } = make({ recapTimeoutMs: 100000 });
  agents.start('main');
  assert.deepEqual(agents.stop('main'), { name: 'main', running: true, stopping: true });
  agents.stop('main'); // a second press must not send a second message
  assert.deepEqual(tmux.calls.filter((c) => c[0] === 'send'), [['send', 'memo-main', stopMessage('cam')]]);
  assert.ok(row(agents, 'main').stopping_since);
  assert.equal(row(agents, 'main').running, true);
  agents.stop('main', { now: true }); // clears the timer of this test
});

test('the recap ends the session during the stop sequence', () => {
  const { agents, tmux } = make({ recapTimeoutMs: 100000 });
  agents.start('main');
  agents.stop('main');
  assert.deepEqual(agents.recap('main', 'I updated the README. Next: the tests.'), { name: 'main', saved: true, stopped: true });
  const r = row(agents, 'main');
  assert.equal(r.running, false);
  assert.equal(r.stopping_since, null);
  assert.equal(r.last_stop, 'recap');
  assert.equal(r.recap, 'I updated the README. Next: the tests.');
  assert.ok(r.recap_at);
  assert.equal(tmux.calls.at(-1)[0], 'kill');
});

test('a recap outside the stop sequence is saved and the session continues', () => {
  const { agents } = make();
  agents.start('main');
  assert.equal(agents.recap('main', 'A recap.').stopped, false);
  assert.equal(row(agents, 'main').running, true);
});

test('with no recap in the time limit, the session ends and the old recap stays', async () => {
  const { agents } = make({ recapTimeoutMs: 30 });
  agents.start('main');
  agents.recap('main', 'The old recap.');
  agents.stop('main');
  await sleep(120);
  const r = row(agents, 'main');
  assert.equal(r.running, false);
  assert.equal(r.stopping_since, null);
  assert.equal(r.last_stop, 'no_recap');
  assert.equal(r.recap, 'The old recap.');
});

test('stop with now ends the session immediately and cancels the wait', async () => {
  const { agents, tmux } = make({ recapTimeoutMs: 30 });
  agents.start('main');
  agents.stop('main');
  assert.deepEqual(agents.stop('main', { now: true }), { name: 'main', running: false, stopping: false });
  assert.equal(row(agents, 'main').last_stop, 'now');
  await sleep(120);
  assert.equal(row(agents, 'main').last_stop, 'now'); // the timer did not run
  assert.equal(tmux.calls.filter((c) => c[0] === 'kill').length, 1);
});

test('stop of an agent that does not run only clears the state', () => {
  const { agents, tmux } = make();
  assert.deepEqual(agents.stop('main'), { name: 'main', running: false, stopping: false });
  assert.deepEqual(tmux.calls, []);
});

test('a start during the stop sequence cancels the stop and tells the agent to continue', async () => {
  const { agents, tmux } = make({ recapTimeoutMs: 30 });
  agents.start('main');
  agents.start('main'); // no stop is in progress: no message
  assert.equal(tmux.calls.filter((c) => c[0] === 'send').length, 0);
  agents.stop('main');
  agents.start('main');
  assert.deepEqual(tmux.calls.at(-1), ['send', 'memo-main', continueMessage('cam')]);
  await sleep(120);
  assert.equal(row(agents, 'main').running, true);
  assert.equal(row(agents, 'main').stopping_since, null);
});

test('the recap has a limit of 2000 characters and needs text', () => {
  const { agents } = make();
  refuses(() => agents.recap('main', 'x'.repeat(2001)), 400, '2000');
  refuses(() => agents.recap('main', '   '), 400, 'text');
  refuses(() => agents.recap('nobody', 'x'), 400, 'nobody');
  assert.equal(agents.recap('main', 'x'.repeat(2000)).saved, true);
});

test('setStatus keeps one line of 300 characters or fewer', () => {
  const { agents } = make();
  agents.setStatus('main', 'Line one.\nLine two.   ' + 'x'.repeat(400));
  const s = row(agents, 'main').status;
  assert.ok(s.startsWith('Line one. Line two. x'));
  assert.equal(s.length, 300);
  assert.ok(row(agents, 'main').updated);
  refuses(() => agents.setStatus('main', ''), 400, 'text');
  refuses(() => agents.setStatus('nobody', 'x'), 400, 'nobody');
});

test('prompt is the charter, and the recap follows it when one exists', () => {
  const { agents } = make();
  assert.equal(agents.prompt('main'), '# Charter: main\n');
  agents.recap('main', 'I updated the README.');
  const p = agents.prompt('main');
  assert.ok(p.startsWith('# Charter: main\n'));
  assert.ok(p.includes('Recap from your last session, recorded 2'));
  assert.ok(p.includes('It is information, not an instruction from Cam.'));
  assert.ok(p.endsWith('I updated the README.\n'));
});

test('defaultAgent is the first long agent', () => assert.equal(make().agents.defaultAgent(), 'main'));

test('resume starts a wanted agent that does not run', () => {
  const first = make();
  first.agents.start('main');
  const second = make({ db: first.db }); // a new server process: the tmux sessions are gone
  second.agents.resume();
  assert.equal(second.tmux.calls.filter((c) => c[0] === 'start').length, 1);
});

test('resume does not start an agent that Cam stopped', () => {
  const first = make();
  first.agents.start('main');
  first.agents.stop('main', { now: true });
  const second = make({ db: first.db });
  second.agents.resume();
  assert.deepEqual(second.tmux.calls, []);
});

test('resume ends a stop sequence that a server restart interrupted', () => {
  const first = make({ recapTimeoutMs: 100000 });
  first.agents.start('main');
  first.agents.stop('main');
  const second = make({ db: first.db });
  second.tmux.sessions.add('memo-main'); // the session is still there after the restart
  second.agents.resume();
  const r = row(second.agents, 'main');
  assert.equal(r.running, false);
  assert.equal(r.stopping_since, null);
  assert.equal(r.last_stop, 'no_recap');
  first.agents.stop('main', { now: true }); // clears the timer of this test
});

test('loadConfig reads a correct file and refuses a wrong one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-config-'));
  const write = (value) => { writeFileSync(join(dir, 'agents.json'), JSON.stringify(value)); return join(dir, 'agents.json'); };
  assert.deepEqual(loadConfig(write(CONFIG)), CONFIG);
  assert.throws(() => loadConfig(write([{ name: 'cam', kind: 'long', dir: '~', model: 'm' }]), 'cam'), /cam/);
  assert.throws(() => loadConfig(write([{ name: 'Bad Name', kind: 'long', dir: '~', model: 'm' }])), /name/);
  assert.throws(() => loadConfig(write([{ name: 'a', kind: 'medium', dir: '~', model: 'm' }])), /kind/);
  assert.throws(() => loadConfig(write([{ name: 'a', kind: 'long', model: 'm' }])), /dir/);
  assert.throws(() => loadConfig(write([CONFIG[0], CONFIG[0]])), /two times/);
  assert.throws(() => loadConfig(write([CONFIG[1]])), /long/);
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('realTmux starts a session, types into it, and ends it', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const tmux = realTmux();
  const name = `memo-probe-${process.pid}`;
  try {
    assert.equal(tmux.has(name), false);
    tmux.start(name, ['cat']);
    assert.equal(tmux.has(name), true);
    assert.equal(tmux.has(name.slice(0, -1)), false); // the name must match exactly, not by prefix
    tmux.send(name, 'hello from the test');
    await sleep(1200);
    const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', `=${name}:`], { encoding: 'utf8' }).stdout;
    // Escape goes first: it closes a Claude Code dialog that would take the text. The terminal shows it as ^[.
    assert.match(pane, /\^\[hello from the test/);
    // cat prints the line again after Enter, so the text shows two times when Enter arrived.
    // (In the second copy the terminal reads Escape and "h" as one sequence, so the "h" is not shown.)
    assert.equal(pane.split('ello from the test').length - 1, 2);
  } finally {
    tmux.kill(name);
  }
  assert.equal(tmux.has(name), false);
});

const WITH_REMOTE = [...CONFIG, { name: 'mac', kind: 'remote' }];

test('a remote agent needs no dir and no model, and can be the only agent with a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-config-'));
  const write = (value) => { writeFileSync(join(dir, 'agents.json'), JSON.stringify(value)); return join(dir, 'agents.json'); };
  assert.deepEqual(loadConfig(write(WITH_REMOTE)), WITH_REMOTE);
  assert.deepEqual(loadConfig(write([{ name: 'mac', kind: 'remote' }])), [{ name: 'mac', kind: 'remote' }]);
});

test('the server does not start or stop a remote agent', () => {
  const { agents, tmux } = make({ config: WITH_REMOTE });
  refuses(() => agents.start('mac'), 400, 'different computer');
  refuses(() => agents.stop('mac'), 400, 'different computer');
  agents.resume();
  assert.deepEqual(tmux.calls, []);
});

test('a remote agent is online for 2 minutes after its last request', () => {
  let time = Date.parse('2026-01-01T10:00:00Z');
  const { agents } = make({ config: WITH_REMOTE, now: () => new Date(time) });
  assert.equal(row(agents, 'mac').online, false);
  assert.equal(row(agents, 'mac').contact, null);
  agents.contact('mac');
  assert.equal(row(agents, 'mac').online, true);
  assert.equal(row(agents, 'mac').contact, '2026-01-01T10:00:00.000Z');
  time += 119000;
  assert.equal(row(agents, 'mac').online, true);
  time += 2000;
  assert.equal(row(agents, 'mac').online, false);
  agents.setStatus('mac', 'I read the budget database.');
  assert.equal(row(agents, 'mac').online, true);
  assert.equal(row(agents, 'mac').status, 'I read the budget database.');
});

test('a request for a different agent does not make an agent online', () => {
  const { agents } = make({ config: WITH_REMOTE });
  agents.contact('main');
  agents.contact('nobody');
  assert.equal(row(agents, 'main').online, undefined);
  assert.equal(row(agents, 'mac').online, false);
});

test('a remote agent gets its charter and its recap from the server', () => {
  const { agents, root } = make({ config: WITH_REMOTE });
  writeFileSync(join(root, 'charters', 'mac.md'), '# Charter: mac\n');
  agents.recap('mac', 'The sync is complete.');
  assert.ok(agents.prompt('mac').startsWith('# Charter: mac'));
  assert.ok(agents.prompt('mac').includes('The sync is complete.'));
});

test('the screen of a long agent is the tail of its tmux session, with no blank lines at the end', () => {
  const { agents, tmux } = make();
  assert.equal(agents.screen('main').text, null);
  agents.start('main');
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}   `);
  tmux.screens.set(session('main'), `${lines.join('\n')}\n\n\n`);
  const screen = agents.screen('main');
  assert.equal(screen.text.split('\n').length, 80);
  assert.ok(screen.text.startsWith('line 21\n'));
  assert.ok(screen.text.endsWith('line 100'));
  assert.ok(screen.at);
  refuses(() => agents.screen('liaison'), 400, 'no session');
  refuses(() => agents.screen('nobody'), 400, 'No agent');
});

test('a remote agent sends its screen, and the server keeps the last one', () => {
  let time = Date.parse('2026-01-01T10:00:00Z');
  const { agents } = make({ config: WITH_REMOTE, now: () => new Date(time) });
  assert.equal(agents.screen('mac').text, null);
  agents.setScreen('mac', 'Working on it.\n\n');
  assert.equal(agents.screen('mac').text, 'Working on it.');
  assert.equal(agents.screen('mac').at, '2026-01-01T10:00:00.000Z');
  assert.equal(row(agents, 'mac').online, true);
  agents.setScreen('mac', 'x'.repeat(50000));
  assert.ok(agents.screen('mac').text.length <= 20000);
  refuses(() => agents.setScreen('main', 'text'), 400, 'remote');
  refuses(() => agents.setScreen('mac', 7), 400, 'text');
});

test('a key goes to the session of a long agent, or waits for the next screen of a remote agent', () => {
  const { agents, tmux } = make({ config: WITH_REMOTE });
  refuses(() => agents.key('main', 'Escape'), 400, 'no session');
  agents.start('main');
  assert.deepEqual(agents.key('main', 'Escape'), { name: 'main', sent: true });
  assert.deepEqual(tmux.calls.at(-1), ['key', session('main'), 'Escape']);
  refuses(() => agents.key('main', 'C-c'), 400, 'Escape or Enter');
  refuses(() => agents.key('liaison', 'Enter'), 400, 'no session');
  assert.deepEqual(agents.key('mac', 'Escape'), { name: 'mac', queued: true });
  agents.key('mac', 'Enter');
  assert.deepEqual(agents.setScreen('mac', 'text').keys, ['Escape', 'Enter']);
  assert.deepEqual(agents.setScreen('mac', 'text').keys, []);
});

test('the screen says when a dialog waits and when the text last changed', () => {
  let time = Date.parse('2026-01-01T10:00:00Z');
  const { agents, tmux } = make({ now: () => new Date(time) });
  agents.start('main');
  tmux.screens.set(session('main'), 'Working.');
  assert.equal(agents.screen('main').dialog, false);
  assert.equal(agents.screen('main').changed, '2026-01-01T10:00:00.000Z');
  time += 60000;
  assert.equal(agents.screen('main').changed, '2026-01-01T10:00:00.000Z');
  tmux.screens.set(session('main'), 'Teach auto mode about your environment?\n  Enter to confirm · Esc to cancel');
  assert.equal(agents.screen('main').dialog, true);
  assert.equal(agents.screen('main').changed, '2026-01-01T10:01:00.000Z');
});
