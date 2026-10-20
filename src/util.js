export class FatalError extends Error {
  constructor(message, http = null) { super(message); this.name = 'FatalError'; this.http = http; }
}
export class BlockedError extends Error {
  constructor(message, http = null) { super(message); this.name = 'BlockedError'; this.http = http; }
}
export class SchemaError extends Error {
  constructor(message, http = null) { super(message); this.name = 'SchemaError'; this.http = http; }
}

export const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

export const rand = (a, b) => a + Math.random() * (b - a);
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Attente (sans coût CPU). `o.fast` la supprime (vérification manuelle, tests). */
export function sleepMs(o, ms) {
  if (o && o.fast) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

export function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Date du jour à Paris au format YYYY-MM-DD. */
export function parisToday(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Masque les valeurs sensibles dans un texte destiné aux logs / au tableau de bord. */
export function scrub(text, secrets = []) {
  let t = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 6) t = t.split(String(s)).join('***');
  return t;
}

export function dayLabel(isoDay) {
  const wd = JOURS[new Date(`${isoDay}T12:00:00Z`).getUTCDay()];
  return `${wd} ${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;
}

/** Regroupe des créneaux ISO par jour : { '2026-10-21': ['09:00', '10:30'] } */
export function groupByDay(slots) {
  const by = {};
  for (const s of [...slots].sort()) (by[s.slice(0, 10)] ||= []).push(s.slice(11, 16));
  return by;
}

export function formatSlots(slots) {
  return Object.entries(groupByDay(slots))
    .map(([d, hours]) => `- ${dayLabel(d)} : ${hours.join(', ')}`)
    .join('\n');
}
