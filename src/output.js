import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The live output of an agent on the Agents page comes from the Claude Code transcript of its session (a .jsonl file).
// A transcript also holds tool inputs, tool results (mail, files, secrets) and thinking.
// This file gives only the visible text of the assistant, and for each tool call its name and its short description.

export const MAX_ENTRIES = 50;
const MAX_TEXT = 4000;
const MAX_DESCRIPTION = 200;
const FIRST_WINDOW = 256 * 1024; // the first read takes the end of the file, and more if it has too few entries
const MAX_WINDOW = 8 * 1024 * 1024;
const MAX_STEP = 4 * 1024 * 1024; // more new bytes than this: start again from the end of the file

const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

export const expandHome = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

// One line of the transcript gives zero or more entries.
export function parseLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return []; }
  if (!record || record.type !== 'assistant' || record.isSidechain) return [];
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const at = typeof record.timestamp === 'string' ? record.timestamp : null;
  const entries = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      entries.push({ kind: 'text', text: cut(block.text.trim(), MAX_TEXT), at });
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      const d = block.input?.description;
      entries.push({ kind: 'tool', name: cut(block.name, 100), description: typeof d === 'string' ? cut(d.replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION) : '', at });
    }
  }
  return entries;
}

// The entries of the complete lines in the buffer. A line without its end is not complete.
// skipFirst: the buffer starts in the middle of a line, so its first line is not complete either.
export function parseChunk(buffer, { skipFirst = false } = {}) {
  const end = buffer.lastIndexOf(0x0a) + 1; // the bytes after the last newline wait for the next read
  let start = 0;
  if (skipFirst) {
    start = buffer.indexOf(0x0a) + 1;
    if (start === 0 || start > end) return { entries: [], used: end };
  }
  const entries = buffer.subarray(start, end).toString('utf8').split('\n').flatMap((l) => (l ? parseLine(l) : []));
  return { entries, used: end };
}

// The newest .jsonl file in the directory, or null.
export function newestTranscript(dir) {
  let best = null;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    let s;
    try { s = statSync(join(dir, name)); } catch { continue; }
    if (s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { name, mtimeMs: s.mtimeMs, size: s.size };
  }
  return best;
}

function readRange(path, from, to) {
  const buffer = Buffer.alloc(to - from);
  const fd = openSync(path, 'r');
  try {
    let done = 0;
    while (done < buffer.length) {
      const n = readSync(fd, buffer, done, buffer.length - done, from + done);
      if (n === 0) break;
      done += n;
    }
    return buffer.subarray(0, done);
  } finally { closeSync(fd); }
}

// The last entries of the file: a larger window from its end until it has enough entries.
function tail(path, size) {
  let window = FIRST_WINDOW;
  for (;;) {
    const from = Math.max(0, size - window);
    const { entries, used } = parseChunk(readRange(path, from, size), { skipFirst: from > 0 });
    if (entries.length >= MAX_ENTRIES || from === 0 || window >= MAX_WINDOW) {
      return { entries: entries.slice(-MAX_ENTRIES), cursor: from + used };
    }
    window *= 4;
  }
}

// dir: the transcript directory of the agent. file and cursor: from the last answer, or absent for the first request.
// The answer: { file, cursor, reset, entries }. reset is true when the page must clear its list (a new file, or the first request).
export function readOutput(dir, { file, cursor } = {}) {
  const newest = newestTranscript(dir);
  if (!newest) return { file: null, cursor: 0, reset: true, entries: [] };
  const path = join(dir, newest.name);
  const at = Number(cursor);
  const same = file === newest.name && Number.isSafeInteger(at) && at >= 0 && at <= newest.size;
  if (!same || newest.size - at > MAX_STEP) return { file: newest.name, reset: true, ...tail(path, newest.size) };
  if (at === newest.size) return { file: newest.name, cursor: at, reset: false, entries: [] };
  const { entries, used } = parseChunk(readRange(path, at, newest.size));
  return { file: newest.name, cursor: at + used, reset: false, entries: entries.slice(-MAX_ENTRIES) };
}
