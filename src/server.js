import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createStore } from './memos.js';
import { createAgents, loadConfig, realTmux } from './agents.js';
import { createApp } from './app.js';
import { createImages } from './images.js';
import { createTicks } from './ticks.js';
import { localFile } from './paths.js';
import { createTickets } from './tickets.js';
import { createLinearSync, DEFAULT_MINUTES } from './linear.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MEMO_TOKEN: token, MEMO_LIAISON_TOKEN: liaisonToken, MEMO_OWNER_TOKEN: ownerToken } = process.env;
if (!token || token.length < 16) {
  console.error('MEMO_TOKEN is not set or has fewer than 16 characters. See .env.example.');
  process.exit(1);
}
if (liaisonToken && (liaisonToken.length < 16 || liaisonToken === token)) {
  console.error('MEMO_LIAISON_TOKEN must have 16 characters or more and must be different from MEMO_TOKEN.');
  process.exit(1);
}
if (ownerToken && (ownerToken.length < 16 || ownerToken === token || ownerToken === liaisonToken)) {
  console.error('MEMO_OWNER_TOKEN must have 16 characters or more and must be different from MEMO_TOKEN and MEMO_LIAISON_TOKEN.');
  process.exit(1);
}

// The name of the person who owns the queue. Agents send memos to this name.
const owner = process.env.MEMO_OWNER || 'owner';
if (!/^[a-z][a-z0-9-]*$/.test(owner)) {
  console.error('MEMO_OWNER must have only a-z, 0-9 and "-", and must start with a letter.');
  process.exit(1);
}
const config = loadConfig(localFile(root, 'agents.json'), owner);
const dbPath = resolve(root, process.env.DATABASE_PATH || './data/memo.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const tickets = createTickets(db, { owner, agents: config.map((a) => a.name) });
const store = createStore(db, {
  owner,
  ensureTicket: tickets.ensure,
  names: [owner, 'discord', ...config.map((a) => a.name)],
  forwardTo: config.filter((a) => a.kind !== 'short').map((a) => a.name),
  // A postponed memo comes back at 9:00 in this zone.
  timeZone: process.env.MEMO_TZ || 'America/New_York',
});
const agents = createAgents({ db, config, root, owner, tmux: realTmux(), counts: store.counts });
const images = createImages(join(dirname(dbPath), 'images'));
// The day of the ticks starts at MEMO_DAY_START (an hour, default 3) in the time zone MEMO_TZ (default: that of this computer).
const ticks = createTicks(db, { dayStart: Number(process.env.MEMO_DAY_START ?? 3), timeZone: process.env.MEMO_TZ || undefined });
const hostname = process.env.HOST || '127.0.0.1';
// Optional: the owner needs no token through Tailscale Serve. See README.md.
const { MEMO_TAILSCALE_LOGIN: login, MEMO_TAILSCALE_HOST: tailscaleHost } = process.env;
if (!login !== !tailscaleHost) {
  console.error('Set MEMO_TAILSCALE_LOGIN and MEMO_TAILSCALE_HOST together, or set none of the two.');
  process.exit(1);
}
// A request from a different computer could contain the Tailscale header, so only Tailscale Serve on this computer can be the source.
if (login && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
  console.error('MEMO_TAILSCALE_LOGIN needs HOST=127.0.0.1. With a different HOST, a computer on the network can pretend to be Tailscale.');
  process.exit(1);
}
const tailscale = login ? { login, host: tailscaleHost } : undefined;
const ticksOn = ['1', 'true', 'on', 'yes'].includes(String(process.env.MEMO_TICKS || '').toLowerCase());
// Optional: the read-only Linear sync of the Desk. Without the key, the Desk has only the tickets that the agents add.
const linearMinutes = Number(process.env.LINEAR_SYNC_MINUTES || DEFAULT_MINUTES);
if (!(linearMinutes >= 1)) {
  console.error('LINEAR_SYNC_MINUTES must be a number of minutes, 1 or more.');
  process.exit(1);
}
const linear = createLinearSync({ tickets, apiKey: process.env.LINEAR_API_KEY || '', minutes: linearMinutes });
const app = createApp({ store, agents, images, ticks, tickets, linear, ticksOn, root, token, liaisonToken, ownerToken, owner, tailscale });

const port = Number(process.env.PORT || 3280);
serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`Memo listens on http://${hostname}:${port}`);
  agents.resume();
  linear.start();
});
