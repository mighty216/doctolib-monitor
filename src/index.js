import { runChecks, ingest, watchdog } from './runner.js';
import { maybeDispatch } from './github.js';
import { renderDashboard, renderMessage } from './dashboard.js';
import { ensureSchema, loadDashboardData, eventStmt, metaStmt, getAllMeta } from './store.js';
import { parseWatches } from './doctolib.js';
import { telegramProblems, sendTelegram } from './telegram.js';
import { clampInt, nowSec, scrub } from './util.js';

const SEC_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function withHeaders(res, extra = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SEC_HEADERS, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

const cookieToken = (key) => sha256Hex(`doctolib-monitor:${key}`);

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** 'none' | 'nokey' | 'query' | 'cookie' */
async function authState(request, env, url) {
  const key = String(env.DASHBOARD_KEY || '');
  if (key.length < 12) return 'nokey';
  const q = url.searchParams.get('key');
  if (q && safeEqual(q, key)) return 'query';
  const c = readCookie(request, 'dk');
  if (c && safeEqual(c, await cookieToken(key))) return 'cookie';
  return 'none';
}

const isDirect = (env) => String(env.MODE || 'ingest').toLowerCase() === 'direct';

/** Authentification du collecteur : Authorization: Bearer <INGEST_KEY> */
function ingestAuth(request, env) {
  const key = String(env.INGEST_KEY || '');
  if (key.length < 16) return 'nokey';
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  return m && safeEqual(m[1], key) ? 'ok' : 'none';
}

async function handleIngest(request, env, url) {
  const auth = ingestAuth(request, env);
  if (auth === 'nokey') return Response.json({ ok: false, error: 'INGEST_KEY absent ou trop court (16 caractères minimum)' }, { status: 503 });
  if (auth === 'none') return Response.json({ ok: false, error: 'non autorisé' }, { status: 401 });

  if (url.pathname === '/api/ingest/config' && request.method === 'GET') {
    const { watches, errors } = parseWatches(env.DOCTOLIB_URLS);
    const meta = env.DB ? (await ensureSchema(env.DB), await getAllMeta(env.DB)) : {};
    const last = Number.parseInt(meta.last_run || '0', 10) || 0;
    return Response.json({
      ok: true,
      watches: watches.map((w) => ({
        key: w.key, practice: w.practice, motives: w.motives, slugCandidates: w.slugCandidates, telehealth: w.telehealth,
      })),
      errors,
      horizon: clampInt(env.MAX_DAYS, 21, 1, 60),
      intervalMin: clampInt(env.INTERVAL_MIN, 15, 1, 1440),
      sinceLastSec: last ? Math.max(0, nowSec() - last) : null,
    });
  }
  if (url.pathname === '/api/ingest' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > 200000) return Response.json({ ok: false, error: 'corps trop gros' }, { status: 413 });
    let payload;
    try { payload = JSON.parse(text); } catch { return Response.json({ ok: false, error: 'JSON invalide' }, { status: 400 }); }
    const r = await ingest(env, payload);
    return Response.json(
      { ok: r.ok, reason: r.reason, alerted: r.alerted, results: r.results },
      { status: r.ok ? 200 : (r.status || 500) },
    );
  }
  return Response.json({ ok: false, error: 'introuvable' }, { status: 404 });
}

async function buildView(env) {
  const now = nowSec();
  const { watches, errors } = parseWatches(env.DOCTOLIB_URLS);
  const problems = [...errors, ...telegramProblems(env)];
  if (String(env.DASHBOARD_KEY || '').length < 12) problems.push('DASHBOARD_KEY trop court (12 caractères minimum)');
  if (!isDirect(env) && String(env.INGEST_KEY || '').length < 16) problems.push('INGEST_KEY absent ou trop court (16 caractères minimum)');
  if (!env.DB) {
    return { now, intervalMin: 15, horizon: 21, mode: isDirect(env) ? 'direct' : 'ingest', staleMin: 75, hasConfig: false, problems: [...problems, 'binding D1 "DB" absent'], lastRun: 0, watches: [], events: [] };
  }
  await ensureSchema(env.DB);
  const d = await loadDashboardData(env.DB, watches.map((w) => w.key), now);
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
  const view = {
    now,
    intervalMin: clampInt(env.INTERVAL_MIN, 15, 1, 1440),
    horizon: clampInt(env.MAX_DAYS, 21, 1, 60),
    mode: isDirect(env) ? 'direct' : 'ingest',
    collector: d.meta.collector || null,
    staleMin: clampInt(env.COLLECTOR_STALE_MIN, 75, 10, 1440),
    hasConfig: watches.length > 0,
    problems: problems.map((p) => scrub(p, secrets)),
    lastRun: Number.parseInt(d.meta.last_run || '0', 10) || 0,
    events: d.events.map((e) => ({ ...e, detail: scrub(e.detail, secrets) })),
    watches: watches.map((w) => {
      let label = `Cabinet ${w.practice}`;
      try { label = JSON.parse(d.meta[`agenda:${w.key}`] || '{}').label || label; } catch { /* défaut */ }
      const timeline = d.timelines[w.key] || [];
      return {
        key: w.key,
        label,
        last: timeline.length ? timeline[timeline.length - 1] : null,
        timeline,
        slots: d.slots[w.key] || [],
        next: d.meta[`next:${w.key}`] || null,
        rate24: d.rate24[w.key],
        rate7: d.rate7[w.key],
      };
    }),
  };
  return view;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/ingest')) return handleIngest(request, env, url);
  const auth = await authState(request, env, url);
  if (auth === 'nokey') {
    return renderMessage('Non configuré', 'Définis le secret DASHBOARD_KEY (12 caractères minimum) : wrangler secret put DASHBOARD_KEY', 503);
  }
  if (auth === 'none') {
    return renderMessage('Accès refusé', "Ouvre l'adresse avec ?key=TA_CLE la première fois.", 401);
  }
  if (auth === 'query') { // pose le cookie puis retire la clé de l'URL
    const token = await cookieToken(env.DASHBOARD_KEY);
    return new Response(null, {
      status: 302,
      headers: {
        location: url.pathname === '/run' ? '/' : url.pathname,
        'set-cookie': `dk=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  }

  if (url.pathname === '/' && request.method === 'GET') {
    return new Response(renderDashboard(await buildView(env)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname === '/api/status' && request.method === 'GET') {
    return Response.json(await buildView(env));
  }
  if (url.pathname === '/run' && request.method === 'POST') {
    if (!isDirect(env)) {
      return renderMessage('Indisponible', 'Les vérifications sont faites par le collecteur GitHub Actions (onglet Actions du dépôt > Run workflow).', 409);
    }
    const meta = env.DB ? await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_manual'").first().catch(() => null) : null;
    const last = Number.parseInt(meta?.value || '0', 10);
    if (nowSec() - last < 120) {
      return renderMessage('Trop tôt', 'Une vérification manuelle a déjà eu lieu il y a moins de 2 minutes.', 429);
    }
    await runChecks(env, { manual: true }).catch((e) => console.error('manual run failed', scrub(e?.message, [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY])));
    return new Response(null, { status: 303, headers: { location: '/' } });
  }
  if (url.pathname === '/test-telegram' && request.method === 'POST') {
    const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
    await ensureSchema(env.DB);
    const m = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_tgtest'").first();
    if (nowSec() - Number.parseInt(m?.value || '0', 10) < 20) {
      return renderMessage('Trop tôt', 'Attends quelques secondes entre deux tests.', 429);
    }
    const problems = telegramProblems(env);
    const r = problems.length
      ? { ok: false, error: problems.join(', ') }
      : await sendTelegram(env, 'Test Doctolib Monitor : Telegram fonctionne.', { fast: true });
    const t = nowSec();
    await env.DB.batch([
      metaStmt(env.DB, 'last_tgtest', t),
      eventStmt(env.DB, t, r.ok ? 'telegram_ok' : 'telegram_ko', null, r.ok ? 'message de test reçu par Telegram' : scrub(r.error, secrets)),
    ]);
    return new Response(null, { status: 303, headers: { location: '/' } });
  }
  return renderMessage('Introuvable', '', 404);
}

export default {
  async scheduled(_event, env, ctx) {
    if (!isDirect(env)) {
      ctx.waitUntil(
        watchdog(env)
          .then((r) => console.log('watchdog', JSON.stringify(r)))
          .catch((e) => console.error('watchdog failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN])))
          .then(() => maybeDispatch(env))
          .then((r) => console.log('dispatch', JSON.stringify(r)))
          .catch((e) => console.error('dispatch failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN, env.GITHUB_TOKEN]))),
      );
      return;
    }
    ctx.waitUntil(
      runChecks(env, {})
        .then((r) => {
          const line = JSON.stringify({
            ok: r.ok, skipped: r.skipped || false, reason: r.reason, alerted: r.alerted,
            results: (r.results || []).map((x) => `${x.label}:${x.status}:${x.slots}`),
          });
          if (r.ok) console.log('run', line); else console.warn('run non effectué', line);
        })
        .catch((e) => console.error('scheduled run failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN]))),
    );
  },
  async fetch(request, env) {
    try {
      const res = await handle(request, env);
      return withHeaders(res);
    } catch (e) {
      console.error('request failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY]));
      return withHeaders(renderMessage('Erreur', 'Erreur interne (voir les logs du Worker).', 500));
    }
  },
};
