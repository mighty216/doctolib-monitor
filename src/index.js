import { runChecks, ingest, watchdog } from './runner.js';
import { maybeDispatch, forceCheck } from './github.js';
import { renderDashboard, renderMessage } from './dashboard.js';
import { ensureSchema, eventStmt, metaStmt, getAllMeta } from './store.js';
import { loadWatches, setPaused, removeWatch, renameWatch } from './watches.js';
import { addAndStart } from './actions.js';
import { telegramProblems, sendTelegram } from './telegram.js';
import { clampInt, nowSec, scrub } from './util.js';
import { agentPoll, agentReport, agentWatchdog, getBot, getCommand, queueCommand, isOnline, BOT_ID_RE } from './hub.js';
import { doctolibView, hubOverview, isDirect } from './overview.js';
import { handleTelegramUpdate, setupWebhook, ensureWebhook, webhookPathSecret, webhookHeaderSecret } from './tgbot.js';
import { buildNav, renderHome, renderBot, renderJournal } from './ui.js';
import { buildInstallScript } from './agent_install.js';

const SEC_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    const { active: watches, errors } = await loadWatches(env);
    const meta = await getAllMeta(env.DB);
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
  if (url.pathname === '/api/ingest/setup-telegram' && request.method === 'POST') { // appelé par l'installeur
    const r = await setupWebhook(env, url.origin);
    return Response.json({ ok: r.ok, error: r.ok ? undefined : scrub(r.error, [env.TELEGRAM_BOT_TOKEN]) }, { status: r.ok ? 200 : 502 });
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

/** Authentification des agents : Authorization: Bearer <AGENT_KEY> */
function agentAuth(request, env) {
  const key = String(env.AGENT_KEY || '');
  if (key.length < 16) return 'nokey';
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  return m && safeEqual(m[1], key) ? 'ok' : 'none';
}

async function handleAgent(request, env, url) {
  const auth = agentAuth(request, env);
  if (auth === 'nokey') return Response.json({ ok: false, error: 'AGENT_KEY absent ou trop court (16 caractères minimum)' }, { status: 503 });
  if (auth === 'none') return Response.json({ ok: false, error: 'non autorisé' }, { status: 401 });
  if (!env.DB) return Response.json({ ok: false, error: 'binding D1 absent' }, { status: 500 });
  if (url.pathname === '/api/agent/poll' && request.method === 'GET') {
    const r = await agentPoll(env, String(url.searchParams.get('bot') || ''), clampInt(url.searchParams.get('wait'), 0, 0, 25));
    return Response.json(r, { status: r.ok ? 200 : (r.status || 500) });
  }
  if (url.pathname === '/api/agent/report' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > 300000) return Response.json({ ok: false, error: 'corps trop gros' }, { status: 413 });
    let payload;
    try { payload = JSON.parse(text); } catch { return Response.json({ ok: false, error: 'JSON invalide' }, { status: 400 }); }
    const r = await agentReport(env, payload);
    return Response.json(r, { status: r.ok ? 200 : (r.status || 500) });
  }
  return Response.json({ ok: false, error: 'introuvable' }, { status: 404 });
}

async function handleTelegramWebhook(request, env, url, ctx) {
  const pathSecret = await webhookPathSecret(env);
  const given = url.pathname.slice('/tg/'.length);
  const hdr = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (telegramProblems(env).length || !safeEqual(given, pathSecret) || !safeEqual(hdr, await webhookHeaderSecret(env))) {
    return new Response('forbidden', { status: 403 });
  }
  if (request.method !== 'POST') return new Response('ok');
  let update;
  try { update = JSON.parse(await request.text()); } catch { return new Response('bad', { status: 400 }); }
  await ensureSchema(env.DB);
  const id = Number(update?.update_id);
  if (Number.isFinite(id)) { // Telegram peut renvoyer deux fois la même mise à jour
    const m = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_update'").first();
    if (m && id <= Number(m.value)) return new Response('ok');
    await metaStmt(env.DB, 'last_update', id).run();
  }
  const job = handleTelegramUpdate(env, update, url.origin);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;
  return new Response('ok');
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  // Formulaire envoyé par le script de la page (sans rechargement) : réponse JSON au lieu d'une redirection.
  const wantsJson = request.headers.get('x-hub-fetch') === '1';
  const back = (path, text, ok = true, extra = {}) => (wantsJson
    ? Response.json({ ok, text: String(text).slice(0, 300), ...extra })
    : new Response(null, {
      status: 303, headers: { location: `${path}?f=${encodeURIComponent(String(text).slice(0, 300))}${ok ? '' : '&bad=1'}` },
    }));
  if (url.pathname.startsWith('/api/ingest')) return handleIngest(request, env, url);
  if (url.pathname.startsWith('/api/agent/')) return handleAgent(request, env, url);
  if (url.pathname.startsWith('/tg/')) return handleTelegramWebhook(request, env, url, ctx);
  if (url.pathname === '/agent/install.sh' && request.method === 'GET') { // installation en une ligne sur le serveur
    if (agentAuth(request, env) !== 'ok') return new Response('non autorisé\n', { status: 401 });
    return new Response(buildInstallScript(url.origin, String(env.AGENT_KEY)), { headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } });
  }
  const auth = await authState(request, env, url);
  if (auth === 'nokey') {
    return renderMessage('Non configuré', 'Définis le secret DASHBOARD_KEY (12 caractères minimum) : wrangler secret put DASHBOARD_KEY', 503);
  }
  if (auth === 'none') {
    return renderMessage('Accès refusé', "Ouvre l'adresse complète avec ?key=TA_CLE (le lien de INFOS.txt ou de Telegram). Si ça recommence, ouvre-le dans Chrome ou Safari plutôt que dans le navigateur de Telegram.", 401);
  }
  if (request.method === 'POST') { // anti-CSRF : un formulaire d'un autre site est refusé
    const o = request.headers.get('origin');
    const sfs = request.headers.get('sec-fetch-site');
    let oh = null;
    try { oh = o && o !== 'null' ? new URL(o).host : null; } catch { oh = '?'; }
    const cross = sfs ? sfs === 'cross-site' : (oh !== null && oh !== url.host);
    if (cross) return renderMessage('Refusé', 'Origine inattendue.', 403);
  }
  const flash = url.searchParams.get('f') ? { ok: !url.searchParams.get('bad'), text: url.searchParams.get('f').slice(0, 300) } : null;
  const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const P = url.pathname;

  if (request.method === 'GET') {
    if (P === '/' || P === '/doctolib' || P.startsWith('/bot/') || P === '/journal') {
      if (env.DB) {
        await ensureSchema(env.DB);
        const known = await env.DB.prepare("SELECT value FROM meta WHERE key = 'origin'").first();
        if (!known || known.value !== url.origin) await metaStmt(env.DB, 'origin', url.origin).run();
      }
    }
    if (P === '/') {
      const o = await hubOverview(env);
      return html(await renderHome(env, await buildNav(env, o), flash, o));
    }
    if (P === '/doctolib') {
      const v = await doctolibView(env);
      const nav = await buildNav(env);
      return html(renderDashboard(v, { nav, flash }));
    }
    if (P === '/journal') {
      const v = await doctolibView(env);
      const nav = await buildNav(env);
      return html(await renderJournal(env, nav, v.events || []));
    }
    if (P.startsWith('/bot/')) {
      const bot = await getBot(env, decodeURIComponent(P.slice(5)));
      const nav = await buildNav(env);
      if (!bot) return renderMessage('Bot introuvable', "Cet agent ne s'est encore jamais connecté.", 404);
      return html(await renderBot(env, nav, bot, flash));
    }
    if (P === '/api/cmd') { // suivi d'une commande envoyée depuis la page
      const bot = String(url.searchParams.get('bot') || '');
      const id = Number.parseInt(url.searchParams.get('id') || '', 10);
      if (!BOT_ID_RE.test(bot) || !Number.isInteger(id)) return Response.json({ ok: false, error: 'paramètres invalides' }, { status: 400 });
      const c = await getCommand(env, bot, id);
      if (!c) return Response.json({ ok: false, status: 'expired', error: 'commande introuvable' }, { status: 404 });
      return Response.json({ ok: true, id: c.id, cmd: c.cmd, status: c.status, result: c.result || '', doneAt: c.done_at || null });
    }
    if (P === '/api/status') return Response.json(await doctolibView(env));
    if (P === '/api/hub') return Response.json(await hubOverview(env));
    return renderMessage('Introuvable', '', 404);
  }
  if (request.method !== 'POST') return renderMessage('Introuvable', '', 404);

  let form = new FormData();
  try { if ((request.headers.get('content-type') || '').includes('form')) form = await request.formData(); } catch { /* formulaire vide */ }
  const field = (k) => String(form.get(k) ?? '');

  if (P === '/doctolib/add') {
    const r = await addAndStart(env, field('url').trim(), field('name'));
    return back('/doctolib', r.text, r.ok);
  }
  if (['/doctolib/pause', '/doctolib/resume', '/doctolib/delete', '/doctolib/rename'].includes(P)) {
    const key = field('key');
    let ok;
    let text;
    if (P.endsWith('pause')) { ok = await setPaused(env, key, true); text = 'Surveillance mise en pause.'; }
    else if (P.endsWith('resume')) { ok = await setPaused(env, key, false); text = 'Surveillance reprise.'; if (ok) await forceCheck(env); }
    else if (P.endsWith('delete')) { ok = await removeWatch(env, key); text = 'Surveillance supprimée.'; }
    else { ok = await renameWatch(env, key, field('name')); text = 'Nom enregistré.'; }
    return back('/doctolib', ok ? text : 'Surveillance introuvable.', ok);
  }
  if (P === '/doctolib/check') {
    const r = await forceCheck(env);
    return back('/doctolib', r.ok ? 'Vérification lancée : résultat dans 1 à 2 minutes.' : r.error, r.ok);
  }
  const mb = /^\/bot\/([a-z][a-z0-9_-]{1,23})\/(action|set)$/.exec(P);
  if (mb) {
    const bot = await getBot(env, mb[1]);
    if (!bot) return renderMessage('Bot introuvable', '', 404);
    if (mb[2] === 'action') {
      const act = (bot.state?.actions || []).find((a) => a.id === field('action'));
      if (!act) return back(`/bot/${bot.id}`, 'Action inconnue.', false);
      const args = {};
      for (const a of act.args) args[a.name] = field(a.name).trim().slice(0, 120);
      if (act.args.some((a) => !args[a.name])) return back(`/bot/${bot.id}`, 'Paramètre manquant.', false);
      const r = await queueCommand(env, bot.id, act.id, args, 'web');
      return back(`/bot/${bot.id}`, r.ok ? `Commande « ${act.label} » envoyée${isOnline(env, bot) ? '' : ' (le bot est hors ligne : elle sera livrée à son retour)'}.` : r.error, r.ok,
        r.ok && r.id ? { cmd: { bot: bot.id, id: r.id } } : {});
    }
    const set = (bot.state?.settings || []).find((x) => x.key === field('key'));
    if (!set) return back(`/bot/${bot.id}`, 'Réglage inconnu.', false);
    const r = await queueCommand(env, bot.id, 'set', { key: set.key, value: field('value').trim().slice(0, 120) }, 'web');
    return back(`/bot/${bot.id}`, r.ok ? `Réglage « ${set.label} » envoyé.` : r.error, r.ok, r.ok && r.id ? { cmd: { bot: bot.id, id: r.id } } : {});
  }
  if (P === '/tg-setup') {
    const r = await setupWebhook(env, url.origin);
    return back('/', r.ok ? 'Telegram est branché sur ce hub.' : `Telegram refuse : ${scrub(r.error, [env.TELEGRAM_BOT_TOKEN])}`, r.ok);
  }
  if (P === '/run') {
    if (!isDirect(env)) return back('/doctolib', 'Les vérifications sont faites par le collecteur : utilise « Vérifier maintenant ».', false);
    const meta = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_manual'").first().catch(() => null);
    if (nowSec() - Number.parseInt(meta?.value || '0', 10) < 120) return back('/doctolib', 'Une vérification manuelle a déjà eu lieu il y a moins de 2 minutes.', false);
    await runChecks(env, { manual: true }).catch((e) => console.error('manual run failed', scrub(e?.message, [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY])));
    return back('/doctolib', 'Vérification terminée.');
  }
  if (P === '/test-telegram') {
    const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
    await ensureSchema(env.DB);
    const m = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_tgtest'").first();
    if (nowSec() - Number.parseInt(m?.value || '0', 10) < 20) return back('/', 'Attends quelques secondes entre deux tests.', false);
    const problems = telegramProblems(env);
    const r = problems.length
      ? { ok: false, error: problems.join(', ') }
      : await sendTelegram(env, 'Test du hub : Telegram fonctionne.', { fast: true });
    const t = nowSec();
    await env.DB.batch([
      metaStmt(env.DB, 'last_tgtest', t),
      eventStmt(env.DB, t, r.ok ? 'telegram_ok' : 'telegram_ko', null, r.ok ? 'message de test reçu par Telegram' : scrub(r.error, secrets)),
    ]);
    return back('/', r.ok ? 'Message de test envoyé sur Telegram.' : `Telegram : ${scrub(r.error, secrets)}`, r.ok);
  }
  return renderMessage('Introuvable', '', 404);
}

export default {
  async scheduled(_event, env, ctx) {
    const guard = (label, p) => p.catch((e) => console.error(`${label} failed`, scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN, env.GITHUB_TOKEN, env.AGENT_KEY])));
    const hub = async () => {
      await guard('agents', agentWatchdog(env).then((r) => r.length && console.log('agents', r.join(','))));
      await guard('webhook', (async () => {
        const o = await env.DB.prepare("SELECT value FROM meta WHERE key = 'origin'").first();
        if (o?.value && telegramProblems(env).length === 0) await ensureWebhook(env, o.value);
      })());
    };
    if (!isDirect(env)) {
      ctx.waitUntil((async () => {
        await ensureSchema(env.DB);
        await guard('watchdog', watchdog(env).then((r) => console.log('watchdog', JSON.stringify(r))));
        await guard('dispatch', maybeDispatch(env).then((r) => console.log('dispatch', JSON.stringify(r))));
        await hub();
      })());
      return;
    }
    ctx.waitUntil((async () => {
      await guard('run', runChecks(env, {}).then((r) => {
        const line = JSON.stringify({
          ok: r.ok, skipped: r.skipped || false, reason: r.reason, alerted: r.alerted,
          results: (r.results || []).map((x) => `${x.label}:${x.status}:${x.slots}`),
        });
        if (r.ok) console.log('run', line); else console.warn('run non effectué', line);
      }));
      await hub();
    })());
  },
  async fetch(request, env, ctx) {
    try {
      let res = await handle(request, env, ctx);
      // Clé valide dans l'adresse : page servie directement (pas de redirection qui dépend du cookie : les navigateurs
      // intégrés de Telegram et autres les perdent), cookie posé, liens et formulaires gardent la clé.
      const url = new URL(request.url);
      const k = url.searchParams.get('key');
      if (k && String(env.DASHBOARD_KEY || '').length >= 12 && safeEqual(k, env.DASHBOARD_KEY) && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tg/')) {
        const add = (u) => (u.startsWith('/') && !u.startsWith('//') ? `${u}${u.includes('?') ? '&' : '?'}key=${encodeURIComponent(k)}` : u);
        const h = new Headers(res.headers);
        h.append('set-cookie', `dk=${await cookieToken(env.DASHBOARD_KEY)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
        if (h.get('location')) h.set('location', add(h.get('location')));
        let body = res.body;
        if ((h.get('content-type') || '').includes('text/html')) {
          body = (await res.text()).replace(/(href|action)="(\/[^"]*)"/g, (_m, a, u) => `${a}="${add(u.replace(/&amp;/g, '&')).replace(/&/g, '&amp;')}"`);
          h.delete('content-length');
        }
        res = new Response(body, { status: res.status, headers: h });
      }
      return withHeaders(res);
    } catch (e) {
      console.error('request failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY, env.AGENT_KEY]));
      return withHeaders(renderMessage('Erreur', 'Erreur interne (voir les logs du Worker).', 500));
    }
  },
};
