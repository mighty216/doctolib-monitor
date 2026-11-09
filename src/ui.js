// Pages de l'interface web commune : accueil, bots branchés, journal.
import { esc, shell, timeTag, tableHtml } from './layout.js';
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
const CMD_STATE = { pending: ['en attente', 'run'], sent: ['en cours', 'run'], done: ['faite', 'ok'], error: ['échec', 'bad'], expired: ['expirée', 'bad'] };

/** Onglets : réutilise une vue d'ensemble déjà calculée pour éviter une deuxième lecture de la base. */
export async function buildNav(env, overview = null) {
  const o = overview || await hubOverview(env);
  return [
    { href: '/', label: 'Accueil' },
    { href: '/doctolib', label: 'Doctolib', status: o.doctolib.status },
    ...o.bots.map((b) => ({ href: b.href, label: b.name, status: b.status })),
    { href: '/journal', label: 'Journal' },
  ];
}

const metricsHtml = (ms) => (ms && ms.length
  ? `<div class="metrics">${ms.map((m) => `<div><b title="${esc(m.value)}">${esc(m.value)}</b><span>${esc(m.label)}</span></div>`).join('')}</div>` : '');

const flashHtml = (flash) => (flash ? `<div class="flash ${flash.ok ? '' : 'bad'}">${esc(flash.text)}</div>` : '');

function botCard(b) {
  const st = b.online ? b.status : 'bad';
  return `<a class="card ${esc(st === 'idle' ? '' : st)}" href="${esc(b.href)}">
<div class="row"><h2>${esc(b.name)}</h2><span class="badge ${st === 'idle' ? '' : esc(st)}">${esc(b.online ? STATE_LABEL[b.status] || '—' : 'Hors ligne')}</span></div>
<p style="margin:2px 0;font-size:14px">${esc(b.summary)}</p>
${metricsHtml(b.metrics.slice(0, 4))}
<p class="muted">Dernier signe : ${timeTag(b.lastSeen)}</p><span class="go">Ouvrir →</span></a>`;
}

const eventRows = (events, withBot) => events.map((e) => [
  timeTag(e.ts), ...(withBot ? [esc(e.bot)] : []), esc(e.text),
]);

export async function renderHome(env, nav, flash, overview = null) {
  const o = overview || await hubOverview(env);
  const events = await recentBotEvents(env, 10);
  const all = [o.doctolib, ...o.bots];
  const bad = all.filter((b) => !b.online || b.status === 'bad').length;
  const warn = all.filter((b) => b.online && b.status === 'warn').length;
  const [gcls, gtxt] = bad ? ['bad', `${bad} bot(s) en problème`] : warn ? ['warn', `${warn} bot(s) à surveiller`] : ['ok', 'Tout fonctionne'];
  const body = `${flashHtml(flash)}
<div class="hero"><div><h1>Mes bots</h1><div class="sub"><span class="global ${gcls}">${esc(gtxt)}</span><span class="muted">${all.length} bot(s) · pilotés d'ici et depuis Telegram</span></div></div>
<div class="actions"><form method="post" action="/test-telegram"><button type="submit">✈️ Tester Telegram</button></form>
<form method="post" action="/tg-setup"><button type="submit">🔌 Reconnecter Telegram</button></form></div></div>
<section class="cards small">${all.map(botCard).join('')}</section>
${o.bots.length ? '' : `<p class="muted" style="margin-top:14px">TGTG, AliExpress coins et les autres bots apparaîtront ici dès que l'agent sera installé sur ton serveur (voir le README, étape « Agent du serveur »).</p>`}
<h3>Derniers évènements</h3>${tableHtml(['Quand', 'Bot', 'Évènement'], eventRows(events, true), { rowClass: (i) => `lv-${events[i].level}`, cellClass: ['nw'] })}`;
  return shell({ title: 'Mes bots', nav, active: '/', body, refresh: 30 });
}

const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

function actionForm(b, a) {
  if (!a.args.length) {
    return `<form class="inline" method="post" action="/bot/${esc(b.id)}/action"${a.confirm ? ` data-confirm="${esc(a.confirm)}"` : ''}>
${hidden('action', a.id)}<button type="submit"${a.danger ? ' class="danger"' : ''}>${esc(a.label)}</button></form>`;
  }
  const fields = a.args.map((x) => `<input type="text" name="${esc(x.name)}" placeholder="${esc(x.placeholder || x.label || x.name)}" aria-label="${esc(x.label || x.name)}" required maxlength="120">`).join('');
  return `<form class="argform" method="post" action="/bot/${esc(b.id)}/action" data-reset${a.confirm ? ` data-confirm="${esc(a.confirm)}"` : ''}>
<span class="lbl">${esc(a.label)}</span>${hidden('action', a.id)}${fields}<button type="submit" data-label="${esc(a.label)}">Envoyer</button></form>`;
}

function settingRow(b, s) {
  let input;
  const id = `s-${b.id}-${s.key}`;
  if (s.type === 'bool') input = `<select id="${esc(id)}" name="value"><option value="1"${s.value === '1' || s.value === 'true' ? ' selected' : ''}>Oui</option><option value="0"${s.value === '0' || s.value === 'false' ? ' selected' : ''}>Non</option></select>`;
  else if (s.type === 'select') input = `<select id="${esc(id)}" name="value">${s.options.map((o) => `<option${o === s.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  else input = `<input id="${esc(id)}" type="${s.type === 'number' ? 'number' : 'text'}"${s.type === 'number' ? ' inputmode="numeric"' : ''} name="value" value="${esc(s.value)}" maxlength="120">`;
  return `<form class="set" method="post" action="/bot/${esc(b.id)}/set"><label for="${esc(id)}">${esc(s.label)}${s.help ? `<span class="muted">${esc(s.help)}</span>` : ''}</label>
${hidden('key', s.key)}${input}<button class="sm" type="submit" data-label="${esc(s.label)}">Appliquer</button></form>`;
}

const num = (v) => Number.parseFloat(String(v).replace(',', '.'));

/** Boutons par ligne d'un tableau (ex. « Réserver » sur un panier) : arguments tirés des colonnes ({n}). */
function rowActionsHtml(b, t, r, actions) {
  return t.rowActions.map((ra) => {
    const act = actions.find((a) => a.id === ra.action);
    if (!act) return '';
    if (ra.when !== null && !(num(r[ra.when]) > 0 || (Number.isNaN(num(r[ra.when])) && String(r[ra.when] ?? '').trim()))) return '';
    const vals = Object.fromEntries(Object.entries(ra.args).map(([k, v]) => [k, String(v).replace(/\{(\d)\}/g, (_m, i) => r[Number(i)] ?? '')]));
    if (act.args.some((x) => !vals[x.name])) return '';
    const conf = ra.confirm ? ra.confirm.replace(/\{(\d)\}/g, (_m, i) => r[Number(i)] ?? '') : '';
    return `<form class="inline" method="post" action="/bot/${esc(b.id)}/action"${conf ? ` data-confirm="${esc(conf)}"` : ''}>
${hidden('action', act.id)}${act.args.map((x) => hidden(x.name, vals[x.name])).join('')}<button class="sm${ra.danger ? ' danger' : ''}" type="submit" data-label="${esc(`${ra.label} · ${r[0] ?? ''}`)}">${esc(ra.label)}</button></form>`;
  }).join('');
}

function botTable(b, t, actions) {
  const hasAct = t.rowActions.length > 0;
  const cols = hasAct ? [...t.columns, ''] : t.columns;
  const rows = t.rows.map((r) => {
    const cells = r.map((c) => esc(c));
    if (hasAct) cells.push(`<div class="actions">${rowActionsHtml(b, t, r, actions)}</div>`);
    return cells;
  });
  const cellClass = hasAct ? { [cols.length - 1]: 'act' } : {};
  const hl = t.highlight;
  return `<h3>${esc(t.title)}</h3>${tableHtml(cols, rows, {
    empty: 'Rien pour le moment.', cellClass,
    rowClass: hl === null ? null : (i) => (num(t.rows[i][hl]) > 0 ? 'hl' : ''),
  })}`;
}

export async function renderBot(env, nav, bot, flash) {
  const now = nowSec();
  const online = !!isOnline(env, bot, now);
  const st = bot.state;
  const cmds = await recentCommands(env, bot.id, 10);
  const events = await recentBotEvents(env, 25, bot.id);
  const status = online ? (st?.status || 'idle') : 'bad';
  const actions = st?.actions || [];
  const visible = actions.filter((a) => !a.hidden);
  const simple = visible.filter((a) => !a.args.length);
  const withArgs = visible.filter((a) => a.args.length);
  const tables = (st?.tables || []).map((t) => botTable(bot, t, actions)).join('');
  const actionsBlock = visible.length ? `<section><h3>Actions</h3><div class="card">
${simple.length ? `<div class="actions">${simple.map((a) => actionForm(bot, a)).join('')}</div>` : ''}
${withArgs.length ? `<div${simple.length ? ' style="margin-top:14px"' : ''}>${withArgs.map((a) => actionForm(bot, a)).join('')}</div>` : ''}
${online ? '' : '<p class="muted">Le bot est hors ligne : les commandes lui seront livrées dès son retour (10 min maximum).</p>'}</div></section>` : '';
  const settingsBlock = st?.settings?.length ? `<section><h3>Réglages</h3><div class="card">${st.settings.map((s) => settingRow(bot, s)).join('')}</div></section>` : '';
  const cmdRows = cmds.map((c) => {
    const [lbl, cls] = CMD_STATE[c.status] || [c.status, ''];
    return [timeTag(c.created_at), `<b>${esc(c.cmd)}</b> ${esc(fmtArgs(c.args))}${c.source === 'telegram' ? ' <span class="chip">Telegram</span>' : ''}`,
      `<span class="chip ${cls}">${esc(lbl)}</span>`, `<span class="res">${esc(c.result || '')}</span>`];
  });
  const body = `${flashHtml(flash)}
<div class="hero"><div><h1>${esc(bot.name)}</h1><div class="sub">
<span class="global ${status === 'idle' ? '' : esc(status)}">${esc(online ? (st?.summary || 'En attente du premier rapport') : 'Hors ligne')}</span>
<span class="muted">Dernier signe de l'agent : ${timeTag(bot.lastSeen)}${online ? '' : " · le serveur est peut-être éteint ou l'agent arrêté"}</span></div></div></div>
${metricsHtml(st?.metrics)}
${actionsBlock || settingsBlock ? `<div class="grid2">${actionsBlock}${settingsBlock}</div>` : ''}
${tables}
${cmds.length ? `<h3>Dernières commandes</h3>${tableHtml(['Quand', 'Commande', 'État', 'Résultat'], cmdRows, { cellClass: ['nw'] })}` : ''}
${st?.log?.length ? `<details class="fold" id="fold-log" open><summary><h3>Journal du bot</h3></summary><pre class="log">${esc(st.log.join('\n'))}</pre></details>` : ''}
${events.length ? `<details class="fold" id="fold-ev"><summary><h3>Évènements (${events.length})</h3></summary>${tableHtml(['Quand', 'Évènement'], eventRows(events, false), { rowClass: (i) => `lv-${events[i].level}`, cellClass: ['nw'] })}</details>` : ''}`;
  return shell({ title: bot.name, nav, active: `/bot/${bot.id}`, body, refresh: 20 });
}

const DOCTOLIB_BAD = ['alert_failed', 'down', 'telegram_ko', 'collector_silent', 'dispatch_failed'];

export async function renderJournal(env, nav, doctolibEvents) {
  const events = await recentBotEvents(env, 100);
  const rows = [
    ...events.map((e) => ({ ts: e.ts, bot: e.bot, level: e.level, text: e.text })),
    ...doctolibEvents.map((e) => ({ ts: e.ts, bot: 'doctolib', level: DOCTOLIB_BAD.includes(e.type) ? 'bad' : 'info', text: `${e.type} ${e.detail || ''}`.trim() })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 120);
  const body = `<div class="hero"><div><h1>Journal</h1><p class="muted">Tous les bots, du plus récent au plus ancien.</p></div></div>
${tableHtml(['Quand', 'Bot', 'Détail'], eventRows(rows, true), { rowClass: (i) => `lv-${rows[i].level}`, cellClass: ['nw'] })}`;
  return shell({ title: 'Journal', nav, active: '/journal', body, refresh: 60 });
}
