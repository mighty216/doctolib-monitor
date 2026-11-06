import { groupByDay, dayLabel } from './util.js';

import { esc, shell, timeTag, fmtTime } from './layout.js';
export { esc };

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

const pct = (r) => (r && r.n ? `${Math.round((100 * r.ok) / r.n)} % (${r.ok}/${r.n})` : '—');

function globalState(view) {
  const { lastRun, intervalMin, now, hasConfig } = view;
  const watches = view.watches.filter((w) => !w.paused);
  if (!hasConfig) return ['bad', 'Configuration incomplète'];
  if (!watches.length) return ['idle', view.watches.length ? 'Toutes les surveillances sont en pause' : 'Aucune surveillance : ajoute un lien Doctolib'];
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

function manageCard(w) {
  const [label, cls] = w.paused ? ['En pause', ''] : (STATUS[w.last?.status] || ['Pas encore vérifié', 'idle']);
  return `<tr><td>${esc(w.label)}${w.name ? ` <span class="muted">(${esc(w.autoLabel)})</span>` : ''}<br><span class="muted">${esc(w.key)}</span></td>
<td><span class="badge ${cls}">${esc(label)}</span></td>
<td class="actions">
${w.paused
    ? `<form class="inline" method="post" action="/doctolib/resume"><input type="hidden" name="key" value="${esc(w.key)}"><button class="sm" type="submit">▶ Reprendre</button></form>`
    : `<form class="inline" method="post" action="/doctolib/pause"><input type="hidden" name="key" value="${esc(w.key)}"><button class="sm" type="submit">⏸ Pause</button></form>`}
<form class="inline" method="post" action="/doctolib/rename"><input type="hidden" name="key" value="${esc(w.key)}"><input type="text" name="name" placeholder="Renommer" value="${esc(w.name || '')}" maxlength="60" style="width:130px"><button class="sm" type="submit">OK</button></form>
<form class="inline" method="post" action="/doctolib/delete" data-confirm="Supprimer cette surveillance et son historique ?"><input type="hidden" name="key" value="${esc(w.key)}"><button class="sm danger" type="submit">🗑</button></form>
</td></tr>`;
}

/**
 * view = { now, intervalMin, horizon, hasConfig, problems[], lastRun, watches[], events[] }
 * ctx = { nav, flash }. Toutes les chaînes sont échappées ici.
 */
export function renderDashboard(view, ctx = {}) {
  const [gcls, gtxt] = globalState(view);
  const problems = view.problems.length
    ? `<section class="notice"><b>À corriger :</b><ul>${view.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>` : '';
  const events = view.events.length
    ? `<table><thead><tr><th>Quand</th><th>Évènement</th><th>Détail</th></tr></thead><tbody>${
      view.events.map((e) => `<tr class="ev-${esc(e.type)}"><td>${timeTag(e.ts)}</td><td>${esc(EVENT[e.type] || e.type)}</td><td>${esc(e.detail || '')}</td></tr>`).join('')
    }</tbody></table>`
    : '<p class="muted">Rien pour le moment.</p>';
  const flash = ctx.flash ? `<div class="flash ${ctx.flash.ok ? '' : 'bad'}">${esc(ctx.flash.text)}</div>` : '';
  const manage = `<h3>Gérer les surveillances</h3>
<div class="card">
${view.watches.length ? `<table><thead><tr><th>Surveillance</th><th>État</th><th>Actions</th></tr></thead><tbody>${view.watches.map(manageCard).join('')}</tbody></table>` : '<p class="muted">Aucune surveillance.</p>'}
<form method="post" action="/doctolib/add"><div class="formrow">
<input type="url" name="url" required placeholder="Colle ici le lien Doctolib de l'étape calendrier (…/booking/availabilities?…)">
<input type="text" name="name" class="grow" maxlength="60" placeholder="Nom (facultatif)" style="max-width:200px">
<button class="pri" type="submit">➕ Ajouter</button></div></form>
<p class="muted">Sur Doctolib, choisis le motif de consultation puis copie l'adresse de la page où s'affichent les créneaux. Tu peux aussi la coller directement dans Telegram.</p>
</div>`;
  const cards = view.watches.filter((w) => !w.paused).map(card).join('') || '<p class="muted">Aucune surveillance active.</p>';
  const body = `${flash}<div class="top"><div><h1>Doctolib Monitor</h1>
<span class="global ${gcls}">${esc(gtxt)}</span>
<p class="muted">Dernier passage : ${timeTag(view.lastRun)} · ${view.mode === 'ingest' ? `environ toutes les ${esc(view.intervalMin)} min, à intervalle irrégulier${view.collector ? ` · collecteur : ${esc(view.collector)}` : ''}` : `toutes les ${esc(view.intervalMin)} min`} · horizon ${esc(view.horizon)} jours</p></div>
<div class="actions">${view.mode === 'ingest' ? '<form method="post" action="/doctolib/check"><button type="submit">Vérifier maintenant</button></form>' : '<form method="post" action="/run"><button type="submit">Vérifier maintenant</button></form>'}
<form method="post" action="/test-telegram"><button type="submit">Tester Telegram</button></form></div></div>
${problems}
<section class="cards">${cards}</section>
${manage}
<h3>Journal</h3>${events}`;
  return shell({ title: 'Doctolib Monitor', nav: ctx.nav || [], active: '/doctolib', body });
}

export function renderMessage(title, text, status = 200) {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)}</title>`
    + `<body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
