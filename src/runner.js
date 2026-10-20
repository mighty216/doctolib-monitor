import {
  parseWatches, getBookingInfo, resolveAgendas, placeLabel, fetchSlots,
} from './doctolib.js';
import { sendTelegram, telegramProblems } from './telegram.js';
import {
  ensureSchema, getAllMeta, getAllSlots, acquireLock, setMeta, metaStmt, metaDelStmt,
  upsertSlotStmt, pruneSlotsStmt, checkStmt, eventStmt, retentionStmts,
} from './store.js';
import {
  FatalError, BlockedError, SchemaError, SLOT_RE, scrub, formatSlots, parisToday, addDays, nowSec, rand, sleepMs, clampInt,
} from './util.js';

const LOCK_TTL = 300; // s
const AGENDA_TTL = 24 * 3600; // s

async function checkWatch(env, w, meta, horizon, today, o, t0) {
  const started = Date.now();
  const res = {
    w, label: `Cabinet ${w.practice}`, status: 'ok', http: 200, error: null,
    slots: [], next: null, ms: 0, newAgenda: null, dropAgenda: false,
  };
  try {
    let cache = null;
    try { cache = meta[`agenda:${w.key}`] ? JSON.parse(meta[`agenda:${w.key}`]) : null; } catch { cache = null; }
    if (cache && (!Array.isArray(cache.agendas) || !cache.agendas.length || t0 - (cache.ts || 0) > AGENDA_TTL)) {
      cache = null;
    }
    if (!cache) {
      const info = await getBookingInfo(env, w, o);
      const agendas = resolveAgendas(w, info);
      if (!agendas.length) {
        const motifs = (info.visit_motives || []).map((m) => `${m.id}=${m.name}`).join(', ');
        throw new FatalError(`Aucun agenda pour le cabinet ${w.practice} et le motif ${w.motives.join('-')} (motifs connus : ${motifs || '?'})`);
      }
      cache = { agendas, label: placeLabel(info, w.practice), ts: t0 };
      res.newAgenda = cache;
    }
    res.label = cache.label || res.label;
    const { slots, next } = await fetchSlots(env, w, cache.agendas, horizon, today, o);
    res.slots = slots;
    res.next = next;
  } catch (e) {
    if (e instanceof BlockedError) res.status = 'blocked';
    else if (e instanceof SchemaError) res.status = 'schema';
    else if (e instanceof FatalError) { res.status = 'fatal'; res.dropAgenda = true; }
    else res.status = 'error';
    res.http = e.http ?? null;
    res.error = scrub(e?.message || String(e), [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY]).slice(0, 300);
  }
  res.ms = Date.now() - started;
  return res;
}

/**
 * Une vérification complète de tous les cabinets.
 * opts.manual : lancée depuis le bouton du tableau de bord (pas de délai aléatoire).
 */
export async function runChecks(env, opts = {}) {
  const db = env.DB;
  if (!db) return { ok: false, reason: 'binding D1 "DB" absent (wrangler.toml)' };
  await ensureSchema(db);
  const { watches, errors } = parseWatches(env.DOCTOLIB_URLS);
  if (!watches.length) return { ok: false, reason: errors[0] || 'DOCTOLIB_URLS vide' };
  const t0 = nowSec();
  if (!(await acquireLock(db, t0, LOCK_TTL))) return { ok: false, skipped: true, reason: 'vérification déjà en cours' };
  try {
    return await doRun(env, watches, opts, t0);
  } finally {
    try { await setMeta(db, 'lock', '0'); } catch { /* le verrou expire seul */ }
  }
}

async function doRun(env, watches, opts, t0) {
  const db = env.DB;
  const o = { fast: !!opts.fast || !!opts.manual || env.FAST === '1', attempts: opts.manual ? 1 : 3 };
  const horizon = clampInt(env.MAX_DAYS, 21, 1, 60);
  const today = parisToday();

  const meta = await getAllMeta(db);
  const known = await getAllSlots(db);

  if (!o.fast) await sleepMs(o, rand(0, clampInt(env.JITTER_MAX_S, 25, 0, 120) * 1000));

  // 1) Vérifier chaque cabinet (mode "direct" : le Worker appelle Doctolib lui-même)
  const results = [];
  for (let i = 0; i < watches.length; i++) {
    if (i) await sleepMs(o, rand(2000, 5000));
    results.push(await checkWatch(env, watches[i], meta, horizon, today, o, t0));
  }
  return commit(env, { watches, results, meta, known, t0, opts, o, horizon });
}

/**
 * Mode "collecteur" : un programme externe (GitHub Actions + proxy résidentiel) interroge Doctolib
 * et envoie les résultats. Le Worker ne fait que décider, alerter et enregistrer.
 * payload = { collector, results: [{ key, label, status, slots[], next, http, error, ms, agendas[] }] }
 */
export async function ingest(env, payload) {
  const db = env.DB;
  if (!db) return { ok: false, status: 500, reason: 'binding D1 "DB" absent' };
  await ensureSchema(db);
  const { watches } = parseWatches(env.DOCTOLIB_URLS);
  if (!watches.length) return { ok: false, status: 409, reason: 'DOCTOLIB_URLS vide ou invalide côté Worker' };
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return { ok: false, status: 400, reason: 'corps invalide : { results: [...] } attendu' };
  }
  const t0 = nowSec();
  if (!(await acquireLock(db, t0, LOCK_TTL))) return { ok: false, status: 409, skipped: true, reason: 'traitement déjà en cours' };
  try {
    const horizon = clampInt(env.MAX_DAYS, 21, 1, 60);
    const end = addDays(parisToday(), horizon);
    const byKey = new Map(watches.map((w) => [w.key, w]));
    const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY, env.INGEST_KEY];
    const results = [];
    const seen = new Set();
    for (const r of payload.results.slice(0, 8)) {
      const w = r && byKey.get(String(r.key));
      if (!w || seen.has(w.key)) continue;
      seen.add(w.key);
      const status = ['ok', 'blocked', 'schema', 'fatal', 'error'].includes(r.status) ? r.status : 'error';
      const slots = status === 'ok'
        ? [...new Set((Array.isArray(r.slots) ? r.slots : [])
          .filter((s) => typeof s === 'string' && s.length <= 40 && SLOT_RE.test(s) && s.slice(0, 10) <= end))].sort().slice(0, 300)
        : [];
      const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 120) : `Cabinet ${w.practice}`;
      const agendas = Array.isArray(r.agendas) ? r.agendas.map(String).slice(0, 20) : [];
      const int = (v, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : null);
      results.push({
        w, label, status, slots,
        next: status === 'ok' && typeof r.next === 'string' && SLOT_RE.test(r.next) ? r.next.slice(0, 40) : null,
        http: int(r.http, 0, 999),
        ms: int(r.ms, 0, 600000) ?? 0,
        error: status === 'ok' ? null : scrub(String(r.error || 'erreur inconnue').slice(0, 300), secrets),
        newAgenda: status === 'ok' ? { agendas, label, ts: t0 } : null,
        dropAgenda: false,
      });
    }
    if (!results.length) return { ok: false, status: 400, reason: 'aucun résultat correspondant aux cabinets configurés' };
    const meta = await getAllMeta(db);
    const known = await getAllSlots(db);
    const collector = String(payload.collector || 'collecteur').replace(/[^\w .:-]/g, '').slice(0, 40) || 'collecteur';
    const r = await commit(env, {
      watches, results, meta, known, t0, opts: {}, o: { fast: true, attempts: 1 }, horizon, ingest: { collector },
    });
    return { ...r, status: 200 };
  } finally {
    try { await setMeta(db, 'lock', '0'); } catch { /* le verrou expire seul */ }
  }
}

/** Mode collecteur : prévient (une fois) si plus aucune donnée n'arrive. Appelé par le cron du Worker. */
export async function watchdog(env) {
  const db = env.DB;
  if (!db) return { ok: false, reason: 'binding D1 "DB" absent' };
  await ensureSchema(db);
  const { watches } = parseWatches(env.DOCTOLIB_URLS);
  if (!watches.length) return { ok: false, reason: 'DOCTOLIB_URLS vide' };
  const meta = await getAllMeta(db);
  const now = nowSec();
  const since = Number.parseInt(meta.watchdog_since || '0', 10);
  if (!since) await setMeta(db, 'watchdog_since', now);
  const ref = Number.parseInt(meta.last_run || '0', 10) || since || now; // jamais reçu : on compte depuis le 1er passage du chien de garde
  const staleMin = clampInt(env.COLLECTOR_STALE_MIN, 75, 10, 1440);
  const silentMin = Math.floor((now - ref) / 60);
  if (silentMin < staleMin) return { ok: true, silentMin, alerted: false };
  if (meta.stale_alerted === String(ref)) return { ok: true, silentMin, alerted: false, already: true };
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
  const text = `Doctolib Monitor : aucune donnée reçue du collecteur depuis ${silentMin} min `
    + `(${meta.last_run ? 'GitHub Actions arrêté, proxy en panne ?' : 'le collecteur n\'a encore jamais envoyé de résultat'}). `
    + "Les créneaux ne sont plus surveillés tant que ça dure. Ouvre l'onglet Actions du dépôt GitHub.";
  const problems = telegramProblems(env);
  const sent = problems.length ? { ok: false, error: problems.join(', ') } : await sendTelegram(env, text, { attempts: 2 });
  await db.batch([
    eventStmt(db, now, sent.ok ? 'collector_silent' : 'alert_failed', null,
      sent.ok ? `aucune donnée depuis ${silentMin} min` : scrub(sent.error, secrets)),
    ...(sent.ok ? [metaStmt(db, 'stale_alerted', ref)] : []),
  ]);
  return { ok: true, silentMin, alerted: sent.ok };
}

async function commit(env, ctx) {
  const db = env.DB;
  const { watches, results, meta, known, t0, opts, o, horizon } = ctx;
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
  const failAfter = clampInt(env.FAIL_ALERT_AFTER, 4, 1, 50);
  const heartbeatH = Number.parseFloat(env.HEARTBEAT_HOURS ?? '24');
  const canAlert = telegramProblems(env).length === 0;
  const tEnd = Math.max(nowSec(), Number.parseInt(meta.last_run_end || '0', 10) + 1);

  // 2) Créneaux à signaler : présents et jamais alertés avec succès
  const fresh = new Map(); // watch -> [slots]
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const k = known.get(r.w.key) || new Map();
    const f = r.slots.filter((s) => k.get(s) !== 1);
    if (f.length) fresh.set(r.w.key, f);
  }
  const events = [];
  let alertSent = false;
  if (fresh.size) {
    const blocks = results
      .filter((r) => fresh.has(r.w.key))
      .map((r) => `${r.label}\n${formatSlots(fresh.get(r.w.key))}\n${r.w.url}`);
    const total = [...fresh.values()].reduce((n, a) => n + a.length, 0);
    if (!canAlert) {
      events.push(['alert_failed', null, `${total} créneau(x) non signalé(s) : ${telegramProblems(env).join(', ')}`]);
    } else {
      const sent = await sendTelegram(env, `Créneau(x) Doctolib disponible(s) !\n\n${blocks.join('\n\n')}`, o);
      alertSent = sent.ok;
      events.push(sent.ok
        ? ['alert', null, `${total} nouveau(x) créneau(x) signalé(s)`]
        : ['alert_failed', null, scrub(sent.error, secrets)]);
    }
  }

  // 3) Pannes / reprises par cabinet
  const metaOps = [];
  const rows = [];
  for (const r of results) {
    const failKey = `fail:${r.w.key}`;
    const prev = Number.parseInt(meta[failKey] || '0', 10);
    if (r.status === 'ok') {
      if (prev >= failAfter) {
        if (canAlert) await sendTelegram(env, `Doctolib watcher : la surveillance de ${r.label} a repris normalement.`, o);
        events.push(['recovered', r.w.key, `${r.label} : de nouveau joignable`]);
      }
      metaOps.push(['set', failKey, 0]);
      metaOps.push(r.next ? ['set', `next:${r.w.key}`, r.next] : ['del', `next:${r.w.key}`]);
    } else {
      const n = prev + 1;
      metaOps.push(['set', failKey, n]);
      if (n === failAfter) {
        if (canAlert) {
          await sendTelegram(env,
            `Doctolib watcher : ${n} vérifications en échec d'affilée sur ${r.label} (${r.status} : ${r.error}). `
            + 'Surveillance interrompue tant que le problème persiste.', o);
        }
        events.push(['down', r.w.key, `${r.label} : ${r.status} - ${r.error}`]);
      }
      if (r.dropAgenda) metaOps.push(['del', `agenda:${r.w.key}`]);
    }
    if (r.newAgenda) metaOps.push(['set', `agenda:${r.w.key}`, JSON.stringify(r.newAgenda)]);
    rows.push(checkStmt(db, {
      ts: tEnd, watch: r.w.key, status: r.status, n_slots: r.slots.length, http: r.http, ms: r.ms, error: r.error,
    }));
  }

  // 3b) Le collecteur reprend après un silence signalé
  if (ctx.ingest) {
    metaOps.push(['set', 'collector', ctx.ingest.collector]);
    if (meta.stale_alerted) {
      if (canAlert) await sendTelegram(env, 'Doctolib Monitor : le collecteur envoie de nouveau des résultats, la surveillance a repris.', o);
      events.push(['recovered', null, 'collecteur de nouveau actif']);
      metaOps.push(['del', 'stale_alerted']);
    }
  }

  // 4) Message "toujours actif"
  if (heartbeatH > 0 && canAlert) {
    const hb = Number.parseInt(meta.heartbeat || '0', 10);
    if (!hb) metaOps.push(['set', 'heartbeat', tEnd]);
    else if (tEnd - hb >= heartbeatH * 3600) {
      const nSlots = results.reduce((n, r) => n + r.slots.length, 0);
      const bad = results.filter((r) => r.status !== 'ok').length;
      const sent = await sendTelegram(env,
        `Watcher toujours actif (${watches.length} cabinet(s)). ${nSlots} créneau(x) sous ${horizon} jours.`
        + (bad ? ` ${bad} cabinet(s) en échec.` : ''), o);
      if (sent.ok) { metaOps.push(['set', 'heartbeat', tEnd]); events.push(['heartbeat', null, 'message envoyé']); }
    }
  }

  // 5) Écriture de l'état en un seul batch
  const stmts = [...rows];
  for (const r of results) {
    if (r.status !== 'ok') continue; // échec : on garde l'état précédent (pas de fausse ré-alerte à la reprise)
    const k = known.get(r.w.key) || new Map();
    const f = new Set(fresh.get(r.w.key) || []);
    for (const s of r.slots) {
      const alerted = k.get(s) === 1 || (f.has(s) && alertSent);
      stmts.push(upsertSlotStmt(db, r.w.key, s, tEnd, alerted));
    }
    stmts.push(pruneSlotsStmt(db, r.w.key, tEnd)); // créneaux disparus : oubliés, ré-alerte s'ils reviennent
    if (r.slots.length) {
      for (const s of r.slots) if (k.get(s) === undefined) { events.push(['slot', r.w.key, `${r.label} : ${s.slice(0, 16).replace('T', ' ')}`]); }
    }
  }
  for (const [type, watch, detail] of events.slice(0, 40)) stmts.push(eventStmt(db, tEnd, type, watch, scrub(detail, secrets)));
  for (const [op, key, value] of metaOps) stmts.push(op === 'set' ? metaStmt(db, key, value) : metaDelStmt(db, key));
  stmts.push(metaStmt(db, 'last_run', tEnd), metaStmt(db, 'last_run_end', tEnd), metaStmt(db, 'last_manual', opts.manual ? t0 : (meta.last_manual || 0)));
  stmts.push(...retentionStmts(db, tEnd));
  await db.batch(stmts);

  return {
    ok: true,
    results: results.map((r) => ({ watch: r.w.key, label: r.label, status: r.status, slots: r.slots.length, error: r.error })),
    alerted: alertSent,
  };
}
