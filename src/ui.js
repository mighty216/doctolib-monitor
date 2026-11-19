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
    ...(o.bots.some((b) => b.id === 'airpods') ? [] : [{ href: '/bot/airpods', label: 'AirPods' }]),
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

const WEEK = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/** Sélecteur des jours de la semaine : 7 boutons, valeur = 7 chiffres (1 = actif), envoyée à chaque clic. */
function weekRow(b, s) {
  const bits = String(s.value || '').padEnd(7, '1').slice(0, 7);
  return `<form class="set weekset" method="post" action="/bot/${esc(b.id)}/set"><label>${esc(s.label)}${s.help ? `<span class="muted">${esc(s.help)}</span>` : ''}</label>
${hidden('key', s.key)}<button type="submit" class="wkgo" data-label="${esc(s.label)}" hidden>ok</button><input type="hidden" name="value" value="${esc(bits)}">
<div class="week" role="group" aria-label="${esc(s.label)}">${WEEK.map((n, i) => `<button type="button" class="day${bits[i] === '1' ? ' on' : ''}" data-i="${i}" aria-pressed="${bits[i] === '1'}">${n}</button>`).join('')}</div></form>`;
}

function settingRow(b, s) {
  if (s.type === 'week') return weekRow(b, s);
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

// ---------------------------------------------------------------- AirPods : sonnerie jouée par le navigateur
// Pour des AirPods connectés au téléphone (ou au PC) qui ouvre la page : le son part vers la sortie Bluetooth active.
// Le script est hors de <main> (remplacé à chaque rafraîchissement) : il garde l'état et remet le bouton à jour.
const LOCAL_RING_HTML = `<section><h3>📱 Sonner sur cet appareil</h3><div class="card">
<p style="margin:0 0 10px">AirPods connectés à <b>ce téléphone</b> (ou à l'appareil qui affiche cette page) : le bip part directement d'ici,
sans agent. Monte le volume média à fond, puis approche-toi du son. Arrêt automatique après 3 min.
<br><span class="muted">⚠️ Son très fort : ne porte pas les AirPods pendant la sonnerie.</span></p>
<div class="actions"><button type="button" data-local-ring>🔊 Sonner ici</button></div></div></section>`;

const LOCAL_RING_JS = `(function(){
  var P=[[0.3,2700],[0.07,0],[0.3,3200],[0.07,0],[0.3,2700],[0.6,0]],C=1.64,MAX=180,ctx=null,out=null,next=0,end=0,timer=null,lock=null;
  function cycle(t){P.forEach(function(p){if(p[1]){var o=ctx.createOscillator(),g=ctx.createGain();o.type="square";o.frequency.value=p[1];
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.9,t+0.01);g.gain.setValueAtTime(0.9,t+p[0]-0.01);g.gain.linearRampToValueAtTime(0,t+p[0]);
    o.connect(g);g.connect(out);o.start(t);o.stop(t+p[0]);}t+=p[0];});}
  function fill(){if(ctx.currentTime>=end){stop();return;}while(next<Math.min(end,ctx.currentTime+30)){cycle(next);next+=C;}}
  function on(){return !!timer}
  function sync(){document.querySelectorAll("[data-origin]").forEach(function(x){x.textContent=location.origin});document.querySelectorAll("[data-local-ring]").forEach(function(b){b.textContent=on()?"⏹ Arrêter ici":"🔊 Sonner ici";b.classList.toggle("danger",on());});}
  function start(){ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();ctx.resume();out=ctx.createGain();out.connect(ctx.destination);
    next=ctx.currentTime+0.05;end=next+MAX;fill();timer=setInterval(fill,1000);
    try{navigator.wakeLock&&navigator.wakeLock.request("screen").then(function(l){lock=l}).catch(function(){})}catch(e){}sync();}
  function stop(){clearInterval(timer);timer=null;if(out){out.disconnect();out=null;}try{lock&&lock.release()}catch(e){}lock=null;sync();}
  document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-local-ring]");if(!b)return;on()?stop():start();});
  new MutationObserver(sync).observe(document.querySelector("main"),{childList:true});sync();
})();`;

// Option repliée en bas de page : le bip local (ci-dessus) reste le seul bloc visible en haut.
function airpodsInstallHtml() {
  return `<details class="fold" id="fold-pc"><summary><h3>💻 Option : sonner via le PC Windows</h3></summary><div class="card">
<p style="margin:0 0 8px">Pour faire sonner les AirPods via le PC depuis n'importe où (web ou Telegram <code>/sonner</code>) : sur le PC où ils sont associés,
ouvre <b>PowerShell</b> et colle cette ligne, avec la clé de l'agent (celle de la ligne <code>curl</code> dans <code>INFOS.txt</code>) :</p>
<pre class="log" style="white-space:pre-wrap;word-break:break-all">irm -Headers @{Authorization="Bearer CLE_AGENT"} <span data-origin>https://TON-HUB</span>/agent/install-airpods.ps1 | iex</pre>
<p class="muted" style="margin:8px 0 0">Installe Python si besoin, l'agent en arrière-plan et son démarrage avec Windows. Relançable pour mettre à jour.</p></div></details>`;
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
  const isAirpods = bot.id === 'airpods';
  const offlineTxt = bot.placeholder ? 'Agent PC pas encore installé' : 'Hors ligne';
  const offlineHint = isAirpods ? ' · PC éteint ou agent arrêté : « Sonner sur cet appareil » marche quand même' : " · le serveur est peut-être éteint ou l'agent arrêté";
  const body = `${flashHtml(flash)}
<div class="hero"><div><h1>${esc(bot.name)}</h1><div class="sub">
<span class="global ${status === 'idle' ? '' : esc(status)}">${esc(online ? (st?.summary || 'En attente du premier rapport') : offlineTxt)}</span>
<span class="muted">Dernier signe de l'agent : ${timeTag(bot.lastSeen)}${online ? '' : offlineHint}</span></div></div></div>
${metricsHtml(st?.metrics)}
${isAirpods ? LOCAL_RING_HTML : ''}
${actionsBlock || settingsBlock ? `<div class="grid2">${actionsBlock}${settingsBlock}</div>` : ''}
${tables}
${cmds.length ? `<h3>Dernières commandes</h3>${tableHtml(['Quand', 'Commande', 'État', 'Résultat'], cmdRows, { cellClass: ['nw'] })}` : ''}
${st?.log?.length ? `<details class="fold" id="fold-log" open><summary><h3>Journal du bot</h3></summary><pre class="log">${esc(st.log.join('\n'))}</pre></details>` : ''}
${events.length ? `<details class="fold" id="fold-ev"><summary><h3>Évènements (${events.length})</h3></summary>${tableHtml(['Quand', 'Évènement'], eventRows(events, false), { rowClass: (i) => `lv-${events[i].level}`, cellClass: ['nw'] })}</details>` : ''}
${isAirpods ? airpodsInstallHtml() : ''}`;
  const script = isAirpods ? LOCAL_RING_JS : '';
  return shell({ title: bot.name, nav, active: `/bot/${bot.id}`, body, refresh: 20, script });
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
