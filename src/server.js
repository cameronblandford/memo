import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createStore } from './memos.js';
import { createAgents, loadConfig, realTmux } from './agents.js';
import { createApp } from './app.js';
import { createImages } from './images.js';
import { localFile } from './paths.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MEMO_TOKEN: token, MEMO_LIAISON_TOKEN: liaisonToken } = process.env;
if (!token || token.length < 16) {
  console.error('MEMO_TOKEN is not set or has fewer than 16 characters. See .env.example.');
  process.exit(1);
}
if (liaisonToken && (liaisonToken.length < 16 || liaisonToken === token)) {
  console.error('MEMO_LIAISON_TOKEN must have 16 characters or more and must be different from MEMO_TOKEN.');
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
const store = createStore(db, {
  owner,
  names: [owner, 'discord', ...config.map((a) => a.name)],
  forwardTo: config.filter((a) => a.kind === 'long').map((a) => a.name),
});
const agents = createAgents({ db, config, root, owner, tmux: realTmux(), counts: store.counts });
const images = createImages(join(dirname(dbPath), 'images'));
const app = createApp({ store, agents, images, root, token, liaisonToken, owner });

const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3280);
serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`Memo listens on http://${hostname}:${port}`);
  agents.resume();
});
