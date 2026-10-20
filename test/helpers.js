import { DatabaseSync } from 'node:sqlite';
import { resetSchemaFlag } from '../src/store.js';

/** Mini-D1 en mémoire (node:sqlite) avec la même API que la vraie : prepare/bind/run/all/first/batch. */
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, a.map((x) => (x === undefined ? null : x))),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })), meta: {} }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    _exec() { return /^\s*(SELECT|WITH)/i.test(sql) ? this.all() : this.run(); },
  });
  return {
    prepare: (sql) => mk(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    raw: db,
  };
}

export const URL_A = 'https://www.doctolib.fr/psychologue/lyon/dr-test/booking/availabilities?masterPatientUuid=x&specialityId=14&telehealth=false&placeId=practice-173867&motiveIds%5B%5D=2522294&source=profile';
export const URL_B = 'https://www.doctolib.fr/psychologue/lyon/dr-test/booking/availabilities?masterPatientUuid=x&specialityId=14&telehealth=false&placeId=practice-205310&motiveIds%5B%5D=2522294&pid=practice-205310&source=profile';
export const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_12';
export const KEY = 'cle-de-test-tres-longue-123';

export function makeEnv(extra = {}) {
  resetSchemaFlag();
  return {
    DB: makeD1(),
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: '42',
    DASHBOARD_KEY: KEY,
    DOCTOLIB_URLS: `${URL_A}\n${URL_B}`,
    MAX_DAYS: '21',
    HEARTBEAT_HOURS: '0',
    FAIL_ALERT_AFTER: '3',
    INTERVAL_MIN: '15',
    FAST: '1',
    MODE: 'direct',
    ...extra,
  };
}

export const iso = (n, h = '09:00') => {
  const d = new Date(Date.now() + n * 86400000 + 3600000); // heure de Paris approx.
  return `${d.toISOString().slice(0, 10)}T${h}:00.000+02:00`;
};
export const avail = (...isos) => {
  const days = {};
  for (const s of isos) (days[s.slice(0, 10)] ||= []).push(s);
  return { availabilities: Object.entries(days).map(([date, slots]) => ({ date, slots })), total: isos.length };
};

export const INFO = {
  data: {
    profile: { name: 'Dr Test' },
    visit_motives: [{ id: 2522294, name: 'Première consultation' }],
    places: [
      { id: 'practice-173867', name: 'Cabinet A', city: 'Lyon 6e' },
      { id: 'practice-205310', name: 'Cabinet B', city: 'Villeurbanne' },
    ],
    agendas: [
      { id: 111, practice_id: 999, visit_motive_ids: [2522294] },
      { id: 222, practice_id: 'practice-173867', visit_motive_ids: [2522294] },
      { id: 333, practice_id: 173867, visit_motive_ids: [1] },
      { id: 444, visit_motive_ids: [], visit_motive_ids_by_practice_id: { 'practice-205310': [2522294] } },
    ],
  },
};

/**
 * Installe un faux fetch global. `doctolib(url, params)` -> Response|objet JSON ; Telegram enregistré dans `sent`.
 * Retourne { sent, calls, tg } ; tg.ok = false simule une panne Telegram.
 */
export function installFetch({ doctolib }) {
  const state = { sent: [], calls: [], tg: { ok: true, status: 500 }, gh: [], ghStatus: 204 };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    state.calls.push(url.pathname + url.search);
    if (url.hostname === 'api.telegram.org') {
      if (state.tg.ok) {
        state.sent.push(JSON.parse(init.body).text);
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response('{"ok":false,"description":"boom"}', { status: state.tg.status });
    }
    if (url.hostname === 'api.github.com') {
      state.gh.push({ path: url.pathname, auth: init.headers?.Authorization, body: JSON.parse(init.body || '{}') });
      return new Response(null, { status: state.ghStatus });
    }
    const out = await doctolib(url.pathname, Object.fromEntries(url.searchParams));
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return state;
}

/** Réponses Doctolib standard : info.json + créneaux par agenda_ids. */
export const standardDoctolib = (byAgenda = {}) => (path, params) => {
  if (path.includes('slot_selection_funnel')) return INFO;
  return byAgenda[params.agenda_ids] || avail();
};
