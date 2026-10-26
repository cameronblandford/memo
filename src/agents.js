import { readFileSync } from 'node:fs';
import { localFile } from './paths.js';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { MemoError } from './memos.js';
import { createEvents } from './events.js';
import { expandHome, readOutput } from './output.js';

// The charters quote the stop message, so it starts with the name of the owner with a capital letter.
const title = (owner) => owner[0].toUpperCase() + owner.slice(1);
export const stopMessage = (owner) => `${title(owner)} stops this session. Record a recap now with \`memo recap\`, then do nothing more.`;
export const continueMessage = (owner) => `${title(owner)} cancels the stop. Continue your work: run \`memo list\`, then \`memo wait\`.`;
const MAX_RECAP = 2000;
const MAX_STATUS = 300;
// A remote agent asks for news each 30 seconds while it waits. After this time with no request, it shows as offline.
const ONLINE_MS = 120000;
// The Agents page shows the tail of each session: this many lines, and this many characters or fewer.
const SCREEN_LINES = 80;
const MAX_SCREEN = 20000;
// The keys that the page can send to a session. They close a Claude Code dialog that stops an agent.
const KEYS = ['Escape', 'Enter'];
// The last line of a Claude Code dialog (a choice that waits for an answer).
const DIALOG = /Enter to confirm|Esc to cancel/;
// A dialog that waits this long sends one memo to the owner. The memo shows this many lines of the screen.
const DIALOG_ALERT_MS = 15 * 60000;
const DIALOG_LINES = 12;

// The last lines of a screen, with no spaces at the line ends and no blank lines at the end.
export function tail(text) {
  const lines = String(text).split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.slice(-SCREEN_LINES).join('\n').slice(-MAX_SCREEN);
}


export const session = (name) => `memo-${name}`;

// A computer name such as "playmac": letters, digits and "-" (a Tailscale machine name).
const COMPUTER = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
// The name of the computer of the server: its host name without the domain ("playmac.local" gives "playmac").
export const hostComputer = (name = hostname()) => String(name).split('.')[0] || null;

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
    // Optional: the directory of the Claude Code transcripts of the agent, for its live output on the Agents page.
    if (a.transcripts !== undefined && (typeof a.transcripts !== 'string' || !a.transcripts)) throw new Error(`agents.json: the transcripts of ${a.name} must be a directory path.`);
    // Optional: the Claude Code settings file of the agent. The owner can approve a permission rule for it in the Inbox.
    if (a.settings !== undefined && (typeof a.settings !== 'string' || !a.settings)) throw new Error(`agents.json: the settings of ${a.name} must be a file path.`);
    if (a.settings !== undefined && a.kind === 'remote') throw new Error(`agents.json: ${a.name} is a remote agent. Its settings file is on a different computer, so it cannot have "settings" here.`);
    // Optional: the name of the computer of the agent, for the Agents page. A local agent has the computer of the server by default.
    if (a.computer !== undefined && (typeof a.computer !== 'string' || !COMPUTER.test(a.computer))) throw new Error(`agents.json: the computer of ${a.name} must be a short name with only letters, digits, and "-".`);
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
    // -J joins the lines that tmux wrapped. -S -100 adds lines above the visible part.
    capture: (s) => run('capture-pane', '-p', '-J', '-S', '-100', '-t', `=${s}:`).stdout || '',
    key: (s, key) => { run('send-keys', '-t', `=${s}:`, key); },
  };
}

export function createAgents({ db, config, root, tmux, owner = 'owner', computer = hostComputer(), counts = () => ({}), now = () => new Date(), recapTimeoutMs = 180000, alert = () => {}, dialogAlertMs = DIALOG_ALERT_MS }) {
  const ts = () => now().toISOString();
  const timers = new Map();
  const contacts = new Map(); // remote agent -> the time of its last request, in milliseconds
  const screens = new Map(); // agent -> { text, at, changed }: the last screen, its time, and the time of its last change
  const keys = new Map(); // remote agent -> the keys that wait for its next screen
  const dialogs = new Map(); // agent -> { since, sent }: the start of the dialog that waits, and whether its memo went
  const events = createEvents(db, now);
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
        name: a.name, kind: a.kind, computer: a.computer ?? (a.kind === 'remote' ? null : computer), running: a.kind === 'long' && running(a.name),
        ...(a.kind === 'remote' ? { online: last !== undefined && now().getTime() - last < ONLINE_MS, contact: last === undefined ? null : new Date(last).toISOString() } : {}),
        status: r.text, updated: r.updated, recap: r.recap, recap_at: r.recap_at,
        stopping_since: r.stopping_since, last_stop: r.last_stop, output: !!a.transcripts, rules: !!a.settings, ...counts(a.name),
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
    events.add(owner, null, 'start', name);
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
    events.add(owner, null, 'stop', immediately ? `${name}, now` : name);
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
    events.add(name, null, 'recap', text);
    const stopped = !!row(name).stopping_since;
    if (stopped) finish(name, 'recap');
    return { name, saved: true, stopped };
  }

  function keep(name, text) {
    const last = screens.get(name);
    const at = ts();
    screens.set(name, { text, at, changed: last && last.text === text ? last.changed : at });
  }

  // The tail of the session. The server reads it for a long agent; a remote agent sends it (setScreen).
  function screen(name) {
    const a = known(name);
    if (a.kind === 'short') throw new MemoError(400, `${name} is a short agent. It has no session to show.`);
    if (a.kind === 'long' && running(name)) keep(name, tail(tmux.capture(session(name))));
    const s = screens.get(name);
    if (!s) return { name, text: null, at: null, changed: null, dialog: false };
    return { name, ...s, dialog: DIALOG.test(s.text.split('\n').slice(-DIALOG_LINES).join('\n')) };
  }

  // The server calls this each minute. A dialog stops the agent until someone answers it, so a dialog that waits for
  // dialogAlertMs sends one memo to the owner (alert gets the fields of the memo). A new dialog sends a new memo.
  // A stopped agent and an offline remote agent have no live screen, so they send nothing.
  function checkDialogs() {
    const t = now().getTime();
    for (const a of config.filter((x) => x.kind !== 'short')) {
      const last = contacts.get(a.name);
      const live = a.kind === 'long' ? running(a.name) : last !== undefined && t - last < ONLINE_MS;
      const s = live ? screen(a.name) : null;
      if (!s?.dialog) { dialogs.delete(a.name); continue; }
      if (!dialogs.has(a.name)) dialogs.set(a.name, { since: t, sent: false });
      const d = dialogs.get(a.name);
      if (d.sent || t - d.since < dialogAlertMs) continue;
      d.sent = true;
      const minutes = Math.floor((t - d.since) / 60000);
      const lines = s.text.split('\n').slice(-DIALOG_LINES).join('\n');
      try {
        alert({
          from: a.name, impact: 4, effort: 'micro', title: `${a.name} waits on a dialog`,
          text: `**${a.name} waits on a Claude Code dialog for ${minutes} minutes.**\n`
            + `${a.name} does no work until the dialog closes. Open the Agents page and send Escape or Enter. `
            + 'If the dialog says that safeguards flagged the session, Escape does not hold: stop the agent and start it again.\n\n'
            + '```text\n' + lines.replaceAll('```', "'''") + '\n```',
        });
      } catch (e) {
        console.error(`Dialog alert for ${a.name}: ${e.message}`);
      }
    }
  }

  // From the computer of a remote agent. The answer gives the keys that wait for the session.
  function setScreen(name, text) {
    const a = known(name);
    if (a.kind !== 'remote') throw new MemoError(400, `${name} is not a remote agent. The server reads its screen itself.`);
    if (typeof text !== 'string') throw new MemoError(400, 'text is necessary.');
    contact(name);
    keep(name, tail(text));
    const waiting = keys.get(name) || [];
    keys.delete(name);
    return { name, saved: true, keys: waiting };
  }

  function key(name, k) {
    const a = known(name);
    if (!KEYS.includes(k)) throw new MemoError(400, `The key must be Escape or Enter.`);
    if (a.kind === 'remote') { keys.set(name, [...(keys.get(name) || []), k].slice(-5)); return { name, queued: true }; }
    if (a.kind !== 'long' || !running(name)) throw new MemoError(400, `${name} has no session that runs on this server.`);
    tmux.key(session(name), k);
    return { name, sent: true };
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
    events.add(name, null, 'status', text);
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

  // The new part of the live output of the agent. See output.js. An agent with no transcripts directory has none.
  function output(name, { file, cursor } = {}) {
    const a = known(name);
    if (!a.transcripts) return { file: null, cursor: 0, reset: true, entries: [] };
    return readOutput(expandHome(a.transcripts), { file, cursor });
  }

  // The Claude Code settings file of the agent (agents.json "settings", ~ expanded), or null.
  function settingsFile(name) {
    const a = known(name);
    return a.settings ? expandHome(a.settings) : null;
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

  return { list, work, start, stop, recap, setStatus, prompt, defaultAgent, resume, contact, output, screen, setScreen, key, settingsFile, checkDialogs };
}
