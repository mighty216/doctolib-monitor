// Surveillances Doctolib stockées dans D1 (ajout / pause / reprise / suppression depuis le web ou Telegram).
// Au premier démarrage, elles sont reprises du secret DOCTOLIB_URLS (une seule fois).
import { parseBookingUrl, parseWatches } from './doctolib.js';
import { ensureSchema, getAllMeta, metaStmt, metaDelStmt } from './store.js';
import { nowSec } from './util.js';

export const MAX_ACTIVE = 12;

async function seed(env) {
  const db = env.DB;
  const seeded = await db.prepare("SELECT value FROM meta WHERE key = 'watches_seeded'").first();
  if (seeded) return;
  const { watches, errors } = parseWatches(env.DOCTOLIB_URLS);
  const t = nowSec();
  await db.batch([
    ...watches.map((w) => db.prepare('INSERT OR IGNORE INTO watches (key, url, name, paused, created_at) VALUES (?, ?, NULL, 0, ?)').bind(w.key, w.url, t)),
    metaStmt(db, 'watches_seeded', t),
    ...(errors.length ? [metaStmt(db, 'seed_errors', JSON.stringify(errors))] : []),
  ]);
}

/** { rows: [{key,url,name,paused}], all: [parsed + row], active: [parsed], errors: [] } */
export async function loadWatches(env) {
  const db = env.DB;
  await ensureSchema(db);
  await seed(env);
  const { results } = await db.prepare('SELECT key, url, name, paused, created_at FROM watches ORDER BY created_at, key').all();
  const all = [];
  const errors = [];
  for (const r of results || []) {
    try {
      const w = parseBookingUrl(r.url);
      all.push({ ...w, key: r.key, name: r.name || null, paused: Number(r.paused) === 1, created_at: r.created_at });
    } catch (e) {
      errors.push(`Surveillance ${r.key} : ${e.message}`);
    }
  }
  const active = all.filter((w) => !w.paused).slice(0, MAX_ACTIVE);
  return { rows: results || [], all, active, errors };
}

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;

export async function addWatch(env, rawUrl, name) {
  const db = env.DB;
  await ensureSchema(db);
  await seed(env);
  let w;
  try { w = parseBookingUrl(String(rawUrl || '').trim()); } catch (e) {
    return { ok: false, error: `${e.message}. Il faut le lien de l'étape calendrier (…/booking/availabilities?…placeId=practice-…&motiveIds[]=…).` };
  }
  const { results } = await db.prepare('SELECT key, paused FROM watches').all();
  const ex = (results || []).find((r) => r.key === w.key);
  if (ex) {
    if (Number(ex.paused) === 1) {
      await db.prepare('UPDATE watches SET paused = 0 WHERE key = ?').bind(w.key).run();
      return { ok: true, key: w.key, resumed: true };
    }
    return { ok: false, error: 'Cette surveillance existe déjà.', key: w.key };
  }
  if ((results || []).filter((r) => Number(r.paused) === 0).length >= MAX_ACTIVE) {
    return { ok: false, error: `Maximum ${MAX_ACTIVE} surveillances actives : mets-en une en pause ou supprime-la.` };
  }
  await db.prepare('INSERT INTO watches (key, url, name, paused, created_at) VALUES (?, ?, ?, 0, ?)')
    .bind(w.key, w.url.slice(0, 1500), cleanName(name), nowSec()).run();
  return { ok: true, key: w.key };
}

export async function setPaused(env, key, paused) {
  const r = await env.DB.prepare('UPDATE watches SET paused = ? WHERE key = ?').bind(paused ? 1 : 0, String(key)).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function renameWatch(env, key, name) {
  const r = await env.DB.prepare('UPDATE watches SET name = ? WHERE key = ?').bind(cleanName(name), String(key)).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function removeWatch(env, key) {
  const db = env.DB;
  const k = String(key);
  const r = await db.prepare('DELETE FROM watches WHERE key = ?').bind(k).run();
  if (!(r.meta?.changes ?? 0)) return false;
  await db.batch([
    db.prepare('DELETE FROM slots WHERE watch = ?').bind(k),
    db.prepare('DELETE FROM checks WHERE watch = ?').bind(k),
    ...['agenda', 'next', 'fail'].map((p) => metaDelStmt(db, `${p}:${k}`)),
  ]);
  return true;
}

export async function watchLabels(env) {
  const meta = await getAllMeta(env.DB);
  const { all } = await loadWatches(env);
  return all.map((w) => {
    let label = `Cabinet ${w.practice}`;
    try { label = JSON.parse(meta[`agenda:${w.key}`] || '{}').label || label; } catch { /* défaut */ }
    return { key: w.key, label: w.name || label, paused: w.paused };
  });
}
