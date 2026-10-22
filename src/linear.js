// The read-only Linear sync of the Desk. With LINEAR_API_KEY in .env, the server reads the Linear issues of the owner
// each LINEAR_SYNC_MINUTES (default 10) and puts them into the tickets table (src/tickets.js).
// Memo never writes to Linear: linearQuery refuses each document that contains the word "mutation", so a mistake
// in this file cannot change an issue. An agent proposes a Linear change to the owner in a memo with the tag linear-draft.
export const LINEAR_URL = 'https://api.linear.app/graphql';
export const DEFAULT_MINUTES = 10;
// The sync also brings the closed issues of the owner that changed in this time, so a ticket shows its last state.
export const RECENT_DAYS = 7;
const MAX_PAGES = 5;
const TIMEOUT_MS = 30000;

export class LinearError extends Error {}

// Sends one GraphQL query to Linear and gives its data. It refuses a mutation and a subscription before a request.
export async function linearQuery({ apiKey, fetch = globalThis.fetch }, document, variables = {}) {
  if (typeof document !== 'string' || !document.trim()) throw new LinearError('The query is empty.');
  if (/mutation|subscription/i.test(document)) throw new LinearError('Memo only reads from Linear. A document that contains "mutation" or "subscription" is refused.');
  if (!/^\s*(query\b|\{)/.test(document.replace(/^\s*#.*$/gm, ''))) throw new LinearError('The document must be a query.');
  if (!apiKey) throw new LinearError('LINEAR_API_KEY is not set.');
  let r;
  try {
    r = await fetch(LINEAR_URL, {
      method: 'POST',
      // A personal API key of Linear goes in the header with no "Bearer".
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new LinearError(`Linear did not answer: ${e?.name || 'error'}.`);
  }
  const body = await r.json().catch(() => null);
  // The error text of Linear never contains the key. The message stays short for the Desk page.
  if (!r.ok || !body || body.errors?.length) {
    const why = body?.errors?.map((e) => e?.message).filter(Boolean).join('; ').slice(0, 200) || `status ${r.status}`;
    throw new LinearError(`Linear refused the query: ${why}`);
  }
  return body.data;
}

// The issues assigned to the owner of the key (the viewer): the open ones, and the closed ones that changed in the
// last RECENT_DAYS days.
export const ISSUES_QUERY = `query DeskIssues($since: DateTimeOrDuration!, $after: String) {
  viewer {
    assignedIssues(first: 100, after: $after, filter: { or: [
      { state: { type: { nin: ["completed", "canceled"] } } },
      { updatedAt: { gte: $since } }
    ] }) {
      nodes { identifier title url priority updatedAt state { name type } team { key } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// One Linear issue as the fields of a ticket.
export const toTicket = (n) => ({
  key: n.identifier, title: n.title, url: n.url, priority: n.priority, updated_at: n.updatedAt,
  linear_state: n.state?.name ?? null, linear_type: n.state?.type ?? null, team: n.team?.key ?? null, assignee_is_owner: true,
});

export async function fetchIssues({ apiKey, fetch, now = () => new Date() }) {
  const since = new Date(now().getTime() - RECENT_DAYS * 86400000).toISOString();
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linearQuery({ apiKey, fetch }, ISSUES_QUERY, { since, after });
    const conn = data?.viewer?.assignedIssues;
    if (!conn || !Array.isArray(conn.nodes)) throw new LinearError('Linear gave an answer in an unknown form.');
    out.push(...conn.nodes.map(toTicket));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// The sync. Without a key it does nothing, and the Desk works with the tickets that the agents add.
// minutes: from LINEAR_SYNC_MINUTES. status(): for the Desk page; it never contains the key.
export function createLinearSync({ tickets, apiKey, fetch = globalThis.fetch, minutes = DEFAULT_MINUTES, now = () => new Date(), log = console.error }) {
  const state = { on: !!apiKey, minutes, last: null, ok: null, count: 0, error: null };
  let timer = null;
  let running = null;

  async function runOnce() {
    if (!apiKey) return status();
    if (running) return running;
    running = (async () => {
      const at = now().toISOString();
      try {
        const issues = await fetchIssues({ apiKey, fetch, now });
        let n = 0;
        for (const issue of issues) {
          try { tickets.upsertLinear(issue, at); n++; } catch { /* an issue with a key that is not valid: skip it */ }
        }
        Object.assign(state, { last: at, ok: true, count: n, error: null });
      } catch (e) {
        Object.assign(state, { last: at, ok: false, error: String(e?.message || e).replaceAll(apiKey, '[key]') });
        log(`Linear sync: ${state.error}`);
      } finally { running = null; }
      return status();
    })();
    return running;
  }

  function start() {
    if (!apiKey || timer) return;
    runOnce();
    timer = setInterval(runOnce, Math.max(1, minutes) * 60000);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  const status = () => ({ ...state });

  return { runOnce, start, stop, status };
}
