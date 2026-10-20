import { FatalError, BlockedError, SchemaError, SLOT_RE, addDays, sleepMs, rand } from './util.js';

// Endpoints non officiels (d'après la gem toc_doc) :
//  - info.json  : agendas, motifs et cabinets d'un praticien
//  - availabilities.json : créneaux
const INFO_PATH = '/online_booking/api/slot_selection_funnel/v1/info.json';
const AVAIL_PATH = '/availabilities.json';
export const MAX_WATCHES = 4; // 50 sous-requêtes max par exécution (plan gratuit)

const base = (env) => String(env.DOCTOLIB_BASE || 'https://www.doctolib.fr').replace(/\/$/, '');

function headers(env) {
  return {
    Accept: 'application/json',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    Referer: `${base(env)}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  };
}

export function parseBookingUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new FatalError('URL invalide'); }
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('booking');
  if (i < 1) throw new FatalError("il faut l'URL de l'étape /booking/availabilities");
  const slug = parts[i - 1];
  const city = i >= 2 ? parts[i - 2] : '';
  const motives = [...u.searchParams.getAll('motiveIds[]'), ...u.searchParams.getAll('motiveIds')]
    .filter((m) => /^\d+$/.test(m));
  const practice = (u.searchParams.get('placeId') || '').replace(/^practice-/, '');
  if (!motives.length || !/^\d+$/.test(practice)) {
    throw new FatalError('motiveIds[] et placeId=practice-XXXX sont requis');
  }
  return {
    url: raw,
    key: `${practice}-${motives.join('-')}`,
    slugCandidates: [slug, ...(city ? [`${slug}-${city}`] : [])],
    motives,
    practice,
    telehealth: u.searchParams.get('telehealth') === 'true' ? 'true' : 'false',
  };
}

/** DOCTOLIB_URLS : une ou plusieurs URL séparées par espace, retour ligne, virgule ou |. */
export function parseWatches(raw) {
  const watches = [];
  const errors = [];
  const seen = new Set();
  const urls = String(raw || '').split(/[\s,|]+/).filter(Boolean);
  urls.forEach((u, idx) => {
    try {
      const w = parseBookingUrl(u);
      if (seen.has(w.key)) return;
      seen.add(w.key);
      watches.push(w);
    } catch (e) {
      errors.push(`URL n°${idx + 1} : ${e.message}`);
    }
  });
  if (watches.length > MAX_WATCHES) {
    errors.push(`Maximum ${MAX_WATCHES} cabinets : les suivants sont ignorés.`);
    watches.length = MAX_WATCHES;
  }
  return { watches, errors };
}

export async function apiGet(env, path, params, o = {}, maxAttempts = 3) {
  const attempts = Math.min(maxAttempts, o.attempts ?? maxAttempts);
  const url = new URL(base(env) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let last = 'inconnu';
  let lastHttp = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let wait = attempt === 0 ? 4000 : 10000;
    let res = null;
    try {
      res = await fetch(url.toString(), { headers: headers(env), signal: AbortSignal.timeout(20000) });
    } catch (e) {
      last = `réseau (${e?.name || 'erreur'})`;
      lastHttp = null;
    }
    if (res) {
      const code = res.status;
      if (code === 200) {
        let text;
        try { text = await res.text(); } catch { text = ''; }
        try { return JSON.parse(text); } catch {
          throw new SchemaError('réponse non-JSON (page de protection anti-bot ?)', 200);
        }
      }
      try { await res.body?.cancel(); } catch { /* ignoré */ }
      if (code === 400 || code === 404 || code === 422) {
        throw new FatalError(`HTTP ${code} sur ${path} : IDs invalides ou endpoint modifié`, code);
      }
      lastHttp = code;
      if (code === 429) {
        last = 'HTTP 429 (trop de requêtes)';
        const ra = Number.parseInt(res.headers.get('Retry-After'), 10);
        if (ra > 0) wait = Math.min(60000, ra * 1000);
      } else if (code === 403) {
        last = 'HTTP 403 (IP ou client bloqué)';
      } else {
        last = `HTTP ${code}`;
      }
    }
    if (attempt < attempts - 1) await sleepMs(o, wait + rand(0, 1500));
  }
  throw new BlockedError(last, lastHttp);
}

const norm = (v) => String(v ?? '').replace(/^practice-/, '');

export async function getBookingInfo(env, w, o) {
  // Même praticien pour plusieurs cabinets : un seul appel par exécution.
  const ck = w.slugCandidates.join('|');
  o.infoCache ||= new Map();
  if (o.infoCache.has(ck)) return o.infoCache.get(ck);
  const info = await fetchBookingInfo(env, w, o);
  o.infoCache.set(ck, info);
  return info;
}

async function fetchBookingInfo(env, w, o) {
  for (const slug of w.slugCandidates) {
    let data;
    try { data = await apiGet(env, INFO_PATH, { profile_slug: slug }, o, 2); } catch (e) {
      if (e instanceof FatalError) continue;
      throw e;
    }
    const info = data && typeof data === 'object' ? data.data : null;
    if (info && typeof info === 'object' && Array.isArray(info.agendas) && info.agendas.length) return info;
  }
  throw new FatalError(`Profil introuvable via l'API (slug testé : ${w.slugCandidates.join(', ')})`);
}

export function resolveAgendas(w, info) {
  const wanted = new Set(w.motives);
  const out = [];
  for (const a of info.agendas || []) {
    const motives = new Set((a.visit_motive_ids || []).map(String));
    const practices = new Set([norm(a.practice_id)]);
    const byPractice = a.visit_motive_ids_by_practice_id;
    if (byPractice && typeof byPractice === 'object') {
      for (const [k, v] of Object.entries(byPractice)) {
        practices.add(norm(k));
        if (norm(k) === w.practice) for (const m of v || []) motives.add(String(m));
      }
    }
    if (practices.has(w.practice) && [...motives].some((m) => wanted.has(m))) out.push(String(a.id));
  }
  return out;
}

export function placeLabel(info, practice) {
  for (const p of info.places || []) {
    if (p && norm(p.id) === practice) {
      const txt = [p.name || p.formal_name, p.city].filter(Boolean).join(', ');
      if (txt) return txt;
    }
  }
  return `Cabinet ${practice}`;
}

/** Retourne { slots: [ISO...] (dans l'horizon), next: prochaine date connue | null } */
export async function fetchSlots(env, w, agendas, horizon, today, o) {
  const end = addDays(today, horizon);
  let cursor = today;
  let calls = 0;
  let next = null;
  const slots = new Set();
  while (cursor <= end && calls < 8) {
    calls++;
    const data = await apiGet(env, AVAIL_PATH, {
      start_date: cursor,
      visit_motive_ids: w.motives.join('-'),
      agenda_ids: agendas.join('-'),
      practice_ids: w.practice,
      telehealth: w.telehealth,
      limit: 7,
    }, o);
    if (!data || typeof data !== 'object' || !Array.isArray(data.availabilities)) {
      throw new SchemaError("clé 'availabilities' absente de la réponse (API modifiée ?)", 200);
    }
    let found = false;
    for (const day of data.availabilities) {
      for (const s of (day && day.slots) || []) {
        const ts = typeof s === 'string' ? s : s && s.start_date;
        if (typeof ts === 'string' && SLOT_RE.test(ts)) { slots.add(ts); found = true; }
      }
    }
    let step = addDays(cursor, 7);
    const nxt = data.next_slot;
    if (typeof nxt === 'string' && SLOT_RE.test(nxt)) {
      if (!next || nxt < next) next = nxt;
      if (!found && nxt.slice(0, 10) > cursor) step = nxt.slice(0, 10);
    }
    cursor = step;
    if (cursor <= end) await sleepMs(o, rand(1000, 2500));
  }
  return { slots: [...slots].filter((s) => s.slice(0, 10) <= end).sort(), next };
}
