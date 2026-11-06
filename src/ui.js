// Pages de l'interface web commune : accueil, bots branchés, journal.
import { esc, shell, timeTag } from './layout.js';
import { hubOverview } from './overview.js';
import { isOnline, recentBotEvents, recentCommands } from './hub.js';
import { nowSec } from './util.js';

function fmtArgs(raw) {
  try {
    const o = JSON.parse(raw || '{}');
    const vals = o.text !== undefined ? [o.text] : Object.values(o);
    return vals.filter((v) => v !== '' && v != null).join(' ');
  } catch { return ''; }
}

const STATE_LABEL = { ok: 'OK', warn: 'Attention', bad: 'Problème', idle: 'En attente' };

export async function buildNav(env) {
  const o = await hubOverview(env);
  return [
    { href: '/', label: 'Accueil' },
    { href: '/doctolib', label: 'Doctolib', status: o.doctolib.status },
    ...o.bots.map((b) => ({ href: b.href, label: b.name, status: b.status })),
    { href: '/journal', label: 'Journal' },
  ];
}

const metricsHtml = (ms) => (ms && ms.length
  ? `<div class="metrics">${ms.map((m) => `<div><b>${esc(m.value)}</b><span>${esc(m.label)}</span></div>`).join('')}</div>` : '');

function botCard(b) {
  return `<a class="card" href="${esc(b.href)}">
<div class="row"><h2>${esc(b.name)}</h2><span class="badge ${b.status === 'idle' ? '' : esc(b.status)}">${esc(b.online ? STATE_LABEL[b.status] || '—' : 'Hors ligne')}</span></div>
<p class="muted" style="font-size:14px;color:var(--fg)">${esc(b.summary)}</p>
${metricsHtml(b.metrics.slice(0, 4))}
<p class="muted">Dernier signe : ${timeTag(b.lastSeen)}</p></a>`;
}

export async function renderHome(env, nav, flash) {
  const o = await hubOverview(env);
  const events = await recentBotEvents(env, 8);
  const ev = events.length
    ? `<table><thead><tr><th>Quand</th><th>Bot</th><th>Évènement</th></tr></thead><tbody>${events.map((e) => `<tr class="lv-${esc(e.level)}"><td>${timeTag(e.ts)}</td><td>${esc(e.bot)}</td><td>${esc(e.text)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Rien pour le moment.</p>';
  const body = `${flash ? `<div class="flash ${flash.ok ? '' : 'bad'}">${esc(flash.text)}</div>` : ''}
<div class="top"><div><h1>Mes bots</h1><p class="muted">Tout est piloté d'ici et depuis ton bot Telegram.</p></div>
<div class="actions"><form method="post" action="/tg-setup"><button type="submit">Reconnecter Telegram</button></form>
<form method="post" action="/test-telegram"><button type="submit">Tester Telegram</button></form></div></div>
<section class="cards small">${botCard(o.doctolib)}${o.bots.map(botCard).join('')}</section>
${o.bots.length ? '' : `<p class="muted" style="margin-top:14px">TGTG, AliExpress coins et les autres bots apparaîtront ici dès que l'agent sera installé sur ton serveur (voir le README, étape « Agent du serveur »).</p>`}
<h3>Derniers évènements des bots</h3>${ev}`;
  return shell({ title: 'Mes bots', nav, active: '/', body });
}

function actionForm(b, a) {
  const fields = a.args.map((x) => `<input type="text" name="${esc(x.name)}" placeholder="${esc(x.label || x.name)}" required maxlength="120" style="width:190px">`).join('');
  return `<form class="inline formrow" method="post" action="/bot/${esc(b.id)}/action"${a.confirm ? ` data-confirm="${esc(a.confirm)}"` : ''}>
<input type="hidden" name="action" value="${esc(a.id)}">${fields}<button type="submit">${esc(a.label)}</button></form>`;
}

function settingRow(b, s) {
  let input;
  if (s.type === 'bool') input = `<select name="value"><option value="1"${s.value === '1' || s.value === 'true' ? ' selected' : ''}>Oui</option><option value="0"${s.value === '0' || s.value === 'false' ? ' selected' : ''}>Non</option></select>`;
  else if (s.type === 'select') input = `<select name="value">${s.options.map((o) => `<option${o === s.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  else input = `<input type="${s.type === 'number' ? 'number' : 'text'}" name="value" value="${esc(s.value)}" maxlength="120" style="width:100%">`;
  return `<form class="set" method="post" action="/bot/${esc(b.id)}/set"><label>${esc(s.label)}${s.help ? `<br><span class="muted">${esc(s.help)}</span>` : ''}</label>
<input type="hidden" name="key" value="${esc(s.key)}">${input}<button class="sm" type="submit">Appliquer</button></form>`;
}

export async function renderBot(env, nav, bot, flash) {
  const now = nowSec();
  const online = !!isOnline(env, bot, now);
  const st = bot.state;
  const cmds = await recentCommands(env, bot.id, 8);
  const events = await recentBotEvents(env, 25, bot.id);
  const status = online ? (st?.status || 'idle') : 'bad';
  const tables = (st?.tables || []).map((t) => `<h3>${esc(t.title)}</h3>${t.rows.length
    ? `<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="muted">Rien.</p>'}`).join('');
  const body = `${flash ? `<div class="flash ${flash.ok ? '' : 'bad'}">${esc(flash.text)}</div>` : ''}
<div class="top"><div><h1>${esc(bot.name)}</h1>
<span class="global ${status === 'idle' ? '' : esc(status)}">${esc(online ? (st?.summary || 'En attente du premier rapport') : 'Hors ligne')}</span>
<p class="muted">Dernier signe de l'agent : ${timeTag(bot.lastSeen)}${online ? '' : ' · le serveur est peut-être éteint ou l\'agent arrêté'}</p></div></div>
${metricsHtml(st?.metrics)}
${st?.actions?.length ? `<h3>Actions</h3><div class="card"><div class="actions">${st.actions.map((a) => actionForm(bot, a)).join('')}</div>${online ? '' : '<p class="muted">Les commandes seront livrées dès que l\'agent sera de retour (10 min maximum).</p>'}</div>` : ''}
${st?.settings?.length ? `<h3>Réglages</h3><div class="card">${st.settings.map((s) => settingRow(bot, s)).join('')}</div>` : ''}
${tables}
${st?.log?.length ? `<h3>Journal du bot</h3><pre class="log">${esc(st.log.join('\n'))}</pre>` : ''}
${cmds.length ? `<h3>Dernières commandes</h3><table><thead><tr><th>Quand</th><th>Commande</th><th>État</th><th>Résultat</th></tr></thead><tbody>${cmds.map((c) => `<tr><td>${timeTag(c.created_at)}</td><td>${esc(c.cmd)} ${esc(fmtArgs(c.args))}</td><td>${esc({ pending: 'en attente', sent: 'envoyée', done: 'faite', error: 'échec', expired: 'expirée' }[c.status] || c.status)}</td><td>${esc(c.result || '')}</td></tr>`).join('')}</tbody></table>` : ''}
${events.length ? `<h3>Évènements</h3><table><tbody>${events.map((e) => `<tr class="lv-${esc(e.level)}"><td>${timeTag(e.ts)}</td><td>${esc(e.text)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  return shell({ title: bot.name, nav, active: `/bot/${bot.id}`, body });
}

export async function renderJournal(env, nav, doctolibEvents) {
  const events = await recentBotEvents(env, 100);
  const rows = [
    ...events.map((e) => ({ ts: e.ts, bot: e.bot, level: e.level, text: e.text })),
    ...doctolibEvents.map((e) => ({ ts: e.ts, bot: 'doctolib', level: ['alert_failed', 'down', 'telegram_ko', 'collector_silent', 'dispatch_failed'].includes(e.type) ? 'bad' : 'info', text: `${e.type} ${e.detail || ''}`.trim() })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 120);
  const body = `<div class="top"><div><h1>Journal</h1><p class="muted">Tous les bots, du plus récent au plus ancien.</p></div></div>
${rows.length ? `<table><thead><tr><th>Quand</th><th>Bot</th><th>Détail</th></tr></thead><tbody>${rows.map((e) => `<tr class="lv-${esc(e.level)}"><td>${timeTag(e.ts)}</td><td>${esc(e.bot)}</td><td>${esc(e.text)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Rien pour le moment.</p>'}`;
  return shell({ title: 'Journal', nav, active: '/journal', body });
}
