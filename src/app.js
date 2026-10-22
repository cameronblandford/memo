import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoError } from './memos.js';
import { placeTicks } from './ticks.js';
import { dueSoon } from './rank.js';
import { approveRule } from './rules.js';

// The only files that /ui/<name> gives.
const UI = {
  'filter.js': 'text/javascript; charset=utf-8',
  'common.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'keys.js': 'text/javascript; charset=utf-8',
  'attach.js': 'text/javascript; charset=utf-8',
  'feedback.js': 'text/javascript; charset=utf-8',
  'working.js': 'text/javascript; charset=utf-8',
  'lightbox.js': 'text/javascript; charset=utf-8',
  'rule.js': 'text/javascript; charset=utf-8',
  'common.css': 'text/css; charset=utf-8',
};
const LIAISON = 'liaison';
const digest = (s) => createHash('sha256').update(s).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

// ticksOn: the ticks are an optional part. They are off unless MEMO_TICKS is set (see README.md).
// ownerToken: the optional token of the owner alone (MEMO_OWNER_TOKEN). The agents have token (MEMO_TOKEN).
export function createApp({ store, agents, images, ticks, ticksOn = false, root, token, liaisonToken, ownerToken, owner = 'owner', tailscale, now = () => new Date() }) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof MemoError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'The server has an error. See data/server.log.' }, 500);
  });

  // The short tailnet name (for example http://memo/inbox, through Tailscale Serve on port 80) goes to the full
  // HTTPS name. There the browser keeps the token and the Tailscale check applies. A redirect gives no data.
  if (tailscale) {
    const short = tailscale.host.split('.')[0];
    app.use('*', async (c, next) => {
      const host = c.req.header('Host') || '';
      if (host !== short && host !== `${short}:80`) return next();
      const url = new URL(c.req.url);
      return c.redirect(`https://${tailscale.host}${url.pathname}${url.search}`, 308);
    });
  }

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/', (c) => c.redirect('/inbox'));
  // The pages talk only to this server. frame-src 'none': a frame of a memo cannot go to an address.
  const PAGE_RULE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
    + "connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  // A page gets the name of the owner in the place of __OWNER__.
  const page = (file) => (c) => c.html(readFileSync(join(root, 'ui', file), 'utf8').replaceAll('__OWNER__', owner), 200, { 'Content-Security-Policy': PAGE_RULE });
  app.get('/inbox', page('inbox.html'));
  app.get('/agents', page('agents.html'));
  app.get('/log', page('log.html'));
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
    // isOwner: the request is from the owner, not from an agent. Only the owner token and the Tailscale login of the
    // owner give it. MEMO_TOKEN does not: the agents have it too.
    const isOwner = (given && ownerToken && same(given, ownerToken)) || (!given && fromOwnerTailnet(c));
    if (given && same(given, token)) c.set('role', 'full');
    else if (given && liaisonToken && same(given, liaisonToken)) c.set('role', LIAISON);
    else if (isOwner) { c.set('role', 'full'); c.set('isOwner', true); }
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
    // The liaison can send to the owner, or to main (an event request for the owner's calendar). Its memos are never trusted.
    only(c, b.from === LIAISON && (b.to === owner || b.to === 'main'));
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
  app.post('/api/brief', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.brief(b.id, { title: b.title, next: b.next }));
  });
  app.post('/api/note', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.note(b.id, b.from, b.text));
  });
  // The sender (from) closes an open memo to the owner and sends a short new memo in its place.
  app.post('/api/compact', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.compact(b.id, b.from, { text: b.text, title: b.title, next: b.next }));
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
  app.post('/api/tag', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.tag(b.id, b.tag, b.on));
  });
  // date: YYYY-MM-DD, or null to bring the memo back now.
  app.post('/api/postpone', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(store.postpone(b.id, b.date ?? null));
  });
  app.get('/api/postponed', (c) => {
    only(c, false);
    return c.json(store.postponed());
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
  // The Approve rule button of the Inbox. The server writes the rule to the settings file of the agent (src/rules.js).
  // Only the owner can approve: an agent must not approve its own request.
  app.post('/api/rule/approve', async (c) => {
    const b = await body(c);
    if (!c.get('isOwner')) {
      throw new MemoError(403, 'Only the owner can approve a rule: open the Inbox through Tailscale, or with MEMO_OWNER_TOKEN. MEMO_TOKEN cannot, because the agents have it.');
    }
    return c.json(approveRule({ store, agents, owner, now }, b.id, b.rule));
  });
  app.get('/api/list', (c) => {
    const to = c.req.query('to');
    only(c, to === LIAISON);
    // The client shows the postponed memos of the owner too, with their return time.
    const memos = store.list(to, { withPostponed: true });
    // peek=1: a check that is not a read by the agent, for example by the Discord watcher.
    if (!c.req.query('peek')) store.delivered(to, memos, 'by memo list');
    return c.json(memos);
  });
  app.get('/api/news', (c) => {
    const who = c.req.query('for');
    only(c, who === LIAISON);
    // peek=1: a check that is not a read by the agent, for example by the Discord watcher.
    const peek = !!c.req.query('peek');
    if (!peek) agents.contact(who);
    // hold: the ids of memo wait --hold, for the Log page.
    const hold = (c.req.query('hold') || '').split(',').map(Number).filter(Number.isInteger);
    return c.json(store.news(who, { hold, peek }));
  });
  // The Log page: the memos on their way to each agent, and the newest events (filter: agent, memo).
  app.get('/api/log', (c) => {
    only(c, false);
    const memo = c.req.query('memo') ? Number(c.req.query('memo')) : null;
    if (memo !== null && !Number.isInteger(memo)) throw new MemoError(400, 'memo must be a memo id.');
    const agent = c.req.query('agent') || null;
    return c.json({ inflight: store.inflight(), events: store.events.list({ agent, memo }) });
  });
  app.get('/api/agents', (c) => {
    only(c, false);
    return c.json(agents.list());
  });
  // The live output of an agent: its visible text and the names and descriptions of its tool calls, after the cursor.
  app.get('/api/agent/output', (c) => {
    only(c, false);
    const q = (k) => c.req.query(k);
    return c.json(agents.output(q('name'), { file: q('file'), cursor: q('cursor') }));
  });
  // The Inbox: the open memos to the owner in their order, and the ticks of now with their places in that order.
  app.get('/api/queue', (c) => {
    only(c, false);
    const memos = store.list(owner);
    return c.json({
      memos,
      ticks: ticksOn ? placeTicks(memos, ticks.due(), dueSoon(now())) : [],
      // For the "Postponed (n)" button, and for the dates of the postpone picker.
      postponed: store.postponed().length,
      timeZone: store.timeZone,
      // For the work sign in the corner: the status of each agent and the work of the owner that waits for it.
      agents: agents.work(),
    });
  });
  const needTicks = () => {
    if (!ticksOn) throw new MemoError(400, 'Ticks are off. To use them, set MEMO_TICKS=1 in .env and start the server again.');
  };
  app.get('/api/ticks', (c) => {
    only(c, false);
    needTicks();
    return c.json(c.req.query('log') ? ticks.log(Number(c.req.query('log'))) : ticks.list());
  });
  const tick = (path, fn) => app.post(`/api/tick/${path}`, async (c) => {
    const b = await body(c);
    only(c, false);
    needTicks();
    return c.json(fn(b));
  });
  tick('add', (b) => ticks.add(b));
  tick('set', (b) => ticks.set(b.id, b));
  tick('adjust', (b) => ticks.adjust(b.id, b.delta));
  tick('remove', (b) => ticks.remove(b.id));
  tick('done', (b) => ticks.done(b.id));
  tick('skip', (b) => ticks.skip(b.id));
  tick('undo', (b) => ticks.undo(b.id));
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
  // The tail of an agent session for the Agents page, and the keys that close a dialog in it.
  app.get('/api/agent/screen', (c) => {
    only(c, false);
    return c.json(agents.screen(c.req.query('name')));
  });
  app.post('/api/agent/screen', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(agents.setScreen(b.name, b.text));
  });
  app.post('/api/agent/key', async (c) => {
    const b = await body(c);
    only(c, false);
    return c.json(agents.key(b.name, b.key));
  });
  app.get('/api/agent/prompt', (c) => {
    only(c, false);
    return c.text(agents.prompt(c.req.query('name')));
  });

  return app;
}
