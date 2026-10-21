import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine, parseChunk, readOutput, newestTranscript, expandHome } from '../src/output.js';
import { loadConfig } from '../src/agents.js';
import { makeApp, call, LIAISON_TOKEN } from './helpers.js';

const SECRET = 'hunter2-secret-mail-body';
const assistant = (content, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T12:00:00.000Z', message: { role: 'assistant', content }, ...extra });
const toolResult = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: SECRET }] } });
const userPrompt = JSON.stringify({ type: 'user', message: { role: 'user', content: `please read ${SECRET}` } });
const thinking = assistant([{ type: 'thinking', thinking: SECRET, signature: 'x' }]);
const toolCall = assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `cat ${SECRET}`, description: 'List the files' } }]);
const toolNoDescription = assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `/x/${SECRET}` } }]);
const text = (t) => assistant([{ type: 'text', text: t }]);

test('parseLine keeps the visible text and the name and description of a tool call', () => {
  assert.deepEqual(parseLine(text('Hello there')), [{ kind: 'text', text: 'Hello there', at: '2026-10-21T12:00:00.000Z' }]);
  assert.deepEqual(parseLine(toolCall), [{ kind: 'tool', name: 'Bash', description: 'List the files', at: '2026-10-21T12:00:00.000Z' }]);
  assert.deepEqual(parseLine(toolNoDescription), [{ kind: 'tool', name: 'Read', description: '', at: '2026-10-21T12:00:00.000Z' }]);
});

test('parseLine drops tool results, thinking, user prompts, sidechains, other records and bad JSON', () => {
  for (const line of [toolResult, userPrompt, thinking, assistant([{ type: 'text', text: SECRET }], { isSidechain: true }),
    JSON.stringify({ type: 'system', content: SECRET }), JSON.stringify({ type: 'attachment', attachment: SECRET }), '{not json', 'null', text('   ')]) {
    assert.deepEqual(parseLine(line), [], line);
  }
});

test('parseLine never gives the input of a tool call', () => {
  const mixed = assistant([{ type: 'thinking', thinking: SECRET }, { type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: { command: SECRET, description: 'Run it' } }]);
  const out = JSON.stringify([parseLine(toolCall), parseLine(toolNoDescription), parseLine(mixed)]);
  assert.ok(!out.includes(SECRET));
  assert.deepEqual(parseLine(mixed).map((e) => e.kind), ['text', 'tool']);
});

test('parseChunk uses only complete lines', () => {
  const buffer = Buffer.from(`${text('a')}\n${text('b')}\n${text('c').slice(0, 20)}`);
  const { entries, used } = parseChunk(buffer);
  assert.deepEqual(entries.map((e) => e.text), ['a', 'b']);
  assert.equal(used, buffer.lastIndexOf(0x0a) + 1);
  const partial = parseChunk(Buffer.from(`${text('a').slice(5)}\n${text('b')}\n`), { skipFirst: true });
  assert.deepEqual(partial.entries.map((e) => e.text), ['b']);
});

const dir = () => mkdtempSync(join(tmpdir(), 'memo-output-'));

test('readOutput gives the last entries, then only the new ones after the cursor', () => {
  const d = dir();
  const lines = [];
  for (let i = 0; i < 70; i++) lines.push(text(`m${i}`), toolResult, thinking);
  writeFileSync(join(d, 's1.jsonl'), `${lines.join('\n')}\n`);
  const first = readOutput(d);
  assert.equal(first.file, 's1.jsonl');
  assert.equal(first.reset, true);
  assert.equal(first.entries.length, 50);
  assert.equal(first.entries.at(-1).text, 'm69');
  assert.ok(!JSON.stringify(first).includes(SECRET));

  assert.deepEqual(readOutput(d, first).entries, []);
  appendFileSync(join(d, 's1.jsonl'), `${toolCall}\n${toolResult}\n${text('new')}`); // the last line is not complete yet
  const second = readOutput(d, first);
  assert.equal(second.reset, false);
  assert.deepEqual(second.entries.map((e) => e.kind), ['tool']);
  appendFileSync(join(d, 's1.jsonl'), '\n');
  const third = readOutput(d, second);
  assert.deepEqual(third.entries.map((e) => e.text), ['new']);
  assert.ok(!JSON.stringify([second, third]).includes(SECRET));
});

test('readOutput goes to the newest file when a new session starts', () => {
  const d = dir();
  writeFileSync(join(d, 'old.jsonl'), `${text('old')}\n`);
  const past = new Date(Date.now() - 60000);
  utimesSync(join(d, 'old.jsonl'), past, past);
  const first = readOutput(d);
  assert.equal(first.file, 'old.jsonl');
  writeFileSync(join(d, 'new.jsonl'), `${text('fresh')}\n`);
  writeFileSync(join(d, 'notes.txt'), 'x');
  const next = readOutput(d, first);
  assert.equal(next.file, 'new.jsonl');
  assert.equal(next.reset, true);
  assert.deepEqual(next.entries.map((e) => e.text), ['fresh']);
});

test('readOutput starts again when the cursor is wrong or the file is shorter', () => {
  const d = dir();
  writeFileSync(join(d, 's.jsonl'), `${text('a')}\n`);
  for (const cursor of ['999999', '-1', 'abc']) assert.equal(readOutput(d, { file: 's.jsonl', cursor }).reset, true);
});

test('readOutput of a directory with no transcript, or no directory, gives nothing', () => {
  assert.deepEqual(readOutput(dir()), { file: null, cursor: 0, reset: true, entries: [] });
  assert.equal(newestTranscript(join(dir(), 'missing')), null);
});

test('expandHome expands only a leading ~', () => {
  assert.ok(!expandHome('~/x').startsWith('~'));
  assert.equal(expandHome('/a/~/b'), '/a/~/b');
});

test('loadConfig accepts a transcripts directory and refuses a value that is not a path', () => {
  const d = dir();
  const write = (config) => { writeFileSync(join(d, 'agents.json'), JSON.stringify(config)); return join(d, 'agents.json'); };
  assert.equal(loadConfig(write([{ name: 'main', kind: 'long', dir: '~', model: 'm', transcripts: '~/t' }]))[0].transcripts, '~/t');
  assert.throws(() => loadConfig(write([{ name: 'main', kind: 'long', dir: '~', model: 'm', transcripts: 5 }])), /transcripts/);
});

test('the output route gives the output of an agent with a transcripts directory, behind the token', async () => {
  const d = dir();
  writeFileSync(join(d, 's.jsonl'), `${text('hi')}\n${toolResult}\n${toolCall}\n`);
  const { app } = makeApp({ config: [
    { name: 'main', kind: 'long', dir: '~/p', model: 'm', transcripts: d },
    { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
  ] });
  const r = await call(app, '/api/agent/output?name=main');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.entries.map((e) => e.kind), ['text', 'tool']);
  assert.ok(!JSON.stringify(r.data).includes(SECRET));
  const again = await call(app, `/api/agent/output?name=main&file=${r.data.file}&cursor=${r.data.cursor}`);
  assert.deepEqual(again.data.entries, []);
  assert.equal(again.data.reset, false);

  const list = (await call(app, '/api/agents')).data;
  assert.equal(list.find((a) => a.name === 'main').output, true);
  assert.equal(list.find((a) => a.name === 'liaison').output, false);
  assert.deepEqual((await call(app, '/api/agent/output?name=liaison')).data.entries, []);
  assert.equal((await call(app, '/api/agent/output?name=nobody')).status, 400);
  assert.equal((await call(app, '/api/agent/output?name=main', null, null)).status, 401);
  assert.equal((await call(app, '/api/agent/output?name=main', null, LIAISON_TOKEN)).status, 403);
});
