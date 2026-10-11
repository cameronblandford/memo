import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoError } from './memos.js';

// The only files that /ui/<name> gives.
const UI = {
  'common.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'common.css': 'text/css; charset=utf-8',
};
const LIAISON = 'liaison';
const digest = (s) => createHash('sha256').update(s).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

export function createApp({ store, agents, images, root, token, liaisonToken, owner = 'owner', tailscale }) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof MemoError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'The server has an error. See data/server.log.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/', (c) => c.redirect('/inbox'));
  // The pages talk only to this server. frame-src 'none': a frame of a memo cannot go to an address.
  const PAGE_RULE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
    + "connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  // A page gets the name of the owner in the place of __OWNER__.
  const page = (file) => (c) => c.html(readFileSync(join(root, 'ui', file), 'utf8').replaceAll('__OWNER__', owner), 200, { 'Content-Security-Policy': PAGE_RULE });
  app.get('/inbox', page('inbox.html'));
  app.get('/agents', page('agents.html'));
  app.get('/ui/:file', (c) => {
    const file = c.req.param('file');
    if (!Object.hasOwn(UI, file)) return c.notFound();
    return c.body(readFileSync(join(root, 'ui', file), 'utf8'), 200, { 'Content-Type': UI[file] });
  });

  // Tailscale Serve sets Tailscale-User-Login and removes a value that the client sent. The owner then needs no token.
  // The Host must be the Tailscale name, so a page that points its own name at this server (DNS rebinding) gets nothing.
  // The Origin and Sec-Fetch-Site checks stop a page of a different site that sends a request from the browser of the owner.
  const fromOwnerTailnet = (c) => {
    if (!tailscale) return false;
    const header = (name) => c.req.header(name) || '';
    if (!same(header('Tailscale-User-Login'), tailscale.login) || header('Host') !== tailscale.host) return false;
    if (header('Origin') && header('Origin') !== `https://${tailscale.host}`) return false;
    return !header('Sec-Fetch-Site') || header('Sec-Fetch-Site') === 'same-origin';
  };

  app.use('/api/*', async (c, next) => {
    const given = (c.req.header('Authorization') || '').replace(/^Bearer\s*/, '');
    if (given && same(given, token)) c.set('role', 'full');
    else if (given && liaisonToken && same(given, liaisonToken)) c.set('role', LIAISON);
    else if (!given && fromOwnerTailnet(c)) c.set('role', 'full');
    else throw new MemoError(401, 'The token is missing or wrong.');
    await next();
  });

  // The liaison run reads text from other people. Its token can do only what `permitted` says.
  const only = (c, permitted) => {
    if (c.get('role') !== 'full' && !permitted) throw new MemoError(403, 'This token cannot do that.');
  };
  const body = async (c) => {
    let b = null;
    try { b = await c.req.json(); } catch { /* handled below */ }
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new MemoError(400, 'The request body must be a JSON object.');
    return b;
  };

  app.post('/api/send', async (c) => {
    const b = await body(c);
    only(c, b.from === LIAISON && b.to === owner);
    if (c.get('role') !== 'full') delete b.trusted;
    return c.json(store.send(b));
  });
  app.post('/api/reply', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.reply(b.id, b.text));
  });
  app.post('/api/close', async (c) => {
    const b = await body(c);
    only(c, store.get(b.id).recipient === LIAISON);
    return c.json(store.close(b.id, b.text));
  });
  app.post('/api/edit', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.edit(b.id, b.text));
  });
  app.post('/api/seen', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.seen(b.ids));
  });
  app.post('/api/check', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.check(b.id, b.n, b.on));
  });
  app.post('/api/adjust', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.adjust(b.id, b.delta));
  });
  app.post('/api/ack', async (c) => {
    const b = await body(c);
    only(c, store.get(b.id).sender === LIAISON);
    return c.json(store.ack(b.id));
  });
  app.post('/api/forward', async (c) => {
    const b = await body(c);
    return c.json(store.forward(b.id, b.to ?? agents.defaultAgent()));
  });
  app.post('/api/status', async (c) => {
    const b = await body(c);
    only(c, b.agent === LIAISON);
    return c.json(agents.setStatus(b.agent, b.text));
  });
  app.post('/api/recap', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(agents.recap(b.agent, b.text));
  });
  app.post('/api/agent/start', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(agents.start(b.name));
  });
  app.post('/api/agent/stop', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(agents.stop(b.name, { now: b.now === true }));
  });
  app.get('/api/list', (c) => {
    const to = c.req.query('to');
    only(c, to === LIAISON);
    return c.json(store.list(to));
  });
  app.get('/api/news', (c) => {
    const who = c.req.query('for');
    only(c, who === LIAISON);
    agents.contact(who);
    return c.json(store.news(who));
  });
  app.get('/api/agents', (c) => {
    only(c, false);
    return c.json(agents.list());
  });
  // An image for a memo. The pages get it with the token, so a memo can show a screenshot and stay private.
  app.post('/api/image', async (c) => {
    only(c, false);
    return c.json(images.save(await c.req.arrayBuffer()));
  });
  app.get('/api/image/:name', (c) => {
    only(c, false);
    const { bytes, type } = images.read(c.req.param('name'));
    return c.body(bytes, 200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
  app.get('/api/agent/prompt', (c) => {
    only(c, false);
    return c.text(agents.prompt(c.req.query('name')));
  });

  return app;
}
