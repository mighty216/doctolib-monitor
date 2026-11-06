// Vue d'ensemble partagée par l'interface web et le bot Telegram.
import { loadDashboardData } from './store.js';
import { loadWatches } from './watches.js';
import { telegramProblems } from './telegram.js';
import { getBots, isOnline } from './hub.js';
import { clampInt, nowSec, scrub } from './util.js';

export const isDirect = (env) => String(env.MODE || 'ingest').toLowerCase() === 'direct';

export async function doctolibView(env) {
  const now = nowSec();
  const mode = isDirect(env) ? 'direct' : 'ingest';
  const base = {
    now, mode, intervalMin: clampInt(env.INTERVAL_MIN, 15, 1, 1440), horizon: clampInt(env.MAX_DAYS, 21, 1, 60),
    staleMin: clampInt(env.COLLECTOR_STALE_MIN, 75, 10, 1440),
  };
  const problems = [...telegramProblems(env)];
  if (String(env.DASHBOARD_KEY || '').length < 12) problems.push('DASHBOARD_KEY trop court (12 caractères minimum)');
  if (mode === 'ingest' && String(env.INGEST_KEY || '').length < 16) problems.push('INGEST_KEY absent ou trop court (16 caractères minimum)');
  if (!env.DB) return { ...base, hasConfig: false, problems: [...problems, 'binding D1 "DB" absent'], lastRun: 0, watches: [], events: [] };

  const { all, active, errors } = await loadWatches(env);
  problems.push(...errors);
  const d = await loadDashboardData(env.DB, all.map((w) => w.key), now);
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY];
  try { problems.push(...JSON.parse(d.meta.seed_errors || '[]')); } catch { /* ignoré */ }
  return {
    ...base,
    collector: d.meta.collector || null,
    hasConfig: active.length > 0 || all.length > 0,
    anyActive: active.length > 0,
    problems: problems.map((p) => scrub(p, secrets)),
    lastRun: Number.parseInt(d.meta.last_run || '0', 10) || 0,
    events: d.events.map((e) => ({ ...e, detail: scrub(e.detail, secrets) })),
    watches: all.map((w) => {
      let label = `Cabinet ${w.practice}`;
      try { label = JSON.parse(d.meta[`agenda:${w.key}`] || '{}').label || label; } catch { /* défaut */ }
      const timeline = d.timelines[w.key] || [];
      return {
        key: w.key,
        label: w.name || label,
        autoLabel: label,
        name: w.name,
        paused: w.paused,
        url: w.url,
        last: timeline.length ? timeline[timeline.length - 1] : null,
        timeline,
        slots: d.slots[w.key] || [],
        next: d.meta[`next:${w.key}`] || null,
        rate24: d.rate24[w.key],
        rate7: d.rate7[w.key],
      };
    }),
  };
}

/** Résumé d'état d'un bot Doctolib sous la même forme que les bots d'agents. */
export function doctolibSummary(view) {
  const act = view.watches.filter((w) => !w.paused);
  const slots = act.reduce((n, w) => n + w.slots.length, 0);
  const bad = act.filter((w) => w.last && w.last.status !== 'ok');
  let status = 'ok';
  let summary = `${act.length} surveillance(s) active(s), ${slots} créneau(x) sous ${view.horizon} jours`;
  if (!view.hasConfig || !view.watches.length) { status = 'idle'; summary = 'Aucune surveillance : ajoute un lien Doctolib'; }
  else if (!act.length) { status = 'idle'; summary = 'Toutes les surveillances sont en pause'; }
  else if (!view.lastRun) { status = 'idle'; summary = 'En attente de la première vérification'; }
  else if (view.now - view.lastRun > (view.mode === 'ingest' ? view.staleMin * 60 : view.intervalMin * 150)) { status = 'bad'; summary = 'Plus de données du collecteur'; }
  else if (bad.length) { status = 'warn'; summary = `Problème sur ${bad.length} cabinet(s) · ${slots} créneau(x)`; }
  return {
    status, summary,
    metrics: [
      { label: 'Surveillances', value: `${act.length}/${view.watches.length}` },
      { label: 'Créneaux', value: String(slots) },
      { label: 'Dernier passage', value: view.lastRun ? new Date(view.lastRun * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' },
    ],
  };
}

/** Tous les bots pour la page d'accueil et /bots. */
export async function hubOverview(env) {
  const now = nowSec();
  const dview = await doctolibView(env);
  const bots = await getBots(env);
  return {
    now,
    doctolib: { id: 'doctolib', name: 'Doctolib Monitor', href: '/doctolib', online: true, lastSeen: dview.lastRun, ...doctolibSummary(dview) },
    bots: bots.map((b) => {
      const online = !!isOnline(env, b, now);
      const st = b.state || { status: 'idle', summary: 'En attente du premier rapport', metrics: [] };
      return {
        id: b.id, name: b.name, href: `/bot/${b.id}`, online, lastSeen: b.lastSeen,
        status: online ? st.status : 'bad',
        summary: online ? st.summary : `Hors ligne (vu ${b.lastSeen ? 'il y a ' + Math.round((now - b.lastSeen) / 60) + ' min' : 'jamais'})`,
        metrics: st.metrics || [],
      };
    }),
  };
}
