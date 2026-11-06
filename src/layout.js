// Habillage commun de l'interface web (navigation, styles).
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#f6f7f9;--fg:#1c2330;--mut:#667085;--card:#fff;--bd:#e3e6ec;--ok:#1a8a4a;--warn:#c27c0e;--bad:#c0362c;--idle:#98a2b3;--acc:#2f5fd0}
@media (prefers-color-scheme:dark){:root{--bg:#10141b;--fg:#e6e9ef;--mut:#98a2b3;--card:#171c26;--bd:#272f3d;--ok:#3ec47a;--warn:#e0a03a;--bad:#ef6a5e;--idle:#667085;--acc:#7a9cf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px 16px 56px}
nav.top{background:var(--card);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:5}
nav.top div{max-width:1000px;margin:0 auto;padding:0 12px;display:flex;gap:2px;overflow-x:auto;white-space:nowrap}
nav.top a{padding:12px 12px;color:var(--mut);text-decoration:none;font-weight:600;border-bottom:3px solid transparent;font-size:14px}
nav.top a:hover{color:var(--fg)}nav.top a.on{color:var(--fg);border-color:var(--acc)}
nav.top a i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--idle)}
nav.top a i.ok{background:var(--ok)}nav.top a i.warn{background:var(--warn)}nav.top a i.bad{background:var(--bad)}
h1{font-size:21px;margin:8px 0 4px}h2{font-size:16px;margin:0}h3{font-size:15px;margin:26px 0 8px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
.global{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:600;color:#fff;background:var(--idle)}
.global.ok{background:var(--ok)}.global.warn{background:var(--warn)}.global.bad{background:var(--bad)}
.muted{color:var(--mut);margin:4px 0;font-size:13px}.err{color:var(--bad);margin:6px 0;font-size:13px;word-break:break-word}
button,.btn{font:inherit;font-size:14px;padding:7px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--mut)}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{color:var(--bad)}button.sm{padding:3px 10px;font-size:13px}
input[type=text],input[type=url],input[type=number],select{font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);max-width:100%}
input.wide{width:100%}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px}
.cards.small{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px}
a.card{display:block;color:inherit;text-decoration:none}a.card:hover{border-color:var(--mut)}
.card.paused{opacity:.7}
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
.flash{background:var(--card);border:1px solid var(--ok);border-radius:10px;padding:9px 14px;margin-bottom:14px}.flash.bad{border-color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--bd);vertical-align:top}th{color:var(--mut);font-weight:600}
td:last-child{word-break:break-word}.ev-alert_failed td,.ev-down td,.ev-telegram_ko td,.lv-bad td{color:var(--bad)}.lv-warn td{color:var(--warn)}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.metrics{display:flex;flex-wrap:wrap;gap:8px 22px;margin:10px 0 0}.metrics div{min-width:90px}.metrics b{display:block;font-size:19px}.metrics span{font-size:12px;color:var(--mut)}
form.inline{display:inline}
.formrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.formrow input[type=url],.formrow input.grow{flex:1 1 280px}
pre.log{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.set{display:grid;grid-template-columns:minmax(120px,220px) 1fr auto;gap:8px 12px;align-items:center;margin:6px 0}
@media (max-width:560px){.set{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
`;

const SCRIPT = `
(function(){
  function rel(ts){var d=Math.max(0,Math.floor(Date.now()/1000)-ts);
    if(d<90)return"à l'instant";if(d<3600)return"il y a "+Math.round(d/60)+" min";
    if(d<86400)return"il y a "+Math.round(d/3600)+" h";return"il y a "+Math.round(d/86400)+" j";}
  document.querySelectorAll("time[data-ts]").forEach(function(t){
    var a=t.textContent;t.title=a;t.textContent=a+" ("+rel(+t.dataset.ts)+")";});
  document.querySelectorAll("form[data-confirm]").forEach(function(f){
    f.addEventListener("submit",function(e){if(!confirm(f.dataset.confirm))e.preventDefault();});});
  setInterval(function(){if(document.visibilityState==="visible"&&!document.querySelector("input:focus,select:focus"))location.reload()},60000);
})();`;

/**
 * nav = [{ href, label, status? }], active = href de l'onglet courant.
 */
export function shell({ title, nav = [], active = '', body }) {
  const links = nav.map((n) => `<a href="${esc(n.href)}" class="${n.href === active ? 'on' : ''}">${n.status ? `<i class="${esc(n.status)}"></i>` : ''}${esc(n.label)}</a>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>
<nav class="top"><div>${links}</div></nav>
<main>${body}</main>
<script>${SCRIPT}</script></body></html>`;
}

const FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ts) => FMT.format(new Date(ts * 1000));
export const timeTag = (ts) => (ts ? `<time data-ts="${Number(ts)}">${esc(fmtTime(ts))}</time>` : '—');
export const badgeCls = { ok: 'ok', warn: 'warn', bad: 'bad', idle: '' };
