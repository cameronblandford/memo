import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createImages } from '../src/images.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/memos.js';
import { createAgents } from '../src/agents.js';
import { createApp } from '../src/app.js';

export const TOKEN = 'full-token-0123456789';
export const LIAISON_TOKEN = 'liaison-token-0123456789';
export const ROOT = join(import.meta.dirname, '..');
const CONFIG = [
  { name: 'main', kind: 'long', dir: '~/p', model: 'm' },
  { name: 'liaison', kind: 'short', dir: '~/p', model: 'm' },
];

export function makeApp({ tailscale, config = CONFIG } = {}) {
  const db = openDb();
  const store = createStore(db, { owner: 'cam', names: ['cam', 'discord', ...config.map((a) => a.name)], forwardTo: config.filter((a) => a.kind !== 'short').map((a) => a.name) });
  const sessions = new Set();
  const tmux = { has: (s) => sessions.has(s), start: (s) => sessions.add(s), kill: (s) => sessions.delete(s), send: () => {} };
  const agents = createAgents({ db, config, root: ROOT, owner: 'cam', tmux, counts: store.counts });
  const images = createImages(mkdtempSync(join(tmpdir(), 'memo-images-')));
  const app = createApp({ store, agents, images, root: ROOT, token: TOKEN, liaisonToken: LIAISON_TOKEN, owner: 'cam', tailscale });
  return { app, store, agents, images, sessions };
}

export async function call(app, path, body, token = TOKEN) {
  const r = await app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
