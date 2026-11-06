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

const apiBase = (env) => String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

/** Appel brut de l'API Telegram. Ne lève jamais : { ok, result?, error?, status? } */
export async function tgCall(env, method, payload = {}) {
  try {
    const r = await fetch(`${apiBase(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    let j = {};
    try { j = await r.json(); } catch { /* ignoré */ }
    if (r.ok && j.ok !== false) return { ok: true, result: j.result, status: r.status };
    return { ok: false, status: r.status, error: `Telegram HTTP ${r.status}${j.description ? ` (${j.description})` : ''}` };
  } catch (e) {
    return { ok: false, error: `Telegram injoignable (${e?.name || 'erreur'})` };
  }
}

/**
 * Envoie un message. o.html : texte en HTML Telegram ; o.markup : { inline_keyboard: [...] } ;
 * o.chat : autre destinataire. Retourne { ok: true } ou { ok: false, error }.
 */
export async function sendTelegram(env, text, o = {}) {
  let last = 'inconnu';
  const attempts = Math.min(3, o.attempts ?? 3);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const body = {
      chat_id: o.chat || env.TELEGRAM_CHAT_ID,
      text: String(text).slice(0, 3800),
      link_preview_options: { is_disabled: true },
    };
    if (o.html) body.parse_mode = 'HTML';
    if (o.markup) body.reply_markup = o.markup;
    const r = await tgCall(env, 'sendMessage', body);
    if (r.ok) return { ok: true, result: r.result };
    last = r.error;
    if ([400, 401, 403, 404].includes(r.status)) return { ok: false, error: last }; // inutile de réessayer
    if (attempt < attempts - 1) await sleepMs(o, 3000 * (attempt + 1));
  }
  return { ok: false, error: last };
}

/** Modifie un message existant (menus). Sinon, en renvoie un nouveau. */
export async function editOrSend(env, chat, messageId, text, markup, o = {}) {
  if (messageId) {
    const body = { chat_id: chat, message_id: messageId, text: String(text).slice(0, 3800), link_preview_options: { is_disabled: true } };
    if (o.html) body.parse_mode = 'HTML';
    if (markup) body.reply_markup = markup;
    const r = await tgCall(env, 'editMessageText', body);
    if (r.ok || /not modified/i.test(r.error || '')) return { ok: true };
  }
  return sendTelegram(env, text, { ...o, markup, chat });
}
