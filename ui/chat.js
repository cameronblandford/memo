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
