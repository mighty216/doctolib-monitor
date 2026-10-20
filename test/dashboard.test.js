import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runChecks } from '../src/runner.js';
import { esc } from '../src/dashboard.js';
import { makeEnv, installFetch, standardDoctolib, avail, iso, INFO, KEY, URL_A } from './helpers.js';

let env;
beforeEach(() => { env = makeEnv(); });
const get = (path, headers = {}, method = 'GET') => worker.fetch(new Request(`https://x.test${path}`, { method, headers }), env);
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

async function login() {
  const r = await get(`/?key=${KEY}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
  return cookieOf(r);
}

test('auth : sans clé 401, mauvaise clé 401, clé absente de la config 503', async () => {
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/?key=mauvaise-cle-mauvaise')).status, 401);
  assert.equal((await get('/api/status')).status, 401);
  assert.equal((await get('/run', {}, 'POST')).status, 401);
  env = makeEnv({ DASHBOARD_KEY: '' });
  assert.equal((await get('/')).status, 503);
  env = makeEnv({ DASHBOARD_KEY: 'court' });
  assert.equal((await get(`/?key=court`)).status, 503, 'clé trop courte refusée');
});

test('en-têtes de sécurité et cookie sans la clé en clair', async () => {
  const r = await get(`/?key=${KEY}`);
  assert.ok(!r.headers.get('set-cookie').includes(KEY));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
});

test('tableau de bord : état, créneaux, historique, journal', async () => {
  installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3), iso(3, '10:30')), 444: avail() }) });
  await runChecks(env);
  await runChecks(env);
  const cookie = await login();
  const res = await get('/', { cookie });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Tout fonctionne/);
  assert.match(html, /Cabinet A, Lyon 6e/);
  assert.match(html, /Cabinet B, Villeurbanne/);
  assert.match(html, /09:00/); assert.match(html, /10:30/);
  assert.match(html, /Alerte envoyée/);
  assert.equal((html.match(/class="c ok"/g) || []).length, 4, '2 cabinets x 2 contrôles dans la frise');
  assert.match(html, /Vérifier maintenant/);
});

test('tableau de bord : cabinet bloqué -> "Problème" + message d\'erreur', async () => {
  installFetch({ doctolib: (p) => (p.includes('slot_selection_funnel') ? INFO : new Response('no', { status: 403 })) });
  await runChecks(env);
  const html = await (await get('/', { cookie: await login() })).text();
  assert.match(html, /Problème sur 2 cabinet/);
  assert.match(html, /HTTP 403/);
});

test('tableau de bord : cron arrêté détecté', async () => {
  installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env);
  env.DB.raw.prepare("UPDATE meta SET value = ? WHERE key = 'last_run'").run(String(Math.floor(Date.now() / 1000) - 3 * 3600));
  const html = await (await get('/', { cookie: await login() })).text();
  assert.match(html, /cron semble arrêté/);
});

test('tableau de bord : avant le premier passage / config invalide', async () => {
  let html = await (await get('/', { cookie: await login() })).text();
  assert.match(html, /En attente de la première vérification/);
  env = makeEnv({ DOCTOLIB_URLS: 'https://exemple.fr/x', TELEGRAM_CHAT_ID: 'abc' });
  html = await (await get('/', { cookie: await login() })).text();
  assert.match(html, /Configuration incomplète/);
  assert.match(html, /URL n°1/);
  assert.match(html, /TELEGRAM_CHAT_ID/);
});

test('XSS : libellés, erreurs et événements sont échappés', async () => {
  const evil = '<script>alert(1)</script>"\'&';
  installFetch({
    doctolib: (p) => (p.includes('slot_selection_funnel')
      ? { data: { ...INFO.data, places: [{ id: 'practice-173867', name: evil }] } }
      : { availabilities: [], next_slot: null }),
  });
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  await runChecks(env);
  env.DB.raw.prepare("INSERT INTO events (ts, type, watch, detail) VALUES (?, 'down', 'x', ?)").run(Math.floor(Date.now() / 1000), evil);
  const html = await (await get('/', { cookie: await login() })).text();
  assert.ok(!html.includes('<script>alert(1)'), 'balise script injectée');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(esc(`<>"'&`), '&lt;&gt;&quot;&#39;&amp;');
});

test('/api/status : JSON complet, sans aucun secret', async () => {
  installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  await runChecks(env);
  const r = await get('/api/status', { cookie: await login() });
  assert.equal(r.status, 200);
  const txt = await r.text();
  const j = JSON.parse(txt);
  assert.equal(j.watches.length, 2);
  assert.equal(j.watches[0].slots.length, 1);
  assert.ok(!txt.includes(KEY) && !txt.includes('AAFake'));
});

test('bouton "Vérifier maintenant" : lance un passage, puis limité à 1 par 2 minutes', async () => {
  const st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  const cookie = await login();
  const r1 = await get('/run', { cookie }, 'POST');
  assert.equal(r1.status, 303);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 2);
  assert.equal(st.sent.length, 1);
  const r2 = await get('/run', { cookie }, 'POST');
  assert.equal(r2.status, 429);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 2, 'pas de second passage');
});

test('cron (scheduled) : exécute un passage complet', async () => {
  installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  let waited;
  await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
  await waited;
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 2);
});

test('routes inconnues : 404 (après authentification)', async () => {
  const cookie = await login();
  assert.equal((await get('/admin', { cookie })).status, 404);
});

test('bouton "Tester Telegram" : message envoyé, résultat dans le journal, limité', async () => {
  const st = installFetch({ doctolib: standardDoctolib({}) });
  const cookie = await login();
  assert.equal((await get('/test-telegram', {}, 'POST')).status, 401);
  assert.equal((await get('/test-telegram', { cookie }, 'POST')).status, 303);
  assert.match(st.sent[0], /Telegram fonctionne/);
  assert.equal((await get('/test-telegram', { cookie }, 'POST')).status, 429);
  let html = await (await get('/', { cookie })).text();
  assert.match(html, /Test Telegram réussi/);
  assert.match(html, /Tester Telegram/);
  env = makeEnv(); st.tg.ok = false; st.tg.status = 401;
  const c2 = await login();
  assert.equal((await get('/test-telegram', { cookie: c2 }, 'POST')).status, 303);
  html = await (await get('/', { cookie: c2 })).text();
  assert.match(html, /Test Telegram ÉCHOUÉ/);
  assert.ok(!html.includes('AAFake'));
});
