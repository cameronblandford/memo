// The loads of the Chat page can overlap: the refresh, a send, a new agent, "Show older". Only the answer of the
// newest request counts, and only for the agent that is selected now. This file has no DOM code, so a test can import it.
export function createLoads() {
  let last = 0;
  return {
    // agent: the selected agent when the request goes out ('' when none is selected yet).
    start: (agent) => ({ n: ++last, agent }),
    // True if the answer can show. agent: the selected agent now. answered: the agent of the answer. With no
    // selected agent, the answer of the server (its default agent) can show; else it must be the selected agent.
    fresh: (ticket, agent, answered) => ticket.n === last && ticket.agent === agent && (agent === '' || answered === agent),
  };
}

// The state of a memo in words, for the Inbox, the Chat page, and the Desk. A memo is a thread: an open memo waits for
// its recipient, and a memo that the owner sent back ('waiting') waits for its sender. owner: the name of the owner.
export function stateText(memo, owner) {
  if (memo.state === 'open') return memo.recipient === owner ? 'waits for you' : `waits for ${memo.recipient}`;
  if (memo.state === 'waiting') return memo.sender === owner ? 'waits for you' : `waits for ${memo.sender}`;
  return memo.state === 'replied' ? 'answered' : 'closed';
}

// The time of the newest turn of the thread (a note), or the send time when the memo has no notes.
export const lastTurnAt = (memo) => (memo.notes?.length ? memo.notes.at(-1).created : memo.created);
