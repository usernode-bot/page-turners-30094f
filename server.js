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

// Set while the graceful-shutdown handler below is draining (see "Graceful
// shutdown" in the platform conventions); /health answers 503 meanwhile.
const DRAIN_MS = 3000;
let shuttingDown = false;
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

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Page Turners ─────────────────────────────────────────────────────────
// The club's data. Two public tables (created in the boot block below):
// `suggestions` holds every proposed book; the single `club_state` row
// holds which one is this month's read and who hosts the next meetup.
//
// All meetup maths is UTC (see CLAUDE.md): the club meets on the last
// Thursday of each month at 19:00. "Now" comes from req.now, never
// new Date(), so a staging preview can be shown as of a chosen moment.

const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL;

// The platform's member list, cached for a minute (the endpoint shares its
// rate limit with the /users/* family). Unavailable for guests (403),
// outside the platform, or on any failure: the page still renders, it just
// can't rotate or initialise the host.
const rosterCache = { at: 0, members: null };
async function getRoster(userToken) {
  if (!PLATFORM_API_BASE || !userToken) return null;
  const at = Date.now();
  if (rosterCache.members && at - rosterCache.at < 60_000) return rosterCache.members;
  try {
    const headers = { 'x-usernode-user-token': userToken };
    if (process.env.USERNODE_LLM_PROXY_TOKEN) {
      headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
    }
    const resp = await fetch(PLATFORM_API_BASE + '/members', { headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data.members) || data.members.length === 0) return null;
    rosterCache.members = data.members;
    rosterCache.at = at;
    return rosterCache.members;
  } catch {
    return null;
  }
}

// The last Thursday of `monthIndex` (a Date.UTC month index; values past 11
// roll into the next year) at 19:00 UTC.
function lastThursdayAt19(year, monthIndex) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay();
  const day = lastDay - ((lastDow - 4 + 7) % 7); // 4 = Thursday
  return new Date(Date.UTC(year, monthIndex, day, 19, 0, 0));
}

// The first meetup strictly after `now`; on the meetup's own evening the
// answer is already next month's.
function nextMeetup(now) {
  const thisMonth = lastThursdayAt19(now.getUTCFullYear(), now.getUTCMonth());
  return thisMonth.getTime() > now.getTime()
    ? thisMonth
    : lastThursdayAt19(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

// The meetup after the given one: next month's last Thursday.
function meetupAfter(at) {
  return lastThursdayAt19(at.getUTCFullYear(), at.getUTCMonth() + 1);
}

// The meetup to show and who hosts it, advancing the stored host lazily:
// every meetup that has passed moves the host one place on through the
// member list (creator first, wrapping), and the new host and meetup are
// stored. With a roster but no stored host, the member after the creator
// hosts first (the creator's v1 choice); with no roster, the stored host
// stands and a hostless meetup shows "to be decided" on the page.
async function resolveMeetup(req) {
  const next = nextMeetup(req.now);
  const { rows } = await pool.query(
    'SELECT host_username, host_meetup_at FROM club_state WHERE id = 1'
  );
  const stored = rows[0] || {};
  let host = stored.host_username || null;
  let at = stored.host_meetup_at ? new Date(stored.host_meetup_at) : null;
  const roster = await getRoster(req.query.token || req.headers['x-usernode-token']);
  if (roster) {
    const names = roster.map((m) => m.username);
    if (!host) {
      host = names[Math.min(1, names.length - 1)];
      at = next;
      await pool.query(
        'UPDATE club_state SET host_username = $1, host_meetup_at = $2 WHERE id = 1',
        [host, at]
      );
    } else {
      let idx = names.indexOf(host);
      let changed = false;
      if (!at) { at = next; changed = true; }
      while (at.getTime() <= req.now.getTime()) {
        idx = (idx + 1) % names.length; // a host no longer on the roster falls to the creator
        at = meetupAfter(at);
        changed = true;
      }
      if (changed) {
        host = names[idx];
        await pool.query(
          'UPDATE club_state SET host_username = $1, host_meetup_at = $2 WHERE id = 1',
          [host, at]
        );
      }
    }
  }
  return { at: next, host };
}

// Everything the club screen needs, in one read. Guests may read: the page
// says "You" only when the viewer matches the suggester.
app.get('/api/club', async (req, res) => {
  try {
    const meetup = await resolveMeetup(req);
    const { rows: readRows } = await pool.query(`
      SELECT s.id, s.title, s.author, s.suggested_by_username
      FROM club_state c JOIN suggestions s ON s.id = c.current_suggestion_id
      WHERE c.id = 1
    `);
    const { rows: sugRows } = await pool.query(`
      SELECT s.id, s.title, s.author, s.suggested_by_username,
             COALESCE(s.id = c.current_suggestion_id, false) AS is_current
      FROM suggestions s CROSS JOIN club_state c
      WHERE c.id = 1
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 50
    `);
    const read = readRows[0];
    res.json({
      viewer: req.user ? req.user.username : null,
      currentRead: read
        ? { id: read.id, title: read.title, author: read.author, suggestedBy: read.suggested_by_username }
        : null,
      meetup: { at: meetup.at.toISOString(), host: meetup.host },
      suggestions: sugRows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        suggestedBy: r.suggested_by_username,
        isCurrentRead: r.is_current,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest a book. Title required (whitespace trimmed away), author optional.
app.post('/api/suggestions', async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const author = typeof body.author === 'string' ? body.author.trim() : '';
    if (!title) {
      return res.status(400).json({ error: 'validation', message: 'A title is required.' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'validation', message: 'Keep the title to 200 characters or fewer.' });
    }
    if (author.length > 120) {
      return res.status(400).json({ error: 'validation', message: 'Keep the author to 120 characters or fewer.' });
    }
    const { rows } = await pool.query(`
      INSERT INTO suggestions (title, author, suggested_by_user_id, suggested_by_username)
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, author, suggested_by_username
    `, [title, author || null, req.user.id, req.user.username]);
    const r = rows[0];
    res.status(201).json({
      suggestion: {
        id: r.id,
        title: r.title,
        author: r.author,
        suggestedBy: r.suggested_by_username,
        isCurrentRead: false,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set which suggestion is this month's read. Any signed-in member may.
app.post('/api/current-read', async (req, res) => {
  try {
    const body = req.body || {};
    const id = Number(body.suggestionId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'validation', message: 'Pick a suggestion to set.' });
    }
    const { rowCount } = await pool.query('SELECT id FROM suggestions WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(400).json({ error: 'validation', message: 'That suggestion is no longer on the list.' });
    }
    await pool.query('UPDATE club_state SET current_suggestion_id = $1 WHERE id = 1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/page-turners-30094f/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/page-turners-30094f/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Platform convention (see "Graceful shutdown"): stop accepting
// connections, drain briefly, close the pool and exit. Idempotent: a
// repeat signal during the drain is a no-op, not a second teardown.
function setupShutdown(server) {
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try {
      await pool.end();
    } catch (e) {
      console.error('[shutdown] pool.end failed', e.message);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function start() {
  // One-time cleanup of the starter template's demo table, now that the
  // screen it served is gone.
  await pool.query('DROP TABLE IF EXISTS presses');

  // The club's two tables, both public (they carry only book titles and
  // usernames). One `club_state` row holds the current pick and the stored
  // host, so the host advances without any cron.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      author VARCHAR(120),
      suggested_by_user_id INTEGER NOT NULL,
      suggested_by_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      current_suggestion_id INTEGER REFERENCES suggestions(id),
      host_username VARCHAR(255),
      host_meetup_at TIMESTAMPTZ
    )
  `);
  await pool.query('INSERT INTO club_state (id) VALUES (1) ON CONFLICT DO NOTHING');

  if (IS_STAGING) {
    // Obviously fake demo rows for previews and checks, owned by a fake
    // identity — never by whoever opened the preview. The stored host is
    // the creator's real v1 choice (priya_t1006), anchored to the meetup
    // current at seed time; COALESCE keeps anything already stored, so the
    // empty screen stays reachable by simply not setting a pick.
    await pool.query(`
      INSERT INTO suggestions (id, title, author, suggested_by_user_id, suggested_by_username)
      VALUES
        (900001, 'Staging demo: The Midnight Library', 'Matt Haig', -1, 'staging-demo-reader'),
        (900002, 'Staging demo: Piranesi', 'Susanna Clarke', -1, 'staging-demo-reader'),
        (900003, 'Staging demo: Project Hail Mary', 'Andy Weir', -1, 'staging-demo-reader')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      UPDATE club_state
      SET current_suggestion_id = COALESCE(current_suggestion_id, 900001),
          host_username = COALESCE(host_username, 'priya_t1006'),
          host_meetup_at = COALESCE(host_meetup_at, $1)
      WHERE id = 1
    `, [nextMeetup(new Date())]);
  }

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  setupShutdown(server);
}

start().catch(err => { console.error(err); process.exit(1); });
