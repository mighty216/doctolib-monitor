import { sleepMs } from './util.js';

export function telegramProblems(env) {
  const out = [];
  if (!/^\d+:[\w-]{30,}$/.test(String(env.TELEGRAM_BOT_TOKEN || ''))) {
    out.push('TELEGRAM_BOT_TOKEN absent ou au mauvais format');
  }
  if (!/^-?\d+$/.test(String(env.TELEGRAM_CHAT_ID || ''))) {
    out.push('TELEGRAM_CHAT_ID absent ou invalide');
  }
  return out;
}

/** Retourne { ok: true } ou { ok: false, error }. Ne lève jamais d'exception. */
export async function sendTelegram(env, text, o = {}) {
  const api = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const url = `${api}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let last = 'inconnu';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: String(text).slice(0, 3800),
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return { ok: true };
      let desc = '';
      try { desc = (await r.json()).description || ''; } catch { /* ignoré */ }
      last = `Telegram HTTP ${r.status}${desc ? ` (${desc})` : ''}`;
      if ([400, 401, 403, 404].includes(r.status)) return { ok: false, error: last }; // inutile de réessayer
    } catch (e) {
      last = `Telegram injoignable (${e?.name || 'erreur'})`;
    }
    if (attempt < 2) await sleepMs(o, 3000 * (attempt + 1));
  }
  return { ok: false, error: last };
}
