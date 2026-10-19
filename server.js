const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Studio API ────────────────────────────────────────────────────────────
// The app keeps no data: these two routes only fetch things (a script from
// the platform's LLM proxy, a product page the user pasted).

const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;

app.get('/api/config', (_req, res) => {
  res.json({ staging: IS_STAGING, llm: { available: LLM_ENABLED } });
});

// The system prompt carries the platform's content rules: the model must
// decline age-restricted topics and answer with a neutral line instead.
const SCRIPT_SYSTEM = [
  'You write voiceover scripts for 15-second TikTok promo videos.',
  'Write about 30 words in 3 to 5 short sentences, plain and friendly.',
  'Name the product, mention the price, and end with a line asking viewers to tap the yellow cart.',
  'Reply with ONLY the script text: no quotes, no headings, no lists.',
  'You must decline requests about sexual or suggestive themes, violence, weapons, gambling, drugs or alcohol, and real-world tragedy:',
  'in those cases reply exactly: I can only write promo scripts for everyday products.',
].join(' ');

function cleanScriptText(text) {
  return String(text || '').replace(/^["“”\s]+|["“”\s]+$/g, '').trim();
}

app.post('/api/script', async (req, res) => {
  if (!LLM_ENABLED) return res.status(503).json({ error: 'llm_unavailable' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  const price = typeof req.body.price === 'string' ? req.body.price.trim().slice(0, 40) : '';
  const badge = typeof req.body.badge === 'string' ? req.body.badge.trim().slice(0, 80) : '';
  if (!name) return res.status(400).json({ error: 'name_required' });

  try {
    const parts = [`Product: ${name}`, price ? `Price: ${price}` : '', badge ? `Badge text: ${badge}` : ''];
    const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': req.headers['x-usernode-token'] || '',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 300,
        system: SCRIPT_SYSTEM,
        messages: [{ role: 'user', content: parts.filter(Boolean).join('\n') }],
      }),
    });
    if (resp.status === 403) {
      return res.status(403).json({ error: 'grant_required' });
    }
    if (resp.status === 429) {
      let code = '';
      try { code = (await resp.json()).code || ''; } catch {}
      const message = code === 'app_cap_exceeded'
        ? 'Daily AI cap for this app reached. It resets at midnight UTC.'
        : 'Your daily AI budget is used up. Try again tomorrow.';
      return res.status(429).json({ error: code || 'rate_limited', message });
    }
    if (!resp.ok) {
      console.warn('script proxy failed: ' + resp.status);
      return res.status(502).json({ error: 'script_failed' });
    }
    const data = await resp.json();
    const script = cleanScriptText((data.content || []).map((c) => (c.type === 'text' ? c.text : '')).join(' '));
    if (!script) return res.status(502).json({ error: 'script_failed' });
    return res.json({ script });
  } catch (err) {
    console.warn('script proxy error: ' + err.message);
    return res.status(502).json({ error: 'script_failed' });
  }
});

// ── Product link reader ───────────────────────────────────────────────────
// A guarded fetch of a product page: http(s) only, DNS resolved and checked
// against loopback / private / link-local / metadata addresses (again after
// each redirect), 5 s timeout, 2 MB page and 5 MB per image, image content
// types only. Anything that fails is 422 unreadable.

const dns = require('dns').promises;
const PAGE_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;

function isPrivateIp(ip) {
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m4) {
    const a = Number(m4[1]);
    const b = Number(m4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  const low = String(ip).toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (/^f[cd]/.test(low)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(low)) return true; // link-local fe80::/10
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(low);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

async function assertPublicHost(hostname) {
  if (isPrivateIp(hostname)) throw new Error('blocked-address');
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('no-address');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('blocked-address');
  }
}

async function guardedFetch(urlStr, { timeoutMs = 5000, redirects = 3 } = {}) {
  let current = new URL(urlStr);
  for (let i = 0; i <= redirects; i++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('bad-scheme');
    await assertPublicHost(current.hostname);
    const resp = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; TekotekStudio/1.0)', accept: '*/*' },
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      try { if (resp.body) resp.body.cancel(); } catch {}
      if (!loc || i === redirects) throw new Error('too-many-redirects');
      current = new URL(loc, current);
      continue;
    }
    return resp;
  }
  throw new Error('too-many-redirects');
}

function readMetas(html) {
  const out = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (key && content) {
      const k = key[1].toLowerCase();
      if (!(k in out)) out[k] = content[1];
    }
  }
  return out;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function formatPrice(amount, currency) {
  const amt = decodeEntities(amount).replace(/[^\d.,]/g, '');
  if (!amt) return '';
  const cur = decodeEntities(currency || '').toUpperCase();
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$' };
  if (symbols[cur]) return symbols[cur] + amt;
  return cur ? `${amt} ${cur}` : amt;
}

async function fetchImageDataUrl(src, base) {
  const u = new URL(src, base);
  const resp = await guardedFetch(u.toString());
  const type = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error('not-an-image');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > IMAGE_LIMIT) throw new Error('too-large');
  return `data:${type};base64,${buf.toString('base64')}`;
}

app.post('/api/link', async (req, res) => {
  const raw = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  try {
    const page = await guardedFetch(raw);
    const buf = Buffer.from(await page.arrayBuffer());
    if (buf.length > PAGE_LIMIT) throw new Error('too-large');
    const metas = readMetas(buf.toString('utf8'));
    const name = decodeEntities(metas['og:title'] || '');
    const price = formatPrice(metas['product:price:amount'] || metas['og:price:amount'] || '', metas['product:price:currency'] || metas['og:price:currency'] || '');
    const srcs = [metas['og:image'], metas['og:image:secure_url'], metas['twitter:image'], metas['twitter:image:src']]
      .filter(Boolean).slice(0, 3);
    const images = [];
    for (const src of srcs) {
      if (images.length >= 3) break;
      try {
        images.push(await fetchImageDataUrl(src, page.url || raw));
      } catch {} // one bad image does not sink the page
    }
    if (!name && !price && !images.length) throw new Error('nothing-found');
    return res.json({ name, price, images });
  } catch (err) {
    console.warn('link read failed: ' + err.message);
    return res.status(422).json({ error: 'unreadable' });
  }
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/tekotek-studio-32863d/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/tekotek-studio-32863d/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  return server;
}

// Stop accepting connections, drain for ~3 s, close the pool, exit.
let shuttingDown = false;
function shutdown(signal, server) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: draining connections`);
  try { if (server) server.close(); } catch {}
  setTimeout(async () => {
    try { await pool.end(); } catch {}
    process.exit(0);
  }, 3000).unref?.();
  // Never hang the container if the drain itself stalls.
  setTimeout(() => process.exit(0), 8000).unref();
}

start()
  .then((server) => {
    process.on('SIGTERM', () => shutdown('SIGTERM', server));
    process.on('SIGINT', () => shutdown('SIGINT', server));
  })
  .catch(err => { console.error(err); process.exit(1); });
