// The owner approves a Claude Code permission rule that an agent asked for (memo rule, see ui/rule.js).
// The agent only asks. The server writes the rule to the settings file of the agent (agents.json "settings"),
// and only for a request of the owner (see /api/rule/approve in app.js).
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MemoError } from './memos.js';
import { parseRule, ruleProblem } from '../ui/rule.js';

// The tools that write files. A rule for them must not reach a settings file.
const WRITE_TOOLS = ['edit', 'write', 'multiedit', 'notebookedit'];
// A Bash rule with a wildcard for one of these commands can run any command, and so can change a settings file.
const RUNS_ANY = /^(sh|bash|zsh|fish|dash|env|eval|exec|command|sudo|su|doas|xargs|nohup|time|nice|timeout|python[0-9.]*|node|deno|bun|npx|perl|ruby|php|lua|osascript|tclsh|awk|gawk)(\s|:|\*|$)/i;

const escape = (s) => s.replace(/[.+^${}()|\\]/g, '\\$&');
// A gitignore-style path pattern as a regular expression: ** is any path, * and ? stay inside one directory.
function globRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) { out += '(?:.*/)?'; i += 2; } else if (pattern.startsWith('**', i)) { out += '.*'; i += 1; } else if (pattern[i] === '*') out += '[^/]*';
    else if (pattern[i] === '?') out += '[^/]';
    else out += escape(pattern[i]);
  }
  return new RegExp(`^${out}$`, 'i');
}

// The absolute form of the path pattern of an Edit or Write rule, as Claude Code reads it:
// //path is absolute, ~/path is in the home directory, /path is in the project, and a name with no "/" is anywhere.
function absolutePattern(pattern, project, home) {
  let p = pattern.endsWith('/') ? `${pattern}**` : pattern;
  if (p.startsWith('//')) return p.slice(1);
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) return project + p;
  return p.includes('/') ? `${project}/${p}` : `**/${p}`;
}

// The reason to refuse the rule, or '' if the owner can approve it. A refused rule would let an agent widen its own
// limits: change a Claude Code settings file, or run any command.
export function refusal(rule, { settings, home = homedir() }) {
  const problem = ruleProblem(rule);
  if (problem) return problem;
  if (rule === '*') return 'The rule * permits all tools.';
  const m = rule.match(/^([A-Za-z0-9_-]+)(?:\((.*)\))?$/);
  const tool = m[1].toLowerCase();
  const pattern = m[2];
  const lower = rule.toLowerCase();
  const names = [settings, basename(settings), '.claude', 'settings.json', 'settings.local.json'].map((s) => s.toLowerCase());
  if (tool === 'bash') {
    if (pattern === undefined || /^[\s*:]*$/.test(pattern)) return 'This rule permits all Bash commands.';
    if (names.some((n) => lower.includes(n))) return 'A Bash rule must not name a Claude Code settings file or a .claude directory.';
    if (RUNS_ANY.test(pattern.trim()) && pattern.includes('*')) return `Bash(${pattern}) can run any command, so it can change the settings of the agent.`;
    return '';
  }
  if (WRITE_TOOLS.includes(tool)) {
    if (pattern === undefined || /^[\s*/~]*$/.test(pattern)) return `This rule permits ${m[1]} on all files, also the settings of the agent.`;
    if (names.some((n) => lower.includes(n))) return `A rule for ${m[1]} must not name a Claude Code settings file or a .claude directory.`;
    if (/[[\]{}\\]|\.\./.test(pattern)) return `A rule for ${m[1]} must not have [ ] { } \\ or "..". Write the path out.`;
    const project = basename(dirname(settings)) === '.claude' ? dirname(dirname(settings)) : dirname(settings);
    const files = [settings, join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json'),
      join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json')];
    const re = globRegex(absolutePattern(pattern, project, home));
    if (files.some((f) => re.test(f))) return `This rule for ${m[1]} reaches a Claude Code settings file.`;
  }
  return '';
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Adds the rule to permissions.allow of the settings file. No other key changes. A file that exists gets a backup
// copy next to it first. The new file goes to a temporary file, then takes the place of the old one.
export function addRule(file, rule, now = () => new Date()) {
  const target = existsSync(file) ? realpathSync(file) : file;
  let text = null;
  try { text = readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let data = {};
  if (text !== null && text.trim()) {
    try { data = JSON.parse(text); } catch { throw new MemoError(409, `${file} is not valid JSON. Nothing changed.`); }
  }
  if (!isObject(data) || (data.permissions !== undefined && !isObject(data.permissions))) throw new MemoError(409, `${file} does not have the form of a Claude Code settings file. Nothing changed.`);
  const allow = data.permissions?.allow ?? [];
  if (!Array.isArray(allow)) throw new MemoError(409, `permissions.allow in ${file} is not a list. Nothing changed.`);
  if (allow.includes(rule)) return { added: false, backup: null };
  data.permissions = { ...(data.permissions || {}), allow: [...allow, rule] };
  mkdirSync(dirname(target), { recursive: true });
  let backup = null;
  if (text !== null) {
    backup = `${target}.bak-${now().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  }
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: text !== null ? statSync(target).mode & 0o777 : 0o600, flag: 'wx' });
  renameSync(temp, target);
  return { added: true, backup };
}

// The approval of the owner. rule: the exact text that the Inbox showed. It must be the rule of the marker now,
// so a change of the memo after the owner looked cannot change the rule.
export function approveRule({ store, agents, owner, now = () => new Date() }, id, rule) {
  if (typeof rule !== 'string' || !rule) throw new MemoError(400, 'rule is necessary.');
  const memo = store.get(id);
  if (memo.state !== 'open') throw new MemoError(409, `Memo ${memo.id} is ${memo.state}. Its rule cannot be approved.`);
  if (memo.recipient !== owner) throw new MemoError(400, `Memo ${memo.id} is not to ${owner}.`);
  const asked = parseRule(memo.text);
  if (!asked) throw new MemoError(400, `Memo ${memo.id} does not ask for a rule.`);
  if (asked.rule !== rule) throw new MemoError(409, `The rule of memo ${memo.id} changed. Load the Inbox again and read the rule again.`);
  if (['liaison', 'discord'].includes(memo.sender)) throw new MemoError(403, `A rule request from ${memo.sender} cannot be approved.`);
  if (asked.agent !== memo.sender) throw new MemoError(400, `Memo ${memo.id} is from ${memo.sender}, but it asks for a rule for ${asked.agent}.`);
  const settings = agents.settingsFile(asked.agent);
  if (!settings) throw new MemoError(400, `${asked.agent} has no "settings" file in agents.json, so its rules cannot be approved here.`);
  const why = refusal(rule, { settings });
  if (why) throw new MemoError(400, `This rule cannot be approved here: ${why}`);
  const { added, backup } = addRule(settings, rule, now);
  const text = added
    ? `Approved: rule added to ${settings}. Restart the agent for it to apply.`
    : `Approved: the rule was already in ${settings}. Nothing changed.`;
  store.note(memo.id, owner, text);
  store.close(memo.id);
  store.events.add(owner, memo.id, 'rule', `${asked.agent}: ${rule}`);
  return { memo: store.get(memo.id), added, file: settings, backup };
}
