import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { webhookPathSecret, webhookHeaderSecret } from '../src/tgbot.js';
import { agentWatchdog } from '../src/hub.js';
import { ensureSchema } from '../src/store.js';
import { makeEnv, URL_A, URL_B, KEY, TOKEN } from './helpers.js';

const AGENT = 'agent-key-de-test-1234567890';
const URL_C = URL_A.replace('practice-173867', 'practice-999111');
let env; let tg; let gh; let pending = [];

beforeEach(async () => {
  pending = [];
  env = makeEnv({ MODE: 'ingest', AGENT_KEY: AGENT, INGEST_KEY: 'ingest-key-de-test-1234567890', GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'me/doctolib-monitor', DOCTOLIB_URLS: URL_A });
  tg = []; gh = [];
  await ensureSchema(env.DB);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.telegram.org') {
      const method = url.pathname.split('/').pop();
      tg.push({ method, ...JSON.parse(init.body || '{}') });
      return new Response('{"ok":true,"result":{"url":"https://other"}}', { status: 200 });
    }
    if (url.hostname === 'api.github.com') { gh.push(url.pathname); return new Response(null, { status: 204 }); }
    return new Response('{}', { status: 404 });
  };
});

const req = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request(`https://hub.test${path}`, { method, headers, body }), env, { waitUntil: (p) => { pending.push(p); } });
async function login() {
  const r = await req(`/?key=${KEY}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const form = (o) => ({ body: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const post = async (path, o = {}, extra = {}) => {
  const cookie = await login();
  const f = form(o);
  return req(path, { method: 'POST', body: f.body, headers: { ...f.headers, cookie, ...extra } });
};
const sentTexts = () => tg.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text);
const agent = (path, o = {}) => req(path, { ...o, headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json', ...(o.headers || {}) } });
const report = (body) => agent('/api/agent/report', { method: 'POST', body: JSON.stringify(body) });
const rows = (sql, ...a) => env.DB.raw.prepare(sql).all(...a);

async function webhook(update, { path, header } = {}) {
  const p = path ?? await webhookPathSecret(env);
  const h = header ?? await webhookHeaderSecret(env);
  const res = await req(`/tg/${p}`, { method: 'POST', body: JSON.stringify(update), headers: { 'x-telegram-bot-api-secret-token': h } });
  await Promise.all(pending.splice(0));
  return res;
}
let uid = 100;
const say = (text, chat = 42) => webhook({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } });
const press = (data, chat = 42, mid = 7) => webhook({ update_id: ++uid, callback_query: { id: 'cb1', from: { id: chat }, data, message: { chat: { id: chat }, message_id: mid } } });

// ------------------------------------------------------------------ surveillances Doctolib
test('web : ajouter / pause / reprendre / renommer / supprimer une surveillance', async () => {
  let r = await post('/doctolib/add', { url: URL_B, name: 'Dr Bleu' });
  assert.equal(r.status, 303);
  assert.doesNotMatch(r.headers.get('location'), /bad=1/);
  assert.equal(rows('SELECT key FROM watches').length, 2);
  assert.ok(gh.length >= 1, 'première vérification demandée à GitHub');
  assert.ok(rows("SELECT * FROM meta WHERE key LIKE 'new:%'").length === 1);

  r = await post('/doctolib/add', { url: URL_B });
  assert.match(r.headers.get('location'), /bad=1/, 'doublon refusé');
  r = await post('/doctolib/add', { url: 'https://exemple.fr/x' });
  assert.match(r.headers.get('location'), /bad=1/, 'lien invalide refusé');

  const key = rows('SELECT key FROM watches WHERE url = ?', URL_B)[0].key;
  await post('/doctolib/pause', { key });
  assert.equal(rows('SELECT paused FROM watches WHERE key = ?', key)[0].paused, 1);
  const cfg = await (await req('/api/ingest/config', { headers: { authorization: 'Bearer ingest-key-de-test-1234567890' } })).json();
  assert.equal(cfg.watches.length, 1, 'une surveillance en pause n\'est plus envoyée au collecteur');
  await post('/doctolib/resume', { key });
  assert.equal(rows('SELECT paused FROM watches WHERE key = ?', key)[0].paused, 0);
  await post('/doctolib/rename', { key, name: 'Nouveau nom' });
  const html = await (await req('/doctolib', { headers: { cookie: await login() } })).text();
  assert.match(html, /Nouveau nom/);
  await post('/doctolib/delete', { key });
  assert.equal(rows('SELECT key FROM watches').length, 1);
  const cfg2 = await (await req('/api/ingest/config', { headers: { authorization: 'Bearer ingest-key-de-test-1234567890' } })).json();
  assert.equal(cfg2.watches.length, 1);
});

test('web : formulaire d\'un autre site refusé, sans cookie refusé', async () => {
  const cookie = await login();
  const f = form({ url: URL_B });
  const r = await req('/doctolib/add', { method: 'POST', body: f.body, headers: { ...f.headers, cookie, origin: 'https://evil.test' } });
  assert.equal(r.status, 403);
  const r2 = await req('/doctolib/add', { method: 'POST', body: f.body, headers: f.headers });
  assert.equal(r2.status, 401);
  assert.equal(rows('SELECT key FROM watches WHERE url = ?', URL_B).length, 0);
});

test('surveillances reprises une seule fois du secret DOCTOLIB_URLS', async () => {
  await req('/doctolib', { headers: { cookie: await login() } });
  await post('/doctolib/delete', { key: rows('SELECT key FROM watches')[0].key });
  assert.equal(rows('SELECT key FROM watches').length, 0);
  await req('/doctolib', { headers: { cookie: await login() } });
  assert.equal(rows('SELECT key FROM watches').length, 0, 'pas de réapparition après suppression');
});

// ------------------------------------------------------------------ Telegram
test('webhook : mauvais chemin, mauvais en-tête ou autre chat -> rien ne se passe', async () => {
  assert.equal((await say('/doctolib', 42)).status, 200);
  const before = tg.length;
  assert.equal((await webhook({ update_id: 1, message: { chat: { id: 42 }, text: '/menu' } }, { path: 'faux' })).status, 403);
  assert.equal((await webhook({ update_id: 2, message: { chat: { id: 42 }, text: '/menu' } }, { header: 'faux' })).status, 403);
  assert.equal(tg.length, before);
  const n = tg.length;
  assert.equal((await say('/doctolib', 999)).status, 200);
  assert.equal((await press('dw:p:x', 999)).status, 200);
  assert.equal(tg.length, n, 'un autre chat est ignoré en silence');
});

test('webhook : la même mise à jour reçue deux fois n\'est traitée qu\'une fois', async () => {
  const u = { update_id: 5000, message: { chat: { id: 42 }, from: { id: 42 }, text: '/aide' } };
  await webhook(u); const n = tg.length; await webhook(u);
  assert.equal(tg.length, n);
});

test('Telegram : coller un lien Doctolib ajoute la surveillance', async () => {
  await say(`Regarde ${URL_B}`);
  assert.equal(rows('SELECT key FROM watches').length, 2);
  assert.match(sentTexts().join('\n'), /Surveillance ajoutée/);
  await say(URL_B);
  assert.match(sentTexts().pop(), /existe déjà/);
});

test('Telegram : /doctolib, /pause n, /reprendre n, /supprimer n', async () => {
  await say(`/ajouter ${URL_B}`);
  await say('/doctolib');
  const menu = tg.filter((c) => c.method === 'sendMessage').pop();
  assert.match(menu.text, /1\. /); assert.match(menu.text, /2\. /);
  assert.ok(menu.reply_markup.inline_keyboard.flat().some((b) => /^dw:p:/.test(b.callback_data || '')));
  await say('/pause 2');
  assert.equal(rows('SELECT paused FROM watches ORDER BY created_at, key')[1].paused, 1);
  await say('/reprendre 2');
  assert.equal(rows('SELECT paused FROM watches ORDER BY created_at, key')[1].paused, 0);
  await say('/supprimer 9');
  assert.match(sentTexts().pop(), /Numéro inconnu/);
  await say('/supprimer 2');
  assert.equal(rows('SELECT key FROM watches').length, 1);
});

test('Telegram : boutons pause / reprise / suppression avec confirmation', async () => {
  const key = rows('SELECT key FROM watches')[0]?.key || (await req('/doctolib', { headers: { cookie: await login() } }), rows('SELECT key FROM watches')[0].key);
  await press(`dw:p:${key}`);
  assert.equal(rows('SELECT paused FROM watches')[0].paused, 1);
  await press(`dw:r:${key}`);
  assert.equal(rows('SELECT paused FROM watches')[0].paused, 0);
  await press(`dw:d:${key}`);
  assert.equal(rows('SELECT key FROM watches').length, 1, 'rien n\'est supprimé avant confirmation');
  assert.match(tg.filter((c) => c.method === 'editMessageText').pop().text, /Supprimer définitivement/);
  await press(`dw:dd:${key}`);
  assert.equal(rows('SELECT key FROM watches').length, 0);
  assert.ok(tg.some((c) => c.method === 'answerCallbackQuery'));
});

test('Telegram : /verifier lance le collecteur (1 par minute)', async () => {
  await say('/verifier');
  assert.equal(gh.length, 1);
  assert.match(sentTexts().pop(), /Vérification lancée/);
  await say('/verifier');
  assert.equal(gh.length, 1);
  assert.match(sentTexts().pop(), /patiente/);
});

test('Telegram : /menu et /aide répondent, commande inconnue aussi', async () => {
  await say('/menu'); assert.match(sentTexts().pop(), /Hub de tes bots/);
  await say('/aide'); assert.match(sentTexts().pop(), /commandes/);
  await say('/blabla'); assert.match(sentTexts().pop(), /inconnue/);
});

test('POST /tg-setup branche le webhook et les commandes du menu', async () => {
  const r = await post('/tg-setup');
  assert.doesNotMatch(r.headers.get('location'), /bad=1/);
  const wh = tg.find((c) => c.method === 'setWebhook');
  assert.match(wh.url, new RegExp(`^https://hub.test/tg/${await webhookPathSecret(env)}$`));
  assert.equal(wh.secret_token, await webhookHeaderSecret(env));
  assert.ok(tg.some((c) => c.method === 'setMyCommands'));
  assert.ok(!JSON.stringify(wh).includes(TOKEN));
});

// ------------------------------------------------------------------ agents
const TGTG_STATE = {
  status: 'ok', summary: '3 favoris, 1 disponible',
  metrics: [{ label: 'Favoris', value: '3' }],
  actions: [{ id: 'favoris', label: 'Favoris' }, { id: 'annuler', label: 'Annuler', args: [{ name: 'order', label: 'Commande' }] }],
  settings: [{ key: 'interval', label: 'Intervalle (s)', type: 'number', value: '15' }],
  log: ['ligne 1'],
};

test('agent : authentification obligatoire', async () => {
  assert.equal((await req('/api/agent/poll?bot=tgtg')).status, 401);
  assert.equal((await req('/api/agent/poll?bot=tgtg', { headers: { authorization: 'Bearer faux' } })).status, 401);
  env.AGENT_KEY = 'court';
  assert.equal((await agent('/api/agent/poll?bot=tgtg')).status, 503);
});

test('agent : rapport d\'état -> bot visible sur l\'accueil et sa page', async () => {
  let r = await report({ bot: 'tgtg', name: 'Too Good To Go', state: TGTG_STATE });
  assert.equal(r.status, 200);
  assert.equal((await report({ bot: 'Mauvais Nom!', state: {} })).status, 400);
  const cookie = await login();
  const home = await (await req('/', { headers: { cookie } })).text();
  assert.match(home, /Too Good To Go/); assert.match(home, /3 favoris, 1 disponible/);
  const page = await (await req('/bot/tgtg', { headers: { cookie } })).text();
  assert.match(page, /Intervalle \(s\)/); assert.match(page, /ligne 1/); assert.match(page, /name="order"/);
  assert.equal((await req('/bot/inconnu', { headers: { cookie } })).status, 404);
});

test('agent : XSS dans l\'état -> échappé', async () => {
  await report({ bot: 'tgtg', name: '<b>x</b>', state: { ...TGTG_STATE, summary: '<script>alert(1)</script>', log: ['<img src=x onerror=1>'] } });
  const html = await (await req('/bot/tgtg', { headers: { cookie: await login() } })).text();
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});

test('commande Telegram -> file -> agent -> résultat renvoyé sur Telegram', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  await say('/favoris');
  let p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].cmd, 'favoris');
  assert.equal(p.commands[0].source, 'telegram');
  p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.equal(p.commands.length, 0, 'une commande n\'est livrée qu\'une fois');
  const id = rows('SELECT id FROM commands')[0].id;
  tg.length = 0;
  await report({ bot: 'tgtg', results: [{ id, ok: true, text: 'Voici tes favoris : A, B' }] });
  assert.match(sentTexts().pop(), /Voici tes favoris/);
  assert.equal(rows('SELECT status FROM commands')[0].status, 'done');
});

test('commande avec argument nommé : /annuler ORD-1 -> args.order', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  await say('/annuler ORD-123');
  const p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.equal(p.commands[0].args.order, 'ORD-123');
  assert.equal(p.commands[0].args.text, 'ORD-123');
});

test('bouton d\'une alerte TGTG (c:tgtg:reserve:ID) -> commande reserve', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  await report({ bot: 'tgtg', messages: [{ text: '🛍 Panier dispo', markup: { inline_keyboard: [[{ text: 'Réserver', callback_data: 'c:tgtg:reserve:12345' }, { text: 'piège', callback_data: 'dw:d:x' }]] } }] });
  const m = tg.filter((c) => c.method === 'sendMessage').pop();
  assert.equal(m.reply_markup.inline_keyboard[0].length, 1, 'callback_data étrangers filtrés');
  await press('c:tgtg:reserve:12345');
  const p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.equal(p.commands[0].cmd, 'reserve');
  assert.equal(p.commands[0].args.text, '12345');
});

test('commande vers un bot hors ligne ou inconnu : message clair, rien en file', async () => {
  await say('/favoris');
  assert.match(sentTexts().pop(), /pas encore branché/);
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  env.DB.raw.prepare('UPDATE bots SET last_seen = ?').run(Math.floor(Date.now() / 1000) - 3600);
  await say('/favoris');
  assert.match(sentTexts().pop(), /hors ligne/);
  assert.equal(rows('SELECT * FROM commands').length, 0);
});

test('web : action et réglage d\'un bot -> commandes pour l\'agent (seulement celles déclarées)', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  let r = await post('/bot/tgtg/action', { action: 'favoris' });
  assert.doesNotMatch(r.headers.get('location'), /bad=1/);
  r = await post('/bot/tgtg/action', { action: 'reboot_tout' });
  assert.match(r.headers.get('location'), /bad=1/);
  r = await post('/bot/tgtg/action', { action: 'annuler' });
  assert.match(r.headers.get('location'), /bad=1/, 'paramètre manquant');
  r = await post('/bot/tgtg/set', { key: 'interval', value: '30' });
  assert.doesNotMatch(r.headers.get('location'), /bad=1/);
  r = await post('/bot/tgtg/set', { key: 'inconnu', value: '1' });
  assert.match(r.headers.get('location'), /bad=1/);
  const p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.deepEqual(p.commands.map((c) => c.cmd), ['favoris', 'set']);
  assert.deepEqual(p.commands[1].args, { key: 'interval', value: '30' });
});

test('surveillance des agents : alerte une fois quand un bot ne répond plus, puis à son retour', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  tg.length = 0;
  assert.deepEqual(await agentWatchdog(env), []);
  env.DB.raw.prepare('UPDATE bots SET last_seen = ?').run(Math.floor(Date.now() / 1000) - 3600);
  assert.deepEqual(await agentWatchdog(env), ['tgtg:down']);
  assert.match(sentTexts().pop(), /TGTG ne répond plus/);
  assert.deepEqual(await agentWatchdog(env), [], 'pas de répétition');
  tg.length = 0;
  await report({ bot: 'tgtg', state: TGTG_STATE });
  assert.match(sentTexts().pop(), /répond de nouveau/);
});

test('un bot qui désactive l\'alerte hors ligne ne déclenche rien', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: { ...TGTG_STATE, offlineAlert: false } });
  env.DB.raw.prepare('UPDATE bots SET last_seen = 1').run();
  assert.deepEqual(await agentWatchdog(env), []);
});

test('long-poll : une commande arrivée pendant l\'attente est livrée', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  const waiting = agent('/api/agent/poll?bot=tgtg&wait=5').then((r) => r.json());
  setTimeout(() => { post('/bot/tgtg/action', { action: 'favoris' }); }, 300);
  const p = await waiting;
  assert.equal(p.commands.length, 1);
});

test('cron : surveille aussi les agents et ne plante pas sans surveillance active', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  env.DB.raw.prepare('UPDATE bots SET last_seen = 1').run();
  let waited;
  await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
  await waited;
  assert.match(sentTexts().join('\n'), /TGTG ne répond plus/);
});

test('/api/hub et journal : accessibles, sans secrets', async () => {
  await report({ bot: 'alicoins', name: 'AliExpress coins', state: { status: 'ok', summary: 'ok' }, events: [{ level: 'ok', text: 'Collecte réussie : +25 coins' }] });
  const cookie = await login();
  const hub = JSON.stringify(await (await req('/api/hub', { headers: { cookie } })).json());
  assert.ok(!hub.includes(TOKEN) && !hub.includes(AGENT));
  const j = await (await req('/journal', { headers: { cookie } })).text();
  assert.match(j, /Collecte réussie/);
});

test('une surveillance ajoutée envoie un message de confirmation au premier passage du collecteur', async () => {
  await post('/doctolib/add', { url: URL_C });
  const key = rows("SELECT key FROM watches WHERE url = ?", URL_C)[0].key;
  tg.length = 0;
  const r = await req('/api/ingest', {
    method: 'POST', headers: { authorization: 'Bearer ingest-key-de-test-1234567890' },
    body: JSON.stringify({ collector: 't', results: [{ key, label: 'Cabinet Z', status: 'ok', slots: [], next: null, http: 200, ms: 5, agendas: ['1'] }] }),
  });
  assert.equal(r.status, 200);
  assert.match(sentTexts().join('\n'), /Surveillance démarrée : Cabinet Z/);
  assert.equal(rows("SELECT * FROM meta WHERE key LIKE 'new:%'").length, 0);
});

test('résultat de commande en HTML : balises retirées dans l\'interface web, gardées pour Telegram', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  await say('/favoris');
  const p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  tg.length = 0;
  await report({ bot: 'tgtg', results: [{ id: p.commands[0].id, ok: true, html: true, text: '📋 <b>Tes favoris</b>\n🟢 <b>A &amp; B</b> — 2 dispo' }] });
  const stored = rows('SELECT result FROM commands')[0].result;
  assert.ok(!stored.includes('<b>'));
  assert.match(stored, /A & B/);
  const m = tg.find((c) => c.method === 'sendMessage');
  assert.equal(m.parse_mode, 'HTML');
  assert.match(m.text, /<b>Tes favoris<\/b>/);
  const html = await (await req('/bot/tgtg', { headers: { cookie: await login() } })).text();
  assert.match(html, /favoris/);
});

test('clé dans l\'adresse : fonctionne sans cookie (navigateur intégré), liens et formulaires gardent la clé', async () => {
  let r = await req(`/doctolib?key=${KEY}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, new RegExp(`action="/doctolib/add\\?key=${KEY}"`));
  assert.match(html, new RegExp(`href="/journal\\?key=${KEY}"`));
  const f = form({ url: URL_B });
  r = await req(`/doctolib/add?key=${KEY}`, { method: 'POST', body: f.body, headers: f.headers });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), new RegExp(`key=${KEY}`));
  assert.equal(rows('SELECT key FROM watches WHERE url = ?', URL_B).length, 1);
  assert.equal((await req(`/doctolib?key=mauvaise-cle-mauvaise`)).status, 401);
});

// ------------------------------------------------------------------ interface sans rechargement
test('web : action envoyée par la page -> JSON + suivi de la commande jusqu\'au résultat', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  const cookie = await login();
  let r = await post('/bot/tgtg/action', { action: 'favoris' }, { 'x-hub-fetch': '1' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true); assert.match(j.text, /envoyée/);
  assert.equal(j.cmd.bot, 'tgtg'); assert.ok(Number.isInteger(j.cmd.id));
  const st = async () => (await req(`/api/cmd?bot=tgtg&id=${j.cmd.id}`, { headers: { cookie } })).json();
  assert.equal((await st()).status, 'pending');
  await agent('/api/agent/poll?bot=tgtg&wait=0');
  assert.equal((await st()).status, 'sent');
  await report({ bot: 'tgtg', results: [{ id: j.cmd.id, ok: true, html: true, text: '<b>Favoris</b>\nA — 1 dispo\nB — 0 dispo' }] });
  const done = await st();
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Favoris\nA — 1 dispo\nB — 0 dispo', 'retours à la ligne conservés, HTML retiré');
  assert.equal((await req(`/api/cmd?bot=tgtg&id=${j.cmd.id}`)).status, 401, 'suivi protégé par la clé');
  assert.equal((await req('/api/cmd?bot=tgtg&id=999999', { headers: { cookie } })).status, 404);
  r = await post('/bot/tgtg/action', { action: 'inconnue' }, { 'x-hub-fetch': '1' });
  assert.equal((await r.json()).ok, false);
  r = await post('/bot/tgtg/action', { action: 'favoris' });
  assert.equal(r.status, 303, 'sans script : redirection classique conservée');
});

test('web : boutons par ligne d\'un tableau (Réserver sur un panier disponible seulement)', async () => {
  const state = {
    ...TGTG_STATE,
    actions: [...TGTG_STATE.actions, { id: 'reserver', label: 'Réserver', hidden: true, args: [{ name: 'item' }, { name: 'qty' }] }],
    tables: [{
      title: 'Favoris', columns: ['Panier', 'Dispo', 'Id'], highlight: 1,
      rows: [['Pain "bio"', '2', 'ID-7'], ['Vide', '0', 'ID-8']],
      rowActions: [{ action: 'reserver', label: 'Réserver', args: { item: '{2}', qty: '1' }, when: 1, confirm: 'Réserver {0} ?' },
        { action: 'absente', label: 'X', args: {} }],
    }],
  };
  await report({ bot: 'tgtg', name: 'TGTG', state });
  const html = await (await req('/bot/tgtg', { headers: { cookie: await login() } })).text();
  assert.equal((html.match(/name="item" value="ID-7"/g) || []).length, 1);
  assert.ok(!html.includes('value="ID-8"'), 'pas de bouton sur un panier vide');
  assert.match(html, /data-confirm="Réserver Pain &quot;bio&quot; \?"/);
  assert.match(html, /<tr class="hl">/);
  assert.ok(!/<span class="lbl">Réserver<\/span>/.test(html), 'action cachée absente de la barre d\'actions');
  assert.match(html, /data-label="Dispo"/, 'libellés de colonnes pour l\'affichage mobile');
  const r = await post('/bot/tgtg/action', { action: 'reserver', item: 'ID-7', qty: '1' }, { 'x-hub-fetch': '1' });
  assert.equal((await r.json()).ok, true);
  const p = await (await agent('/api/agent/poll?bot=tgtg&wait=0')).json();
  assert.deepEqual(p.commands[0].args, { item: 'ID-7', qty: '1' });
});

test('le nettoyage de la file se fait au cron, plus à chaque rapport d\'agent', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: TGTG_STATE });
  env.DB.raw.prepare("INSERT INTO commands (bot, cmd, args, source, status, created_at) VALUES ('tgtg', 'favoris', '{}', 'web', 'pending', ?)").run(Math.floor(Date.now() / 1000) - 3600);
  await report({ bot: 'tgtg', state: TGTG_STATE });
  assert.equal(rows("SELECT status FROM commands")[0].status, 'pending');
  await agentWatchdog(env);
  assert.equal(rows("SELECT status FROM commands")[0].status, 'expired');
});

test('CSP : les appels de la page vers le hub sont autorisés, rien d\'autre', async () => {
  const r = await req('/', { headers: { cookie: await login() } });
  assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('Telegram : une action à confirmer (redémarrer) demande d\'abord confirmation', async () => {
  await report({ bot: 'tgtg', name: 'TGTG', state: { ...TGTG_STATE, actions: [...TGTG_STATE.actions, { id: 'reboot', label: 'Redémarrer', confirm: 'Redémarrer le bot ?' }] } });
  await press('m:bot:tgtg');
  const menu = tg.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').pop();
  const btns = menu.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(btns.includes('k:tgtg:reboot')); assert.ok(btns.includes('c:tgtg:favoris'));
  await press('k:tgtg:reboot');
  assert.equal(rows('SELECT * FROM commands').length, 0, 'rien n\'est envoyé avant la confirmation');
  assert.match(tg.filter((c) => c.method === 'editMessageText').pop().text, /Redémarrer le bot \?/);
  await press('c:tgtg:reboot');
  assert.equal(rows('SELECT cmd FROM commands')[0].cmd, 'reboot');
});

test('Telegram : un message HTML refusé est renvoyé en texte simple au lieu d\'être perdu', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const b = JSON.parse(init.body || '{}'); calls.push(b);
    if (b.parse_mode === 'HTML') return new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 });
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  const { sendTelegram } = await import('../src/telegram.js');
  const r = await sendTelegram(env, '<b>Panier &amp; co</b> <i>coupé', { html: true, fast: true });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2); assert.equal(calls[1].text, 'Panier & co coupé'); assert.equal(calls[1].parse_mode, undefined);
});
