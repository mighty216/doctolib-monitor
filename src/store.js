// Accès D1 : état, historique, journal. Le schéma se crée tout seul (aucune migration à lancer).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS checks (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, watch TEXT NOT NULL,
     status TEXT NOT NULL, n_slots INTEGER NOT NULL DEFAULT 0, http INTEGER, ms INTEGER, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_checks_watch_id ON checks (watch, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks (ts)`,
  `CREATE TABLE IF NOT EXISTS slots (
     watch TEXT NOT NULL, slot TEXT NOT NULL, first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (watch, slot))`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
     watch TEXT, detail TEXT)`,
];

let schemaDone = false;
export function resetSchemaFlag() { schemaDone = false; } // tests

export async function ensureSchema(db) {
  if (schemaDone) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaDone = true;
}

export async function getAllMeta(db) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all();
  const m = {};
  for (const r of results || []) m[r.key] = r.value;
  return m;
}

export const metaStmt = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value));

export const metaDelStmt = (db, key) => db.prepare('DELETE FROM meta WHERE key = ?').bind(key);

export async function setMeta(db, key, value) { await metaStmt(db, key, value).run(); }

/** Verrou atomique : une seule vérification à la fois (cron + bouton manuel). */
export async function acquireLock(db, now, ttlSec) {
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('lock', '0')").run();
  const r = await db
    .prepare("UPDATE meta SET value = ? WHERE key = 'lock' AND CAST(value AS INTEGER) < ?")
    .bind(String(now), now - ttlSec)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Map watch -> Map(slot -> alerted) */
export async function getAllSlots(db) {
  const { results } = await db.prepare('SELECT watch, slot, alerted FROM slots').all();
  const m = new Map();
  for (const r of results || []) {
    if (!m.has(r.watch)) m.set(r.watch, new Map());
    m.get(r.watch).set(r.slot, Number(r.alerted));
  }
  return m;
}

export const upsertSlotStmt = (db, watch, slot, ts, alerted) =>
  db.prepare(
    `INSERT INTO slots (watch, slot, first_seen, last_seen, alerted) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(watch, slot) DO UPDATE SET last_seen = excluded.last_seen,
       alerted = MAX(slots.alerted, excluded.alerted)`,
  ).bind(watch, slot, ts, ts, alerted ? 1 : 0);

export const pruneSlotsStmt = (db, watch, ts) =>
  db.prepare('DELETE FROM slots WHERE watch = ? AND last_seen < ?').bind(watch, ts);

export const checkStmt = (db, c) =>
  db.prepare('INSERT INTO checks (ts, watch, status, n_slots, http, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(c.ts, c.watch, c.status, c.n_slots ?? 0, c.http ?? null, c.ms ?? null, c.error ?? null);

export const eventStmt = (db, ts, type, watch, detail) =>
  db.prepare('INSERT INTO events (ts, type, watch, detail) VALUES (?, ?, ?, ?)')
    .bind(ts, type, watch ?? null, detail == null ? null : String(detail).slice(0, 500));

export const retentionStmts = (db, now) => [
  db.prepare('DELETE FROM checks WHERE ts < ?').bind(now - 8 * 86400),
  db.prepare('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM events) - 300'),
];

/** Toutes les données nécessaires au tableau de bord, en un seul aller-retour D1. */
export async function loadDashboardData(db, watchKeys, now) {
  const stmts = [
    db.prepare('SELECT key, value FROM meta'),
    db.prepare('SELECT watch, slot, alerted FROM slots ORDER BY slot LIMIT 400'),
    db.prepare('SELECT ts, type, watch, detail FROM events ORDER BY id DESC LIMIT 30'),
    db.prepare(
      `SELECT watch, COUNT(*) AS n, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok
       FROM checks WHERE ts >= ? GROUP BY watch`,
    ).bind(now - 86400),
    db.prepare(
      `SELECT watch, COUNT(*) AS n, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok
       FROM checks WHERE ts >= ? GROUP BY watch`,
    ).bind(now - 7 * 86400),
    ...watchKeys.map((k) =>
      db.prepare(
        'SELECT ts, status, n_slots, http, ms, error FROM checks WHERE watch = ? ORDER BY id DESC LIMIT 48',
      ).bind(k),
    ),
  ];
  const res = await db.batch(stmts);
  const rows = (i) => res[i]?.results || [];
  const meta = {};
  for (const r of rows(0)) meta[r.key] = r.value;
  const slots = {};
  for (const r of rows(1)) (slots[r.watch] ||= []).push({ slot: r.slot, alerted: Number(r.alerted) === 1 });
  const rate = (i) => Object.fromEntries(rows(i).map((r) => [r.watch, { n: Number(r.n), ok: Number(r.ok) }]));
  const timelines = {};
  watchKeys.forEach((k, idx) => { timelines[k] = rows(5 + idx).slice().reverse(); }); // ancien -> récent
  return { meta, slots, events: rows(2), rate24: rate(3), rate7: rate(4), timelines };
}
