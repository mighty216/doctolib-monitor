import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { watchdog } from '../src/runner.js';
import { parseWatches } from '../src/doctolib.js';
import { makeEnv, installFetch, iso, URL_A, URL_B, TOKEN, KEY } from './helpers.js';

const INGEST = 'cle-ingest-de-test-0123456789';
let env;
let net;
beforeEach(() => {
  env = makeEnv({ MODE: 'ingest', INGEST_KEY: INGEST });
  net = installFetch({ doctolib: () => { throw new Error('le Worker ne doit jamais appeler Doctolib en mode collecteur'); } });
});

const keys = parseWatches(`${URL_A} ${URL_B}`).watches.map((w) => w.key);
const [KA, KB] = keys;
const meta = (k) => env.DB.raw.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
const rows = (sql) => env.DB.raw.prepare(sql).all();

const call = (path, { method = 'GET', body, key = INGEST, headers = {} } = {}) =>
  worker.fetch(new Request(`https://x.test${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }), env);

const okRes = (key, label, slots = [], extra = {}) => ({ key, label, status: 'ok', slots, next: null, http: 200, ms: 800, agendas: ['222'], ...extra });

test('ingest : authentification obligatoire (Bearer), clé absente ou trop courte = 503', async () => {
  assert.equal((await call('/api/ingest', { method: 'POST', body: { results: [] }, key: null })).status, 401);
  assert.equal((await call('/api/ingest', { method: 'POST', body: { results: [] }, key: 'mauvaise-cle-mauvaise' })).status, 401);
  assert.equal((await call('/api/ingest/config', { key: null })).status, 401);
  // la clé du tableau de bord ne donne pas accès à l'ingestion
  assert.equal((await call('/api/ingest/config', { key: KEY })).status, 401);
  env = makeEnv({ MODE: 'ingest', INGEST_KEY: 'court' });
  assert.equal((await call('/api/ingest/config', { key: 'court' })).status, 503);
});

test('config : cabinets analysés (sans URL ni secret) + ancienneté du dernier passage', async () => {
  const r = await call('/api/ingest/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.watches.length, 2);
  assert.deepEqual(j.watches[0].motives, ['2522294']);
  assert.equal(j.watches[0].practice, '173867');
  assert.equal(j.sinceLastSec, null);
  const txt = JSON.stringify(j);
  assert.ok(!txt.includes('doctolib.fr') && !txt.includes(TOKEN) && !txt.includes(KEY));
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'Cabinet A')] } });
  const j2 = await (await call('/api/ingest/config')).json();
  assert.ok(j2.sinceLastSec >= 0 && j2.sinceLastSec < 10);
});

test('ingest : créneau reçu -> une alerte Telegram avec le lien, état et historique enregistrés', async () => {
  const s = iso(2, '10:00');
  const r = await call('/api/ingest', { method: 'POST', body: { collector: 'github-actions', results: [okRes(KA, 'Cabinet A, Lyon', [s]), okRes(KB, 'Cabinet B', [])] } });
  assert.equal(r.status, 200);
  assert.equal(net.sent.length, 1);
  assert.match(net.sent[0], /Cabinet A, Lyon/);
  assert.ok(net.sent[0].includes('placeId=practice-173867'));
  assert.equal(rows('SELECT * FROM checks').length, 2);
  assert.equal(rows('SELECT * FROM slots WHERE alerted = 1').length, 1);
  assert.equal(meta('collector'), 'github-actions');
  // même contenu au passage suivant : pas de doublon
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'Cabinet A, Lyon', [s]), okRes(KB, 'Cabinet B', [])] } });
  assert.equal(net.sent.length, 1);
  // nouveau créneau
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'Cabinet A, Lyon', [s, iso(3, '11:00')])] } });
  assert.equal(net.sent.length, 2);
});

test("ingest : cabinet bloqué -> état précédent gardé, panne signalée une fois, puis reprise", async () => {
  const s = iso(2, '10:00');
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'A', [s])] } });
  net.sent.length = 0;
  const blocked = { key: KA, status: 'blocked', http: 403, error: 'HTTP 403 (IP ou client bloqué)', slots: [iso(1)] };
  for (let i = 0; i < 4; i++) await call('/api/ingest', { method: 'POST', body: { results: [blocked] } });
  assert.equal(net.sent.length, 1, 'une seule alerte de panne (FAIL_ALERT_AFTER=3)');
  assert.match(net.sent[0], /en échec/);
  assert.equal(rows('SELECT * FROM slots').length, 1, 'créneaux conservés, ceux envoyés avec un échec ignorés');
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'A', [s])] } });
  assert.equal(net.sent.length, 2);
  assert.match(net.sent[1], /repris/);
  assert.equal(net.sent.filter((t) => /Créneau/.test(t)).length, 0, 'pas de fausse ré-alerte à la reprise');
});

test('ingest : entrées hostiles ou incohérentes assainies', async () => {
  const far = '2099-01-01T09:00:00.000+02:00';
  const r = await call('/api/ingest', {
    method: 'POST',
    body: {
      collector: '<script>x</script>',
      results: [
        okRes('inconnu-123', 'Pirate', [iso(1)]),
        okRes(KA, `<img src=x onerror=1>`, [iso(1), 'pas-une-date', far, 42, iso(1)]),
        okRes(KA, 'doublon ignoré', [iso(2)]),
        { key: KB, status: 'nimporte', error: `fuite ${TOKEN} et ${INGEST}` },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(rows('SELECT * FROM slots').length, 1, 'une seule date valide, dans l\'horizon, dédoublonnée');
  const chk = rows('SELECT watch, status, error FROM checks ORDER BY id');
  assert.equal(chk.length, 2);
  assert.equal(chk[1].status, 'error');
  assert.ok(!chk[1].error.includes(TOKEN) && !chk[1].error.includes(INGEST));
  assert.ok(!/[<>]/.test(meta('collector')));
  const cookie = (await call(`/?key=${KEY}`, { key: null })).headers.get('set-cookie').split(';')[0];
  const html = await (await call('/', { key: null, headers: { cookie } })).text();
  assert.ok(!html.includes('<img src=x'));
});

test('ingest : requêtes invalides refusées sans toucher à l\'état', async () => {
  assert.equal((await call('/api/ingest', { method: 'POST', body: 'pas du json' })).status, 400);
  assert.equal((await call('/api/ingest', { method: 'POST', body: { results: 'x' } })).status, 400);
  assert.equal((await call('/api/ingest', { method: 'POST', body: { results: [okRes('zzz', 'x')] } })).status, 400);
  assert.equal((await call('/api/ingest', { method: 'POST', body: JSON.stringify({ results: [], pad: 'x'.repeat(200001) }) })).status, 413);
  assert.equal((await call('/api/ingest', { method: 'GET' })).status, 404);
  assert.equal(rows('SELECT * FROM checks').length, 0);
});

test('mode collecteur : le bouton « Vérifier maintenant » disparaît, /run refusé, tableau de bord lisible', async () => {
  await call('/api/ingest', { method: 'POST', body: { collector: 'github-actions', results: [okRes(KA, 'Cabinet A', [iso(2)]), okRes(KB, 'Cabinet B')] } });
  const cookie = (await call(`/?key=${KEY}`, { key: null })).headers.get('set-cookie').split(';')[0];
  const html = await (await call('/', { key: null, headers: { cookie } })).text();
  assert.ok(!html.includes('action="/run"'));
  assert.match(html, /Tout fonctionne/);
  assert.match(html, /github-actions/);
  const r = await call('/run', { method: 'POST', key: null, headers: { cookie } });
  assert.equal(r.status, 409);
});

test('mode collecteur : INGEST_KEY manquant signalé sur le tableau de bord', async () => {
  env = makeEnv({ MODE: 'ingest' });
  const cookie = (await call(`/?key=${KEY}`, { key: null })).headers.get('set-cookie').split(';')[0];
  const html = await (await call('/', { key: null, headers: { cookie } })).text();
  assert.match(html, /INGEST_KEY/);
});

test('watchdog : silence signalé une seule fois, reprise signalée, jamais de bruit si tout va bien', async () => {
  const set = (k, v) => env.DB.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const now = Math.floor(Date.now() / 1000);
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'A')] } });
  net.sent.length = 0;
  assert.equal((await watchdog(env)).alerted, false);
  assert.equal(net.sent.length, 0);

  set('last_run', now - 80 * 60);
  const r1 = await watchdog(env);
  assert.equal(r1.alerted, true);
  assert.match(net.sent[0], /aucune donnée reçue/);
  await watchdog(env);
  await watchdog(env);
  assert.equal(net.sent.length, 1, 'une seule alerte pour le même silence');

  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'A')] } });
  assert.equal(net.sent.length, 2);
  assert.match(net.sent[1], /de nouveau/);
  assert.equal(meta('stale_alerted'), undefined);

  set('last_run', now - 200 * 60);
  await watchdog(env);
  assert.equal(net.sent.length, 3, 'un nouveau silence est de nouveau signalé');
});

test('watchdog : jamais de donnée reçue -> alerte après le délai, pas avant', async () => {
  const set = (k, v) => env.DB.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  assert.equal((await watchdog(env)).alerted, false);
  assert.equal(net.sent.length, 0);
  set('watchdog_since', Math.floor(Date.now() / 1000) - 100 * 60);
  const r = await watchdog(env);
  assert.equal(r.alerted, true);
  assert.match(net.sent[0], /jamais envoyé/);
});

test('watchdog : Telegram en panne -> nouvelle tentative au passage suivant', async () => {
  const set = (k, v) => env.DB.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  await call('/api/ingest', { method: 'POST', body: { results: [okRes(KA, 'A')] } });
  set('last_run', Math.floor(Date.now() / 1000) - 90 * 60);
  net.tg.ok = false; net.tg.status = 401;
  assert.equal((await watchdog(env)).alerted, false);
  net.tg.ok = true;
  assert.equal((await watchdog(env)).alerted, true);
});

test('cron en mode collecteur : watchdog seulement, aucun appel Doctolib', async () => {
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(net.calls.filter((c) => c.includes('doctolib')).length, 0);
  assert.equal(rows('SELECT * FROM checks').length, 0);
  assert.equal(meta('watchdog_since') !== undefined, true);
});

// ---------------------------------------------------------------------------- déclenchement par Cloudflare
import { maybeDispatch } from '../src/github.js';
import { ensureSchema } from '../src/store.js';

const GHT = 'github_pat_FAKE_TOKEN_0123456789_abcdefghijklmnop';
const setMeta = (k, v) => env.DB.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const withGh = (extra = {}) => { env = makeEnv({ MODE: 'ingest', INGEST_KEY: INGEST, GITHUB_TOKEN: GHT, GITHUB_REPO: 'pierrick/doctolib-monitor', ...extra }); };
const withRandom = async (v, fn) => { const o = Math.random; Math.random = () => v; try { return await fn(); } finally { Math.random = o; } };
const now = () => Math.floor(Date.now() / 1000);

test('dispatch : non configuré -> rien (aucun appel GitHub)', async () => {
  const r = await maybeDispatch(env);
  assert.equal(r.dispatched, false);
  assert.equal(net.gh.length, 0);
});

test('dispatch : jamais de passage -> lancement immédiat, bon dépôt, bon jeton, force=true', async () => {
  withGh();
  const r = await maybeDispatch(env);
  assert.equal(r.dispatched, true);
  assert.equal(net.gh.length, 1);
  assert.equal(net.gh[0].path, '/repos/pierrick/doctolib-monitor/actions/workflows/collector.yml/dispatches');
  assert.equal(net.gh[0].auth, `Bearer ${GHT}`);
  assert.deepEqual(net.gh[0].body, { ref: 'main', inputs: { force: 'true' } });
  assert.ok(meta('last_dispatch'));
});

test('dispatch : rythme irrégulier (trop tôt / tirage / obligatoire)', async () => {
  withGh();
  await ensureSchema(env.DB);
  setMeta('last_run', now() - 3 * 60);
  assert.equal((await withRandom(0, () => maybeDispatch(env))).dispatched, false, '3 min : trop tôt même avec un tirage favorable');
  setMeta('last_run', now() - 10 * 60);
  assert.equal((await withRandom(0.9, () => maybeDispatch(env))).dispatched, false, 'tirage défavorable');
  assert.equal((await withRandom(0.1, () => maybeDispatch(env))).dispatched, true, 'tirage favorable');
  assert.equal(net.gh.length, 1);
  // juste après un lancement : on n'en relance pas un second pendant que le collecteur travaille
  assert.equal((await withRandom(0, () => maybeDispatch(env))).dispatched, false);
  setMeta('last_dispatch', now() - 30 * 60); setMeta('last_run', now() - 30 * 60);
  assert.equal((await withRandom(0.99, () => maybeDispatch(env))).dispatched, true, '26 min et plus : obligatoire');
});

test('dispatch : refus de GitHub -> réessai au prochain tick, alerte Telegram une seule fois à la 3e erreur, jeton jamais divulgué', async () => {
  withGh();
  net.ghStatus = 401;
  for (let i = 0; i < 5; i++) await maybeDispatch(env);
  assert.equal(net.gh.length, 5, 'réessaie à chaque tick tant que ça échoue');
  assert.equal(net.sent.length, 1);
  assert.match(net.sent[0], /n'arrive plus à lancer le collecteur/);
  assert.ok(!net.sent[0].includes(GHT));
  const ev = rows("SELECT detail FROM events WHERE type = 'dispatch_failed'");
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => !e.detail.includes(GHT)));
  net.ghStatus = 204;
  assert.equal((await maybeDispatch(env)).dispatched, true);
  assert.equal(meta('dispatch_fail'), '0');
});

test('dispatch : GitHub injoignable -> pas de plantage, erreur consignée', async () => {
  withGh();
  const f = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes('api.github.com')) throw new TypeError('boom'); return f(u, i); };
  const r = await maybeDispatch(env);
  assert.equal(r.dispatched, false);
  assert.match(r.reason, /réseau/);
});

test('cron : chien de garde puis lancement du collecteur', async () => {
  withGh();
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(net.gh.length, 1);
  assert.equal(net.calls.filter((c) => c.includes('availabilities')).length, 0, 'jamais d\'appel Doctolib depuis le Worker');
});
