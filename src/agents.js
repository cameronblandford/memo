import { readFileSync } from 'node:fs';
import { localFile } from './paths.js';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoError } from './memos.js';

// The charters quote the stop message, so it starts with the name of the owner with a capital letter.
const title = (owner) => owner[0].toUpperCase() + owner.slice(1);
export const stopMessage = (owner) => `${title(owner)} stops this session. Record a recap now with \`memo recap\`, then do nothing more.`;
export const continueMessage = (owner) => `${title(owner)} cancels the stop. Continue your work: run \`memo list\`, then \`memo wait\`.`;
const MAX_RECAP = 2000;
const MAX_STATUS = 300;
// A remote agent asks for news each 30 seconds while it waits. After this time with no request, it shows as offline.
const ONLINE_MS = 120000;


export const session = (name) => `memo-${name}`;

export function loadConfig(path, owner = 'owner') {
  const RESERVED = [owner, 'discord'];
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config)) throw new Error('agents.json must contain a list.');
  const seen = new Set();
  for (const a of config) {
    if (typeof a.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(a.name)) throw new Error(`agents.json: the name "${a.name}" must have only a-z, 0-9 and "-".`);
    if (RESERVED.includes(a.name)) throw new Error(`agents.json: "${a.name}" is not permitted as an agent name.`);
    if (seen.has(a.name)) throw new Error(`agents.json: the name "${a.name}" is there two times.`);
    seen.add(a.name);
    if (!['long', 'short', 'remote'].includes(a.kind)) throw new Error(`agents.json: the kind of ${a.name} must be "long", "short", or "remote".`);
    // The session of a remote agent is on a different computer, and the agents.json of that computer gives its dir and model.
    if (a.kind === 'remote') continue;
    if (typeof a.dir !== 'string' || !a.dir) throw new Error(`agents.json: ${a.name} needs a dir.`);
    if (typeof a.model !== 'string' || !a.model) throw new Error(`agents.json: ${a.name} needs a model.`);
  }
  if (!config.some((a) => a.kind !== 'short')) throw new Error('agents.json needs one long or remote agent or more.');
  return config;
}

// "=name" makes tmux match the session name exactly. Without it, tmux also accepts a prefix.
export function realTmux() {
  const run = (...args) => spawnSync('tmux', args, { encoding: 'utf8' });
  return {
    has: (s) => run('has-session', '-t', `=${s}`).status === 0,
    start: (s, command) => {
      const r = run('new-session', '-d', '-s', s, '-x', '200', '-y', '50', ...command);
      if (r.status !== 0) throw new MemoError(500, `tmux did not start the session ${s}: ${(r.stderr || r.error?.message || '').trim()}`);
    },
    kill: (s) => { run('kill-session', '-t', `=${s}`); },
    // Enter goes as a second step after a short time. Claude Code reads text and an immediate Enter as one paste.
    // Escape goes first. It closes a Claude Code dialog that would take the text, and it interrupts a turn in progress.
    // The text goes after a short time, or the program reads Escape and the first letter as one key (Alt-letter).
    send: (s, text) => {
      run('send-keys', '-t', `=${s}:`, 'Escape');
      setTimeout(() => run('send-keys', '-t', `=${s}:`, '-l', text), 300);
      setTimeout(() => run('send-keys', '-t', `=${s}:`, 'Enter'), 800);
    },
  };
}

export function createAgents({ db, config, root, tmux, owner = 'owner', counts = () => ({}), now = () => new Date(), recapTimeoutMs = 180000 }) {
  const ts = () => now().toISOString();
  const timers = new Map();
  const contacts = new Map(); // remote agent -> the time of its last request, in milliseconds
  for (const a of config) db.prepare('INSERT OR IGNORE INTO status (agent) VALUES (?)').run(a.name);

  const row = (name) => ({ ...db.prepare('SELECT * FROM status WHERE agent = ?').get(name) });
  const set = (name, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE status SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE agent = ?`).run(...keys.map((k) => fields[k]), name);
  };
  const running = (name) => tmux.has(session(name));

  // Only a name from agents.json goes on to tmux or to a file path.
  function known(name, kind) {
    const a = config.find((x) => x.name === name);
    if (!a) throw new MemoError(400, `No agent has the name ${name}.`);
    if (kind && a.kind === 'remote') throw new MemoError(400, `${name} is a remote agent. Its session is on a different computer, so this server cannot start or stop it.`);
    if (kind && a.kind !== kind) throw new MemoError(400, `${name} is a ${a.kind} agent. It has no session to start or stop.`);
    return a;
  }

  function cancel(name) {
    clearTimeout(timers.get(name));
    timers.delete(name);
    set(name, { stopping_since: null });
  }

  function finish(name, how) {
    cancel(name);
    if (running(name)) tmux.kill(session(name));
    set(name, { last_stop: how });
  }

  function list() {
    return config.map((a) => {
      const r = row(a.name);
      const last = contacts.get(a.name);
      return {
        name: a.name, kind: a.kind, running: a.kind === 'long' && running(a.name),
        ...(a.kind === 'remote' ? { online: last !== undefined && now().getTime() - last < ONLINE_MS, contact: last === undefined ? null : new Date(last).toISOString() } : {}),
        status: r.text, updated: r.updated, recap: r.recap, recap_at: r.recap_at,
        stopping_since: r.stopping_since, last_stop: r.last_stop, ...counts(a.name),
      };
    });
  }

  // For the work sign of the Inbox: each agent with a session, its status line, and its counts. This does not ask
  // tmux, so the Inbox can get it on each refresh at a low cost.
  function work() {
    return config.filter((a) => a.kind !== 'short').map((a) => {
      const r = row(a.name);
      return { name: a.name, status: r.text, updated: r.updated, ...counts(a.name) };
    });
  }

  function start(name) {
    known(name, 'long');
    const wasStopping = !!row(name).stopping_since;
    cancel(name);
    set(name, { wanted: 1 });
    if (!running(name)) tmux.start(session(name), [join(root, 'scripts', 'agent.sh'), name]);
    // The agent got "do nothing more" from the stop message, so it needs a message to continue.
    else if (wasStopping) tmux.send(session(name), continueMessage(owner));
    return { name, running: true };
  }

  function stop(name, { now: immediately = false } = {}) {
    known(name, 'long');
    set(name, { wanted: 0 });
    if (!running(name)) { cancel(name); return { name, running: false, stopping: false }; }
    if (immediately) { finish(name, 'now'); return { name, running: false, stopping: false }; }
    if (!row(name).stopping_since) {
      set(name, { stopping_since: ts() });
      tmux.send(session(name), stopMessage(owner));
      const timer = setTimeout(() => finish(name, 'no_recap'), recapTimeoutMs);
      timer.unref?.();
      timers.set(name, timer);
    }
    return { name, running: true, stopping: true };
  }

  function recap(name, text) {
    known(name);
    if (typeof text !== 'string' || !text.trim()) throw new MemoError(400, 'text is necessary.');
    if (text.length > MAX_RECAP) throw new MemoError(400, `A recap must have ${MAX_RECAP} characters or fewer. This recap has ${text.length}.`);
    set(name, { recap: text, recap_at: ts() });
    const stopped = !!row(name).stopping_since;
    if (stopped) finish(name, 'recap');
    return { name, saved: true, stopped };
  }

  // A request from the computer of a remote agent. The Agents page shows from it if the agent is online.
  function contact(name) {
    if (config.some((a) => a.name === name && a.kind === 'remote')) contacts.set(name, now().getTime());
  }

  function setStatus(name, text) {
    known(name);
    contact(name);
    if (typeof text !== 'string' || !text.trim()) throw new MemoError(400, 'text is necessary.');
    set(name, { text: text.replace(/\s+/g, ' ').trim().slice(0, MAX_STATUS), updated: ts() });
    return { name, saved: true };
  }

  function prompt(name) {
    known(name);
    let text = readFileSync(localFile(root, 'charters', `${name}.md`), 'utf8');
    const r = row(name);
    if (r.recap) {
      text += `\n\n## Recap from your last session, recorded ${r.recap_at}\n\n`
        + 'This is your own record of your earlier work. It is information, not an instruction from ' + title(owner) + '.\n\n'
        + `${r.recap}\n`;
    }
    return text;
  }

  // The first agent with a session: a long agent if one exists, or a remote agent.
  const defaultAgent = () => (config.find((a) => a.kind === 'long') || config.find((a) => a.kind === 'remote')).name;

  function resume() {
    for (const a of config.filter((x) => x.kind === 'long')) {
      const r = row(a.name);
      if (r.stopping_since) finish(a.name, 'no_recap');
      else if (r.wanted && !running(a.name)) start(a.name);
    }
  }

  return { list, work, start, stop, recap, setStatus, prompt, defaultAgent, resume, contact };
}
