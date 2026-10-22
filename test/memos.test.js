import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createStore, MemoError } from '../src/memos.js';

const NAMES = ['cam', 'discord', 'main', 'liaison'];
function makeStore() {
  let t = Date.parse('2026-10-09T12:00:00Z');
  return createStore(openDb(), { owner: 'cam', names: NAMES, forwardTo: ['main'], now: () => new Date((t += 1000)) });
}
const toCam = { from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 4, effort: 'micro' };
const refuses = (fn, status, part) =>
  assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));

test('send to cam stores an open memo with its impact and effort', () => {
  const s = makeStore();
  const { memo, corrections } = s.send(toCam);
  assert.equal(memo.id, 1);
  assert.equal(memo.state, 'open');
  assert.equal(memo.sender, 'main');
  assert.equal(memo.recipient, 'cam');
  assert.equal(memo.impact, 4);
  assert.equal(memo.effort, 'micro');
  assert.equal(memo.acked, 0);
  assert.deepEqual(corrections, []);
});

test('a memo to cam needs a correct impact and effort', () => {
  const s = makeStore();
  refuses(() => s.send({ ...toCam, impact: undefined }), 400, 'impact');
  refuses(() => s.send({ ...toCam, impact: 6 }), 400, 'impact');
  refuses(() => s.send({ ...toCam, impact: '4' }), 400, 'impact');
  refuses(() => s.send({ ...toCam, impact: 2.5 }), 400, 'impact');
  refuses(() => s.send({ ...toCam, effort: undefined }), 400, 'effort');
  refuses(() => s.send({ ...toCam, effort: 'deep' }), 400, 'effort');
});

test('a memo to an agent needs no impact and keeps none', () => {
  const s = makeStore();
  const { memo } = s.send({ from: 'cam', to: 'main', text: 'Update the README.', impact: 5, effort: 'day' });
  assert.equal(memo.impact, null);
  assert.equal(memo.effort, null);
});

test('the sender and the recipient must be known names', () => {
  const s = makeStore();
  refuses(() => s.send({ ...toCam, from: 'nobody' }), 400, 'from');
  refuses(() => s.send({ ...toCam, to: 'nobody' }), 400, 'to');
  refuses(() => s.send({ from: 'cam', to: 'discord', text: 'x' }), 400, 'to');
  refuses(() => s.send(), 400, 'from');
});

test('the text must be present, must be text, and has a limit', () => {
  const s = makeStore();
  refuses(() => s.send({ ...toCam, text: '' }), 400, 'text');
  refuses(() => s.send({ ...toCam, text: undefined }), 400, 'text');
  refuses(() => s.send({ ...toCam, text: 42 }), 400, 'text');
  refuses(() => s.send({ ...toCam, text: 'x'.repeat(20001) }), 400, '20000');
  assert.equal(s.send({ ...toCam, text: 'x'.repeat(20000) }).memo.text.length, 20000);
});

test('the due date must be a real date', () => {
  const s = makeStore();
  for (const due of ['tomorrow', '2026-13-45', '2026-02-30', '10/15/2026', 20261015]) {
    refuses(() => s.send({ ...toCam, due }), 400, 'due');
  }
  assert.equal(s.send({ ...toCam, due: '2026-10-15' }).memo.due, '2026-10-15');
  assert.equal(s.send({ ...toCam, due: '' }).memo.due, null);
});

test('reply sets the reply and the state, one time only', () => {
  const s = makeStore();
  s.send(toCam);
  const c = s.reply(1, 'Yes.');
  assert.equal(c.state, 'replied');
  assert.equal(c.reply, 'Yes.');
  assert.ok(c.closed);
  refuses(() => s.reply(1, 'Again.'), 409, 'replied');
  refuses(() => s.close(1), 409, 'replied');
});

test('reply needs text and a known memo', () => {
  const s = makeStore();
  s.send(toCam);
  refuses(() => s.reply(1, ''), 400, 'text');
  refuses(() => s.reply(99, 'x'), 404, '99');
  refuses(() => s.reply('abc', 'x'), 404, 'abc');
});

test('close works with and without a text', () => {
  const s = makeStore();
  s.send(toCam);
  s.send(toCam);
  assert.equal(s.close(1).reply, null);
  assert.equal(s.close(1 + 1, 'Done by hand.').reply, 'Done by hand.');
  assert.equal(s.get(1).state, 'closed');
  refuses(() => s.adjust(1, 1), 409, 'closed');
});

test('adjust changes the impact and records a correction', () => {
  const s = makeStore();
  s.send(toCam);
  assert.equal(s.adjust(1, 1).impact, 5);
  assert.equal(s.adjust(1, 1).impact, 5); // the limit is 5: no change and no new correction
  assert.equal(s.adjust(1, -1).impact, 4);
  const rows = s.corrections('main');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].old_impact, rows[0].new_impact], [5, 4]); // the newest is first
  assert.deepEqual([rows[1].old_impact, rows[1].new_impact], [4, 5]);
  assert.equal(rows[0].text, 'Approve the deploy?');
});

test('adjust refuses a wrong delta and a memo to an agent', () => {
  const s = makeStore();
  s.send(toCam);
  s.send({ from: 'cam', to: 'main', text: 'Work.' });
  refuses(() => s.adjust(1, 2), 400, 'delta');
  refuses(() => s.adjust(1, '1'), 400, 'delta');
  refuses(() => s.adjust(2, 1), 400, 'impact');
});

test('send to cam returns the last 5 corrections of that sender', () => {
  const s = makeStore();
  for (let i = 0; i < 7; i++) s.adjust(s.send({ ...toCam, impact: 3 }).memo.id, -1);
  s.adjust(s.send({ ...toCam, from: 'liaison', impact: 3 }).memo.id, 1);
  const { corrections } = s.send(toCam);
  assert.equal(corrections.length, 5);
  assert.ok(corrections.every((k) => k.new_impact === 2));
  assert.equal(corrections[0].memo_id, 7);
});

test('list gives cam the queue order and gives an agent the order of age', () => {
  const s = makeStore();
  s.send({ ...toCam, impact: 1 });
  s.send({ ...toCam, impact: 5 });
  s.send({ from: 'cam', to: 'main', text: 'First.' });
  s.send({ from: 'cam', to: 'main', text: 'Second.' });
  s.close(3);
  assert.deepEqual(s.list('cam').map((c) => c.id), [2, 1]);
  assert.deepEqual(s.list('main').map((c) => c.id), [4]);
  refuses(() => s.list('nobody'), 400, 'to');
});

test('news shows open memos and results until the sender acks them', () => {
  const s = makeStore();
  s.send(toCam);
  s.send({ from: 'cam', to: 'main', text: 'Work.' });
  assert.deepEqual(s.news('main').to_you.map((c) => c.id), [2]);
  assert.deepEqual(s.news('main').results, []);
  refuses(() => s.ack(1), 409, 'open');
  s.reply(1, 'Yes.');
  assert.deepEqual(s.news('main').results.map((c) => c.id), [1]);
  assert.equal(s.ack(1).acked, 1);
  assert.deepEqual(s.news('main').results, []);
});

test('counts gives the open memos to and from a name', () => {
  const s = makeStore();
  s.send(toCam);
  s.send(toCam);
  s.send({ from: 'cam', to: 'main', text: 'Work.' });
  s.reply(1, 'Yes.');
  assert.deepEqual(s.counts('main'), { open_to: 1, open_from: 1, owner_open: 1, owner_since: s.get(3).created });
});

test('counts gives the work of the owner that waits for an agent: open memos and unread notes', () => {
  const s = makeStore();
  assert.deepEqual(s.counts('main'), { open_to: 0, open_from: 0, owner_open: 0, owner_since: null });
  s.send(toCam); // 1: from main to cam
  s.send({ from: 'cam', to: 'main', text: 'Work.' }); // 2
  s.send({ from: 'cam', to: 'main', text: 'More work.' }); // 3
  assert.deepEqual([s.counts('main').owner_open, s.counts('main').owner_since], [2, s.get(2).created]);
  // A note of the owner on a memo from main counts too, until main reads it.
  s.note(1, 'cam', 'Use the other file.');
  assert.equal(s.counts('main').owner_open, 3);
  s.reply(2, 'Done.');
  s.reply(3, 'Done.');
  const note = s.get(1).notes[0];
  assert.deepEqual([s.counts('main').owner_open, s.counts('main').owner_since], [1, note.created]);
  s.news('main');
  s.note(1, 'main', 'I use it.');
  assert.deepEqual([s.counts('main').owner_open, s.counts('main').owner_since], [0, null]);
  // A memo from a different sender does not count for main.
  s.send({ from: 'cam', to: 'liaison', text: 'Look.' });
  assert.equal(s.counts('main').owner_open, 0);
});

test('forward copies a trusted Discord memo to an agent as a memo from cam', () => {
  const s = makeStore();
  s.send({ from: 'discord', to: 'liaison', text: 'Discord, Cam (the owner): add a page', trusted: true });
  const { memo } = s.forward(1, 'main');
  assert.equal(memo.sender, 'cam');
  assert.equal(memo.recipient, 'main');
  assert.equal(memo.text, 'Discord, Cam (the owner): add a page');
  assert.equal(s.get(1).state, 'open'); // the liaison closes its own memo
});

test('forward refuses a memo that is not a trusted Discord memo', () => {
  const s = makeStore();
  s.send({ from: 'discord', to: 'liaison', text: 'From another person.' });
  s.send({ from: 'cam', to: 'liaison', text: 'Not from Discord.', trusted: true });
  s.send({ from: 'discord', to: 'liaison', text: 'Trusted.', trusted: true });
  refuses(() => s.forward(1, 'main'), 403, 'Discord');
  refuses(() => s.forward(2, 'main'), 403, 'Discord');
  refuses(() => s.forward(3, 'cam'), 400, 'to');
  refuses(() => s.forward(3, 'discord'), 400, 'to');
  refuses(() => s.forward(3, 'liaison'), 400, 'to'); // not a long agent
});

test('forward works one time only for each memo', () => {
  const s = makeStore();
  s.send({ from: 'discord', to: 'liaison', text: 'Discord, Cam (the owner): add a page', trusted: true });
  s.forward(1, 'main');
  refuses(() => s.forward(1, 'main'), 409, 'already');
  assert.equal(s.list('main').length, 1);
});

test('edit changes the text of an open memo and nothing more', () => {
  const s = makeStore();
  s.send({ ...toCam, due: '2026-10-15' });
  s.adjust(1, -1);
  const c = s.edit(1, '**Approve the deploy?**');
  assert.equal(c.text, '**Approve the deploy?**');
  assert.deepEqual([c.state, c.impact, c.effort, c.due, c.sender], ['open', 3, 'micro', '2026-10-15', 'main']);
});

test('edit marks the notes of the owner as read, so that the sender does not get the same note again', () => {
  const s = makeStore();
  const { id } = s.send(toCam).memo;
  s.note(id, 'cam', 'Add the price, please.');
  assert.deepEqual(s.news('main').noted.map((c) => c.id), [id]);
  const c = s.edit(id, 'Approve the deploy? The price is $14.');
  assert.equal(c.notes[0].read, 1);
  assert.deepEqual(s.news('main').noted, []);
  assert.equal(c.state, 'open');
});

test('edit refuses a closed memo, an empty text, and an unknown memo', () => {
  const s = makeStore();
  s.send(toCam);
  refuses(() => s.edit(1, ''), 400, 'text');
  refuses(() => s.edit(9, 'x'), 404, '9');
  s.reply(1, 'Yes.');
  refuses(() => s.edit(1, 'x'), 409, 'replied');
});

test('a memo to the owner is new, then seen, and an edit after that makes it updated', () => {
  const s = makeStore();
  s.send({ from: 'main', to: 'cam', text: 'Approve the deploy?', impact: 3, effort: 'micro' });
  s.send({ from: 'main', to: 'cam', text: 'A second question.', impact: 2, effort: 'micro' });
  assert.equal(s.get(1).seen, 0);
  s.edit(1, 'Approve the deploy today?');
  assert.equal(s.get(1).seen, 0, 'an edit of a memo that the owner did not see keeps it new');
  assert.deepEqual(s.seen([1]), { seen: 1 });
  assert.equal(s.get(1).seen, 1);
  assert.equal(s.get(2).seen, 0, 'only the memo in the list changes');
  assert.deepEqual(s.seen([1]), { seen: 0 }, 'a second call changes nothing');
  s.edit(1, 'Approve the deploy tomorrow?');
  assert.equal(s.get(1).seen, 2);
  s.seen([1, 2]);
  assert.deepEqual([s.get(1).seen, s.get(2).seen], [1, 1]);
});

test('seen changes only memos to the owner and refuses a bad list', () => {
  const s = makeStore();
  s.send({ from: 'cam', to: 'main', text: 'Update the README.' });
  assert.deepEqual(s.seen([1, 99]), { seen: 0 });
  assert.equal(s.get(1).seen, 0);
  refuses(() => s.seen([]), 400, 'ids');
  refuses(() => s.seen('1'), 400, 'ids');
  refuses(() => s.seen([1.5]), 400, 'ids');
});

test('check changes one check box of a memo to the owner and keeps the memo seen', () => {
  const s = makeStore();
  s.send({ from: 'main', to: 'cam', text: 'Pack:\n- [ ] Rain jacket\n- [ ] Charger', impact: 3, effort: 'short' });
  s.seen([1]);
  assert.equal(s.check(1, 1, true).text, 'Pack:\n- [ ] Rain jacket\n- [x] Charger');
  assert.equal(s.get(1).seen, 1, 'a check box is not an update of the memo');
  assert.equal(s.check(1, 1, false).text, 'Pack:\n- [ ] Rain jacket\n- [ ] Charger');
  refuses(() => s.check(1, 2, true), 404, 'check box 2');
  refuses(() => s.check(1, '0', true), 400, 'whole number');
  refuses(() => s.check(1, 0, 'yes'), 400, 'true or false');
  s.send({ from: 'cam', to: 'main', text: '- [ ] a task for the agent' });
  refuses(() => s.check(2, 0, true), 400, 'Only a memo to cam');
  s.close(1);
  refuses(() => s.check(1, 0, true), 409, '');
});

// Threads: a note is one turn in a memo to the owner. A note of the owner (Send) gives the turn to the sender, and the
// answer of the sender gives it back. The memo keeps its id.
function withMemo() {
  const s = createStore(openDb(), { names: ['cam', 'discord', 'main', 'liaison'], owner: 'cam' });
  const { memo } = s.send({ from: 'main', to: 'cam', text: 'Approve the plan?', impact: 3, effort: 'short' });
  return { s, id: memo.id };
}
const refusesNote = (fn, status, part) => assert.throws(fn, (e) => e instanceof MemoError && e.status === status && e.message.includes(part));

test('Send: a note of the owner keeps the memo, takes it out of the Inbox, and gives it back to the sender', () => {
  const { s, id } = withMemo();
  const m = s.note(id, 'cam', 'Add the price, please.');
  assert.equal(m.state, 'waiting');
  assert.equal(m.seen, 1, 'the owner wrote the turn, so the owner saw the memo');
  assert.deepEqual(m.notes.map((n) => [n.author, n.text, n.read]), [['cam', 'Add the price, please.', 0]]);
  assert.deepEqual(s.list('cam'), [], 'a memo that waits for its sender is not in the Inbox');
  assert.deepEqual(s.waiting().map((c) => c.id), [id]);
  assert.deepEqual(s.counts('main').owner_open, 1, 'the work sign of main counts it');
  const news = s.news('main');
  assert.deepEqual(news.noted.map((c) => c.id), [id]);
  assert.deepEqual(news.waiting.map((c) => c.id), [id]);
  assert.deepEqual(news.results, [], 'a memo that waits is not a result');
});

test('the answer of the sender gives the memo back to the owner as updated, with the same id', () => {
  const { s, id } = withMemo();
  s.seen([id]);
  s.note(id, 'cam', 'Add the price, please.');
  s.news('main');
  const m = s.note(id, 'main', 'The price is $14.');
  assert.deepEqual([m.id, m.state, m.seen], [id, 'open', 2]);
  assert.deepEqual(s.list('cam').map((c) => c.id), [id]);
  assert.deepEqual(s.waiting(), []);
  assert.deepEqual(m.notes.map((n) => [n.author, n.text]), [['cam', 'Add the price, please.'], ['main', 'The price is $14.']]);
  assert.equal(s.counts('main').owner_open, 0);
  // A second Send and a second answer: the same memo again.
  s.note(id, 'cam', 'Monthly or yearly?');
  assert.equal(s.get(id).state, 'waiting');
  s.news('main');
  assert.equal(s.edit(id, 'Approve the plan? $14 each month.').state, 'open', 'an edit of the sender is an answer too');
  assert.equal(s.send({ from: 'main', to: 'cam', text: 'x', impact: 1, effort: 'micro' }).memo.id, id + 1, 'no new memo for the thread');
});

test('Done closes the memo, also while it waits for the sender; the sender gets the full thread as a result', () => {
  const { s, id } = withMemo();
  s.note(id, 'cam', 'Add the price, please.');
  s.news('main');
  const m = s.close(id, 'No need, I found it.');
  assert.deepEqual([m.state, m.reply], ['closed', 'No need, I found it.']);
  const news = s.news('main');
  assert.deepEqual(news.results.map((c) => c.id), [id]);
  assert.equal(news.results[0].notes.length, 1);
  assert.deepEqual([news.noted, news.waiting], [[], []]);
  s.ack(id);
  assert.deepEqual(s.news('main').results, []);
  refusesNote(() => s.note(id, 'cam', 'x'), 409, 'closed');
});

test('memo wait gives each turn of the owner one time', () => {
  const { s, id } = withMemo();
  s.note(id, 'cam', 'First turn.');
  assert.deepEqual(s.news('main', { peek: true }).noted.map((c) => c.id), [id], 'a peek is not a delivery');
  assert.deepEqual(s.news('main').noted.map((c) => c.id), [id]);
  assert.deepEqual(s.news('main').noted, [], 'the same turn does not come again');
  assert.deepEqual(s.news('main').waiting.map((c) => c.id), [id], 'memo list still shows it');
  s.note(id, 'cam', 'Second turn, while the memo waits.');
  const again = s.news('main').noted;
  assert.deepEqual(again.map((c) => c.id), [id]);
  assert.deepEqual(again[0].notes.map((n) => n.text), ['First turn.', 'Second turn, while the memo waits.'], 'the full thread, in order');
  assert.deepEqual(s.news('main').noted, []);
  s.note(id, 'main', 'Both done.');
  s.note(id, 'cam', 'Third turn.');
  assert.deepEqual(s.news('main').noted[0].notes.map((n) => n.author), ['cam', 'cam', 'main', 'cam']);
  assert.deepEqual(s.news('main').noted, []);
});

test('ack refuses a memo that waits for an answer', () => {
  const { s, id } = withMemo();
  refusesNote(() => s.ack(id), 409, 'open');
  s.note(id, 'cam', 'Add the price.');
  s.news('main');
  refusesNote(() => s.ack(id), 409, 'waits for your answer');
  assert.equal(s.get(id).state, 'waiting');
});

test('an answer of the sender marks the note as read and shows the memo as updated', () => {
  const { s, id } = withMemo();
  s.seen([id]);
  s.note(id, 'cam', 'Add the price, please.');
  assert.equal(s.get(id).seen, 1, 'a note of the owner does not make the memo new for the owner');
  s.news('main');
  const m = s.note(id, 'main', 'The price is $14.');
  assert.deepEqual(m.notes.map((n) => [n.author, n.read]), [['cam', 1], ['main', 0]]);
  assert.equal(m.seen, 2);
  assert.deepEqual(s.news('main').noted, []);
  assert.equal(s.note(id, 'cam', 'Thanks.').notes[1].read, 1);
});

test('a note of the owner from before threads (on an open memo) still goes to the sender, and ack marks it read', () => {
  const db = openDb();
  const s = createStore(db, { names: ['cam', 'discord', 'main', 'liaison'], owner: 'cam' });
  const { id } = s.send({ from: 'main', to: 'cam', text: 'Old memo', impact: 3, effort: 'short' }).memo;
  db.prepare("INSERT INTO notes (memo_id, author, text, created) VALUES (?, 'cam', 'I read this later.', '2026-10-01T00:00:00Z')").run(id);
  assert.deepEqual(s.news('main').noted.map((c) => c.id), [id]);
  assert.equal(s.ack(id).notes[0].read, 1);
  assert.deepEqual(s.news('main').noted, []);
  assert.equal(s.get(id).state, 'open');
});

// A note of the owner is read only when the sender got it from memo wait or memo list. A note that came
// after the last delivery stays unread, so the next memo wait gives it.
test('a note, an edit, or an ack of the sender marks only the notes of the owner that the sender got', () => {
  const { s, id } = withMemo();
  s.note(id, 'cam', 'First question.');
  s.news('main'); // main gets the first note
  s.note(id, 'cam', 'Second question.'); // main has not got this one
  let m = s.note(id, 'main', 'Answer to the first.');
  assert.deepEqual(m.notes.map((n) => [n.text, n.read]), [['First question.', 1], ['Second question.', 0], ['Answer to the first.', 0]]);
  assert.deepEqual(s.news('main').noted.map((c) => c.id), [id], 'the second note comes in the next memo wait');
  s.note(id, 'cam', 'Third question.');
  m = s.edit(id, 'Approve the plan? (changed for the second note)');
  assert.deepEqual(m.notes.filter((n) => n.author === 'cam').map((n) => n.read), [1, 1, 0]);
  refusesNote(() => s.ack(id), 409, 'did not get');
  assert.equal(s.get(id).notes.at(-1).read, 0);
  s.news('main');
  assert.equal(s.ack(id).notes.every((n) => n.author !== 'cam' || n.read), true);
});

test('a note of the owner marks all notes of the sender as read: the Inbox shows all of them', () => {
  const { s, id } = withMemo();
  s.note(id, 'cam', 'A question.');
  s.news('main');
  s.note(id, 'main', 'One.');
  s.note(id, 'main', 'Two.');
  const m = s.note(id, 'cam', 'Thanks.');
  assert.deepEqual(m.notes.filter((n) => n.author === 'main').map((n) => n.read), [1, 1]);
});

test('a note from before the event log counts as got when the memo has a delivery', () => {
  const db = openDb();
  const s = createStore(db, { names: ['cam', 'discord', 'main', 'liaison'], owner: 'cam' });
  const { memo } = s.send({ from: 'main', to: 'cam', text: 'Old memo', impact: 3, effort: 'short' });
  db.prepare("INSERT INTO notes (memo_id, author, text, created) VALUES (?, 'cam', 'old note', '2026-01-01T00:00:00Z')").run(memo.id);
  refusesNote(() => s.ack(memo.id), 409, 'did not get');
  s.news('main');
  s.note(memo.id, 'cam', 'New note.'); // after the delivery
  assert.deepEqual(s.note(memo.id, 'main', 'Answer.').notes.map((n) => [n.text, n.read]), [['old note', 1], ['New note.', 0], ['Answer.', 0]]);
});

test('note refuses a wrong party, a closed memo, a memo to an agent, and a text that is too long', () => {
  const { s, id } = withMemo();
  refusesNote(() => s.note(id, 'liaison', 'x'), 403, 'Only cam and main');
  refusesNote(() => s.note(id, 'cam', ''), 400, 'text');
  refusesNote(() => s.note(id, 'cam', 'x'.repeat(4001)), 400, '4000');
  const toAgent = s.send({ from: 'cam', to: 'main', text: 'Do it.' }).memo;
  refusesNote(() => s.note(toAgent.id, 'cam', 'x'), 400, 'Only a memo to cam');
  s.reply(id, 'Yes.');
  refusesNote(() => s.note(id, 'cam', 'x'), 409, 'replied');
});

test('a memo with no notes has no notes field', () => {
  const { s, id } = withMemo();
  assert.equal('notes' in s.get(id), false);
});

test('a memo can have a brief: a title and a next step, each one line', () => {
  const s = makeStore();
  const { memo } = s.send({ ...toCam, title: '  Deploy of PR 12 ', next: 'Reply deploy' });
  assert.equal(memo.title, 'Deploy of PR 12');
  assert.equal(memo.next, 'Reply deploy');
  const plain = s.send(toCam).memo;
  assert.equal(plain.title, null);
  assert.equal(plain.next, null);
  refuses(() => s.send({ ...toCam, title: 'two\nlines' }), 400, 'one line');
  refuses(() => s.send({ ...toCam, title: 'x'.repeat(61) }), 400, '60 characters');
  refuses(() => s.send({ ...toCam, next: 'x'.repeat(101) }), 400, '100 characters');
  refuses(() => s.send({ ...toCam, next: 5 }), 400, 'must be text');
});

test('memo brief changes one part, keeps the other, and does not mark the memo updated', () => {
  const s = makeStore();
  const { memo } = s.send({ ...toCam, title: 'Deploy', next: 'Reply deploy' });
  s.seen([memo.id]);
  let m = s.brief(memo.id, { next: 'Reply wait' });
  assert.equal(m.title, 'Deploy');
  assert.equal(m.next, 'Reply wait');
  assert.equal(m.seen, 1);
  m = s.brief(memo.id, { title: '' });
  assert.equal(m.title, null);
  assert.equal(m.next, 'Reply wait');
  refuses(() => s.brief(memo.id, {}), 400, 'title, next');
  s.close(memo.id);
  refuses(() => s.brief(memo.id, { title: 'Late' }), 409, 'closed');
});

test('choices: a memo to cam keeps the answer buttons of the sender in their order', () => {
  const s = makeStore();
  assert.deepEqual(s.send(toCam).memo.choices, [], 'a memo with no choices has an empty list');
  assert.deepEqual(s.send({ ...toCam, choices: ' push , draft,skip,push,' }).memo.choices, ['push', 'draft', 'skip']);
  assert.deepEqual(s.send({ ...toCam, choices: ['send it', 'wait'] }).memo.choices, ['send it', 'wait']);
  refuses(() => s.send({ ...toCam, choices: ['a,b'] }), 400, 'no comma');
  refuses(() => s.send({ ...toCam, choices: ['x'.repeat(25)] }), 400, '24 characters');
  refuses(() => s.send({ ...toCam, choices: 'a,b,c,d,e,f,g' }), 400, '6 choices');
  refuses(() => s.send({ ...toCam, choices: 5 }), 400, 'choices');
  refuses(() => s.send({ from: 'cam', to: 'main', text: 'x', choices: 'yes,no' }), 400, 'Only a memo to cam');
  assert.equal(s.list('cam').length, 3, 'a refused send stores nothing');
});

test('an old database gets the choices column, and its memos get no buttons', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'memo-db-')), 'memo.db');
  const db = openDb(file);
  db.exec('ALTER TABLE memos DROP COLUMN choices');
  db.prepare("INSERT INTO memos (sender, recipient, text, created) VALUES ('main', 'cam', 'old', '2026-10-01T00:00:00Z')").run();
  db.close();
  const s = createStore(openDb(file), { owner: 'cam', names: NAMES });
  assert.deepEqual(s.get(1).choices, []);
});
