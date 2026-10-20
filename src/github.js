import { ensureSchema, getAllMeta, metaStmt, eventStmt } from './store.js';
import { sendTelegram, telegramProblems } from './telegram.js';
import { clampInt, nowSec, scrub } from './util.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const REASON = {
  401: 'jeton refusé ou expiré',
  403: 'jeton sans accès (permission « Actions : Read and write » manquante ?)',
  404: 'dépôt ou jeton introuvable',
  422: 'workflow collector.yml introuvable sur la branche main',
};

/**
 * Appelé par le cron du Worker (toutes les 5 min) : décide, avec le même tirage au sort irrégulier
 * que le collecteur, s'il faut demander à GitHub de lancer le collecteur maintenant.
 * Le planning de GitHub est trop peu fiable pour servir de déclencheur.
 */
export async function maybeDispatch(env) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  if (!token || !REPO_RE.test(repo)) return { dispatched: false, reason: 'non configuré' };
  const db = env.DB;
  if (!db) return { dispatched: false, reason: 'binding D1 "DB" absent' };
  await ensureSchema(db);
  const meta = await getAllMeta(db);
  const now = nowSec();
  const interval = clampInt(env.INTERVAL_MIN, 15, 1, 1440) * 60;
  const ref = Math.max(Number.parseInt(meta.last_run || '0', 10) || 0, Number.parseInt(meta.last_dispatch || '0', 10) || 0);
  const since = ref ? now - ref : null;
  let go;
  if (since === null || since >= 1.7 * interval) go = true;
  else if (since < 0.4 * interval) go = false;
  else go = Math.random() < 0.4;
  if (!go) return { dispatched: false, reason: 'pas maintenant', since };

  const base = String(env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
  let status = 0;
  let netErr = '';
  try {
    const res = await fetch(`${base}/repos/${repo}/actions/workflows/collector.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'doctolib-monitor',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { force: 'true' } }),
      signal: AbortSignal.timeout(15000),
    });
    status = res.status;
    try { await res.body?.cancel(); } catch { /* ignoré */ }
  } catch (e) {
    netErr = `réseau (${e?.name || 'erreur'})`;
  }
  if (status === 204) {
    await db.batch([metaStmt(db, 'last_dispatch', now), metaStmt(db, 'dispatch_fail', 0)]);
    return { dispatched: true };
  }

  const n = (Number.parseInt(meta.dispatch_fail || '0', 10) || 0) + 1;
  const why = netErr || `HTTP ${status} : ${REASON[status] || 'refus de GitHub'}`;
  const secrets = [token, env.TELEGRAM_BOT_TOKEN, env.DASHBOARD_KEY, env.INGEST_KEY];
  const stmts = [metaStmt(db, 'dispatch_fail', n)];
  if (n === 1 || n === 3) stmts.push(eventStmt(db, now, 'dispatch_failed', null, scrub(why, secrets)));
  if (n === 3 && telegramProblems(env).length === 0) {
    await sendTelegram(env,
      `Doctolib Monitor : Cloudflare n'arrive plus à lancer le collecteur sur GitHub (${scrub(why, secrets)}). `
      + 'Il reste le planning de GitHub, beaucoup moins fiable. Recrée le jeton GitHub puis relance install.bat.',
      { attempts: 2 });
  }
  await db.batch(stmts);
  return { dispatched: false, reason: why, failures: n };
}
