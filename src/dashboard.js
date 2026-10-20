import { groupByDay, dayLabel } from './util.js';

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  ok: ['OK', 'ok'],
  blocked: ['Bloqué / injoignable', 'bad'],
  schema: ['Réponse inattendue', 'warn'],
  fatal: ['Config / IDs invalides', 'bad'],
  error: ['Erreur', 'bad'],
};
const EVENT = {
  alert: 'Alerte envoyée',
  alert_failed: 'Alerte NON envoyée',
  slot: 'Créneau détecté',
  down: 'Panne',
  recovered: 'Reprise',
  heartbeat: 'Message de vie',
  telegram_ok: 'Test Telegram réussi',
  telegram_ko: 'Test Telegram ÉCHOUÉ',
  collector_silent: 'Collecteur silencieux',
  dispatch_failed: 'Lancement du collecteur impossible',
};

const fmtTime = (ts) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));

const timeTag = (ts) => (ts ? `<time data-ts="${Number(ts)}">${esc(fmtTime(ts))}</time>` : '—');
const pct = (r) => (r && r.n ? `${Math.round((100 * r.ok) / r.n)} % (${r.ok}/${r.n})` : '—');

function globalState(view) {
  const { lastRun, intervalMin, now, watches, hasConfig } = view;
  if (!hasConfig) return ['bad', 'Configuration incomplète'];
  if (!lastRun) return ['idle', 'En attente de la première vérification'];
  if (view.mode === 'ingest') {
    if (now - lastRun > (view.staleMin || 75) * 60) return ['bad', 'Plus de données du collecteur : GitHub Actions semble arrêté'];
  } else if (now - lastRun > intervalMin * 60 * 2.5) return ['bad', 'Aucune vérification récente : le cron semble arrêté'];
  const bad = watches.filter((w) => w.last && w.last.status !== 'ok');
  if (bad.length) return ['warn', `Problème sur ${bad.length} cabinet(s)`];
  return ['ok', 'Tout fonctionne'];
}

function slotsHtml(list) {
  if (!list.length) return '<p class="muted">Aucun créneau pour le moment.</p>';
  const byDay = groupByDay(list.map((x) => x.slot));
  const alerted = new Set(list.filter((x) => x.alerted).map((x) => x.slot));
  const rows = Object.entries(byDay).map(([d, hours]) => {
    const hs = hours.map((h) => {
      const full = list.find((x) => x.slot.startsWith(`${d}T${h}`));
      const mark = full && alerted.has(full.slot) ? '' : ' <span class="tag">non alerté</span>';
      return `<span class="slot">${esc(h)}</span>${mark}`;
    }).join(' ');
    return `<li><b>${esc(dayLabel(d))}</b> ${hs}</li>`;
  });
  return `<ul class="slots">${rows.join('')}</ul>`;
}

function card(w) {
  const [label, cls] = STATUS[w.last?.status] || ['Pas encore vérifié', 'idle'];
  const cells = w.timeline.map((c) => {
    const k = (STATUS[c.status] || ['', 'idle'])[1];
    const tip = `${fmtTime(c.ts)} · ${(STATUS[c.status] || [c.status])[0]}${c.error ? ` · ${c.error}` : ''}`;
    return `<i class="c ${k}" title="${esc(tip)}"></i>`;
  }).join('');
  const err = w.last && w.last.status !== 'ok'
    ? `<p class="err">${esc(w.last.error || '')}${w.last.http ? ` (HTTP ${esc(w.last.http)})` : ''}</p>` : '';
  const next = w.next ? esc(`${dayLabel(w.next.slice(0, 10))} ${w.next.slice(11, 16)}`) : 'aucun connu';
  return `<article class="card">
  <div class="row"><h2>${esc(w.label)}</h2><span class="badge ${cls}">${esc(label)}</span></div>
  <p class="big">${w.slots.length} <span>créneau${w.slots.length > 1 ? 'x' : ''}</span></p>
  <p class="muted">Prochain créneau connu : ${next}</p>
  ${err}
  <div class="tl" aria-label="Historique des dernières vérifications">${cells}</div>
  <p class="muted">Dernière vérification : ${timeTag(w.last?.ts)} · disponibilité 24 h : ${esc(pct(w.rate24))} · 7 j : ${esc(pct(w.rate7))}</p>
  ${slotsHtml(w.slots)}
</article>`;
}

/**
 * view = { now, intervalMin, horizon, hasConfig, problems[], lastRun, watches[], events[] }
 * Toutes les chaînes sont échappées ici.
 */
export function renderDashboard(view) {
  const [gcls, gtxt] = globalState(view);
  const problems = view.problems.length
    ? `<section class="notice"><b>À corriger :</b><ul>${view.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>` : '';
  const events = view.events.length
    ? `<table><thead><tr><th>Quand</th><th>Évènement</th><th>Détail</th></tr></thead><tbody>${
      view.events.map((e) => `<tr class="ev-${esc(e.type)}"><td>${timeTag(e.ts)}</td><td>${esc(EVENT[e.type] || e.type)}</td><td>${esc(e.detail || '')}</td></tr>`).join('')
    }</tbody></table>`
    : '<p class="muted">Rien pour le moment.</p>';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Doctolib Monitor</title>
<style>
:root{--bg:#f6f7f9;--fg:#1c2330;--mut:#667085;--card:#fff;--bd:#e3e6ec;--ok:#1a8a4a;--warn:#c27c0e;--bad:#c0362c;--idle:#98a2b3}
@media (prefers-color-scheme:dark){:root{--bg:#10141b;--fg:#e6e9ef;--mut:#98a2b3;--card:#171c26;--bd:#272f3d;--ok:#3ec47a;--warn:#e0a03a;--bad:#ef6a5e;--idle:#667085}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0}h3{font-size:15px;margin:28px 0 8px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
.global{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:600;color:#fff;background:var(--idle)}
.global.ok{background:var(--ok)}.global.warn{background:var(--warn)}.global.bad{background:var(--bad)}
.muted{color:var(--mut);margin:4px 0;font-size:13px}.err{color:var(--bad);margin:6px 0;font-size:13px;word-break:break-word}
button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--mut)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center}
.badge{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;color:#fff;background:var(--idle);white-space:nowrap}
.badge.ok{background:var(--ok)}.badge.warn{background:var(--warn)}.badge.bad{background:var(--bad)}
.big{font-size:30px;font-weight:700;margin:6px 0 0}.big span{font-size:14px;font-weight:400;color:var(--mut)}
.tl{display:flex;gap:2px;margin:10px 0 6px;flex-wrap:nowrap;overflow:hidden}
.c{flex:1 1 0;min-width:3px;height:18px;border-radius:2px;background:var(--idle);display:block}
.c.ok{background:var(--ok)}.c.warn{background:var(--warn)}.c.bad{background:var(--bad)}
.slots{list-style:none;padding:0;margin:10px 0 0}.slots li{padding:4px 0;border-top:1px solid var(--bd)}
.slot{display:inline-block;padding:0 7px;margin:0 2px;border-radius:6px;background:var(--bg);border:1px solid var(--bd);font-variant-numeric:tabular-nums}
.tag{font-size:11px;color:var(--warn)}
.notice{background:var(--card);border:1px solid var(--warn);border-radius:10px;padding:10px 14px;margin-bottom:14px}.notice ul{margin:6px 0 0;padding-left:20px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--bd);vertical-align:top}th{color:var(--mut);font-weight:600}
td:last-child{word-break:break-word}.ev-alert_failed td,.ev-down td,.ev-telegram_ko td{color:var(--bad)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
</style></head><body><main>
<div class="top"><div><h1>Doctolib Monitor</h1>
<span class="global ${gcls}">${esc(gtxt)}</span>
<p class="muted">Dernier passage : ${timeTag(view.lastRun)} · ${view.mode === 'ingest' ? `environ toutes les ${esc(view.intervalMin)} min, à intervalle irrégulier${view.collector ? ` · collecteur : ${esc(view.collector)}` : ''}` : `toutes les ${esc(view.intervalMin)} min`} · horizon ${esc(view.horizon)} jours</p></div>
<div class="actions">${view.mode === 'ingest' ? '' : '<form method="post" action="/run"><button type="submit">Vérifier maintenant</button></form>'}
<form method="post" action="/test-telegram"><button type="submit">Tester Telegram</button></form></div></div>
${problems}
<section class="cards">${view.watches.map(card).join('') || '<p class="muted">Aucun cabinet configuré.</p>'}</section>
<h3>Journal</h3>${events}
</main>
<script>
(function(){
  function rel(ts){var d=Math.max(0,Math.floor(Date.now()/1000)-ts);
    if(d<90)return"à l'instant";if(d<3600)return"il y a "+Math.round(d/60)+" min";
    if(d<86400)return"il y a "+Math.round(d/3600)+" h";return"il y a "+Math.round(d/86400)+" j";}
  document.querySelectorAll("time[data-ts]").forEach(function(t){
    var a=t.textContent;t.title=a;t.textContent=a+" ("+rel(+t.dataset.ts)+")";});
  setInterval(function(){if(document.visibilityState==="visible")location.reload()},300000);
})();
</script></body></html>`;
}

export function renderMessage(title, text, status = 200) {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)}</title>`
    + `<body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
