// Bot Telegram unique du hub (webhook) : menus, gestion des surveillances Doctolib, relais vers les agents.
import { tgCall, sendTelegram, editOrSend, telegramProblems } from './telegram.js';
import { doctolibView, doctolibSummary, hubOverview } from './overview.js';
import { addWatch, setPaused, removeWatch, loadWatches } from './watches.js';
import { getBot, getBots, isOnline, queueCommand } from './hub.js';
import { forceCheck } from './github.js';
import { metaStmt } from './store.js';
import { addAndStart } from './actions.js';
import { nowSec, dayLabel, scrub } from './util.js';

const ICON = { ok: '🟢', warn: '🟠', bad: '🔴', idle: '⚪' };
const LEGACY = new Set(['favoris', 'commandes', 'annuler', 'horaires', 'auto', 'interval', 'log', 'ok', 'reboot', 'reserver']);
const ALIAS = { coins: 'alicoins', ali: 'alicoins', aliexpress: 'alicoins', medin: 'medinlyon', medinlyon: 'medinlyon', tgtg: 'tgtg', doctolib: 'doctolib' };

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const webhookPathSecret = async (env) => (await sha(`hub-path:${env.TELEGRAM_BOT_TOKEN}`)).slice(0, 32);
export const webhookHeaderSecret = async (env) => (await sha(`hub-hdr:${env.TELEGRAM_BOT_TOKEN}`)).slice(0, 48);

const COMMANDS = [
  ['menu', 'Menu principal'], ['bots', 'État de tous les bots'], ['doctolib', 'Surveillances Doctolib'],
  ['ajouter', 'Ajouter un lien Doctolib'], ['verifier', 'Vérifier Doctolib maintenant'],
  ['tgtg', 'Too Good To Go'], ['favoris', 'Favoris TGTG'], ['commandes', 'Commandes TGTG'],
  ['coins', 'AliExpress coins'], ['aide', 'Aide'],
];

/** (Re)branche le webhook sur ce Worker. Retourne { ok, error? }. */
export async function setupWebhook(env, origin) {
  if (telegramProblems(env).length) return { ok: false, error: telegramProblems(env).join(', ') };
  const url = `${origin}/tg/${await webhookPathSecret(env)}`;
  const r = await tgCall(env, 'setWebhook', {
    url, secret_token: await webhookHeaderSecret(env), allowed_updates: ['message', 'callback_query'], max_connections: 4,
  });
  if (!r.ok) return r;
  await tgCall(env, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  return { ok: true };
}

/** Vérifie une fois par jour que le webhook pointe bien sur ce Worker (le répare sinon). */
export async function ensureWebhook(env, origin) {
  const db = env.DB;
  const m = await db.prepare("SELECT value FROM meta WHERE key = 'webhook_checked'").first();
  const now = nowSec();
  if (m && now - Number(m.value) < 86400) return { skipped: true };
  const info = await tgCall(env, 'getWebhookInfo');
  const want = `${origin}/tg/${await webhookPathSecret(env)}`;
  let res = { ok: true, already: true };
  if (info.ok && info.result?.url !== want) res = await setupWebhook(env, origin);
  if (res.ok) await metaStmt(db, 'webhook_checked', now).run();
  return res;
}

const rel = (ts, now = nowSec()) => {
  if (!ts) return 'jamais';
  const d = Math.max(0, now - ts);
  if (d < 90) return "à l'instant";
  if (d < 3600) return `il y a ${Math.round(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  return `il y a ${Math.round(d / 86400)} j`;
};

const webButton = (origin, key) => ({ text: '🌐 Interface web', url: `${origin}/?key=${encodeURIComponent(key)}` });

// ---------------------------------------------------------------- menus
async function mainMenu(env, origin) {
  const o = await hubOverview(env);
  const all = [o.doctolib, ...o.bots];
  const lines = all.map((b) => `${ICON[b.status] || '⚪'} ${b.name} : ${b.summary}`);
  const rows = [[{ text: '🩺 Doctolib', callback_data: 'm:doctolib' }]];
  const botBtns = o.bots.map((b) => ({ text: `${ICON[b.status] || '⚪'} ${b.name}`, callback_data: `m:bot:${b.id}` }));
  for (let i = 0; i < botBtns.length; i += 2) rows.push(botBtns.slice(i, i + 2));
  if (env.DASHBOARD_KEY && origin) rows.push([webButton(origin, env.DASHBOARD_KEY)]);
  return { text: `Hub de tes bots\n\n${lines.join('\n')}`, markup: { inline_keyboard: rows } };
}

function slotsLine(w) {
  const days = [...new Set(w.slots.map((s) => s.slot.slice(0, 10)))].sort();
  if (!days.length) return w.next ? `prochain : ${dayLabel(w.next.slice(0, 10))}` : 'aucun créneau';
  return `${w.slots.length} créneau(x) : ${days.slice(0, 4).map(dayLabel).join(', ')}${days.length > 4 ? '…' : ''}`;
}

export async function doctolibMenu(env, origin) {
  const v = await doctolibView(env);
  const lines = [];
  const rows = [];
  v.watches.forEach((w, i) => {
    const st = w.paused ? '⏸ en pause' : (w.last ? (w.last.status === 'ok' ? slotsLine(w) : `⚠ ${w.last.error || w.last.status}`) : 'pas encore vérifié');
    lines.push(`${i + 1}. ${w.paused ? '⏸' : (w.last && w.last.status !== 'ok' ? '🟠' : '🟢')} ${w.label}\n   ${st}`);
    rows.push([
      w.paused
        ? { text: `▶ Reprendre ${i + 1}`, callback_data: `dw:r:${w.key}` }
        : { text: `⏸ Pause ${i + 1}`, callback_data: `dw:p:${w.key}` },
      { text: `🗑 Supprimer ${i + 1}`, callback_data: `dw:d:${w.key}` },
    ]);
  });
  rows.push([{ text: '🔄 Vérifier maintenant', callback_data: 'dw:check' }, { text: '↩ Menu', callback_data: 'm:main' }]);
  if (env.DASHBOARD_KEY && origin) rows.push([{ text: '🌐 Détails sur le web', url: `${origin}/doctolib?key=${encodeURIComponent(env.DASHBOARD_KEY)}` }]);
  const head = 'Surveillances Doctolib';
  const body = lines.length ? lines.join('\n') : 'Aucune surveillance pour le moment.';
  return {
    text: `${head}\n\n${body}\n\nPour en ajouter : colle ici le lien Doctolib de l'étape calendrier (…/booking/availabilities?…), ou /ajouter <lien>.`,
    markup: { inline_keyboard: rows },
  };
}

export function botText(env, bot, now = nowSec()) {
  const st = bot.state;
  const online = isOnline(env, bot, now);
  const lines = [`${ICON[online ? (st?.status || 'idle') : 'bad']} ${bot.name}`];
  lines.push(online ? (st?.summary || 'en attente du premier rapport') : `Hors ligne (dernier signe : ${rel(bot.lastSeen, now)})`);
  for (const m of st?.metrics || []) lines.push(`• ${m.label} : ${m.value}`);
  for (const s of st?.settings || []) lines.push(`⚙ ${s.label} : ${s.value}`);
  return lines.join('\n');
}

function botMarkup(bot, origin, env) {
  const rows = [];
  const acts = (bot.state?.actions || []).filter((a) => !a.args.length);
  for (let i = 0; i < acts.length; i += 2) {
    rows.push(acts.slice(i, i + 2).map((a) => ({ text: a.label, callback_data: `c:${bot.id}:${a.id}` })));
  }
  const withArgs = (bot.state?.actions || []).filter((a) => a.args.length);
  rows.push([{ text: '↩ Menu', callback_data: 'm:main' }, ...(env.DASHBOARD_KEY && origin ? [{ text: '🌐 Web', url: `${origin}/bot/${bot.id}?key=${encodeURIComponent(env.DASHBOARD_KEY)}` }] : [])]);
  return { rows, withArgs };
}

async function botMenu(env, origin, bot) {
  const { rows, withArgs } = botMarkup(bot, origin, env);
  let text = botText(env, bot);
  if (withArgs.length) text += `\n\nAvec paramètre : ${withArgs.map((a) => `/${bot.id} ${a.id} ${a.args.map((x) => `<${x.name}>`).join(' ')}`).join(' · ')}`;
  return { text, markup: { inline_keyboard: rows } };
}

const HELP = `Hub de tes bots – commandes

Général : /menu · /bots · /aide
Doctolib : /doctolib · /ajouter <lien> · /pause <n> · /reprendre <n> · /supprimer <n> · /verifier
  (ou colle simplement un lien Doctolib)
Too Good To Go : /tgtg · /favoris · /commandes · /annuler <id> · /reserver <id> · /horaires 6h-22h · /auto [n] · /interval <min> · /log · /ok · /reboot
AliExpress coins : /coins · /coins run
Autres bots : /<nom> pour voir l'état et les actions.`;

// ---------------------------------------------------------------- actions Doctolib
async function dwAdd(env, url, name) {
  const r = await addAndStart(env, url, name);
  return `${r.ok ? '✅' : '❌'} ${r.text}`;
}

async function watchByIndex(env, n) {
  const { all } = await loadWatches(env);
  return all[Number(n) - 1] || null;
}

// ---------------------------------------------------------------- relais vers les agents
async function relay(env, chat, botId, cmd, args, source = 'telegram') {
  const bot = await getBot(env, botId);
  if (!bot) return sendTelegram(env, `Le bot « ${botId} » n'est pas encore branché (installe l'agent sur ton serveur, voir le README).`, { chat, attempts: 1 });
  if (!isOnline(env, bot)) {
    return sendTelegram(env, `${bot.name} est hors ligne (dernier signe ${rel(bot.lastSeen)}). Ta commande n'a pas été envoyée : vérifie le serveur.`, { chat, attempts: 1 });
  }
  const r = await queueCommand(env, botId, cmd, args, source);
  if (!r.ok) return sendTelegram(env, `❌ ${r.error}`, { chat, attempts: 1 });
  await tgCall(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
  return r;
}

/** Associe les mots tapés aux noms d'arguments déclarés par l'action de l'agent. */
function mapArgs(bot, cmd, text) {
  const act = (bot.state?.actions || []).find((a) => a.id === cmd);
  const t = String(text || '').trim();
  if (!act || !act.args.length) return t ? { text: t } : {};
  const words = t.split(/\s+/).filter(Boolean);
  const out = { text: t };
  act.args.forEach((a, i) => {
    out[a.name] = i === act.args.length - 1 ? words.slice(i).join(' ') : (words[i] || '');
  });
  return out;
}

// ---------------------------------------------------------------- texte reçu
async function onText(env, chat, text, origin) {
  const t = text.trim();
  if (!t) return;
  const send = (m, markup) => sendTelegram(env, m, { chat, markup, attempts: 2 });
  const doctolibUrl = /https?:\/\/[^\s]*doctolib\.[a-z]+\/[^\s]*booking[^\s]*/i.exec(t);
  if (!t.startsWith('/') && doctolibUrl) return send(await dwAdd(env, doctolibUrl[0], ''));
  if (!t.startsWith('/')) return send('Je comprends les commandes (/aide) et les liens Doctolib.', { inline_keyboard: [[{ text: 'Menu', callback_data: 'm:main' }]] });

  const m = /^\/([\w]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();

  switch (cmd) {
    case 'start': case 'menu': case 'bots': { const x = await mainMenu(env, origin); return send(x.text, x.markup); }
    case 'aide': case 'help': return send(HELP);
    case 'doctolib': case 'surveillances': { const x = await doctolibMenu(env, origin); return send(x.text, x.markup); }
    case 'ajouter': case 'add': {
      const u = /https?:\/\/\S+/.exec(rest);
      if (!u) return send("Usage : /ajouter <lien Doctolib de l'étape calendrier> [nom]");
      return send(await dwAdd(env, u[0], rest.replace(u[0], '').trim()));
    }
    case 'pause': case 'reprendre': case 'supprimer': case 'retirer': case 'stop': {
      const w = await watchByIndex(env, rest.split(/\s+/)[0]);
      if (!w) { const x = await doctolibMenu(env, origin); return send(`Numéro inconnu. Utilise /${cmd} <n°> d'après cette liste.\n\n${x.text}`, x.markup); }
      if (cmd === 'pause' || cmd === 'stop') await setPaused(env, w.key, true);
      else if (cmd === 'reprendre') { await setPaused(env, w.key, false); await forceCheck(env); } else await removeWatch(env, w.key);
      const x = await doctolibMenu(env, origin);
      return send(`${cmd === 'pause' || cmd === 'stop' ? '⏸ En pause' : cmd === 'reprendre' ? '▶ Reprise' : '🗑 Supprimé'} : ${w.name || w.practice}\n\n${x.text}`, x.markup);
    }
    case 'verifier': case 'check': {
      const f = await forceCheck(env);
      return send(f.ok ? '🔄 Vérification lancée, résultat dans 1 à 2 minutes.' : `❌ ${f.error}`);
    }
    default: break;
  }

  // Commandes d'un bot branché
  const botId = ALIAS[cmd] || cmd;
  const bots = await getBots(env);
  const target = bots.find((b) => b.id === botId);
  if (target && ALIAS[cmd] !== 'doctolib') {
    if (!rest) { const x = await botMenu(env, origin, target); return send(x.text, x.markup); }
    const [sub, ...more] = rest.split(/\s+/);
    const r = await relay(env, chat, target.id, sub.toLowerCase(), mapArgs(target, sub.toLowerCase(), more.join(' ')));
    return r;
  }
  if (LEGACY.has(cmd)) return relay(env, chat, 'tgtg', cmd, mapArgs(bots.find((b) => b.id === 'tgtg') || {}, cmd, rest));
  for (const b of bots) {
    if ((b.state?.telegram || []).some((c) => c.cmd === cmd)) return relay(env, chat, b.id, cmd, mapArgs(b, cmd, rest));
  }
  if (ALIAS[cmd]) return send(`Le bot « ${ALIAS[cmd]} » n'est pas encore branché. Installe son agent sur ton serveur (voir le README).`);
  return send('Commande inconnue. /aide pour la liste.');
}

// ---------------------------------------------------------------- boutons
async function onCallback(env, cb, origin) {
  const chat = cb.message?.chat?.id;
  const mid = cb.message?.message_id;
  const data = String(cb.data || '');
  const answer = (text) => tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text: text.slice(0, 180) } : {}) });
  const show = (x) => editOrSend(env, chat, mid, x.text, x.markup);

  if (data === 'm:main') { await answer(); return show(await mainMenu(env, origin)); }
  if (data === 'm:doctolib') { await answer(); return show(await doctolibMenu(env, origin)); }
  if (data.startsWith('m:bot:')) {
    const bot = await getBot(env, data.slice(6));
    if (!bot) return answer('Bot inconnu');
    await answer();
    return show(await botMenu(env, origin, bot));
  }
  if (data.startsWith('dw:')) {
    const [, op, ...k] = data.split(':');
    const key = k.join(':');
    if (op === 'check') {
      const f = await forceCheck(env);
      return answer(f.ok ? 'Vérification lancée (1 à 2 min)' : f.error);
    }
    if (op === 'p') { await setPaused(env, key, true); await answer('En pause'); }
    else if (op === 'r') { await setPaused(env, key, false); await forceCheck(env); await answer('Reprise'); }
    else if (op === 'd') { // confirmation avant suppression
      await answer();
      const { all } = await loadWatches(env);
      const w = all.find((x) => x.key === key);
      return editOrSend(env, chat, mid, `Supprimer définitivement « ${w?.name || w?.practice || key} » ?\nL'historique de cette surveillance sera effacé.`, {
        inline_keyboard: [[{ text: '🗑 Oui, supprimer', callback_data: `dw:dd:${key}` }, { text: 'Annuler', callback_data: 'm:doctolib' }]],
      });
    } else if (op === 'dd') { await removeWatch(env, key); await answer('Supprimée'); }
    else return answer();
    return show(await doctolibMenu(env, origin));
  }
  if (data.startsWith('c:')) { // action d'un bot : c:<bot>:<cmd>[:<arg>]
    const [, botId, cmd, ...arg] = data.split(':');
    const bot = await getBot(env, botId);
    if (!bot) return answer('Bot inconnu');
    if (!isOnline(env, bot)) return answer(`${bot.name} est hors ligne`);
    const r = await queueCommand(env, botId, cmd, arg.length ? { text: arg.join(':') } : {}, 'telegram');
    return answer(r.ok ? 'Envoyé…' : r.error);
  }
  return answer();
}

/** Point d'entrée du webhook. Ne lève jamais : Telegram doit toujours recevoir 200. */
export async function handleTelegramUpdate(env, update, origin) {
  const allowed = String(env.TELEGRAM_CHAT_ID || '');
  try {
    if (update?.callback_query) {
      const cb = update.callback_query;
      if (String(cb.message?.chat?.id) !== allowed || String(cb.from?.id) !== allowed) return;
      await onCallback(env, cb, origin);
    } else if (update?.message?.text) {
      const msg = update.message;
      if (String(msg.chat?.id) !== allowed) return; // les autres chats sont ignorés
      await onText(env, msg.chat.id, msg.text, origin);
    }
  } catch (e) {
    console.error('telegram update failed', scrub(e?.stack || e?.message, [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY]));
    try { await sendTelegram(env, 'Erreur interne en traitant ta commande. Réessaie dans un instant.', { attempts: 1 }); } catch { /* ignoré */ }
  }
}
