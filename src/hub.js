// Cœur du hub : bots branchés par un agent (TGTG, ali-coins, MédinLyon...), file de commandes, journal.
import { ensureSchema, getAllMeta, metaStmt, metaDelStmt, eventStmt } from './store.js';
import { sendTelegram, telegramProblems } from './telegram.js';
import { clampInt, nowSec, scrub } from './util.js';

export const BOT_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const STATUSES = ['ok', 'warn', 'bad', 'idle'];
const str = (v, n) => String(v ?? '').slice(0, n);
const stripHtml = (t) => String(t ?? '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Nettoie l'état envoyé par un agent : tout est borné, rien n'est interprété. */
export function sanitizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  return {
    status: STATUSES.includes(s.status) ? s.status : 'idle',
    summary: str(s.summary, 300),
    metrics: arr(s.metrics, 16).map((m) => ({ label: str(m?.label, 40), value: str(m?.value, 80) })),
    tables: arr(s.tables, 4).map((t) => {
      const columns = arr(t?.columns, 8).map((c) => str(c, 40));
      const col = (v) => (Number.isInteger(v) && v >= 0 && v < columns.length ? v : null);
      return {
        title: str(t?.title, 80),
        columns,
        rows: arr(t?.rows, 40).map((r) => arr(r, 8).map((c) => str(c, 160))),
        highlight: col(t?.highlight),
        // boutons par ligne : { action, label, args: { nom: "{n° de colonne}" | valeur }, when: n° de colonne, confirm, danger }
        rowActions: arr(t?.rowActions, 3).map((a) => ({
          action: str(a?.action, 30).replace(/[^\w-]/g, ''),
          label: str(a?.label, 30),
          args: Object.fromEntries(Object.entries(a?.args && typeof a.args === 'object' ? a.args : {}).slice(0, 3)
            .map(([k, v]) => [str(k, 20).replace(/[^\w-]/g, ''), str(v, 60)]).filter(([k]) => k)),
          when: col(a?.when),
          confirm: a?.confirm ? str(a.confirm, 120) : '',
          danger: !!a?.danger,
        })).filter((a) => a.action && a.label),
      };
    }),
    actions: arr(s.actions, 16).map((a) => ({
      id: str(a?.id, 30).replace(/[^\w-]/g, ''),
      label: str(a?.label, 40),
      confirm: a?.confirm ? str(a.confirm, 120) : '',
      hidden: !!a?.hidden, // seulement via les boutons des tableaux
      danger: !!a?.danger,
      args: arr(a?.args, 3).map((x) => ({ name: str(x?.name, 20).replace(/[^\w-]/g, ''), label: str(x?.label, 40), placeholder: str(x?.placeholder, 40) })),
    })).filter((a) => a.id && a.label),
    settings: arr(s.settings, 16).map((x) => ({
      key: str(x?.key, 30).replace(/[^\w-]/g, ''),
      label: str(x?.label, 60),
      type: ['text', 'number', 'bool', 'select'].includes(x?.type) ? x.type : 'text',
      value: str(x?.value, 120),
      options: arr(x?.options, 12).map((o) => str(o, 40)),
      help: str(x?.help, 160),
    })).filter((x) => x.key && x.label),
    log: arr(s.log, 40).map((l) => str(l, 220)),
    offlineAlert: s.offlineAlert !== false,
    telegram: arr(s.telegram, 12).map((c) => ({ cmd: str(c?.cmd, 30).replace(/[^\w]/g, ''), text: str(c?.text, 80) })).filter((c) => c.cmd),
  };
}

export async function getBots(env) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare('SELECT id, name, kind, last_seen, state, state_ts FROM bots ORDER BY id').all();
  return (results || []).map((b) => {
    let state = null;
    try { state = b.state ? JSON.parse(b.state) : null; } catch { state = null; }
    return { id: b.id, name: b.name, kind: b.kind, lastSeen: Number(b.last_seen), stateTs: Number(b.state_ts), state };
  });
}

export async function getBot(env, id) {
  return (await getBots(env)).find((b) => b.id === id) || null;
}

export const offlineAfterSec = (env) => clampInt(env.AGENT_STALE_MIN, 6, 2, 1440) * 60;
export const isOnline = (env, bot, now = nowSec()) => bot && bot.lastSeen && now - bot.lastSeen < offlineAfterSec(env);

/** Met en file une commande pour l'agent d'un bot. */
export async function queueCommand(env, bot, cmd, args, source = 'web') {
  const db = env.DB;
  await ensureSchema(db);
  const c = String(cmd || '').replace(/[^\w-]/g, '').slice(0, 30);
  if (!c) return { ok: false, error: 'commande vide' };
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM commands WHERE bot = ? AND status IN ('pending','sent')").bind(bot).first();
  if (Number(pending?.n) >= 30) return { ok: false, error: 'trop de commandes en attente pour ce bot' };
  const r = await db.prepare('INSERT INTO commands (bot, cmd, args, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(bot, c, JSON.stringify(args ?? {}).slice(0, 2000), source, nowSec()).run();
  return { ok: true, id: r.meta?.last_row_id };
}

export async function recentCommands(env, bot, limit = 8) {
  const { results } = await env.DB.prepare(
    'SELECT id, cmd, args, source, status, created_at, done_at, result FROM commands WHERE bot = ? ORDER BY id DESC LIMIT ?',
  ).bind(bot, limit).all();
  return results || [];
}

/** État d'une commande (suivi en direct depuis l'interface web). */
export async function getCommand(env, bot, id) {
  await ensureSchema(env.DB);
  return env.DB.prepare('SELECT id, cmd, status, created_at, done_at, result FROM commands WHERE bot = ? AND id = ?').bind(bot, id).first();
}

/** Nettoyage de la file de commandes et du journal : lancé par le cron (et non à chaque rapport d'agent, toutes les 20 s,
 * où ces requêtes sans index parcouraient toute la table et consommaient l'essentiel du quota de lectures D1). */
export async function cleanupStmts(db, t = nowSec()) {
  return [
    db.prepare('DELETE FROM bot_events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM bot_events) - 400'),
    db.prepare("DELETE FROM commands WHERE created_at < ? OR (status IN ('done','error','expired') AND id <= (SELECT COALESCE(MAX(id),0) FROM commands) - 200)").bind(t - 3 * 86400),
    db.prepare("UPDATE commands SET status = 'expired', done_at = ? WHERE status IN ('pending','sent') AND created_at < ?").bind(t, t - 600),
  ];
}

export async function recentBotEvents(env, limit = 60, bot = null) {
  const q = bot
    ? env.DB.prepare('SELECT ts, bot, level, text FROM bot_events WHERE bot = ? ORDER BY id DESC LIMIT ?').bind(bot, limit)
    : env.DB.prepare('SELECT ts, bot, level, text FROM bot_events ORDER BY id DESC LIMIT ?').bind(limit);
  const { results } = await q.all();
  return results || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Appelé par l'agent : renvoie les commandes en attente (attend jusqu'à `waitSec` s si aucune). */
export async function agentPoll(env, bot, waitSec) {
  const db = env.DB;
  await ensureSchema(db);
  if (!BOT_ID_RE.test(bot)) return { ok: false, status: 400, error: 'identifiant de bot invalide' };
  if (bot === 'ping') return { ok: true, commands: [] }; // test de connexion de l'installeur
  const t = nowSec();
  const row = await db.prepare('SELECT last_seen FROM bots WHERE id = ?').bind(bot).first();
  if (!row) {
    await db.prepare('INSERT OR IGNORE INTO bots (id, name, kind, last_seen, state_ts) VALUES (?, ?, ?, ?, 0)').bind(bot, bot, 'agent', t).run();
  } else if (t - Number(row.last_seen) >= 30) {
    await db.prepare('UPDATE bots SET last_seen = ? WHERE id = ?').bind(t, bot).run();
  }
  const deadline = Date.now() + Math.min(25, Math.max(0, waitSec)) * 1000;
  for (;;) {
    const { results } = await db.prepare(
      "SELECT id, cmd, args, source FROM commands WHERE bot = ? AND status = 'pending' ORDER BY id LIMIT 10",
    ).bind(bot).all();
    if (results && results.length) {
      await db.batch(results.map((c) => db.prepare("UPDATE commands SET status = 'sent' WHERE id = ?").bind(c.id)));
      return {
        ok: true,
        commands: results.map((c) => {
          let args = {};
          try { args = JSON.parse(c.args || '{}'); } catch { args = {}; }
          return { id: c.id, cmd: c.cmd, args, source: c.source };
        }),
      };
    }
    if (Date.now() + 2000 > deadline) return { ok: true, commands: [] };
    await sleep(2000);
  }
}

/**
 * Appelé par l'agent : état, journal, messages Telegram à relayer, résultats de commandes.
 * payload = { bot, name, kind, state, messages:[{text, html, markup}], events:[{level,text}], results:[{id, ok, text}] }
 */
export async function agentReport(env, payload) {
  const db = env.DB;
  await ensureSchema(db);
  const p = payload && typeof payload === 'object' ? payload : {};
  const bot = str(p.bot, 24);
  if (!BOT_ID_RE.test(bot)) return { ok: false, status: 400, error: 'identifiant de bot invalide' };
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY, env.INGEST_KEY, env.AGENT_KEY];
  const t = nowSec();
  const wasDown = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(`agent_alerted:${bot}`).first();
  const stmts = [];
  const name = str(p.name, 40).trim() || bot;
  const kind = str(p.kind, 20) || 'agent';
  if (p.state !== undefined) {
    const state = sanitizeState(p.state);
    stmts.push(db.prepare(
      `INSERT INTO bots (id, name, kind, last_seen, state, state_ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, last_seen = excluded.last_seen,
         state = excluded.state, state_ts = excluded.state_ts`,
    ).bind(bot, name, kind, t, scrub(JSON.stringify(state), secrets), t));
  } else {
    stmts.push(db.prepare(
      `INSERT INTO bots (id, name, kind, last_seen, state_ts) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(bot, name, kind, t));
  }
  for (const e of (Array.isArray(p.events) ? p.events : []).slice(0, 30)) {
    const level = ['info', 'ok', 'warn', 'bad'].includes(e?.level) ? e.level : 'info';
    stmts.push(db.prepare('INSERT INTO bot_events (ts, bot, level, text) VALUES (?, ?, ?, ?)').bind(t, bot, level, scrub(str(e?.text, 300), secrets)));
  }
  if (wasDown) stmts.push(metaDelStmt(db, `agent_alerted:${bot}`));

  const toSend = [];
  for (const m of (Array.isArray(p.messages) ? p.messages : []).slice(0, 10)) {
    if (m && typeof m.text === 'string' && m.text.trim()) {
      toSend.push({ text: scrub(m.text, secrets), html: !!m.html, markup: sanitizeMarkup(m.markup) });
    }
  }
  const results = Array.isArray(p.results) ? p.results.slice(0, 20) : [];
  let cmdRows = [];
  if (results.length) {
    const ids = results.map((r) => Number(r?.id)).filter(Number.isInteger);
    if (ids.length) {
      const { results: rows } = await db.prepare(`SELECT id, source FROM commands WHERE bot = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(bot, ...ids).all();
      cmdRows = rows || [];
    }
    for (const r of results) {
      const row = cmdRows.find((x) => x.id === Number(r?.id));
      if (!row) continue;
      const text = scrub(str(r.text, 1500), secrets);
      const plain = r.html ? stripHtml(text) : text;
      stmts.push(db.prepare('UPDATE commands SET status = ?, done_at = ?, result = ? WHERE id = ?').bind(r.ok === false ? 'error' : 'done', t, plain.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500), row.id));
      if (row.source === 'telegram' && text.trim()) toSend.push({ text: r.ok === false ? `${name} : ${text}` : text, html: !!r.html, markup: sanitizeMarkup(r.markup) });
    }
  }
  await db.batch(stmts);
  if (wasDown && telegramProblems(env).length === 0) await sendTelegram(env, `${name} répond de nouveau.`, { attempts: 2 });

  let sent = 0;
  if (toSend.length && telegramProblems(env).length === 0) {
    for (const m of toSend) {
      const r = await sendTelegram(env, m.text, { html: m.html, markup: m.markup, attempts: 2 });
      if (r.ok) sent++;
      else await db.prepare('INSERT INTO bot_events (ts, bot, level, text) VALUES (?, ?, ?, ?)').bind(t, bot, 'bad', scrub(`Message Telegram non envoyé : ${r.error}`, secrets)).run();
    }
  }
  return { ok: true, sent };
}

/** Boutons Telegram renvoyés par un agent : callback_data limité à "c:<bot>:..." et à 64 octets. */
export function sanitizeMarkup(m) {
  if (!m || !Array.isArray(m.inline_keyboard)) return undefined;
  const rows = m.inline_keyboard.slice(0, 6).map((row) => (Array.isArray(row) ? row : []).slice(0, 4).map((b) => {
    const text = str(b?.text, 40);
    if (!text) return null;
    if (typeof b.url === 'string' && /^https:\/\//.test(b.url)) return { text, url: b.url.slice(0, 500) };
    if (typeof b.callback_data === 'string' && /^c:[a-z][\w-]{1,23}:[\w:.-]{1,50}$/.test(b.callback_data) && new TextEncoder().encode(b.callback_data).length <= 64) {
      return { text, callback_data: b.callback_data };
    }
    return null;
  }).filter(Boolean)).filter((r) => r.length);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Cron : prévient (une fois) quand un agent ne répond plus, puis à sa reprise. */
export async function agentWatchdog(env) {
  const db = env.DB;
  await ensureSchema(db);
  const bots = await getBots(env);
  const meta = await getAllMeta(db);
  const now = nowSec();
  const out = [];
  await db.batch(await cleanupStmts(db, now));
  for (const b of bots) {
    if (b.state && b.state.offlineAlert === false) continue;
    const key = `agent_alerted:${b.id}`;
    const down = !isOnline(env, b, now);
    if (down && !meta[key]) {
      const mins = Math.round((now - b.lastSeen) / 60);
      const sent = telegramProblems(env).length ? { ok: false } : await sendTelegram(env, `${b.name} ne répond plus depuis ${mins} min (agent arrêté ou serveur éteint ?).`, { attempts: 2 });
      await db.batch([
        eventStmt(db, now, 'agent_silent', b.id, `${b.name} : plus de nouvelles depuis ${mins} min`),
        ...(sent.ok ? [metaStmt(db, key, now)] : []),
      ]);
      out.push(`${b.id}:down`);
    }
  }
  return out;
}
