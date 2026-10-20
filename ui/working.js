// The work sign in the corner of the Inbox: for each agent with work from the owner, "working" or "queued".
// This file has no DOM code, so a test can import it.

// The state of one agent, from the fields of /api/queue (agents) or /api/agents. Gives null when no work of the
// owner waits for the agent. The agent sets its status line before each memo. Thus a status that is newer than
// the oldest waiting memo or note tells that the agent started the work. A status "Waiting ..." tells that the
// agent waits for new memos, so the work did not start.
export function workState(agent) {
  if (!agent?.owner_open || !agent.owner_since) return null;
  const since = Date.parse(agent.owner_since);
  const updated = agent.updated ? Date.parse(agent.updated) : NaN;
  const status = (agent.status || '').trim();
  const started = updated >= since && !/^waiting\b/i.test(status);
  return started
    ? { name: agent.name, state: 'working', status, count: agent.owner_open }
    : { name: agent.name, state: 'queued', status, count: agent.owner_open };
}

// The signs for a list of agents, in the order of the list. An agent with no work gets no sign.
export const workSigns = (agents) => (agents || []).map(workState).filter(Boolean);

// The text of a sign, for example "main · working: I update the README." or "main · queued (2)".
export function signText(sign) {
  if (sign.state === 'working') return sign.status ? `${sign.name} · working: ${sign.status}` : `${sign.name} · working`;
  return `${sign.name} · queued (${sign.count})`;
}
