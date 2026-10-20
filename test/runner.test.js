import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../src/runner.js';
import { parseWatches } from '../src/doctolib.js';
import { formatSlots, scrub } from '../src/util.js';
import {
  makeEnv, installFetch, standardDoctolib, avail, iso, INFO, URL_A, URL_B, TOKEN,
} from './helpers.js';

let env;
beforeEach(() => { env = makeEnv(); });
const rows = (sql) => env.DB.raw.prepare(sql).all();
const meta = (k) => env.DB.raw.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;

test('parseWatches : 2 URL -> 2 cabinets, pid ignoré, doublon écarté, URL invalide signalée', () => {
  const { watches, errors } = parseWatches(`${URL_A} ${URL_B},${URL_A}\nhttps://exemple.fr/pas-doctolib`);
  assert.deepEqual(watches.map((w) => w.practice), ['173867', '205310']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /URL n°4/);
});

test('premier passage : agendas résolus par cabinet, 1 alerte regroupée, liens corrects', async () => {
  const st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)), 444: avail(iso(5, '14:30')) }) });
  const r = await runChecks(env);
  assert.equal(r.ok, true);
  assert.equal(st.sent.length, 1);
  const msg = st.sent[0];
  assert.match(msg, /Cabinet A, Lyon 6e/);
  assert.match(msg, /Cabinet B, Villeurbanne/);
  assert.match(msg, /09:00/);
  assert.match(msg, /14:30/);
  assert.ok(msg.includes('practice-173867') && msg.includes('practice-205310'));
  const agendas = rows("SELECT key FROM meta WHERE key LIKE 'agenda:%'");
  assert.equal(agendas.length, 2);
  assert.deepEqual(JSON.parse(meta('agenda:173867-2522294')).agendas, ['222']);
  assert.deepEqual(JSON.parse(meta('agenda:205310-2522294')).agendas, ['444']);
  const infoCalls = st.calls.filter((c) => c.includes('slot_selection_funnel'));
  assert.equal(infoCalls.length, 1, 'info.json appelé une seule fois pour le même praticien (cache par slug)');
});

test('passage identique : pas de doublon ; nouveau créneau sur B : alerte B seul', async () => {
  const st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)), 444: avail(iso(5, '14:30')) }) });
  await runChecks(env);
  await runChecks(env);
  assert.equal(st.sent.length, 1);
  installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)), 444: avail(iso(5, '14:30'), iso(6, '10:00')) }) });
  const st2 = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)), 444: avail(iso(5, '14:30'), iso(6, '10:00')) }) });
  await runChecks(env);
  assert.equal(st2.sent.length, 1);
  assert.match(st2.sent[0], /Cabinet B/);
  assert.doesNotMatch(st2.sent[0], /Cabinet A/);
  assert.match(st2.sent[0], /10:00/);
  assert.doesNotMatch(st2.sent[0], /14:30/);
});

test('créneau disparu puis revenu : ré-alerte', async () => {
  let st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  await runChecks(env);
  st = installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env);
  assert.equal(rows('SELECT * FROM slots').length, 0, 'créneau disparu oublié');
  st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  await runChecks(env);
  assert.equal(st.sent.length, 1);
});

test('Telegram KO : le créneau reste "non alerté" puis part au passage suivant', async () => {
  const st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  st.tg.ok = false; st.tg.status = 500;
  await runChecks(env);
  assert.equal(st.sent.length, 0);
  assert.deepEqual(rows('SELECT alerted FROM slots').map((r) => r.alerted), [0]);
  assert.ok(rows('SELECT * FROM events').some((e) => e.type === 'alert_failed'));
  st.tg.ok = true;
  await runChecks(env);
  assert.equal(st.sent.length, 1);
  assert.deepEqual(rows('SELECT alerted FROM slots').map((r) => r.alerted), [1]);
});

test('Telegram mal configuré : les vérifications continuent, aucune alerte, événement consigné', async () => {
  env = makeEnv({ TELEGRAM_BOT_TOKEN: '' });
  const st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)) }) });
  await runChecks(env);
  assert.equal(st.sent.length, 0);
  assert.equal(rows('SELECT * FROM checks').length, 2);
  assert.ok(rows('SELECT * FROM events').some((e) => e.type === 'alert_failed' && /TELEGRAM_BOT_TOKEN/.test(e.detail)));
});

test('cabinet B bloqué : A traité, état de B conservé, aucune fausse alerte à la reprise', async () => {
  installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3)), 444: avail(iso(5, '14:30')) }) });
  await runChecks(env);
  const partial = (path, params) => {
    if (path.includes('slot_selection_funnel')) return INFO;
    return params.agenda_ids === '444' ? new Response('no', { status: 403 }) : avail(iso(3), iso(4, '16:00'));
  };
  let st = installFetch({ doctolib: partial });
  await runChecks(env);
  assert.equal(st.sent.length, 1);
  assert.match(st.sent[0], /16:00/);
  const last = rows("SELECT * FROM checks WHERE watch = '205310-2522294' ORDER BY id DESC LIMIT 1")[0];
  assert.equal(last.status, 'blocked');
  assert.equal(last.http, 403);
  assert.equal(rows("SELECT * FROM slots WHERE watch = '205310-2522294'").length, 1, 'état de B conservé');
  st = installFetch({ doctolib: standardDoctolib({ 222: avail(iso(3), iso(4, '16:00')), 444: avail(iso(5, '14:30')) }) });
  await runChecks(env);
  assert.equal(st.sent.length, 0);
});

test('pannes répétées : alerte unique à N échecs, puis message de reprise', async () => {
  let st = installFetch({ doctolib: (p) => (p.includes('slot_selection_funnel') ? INFO : new Response('x', { status: 403 })) });
  for (let i = 0; i < 5; i++) await runChecks(env);
  const down = st.sent.filter((m) => /échec d'affilée/.test(m));
  assert.equal(down.length, 2, 'un message par cabinet, une seule fois (FAIL_ALERT_AFTER=3)');
  assert.ok(rows('SELECT * FROM events').some((e) => e.type === 'down'));
  st = installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env);
  assert.equal(st.sent.filter((m) => /a repris normalement/.test(m)).length, 2);
});

test('réponses anormales : HTML -> schema, JSON sans availabilities -> schema, 404 -> fatal + cache agenda purgé', async () => {
  installFetch({ doctolib: standardDoctolib({ 222: avail() }) });
  await runChecks(env);
  assert.ok(meta('agenda:173867-2522294'));
  installFetch({ doctolib: (p) => (p.includes('slot_selection_funnel') ? INFO : new Response('<html>captcha</html>', { status: 200 })) });
  await runChecks(env);
  assert.equal(rows('SELECT status FROM checks ORDER BY id DESC LIMIT 1')[0].status, 'schema');
  installFetch({ doctolib: (p) => (p.includes('slot_selection_funnel') ? INFO : { erreur: 'x' }) });
  await runChecks(env);
  assert.equal(rows('SELECT status FROM checks ORDER BY id DESC LIMIT 1')[0].status, 'schema');
  installFetch({ doctolib: (p) => (p.includes('slot_selection_funnel') ? INFO : new Response('nf', { status: 404 })) });
  await runChecks(env);
  assert.equal(rows('SELECT status FROM checks ORDER BY id DESC LIMIT 1')[0].status, 'fatal');
  assert.equal(meta('agenda:173867-2522294'), undefined, 'cache agenda purgé après 404');
});

test('réseau coupé : 3 tentatives puis "blocked"', async () => {
  let n = 0;
  installFetch({ doctolib: (p) => { if (p.includes('slot_selection_funnel')) return INFO; n++; throw new TypeError('down'); } });
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  await runChecks(env);
  assert.equal(n, 3);
  assert.equal(rows('SELECT status FROM checks')[0].status, 'blocked');
});

test('429 puis 200 : récupéré', async () => {
  let n = 0;
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  const st = installFetch({
    doctolib: (p, params) => {
      if (p.includes('slot_selection_funnel')) return INFO;
      return n++ === 0 ? new Response('slow', { status: 429, headers: { 'retry-after': '1' } }) : avail(iso(3));
    },
  });
  await runChecks(env);
  assert.equal(rows('SELECT status FROM checks')[0].status, 'ok');
  assert.equal(st.sent.length, 1);
});

test('aucun agenda correspondant : fatal avec message explicite', async () => {
  installFetch({ doctolib: () => ({ data: { agendas: [{ id: 1, practice_id: 5, visit_motive_ids: [7] }], visit_motives: [{ id: 7, name: 'Autre' }] } }) });
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  await runChecks(env);
  const c = rows('SELECT * FROM checks')[0];
  assert.equal(c.status, 'fatal');
  assert.match(c.error, /Aucun agenda/);
});

test('créneau hors horizon ignoré ; next_slot lointain : appels bornés', async () => {
  const far = iso(60, '10:00');
  const st = installFetch({ doctolib: standardDoctolib({ 222: { availabilities: [], next_slot: far } }) });
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  await runChecks(env);
  assert.equal(st.sent.length, 0);
  const avCalls = st.calls.filter((c) => c.startsWith('/availabilities.json'));
  assert.ok(avCalls.length <= 8, `appels availabilities: ${avCalls.length}`);
  assert.equal(meta('next:173867-2522294'), far);
});

test('verrou : une exécution déjà en cours est ignorée', async () => {
  installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env); // crée le schéma
  env.DB.raw.prepare("UPDATE meta SET value = ? WHERE key = 'lock'").run(String(Math.floor(Date.now() / 1000)));
  const r = await runChecks(env);
  assert.equal(r.skipped, true);
  env.DB.raw.prepare("UPDATE meta SET value = ? WHERE key = 'lock'").run(String(Math.floor(Date.now() / 1000) - 1000));
  assert.equal((await runChecks(env)).ok, true, 'verrou périmé : repris');
  assert.equal(meta('lock'), '0', 'verrou libéré');
});

test('message de vie : jamais au 1er passage, envoyé quand dû, puis espacé', async () => {
  env = makeEnv({ HEARTBEAT_HOURS: '24' });
  const st = installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env);
  assert.equal(st.sent.length, 0);
  env.DB.raw.prepare("UPDATE meta SET value = ? WHERE key = 'heartbeat'").run(String(Math.floor(Date.now() / 1000) - 25 * 3600));
  await runChecks(env);
  assert.equal(st.sent.filter((m) => /toujours actif/.test(m)).length, 1);
  await runChecks(env);
  assert.equal(st.sent.filter((m) => /toujours actif/.test(m)).length, 1);
});

test('rétention : les anciens contrôles sont purgés', async () => {
  installFetch({ doctolib: standardDoctolib({}) });
  await runChecks(env);
  env.DB.raw.prepare("INSERT INTO checks (ts, watch, status) VALUES (1000, 'x', 'ok')").run();
  await runChecks(env);
  assert.equal(rows("SELECT * FROM checks WHERE watch = 'x'").length, 0);
});

test('secrets : jamais dans les erreurs ni le journal', async () => {
  installFetch({ doctolib: (p) => { if (p.includes('slot_selection_funnel')) return INFO; throw new Error(`échec ${TOKEN}`); } });
  env = makeEnv({ DOCTOLIB_URLS: URL_A });
  await runChecks(env);
  const dump = JSON.stringify([rows('SELECT * FROM checks'), rows('SELECT * FROM events'), rows('SELECT * FROM meta')]);
  assert.ok(!dump.includes('AAFakeToken'));
  assert.equal(scrub(`x ${TOKEN} y`, [TOKEN]), 'x *** y');
});

test('formatSlots', () => {
  assert.equal(formatSlots(['2026-10-21T09:00:00.000+02:00', '2026-10-21T10:30:00.000+02:00']), '- mer 21/10 : 09:00, 10:30');
});
