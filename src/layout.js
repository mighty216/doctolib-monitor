// Habillage commun de l'interface web (navigation, styles, interactions sans rechargement).
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{color-scheme:light;--bg:#f3f4f8;--s1:#ffffff;--s2:#f7f8fb;--fg:#111827;--mut:#6b7280;--bd:#e4e7ee;--bd2:#d3d8e2;
--acc:#4f46e5;--acc2:#7c3aed;--accfg:#fff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--idle:#9ca3af;
--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);--shadow2:0 10px 30px rgba(16,24,40,.14);--r:14px}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b0d13;--s1:#141823;--s2:#1a1f2d;--fg:#e8eaf0;--mut:#98a0b3;--bd:#242a3a;--bd2:#323a4e;
--acc:#818cf8;--acc2:#a78bfa;--accfg:#0b0d13;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--idle:#6b7280;
--shadow:0 1px 2px rgba(0,0,0,.4);--shadow2:0 12px 32px rgba(0,0,0,.55)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--acc)}
main{max-width:1120px;margin:0 auto;padding:20px 16px 72px;transition:opacity .2s}
main.loading{opacity:.55}
/* ---- barre du haut */
header.bar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--s1) 85%,transparent);backdrop-filter:saturate(1.6) blur(12px);-webkit-backdrop-filter:saturate(1.6) blur(12px);border-bottom:1px solid var(--bd)}
header.bar .in{max-width:1120px;margin:0 auto;padding:0 12px;display:flex;align-items:center;gap:6px}
.brand{display:flex;align-items:center;gap:8px;font-weight:800;letter-spacing:-.02em;color:var(--fg);text-decoration:none;padding:10px 8px 10px 4px;flex:none}
.brand b{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;font-size:14px}
nav.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent)}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{display:flex;align-items:center;gap:7px;padding:8px 12px;margin:7px 0;border-radius:9px;color:var(--mut);text-decoration:none;font-weight:600;font-size:14px;white-space:nowrap}
nav.tabs a:hover{color:var(--fg);background:var(--s2)}
nav.tabs a.on{color:var(--fg);background:var(--s2);box-shadow:inset 0 0 0 1px var(--bd)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle);flex:none;display:inline-block}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.live{flex:none;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mut);padding-left:6px;white-space:nowrap}
.live .dot{background:var(--ok);animation:pulse 2s infinite}
.live.off .dot{background:var(--idle);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
/* ---- typographie */
h1{font-size:26px;line-height:1.2;margin:0 0 8px;letter-spacing:-.025em}
h2{font-size:16px;margin:0;letter-spacing:-.01em}
h3{font-size:13px;margin:30px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:700}
.muted{color:var(--mut);margin:4px 0;font-size:13px}
.err{color:var(--bad);margin:6px 0;font-size:13px;word-break:break-word}
/* ---- en-tête de page */
.hero{display:flex;flex-wrap:wrap;gap:14px 20px;align-items:flex-end;justify-content:space-between;margin:4px 0 18px}
.hero .sub{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
.pill,.global{display:inline-flex;align-items:center;gap:7px;padding:4px 12px 4px 10px;border-radius:999px;font-weight:600;font-size:13px;background:color-mix(in srgb,var(--idle) 16%,transparent);color:var(--fg)}
.pill::before,.global::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--idle)}
.pill.ok,.global.ok{background:color-mix(in srgb,var(--ok) 14%,transparent)}.pill.ok::before,.global.ok::before{background:var(--ok)}
.pill.warn,.global.warn{background:color-mix(in srgb,var(--warn) 16%,transparent)}.pill.warn::before,.global.warn::before{background:var(--warn)}
.pill.bad,.global.bad{background:color-mix(in srgb,var(--bad) 14%,transparent)}.pill.bad::before,.global.bad::before{background:var(--bad)}
/* ---- boutons et champs */
button,.btn{font:inherit;font-size:14px;font-weight:600;padding:8px 14px;border-radius:10px;border:1px solid var(--bd2);background:var(--s1);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;line-height:1.2;min-height:38px;transition:background .15s,border-color .15s,transform .05s,box-shadow .15s;box-shadow:var(--shadow);-webkit-tap-highlight-color:transparent}
button:hover,.btn:hover{border-color:var(--mut);background:var(--s2)}
button:active{transform:translateY(1px)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button.pri{background:linear-gradient(135deg,var(--acc),var(--acc2));border-color:transparent;color:#fff}
button.pri:hover{filter:brightness(1.08)}
button.danger{color:var(--bad)}button.danger:hover{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 8%,var(--s1))}
button.ghost{box-shadow:none;background:transparent}
button.sm{padding:5px 11px;font-size:13px;min-height:32px;border-radius:8px}
button[disabled]{opacity:.6;cursor:progress}
button.busy::after{content:"";width:13px;height:13px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
input[type=text],input[type=url],input[type=number],select{font:inherit;font-size:14px;padding:8px 11px;min-height:38px;border-radius:10px;border:1px solid var(--bd2);background:var(--s2);color:var(--fg);max-width:100%;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 22%,transparent);outline:none}
input.wide{width:100%}
/* ---- cartes */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,440px),1fr));gap:14px}
.cards.small{grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))}
.card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:18px;box-shadow:var(--shadow);min-width:0}
a.card{display:flex;flex-direction:column;gap:6px;color:inherit;text-decoration:none;transition:transform .15s,box-shadow .15s,border-color .15s;position:relative;overflow:hidden}
a.card:hover{transform:translateY(-2px);box-shadow:var(--shadow2);border-color:var(--bd2)}
a.card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--idle)}
a.card.ok::before{background:var(--ok)}a.card.warn::before{background:var(--warn)}a.card.bad::before{background:var(--bad)}
a.card .go{margin-top:auto;padding-top:8px;font-size:13px;font-weight:600;color:var(--acc)}
.card.paused{opacity:.7}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center}
.badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap;background:color-mix(in srgb,var(--idle) 18%,transparent);color:var(--mut)}
.badge.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.badge.warn{background:color-mix(in srgb,var(--warn) 17%,transparent);color:var(--warn)}
.badge.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.big{font-size:34px;font-weight:800;margin:6px 0 0;letter-spacing:-.03em}.big span{font-size:14px;font-weight:500;color:var(--mut);letter-spacing:0}
/* ---- frise Doctolib */
.tl{display:flex;gap:2px;margin:12px 0 6px;flex-wrap:nowrap;overflow:hidden}
.c{flex:1 1 0;min-width:3px;height:20px;border-radius:3px;background:var(--idle);display:block;opacity:.85}
.c:hover{opacity:1;transform:scaleY(1.15)}
.c.ok{background:var(--ok)}.c.warn{background:var(--warn)}.c.bad{background:var(--bad)}
.slots{list-style:none;padding:0;margin:12px 0 0}.slots li{padding:7px 0;border-top:1px solid var(--bd);display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.slots li b{min-width:76px}
.slot{display:inline-block;padding:1px 8px;border-radius:7px;background:var(--s2);border:1px solid var(--bd);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600}
.tag{font-size:11px;color:var(--warn)}
/* ---- messages */
.notice{background:color-mix(in srgb,var(--warn) 9%,var(--s1));border:1px solid color-mix(in srgb,var(--warn) 45%,var(--bd));border-radius:12px;padding:12px 16px;margin-bottom:16px}.notice ul{margin:6px 0 0;padding-left:20px}
.flash{background:color-mix(in srgb,var(--ok) 9%,var(--s1));border:1px solid color-mix(in srgb,var(--ok) 45%,var(--bd));border-radius:12px;padding:10px 16px;margin-bottom:16px;font-weight:500}
.flash.bad{background:color-mix(in srgb,var(--bad) 9%,var(--s1));border-color:color-mix(in srgb,var(--bad) 45%,var(--bd))}
/* ---- tableaux (cartes empilées sur mobile) */
.tw{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)}
.card .tw{box-shadow:none}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--bd);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;background:var(--s2)}
tbody tr:hover td{background:color-mix(in srgb,var(--s2) 70%,transparent)}
td{word-break:break-word}td.nw{white-space:nowrap;color:var(--mut);font-variant-numeric:tabular-nums}
tr.hl td:first-child{box-shadow:inset 3px 0 0 var(--ok);font-weight:600}
.ev-alert_failed td,.ev-down td,.ev-telegram_ko td,.lv-bad td{color:var(--bad)}.lv-warn td{color:var(--warn)}.lv-ok td{color:var(--ok)}
td.nw{color:var(--mut)!important}
.res{white-space:pre-line;max-height:5.6em;overflow:hidden;display:block}
td .actions{gap:6px;flex-wrap:nowrap}
/* ---- blocs */
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:0}
.metrics div{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);min-width:0}
.metrics b{display:block;font-size:20px;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metrics span{font-size:12px;color:var(--mut);font-weight:500}
.card .metrics{grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-top:6px}
.card .metrics div{background:var(--s2);box-shadow:none;padding:8px 10px;border-radius:10px}.card .metrics b{font-size:16px}
form.inline{display:inline}
.formrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.formrow input[type=url],.formrow input.grow{flex:1 1 260px}
.argform{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 0;border-top:1px solid var(--bd)}
.argform:first-child{border-top:0;padding-top:0}.argform:last-child{padding-bottom:0}
.argform input{flex:1 1 150px;min-width:0}.argform .lbl{flex:1 0 100%;font-weight:600;font-size:13px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;align-items:start}
.grid2>section>h3:first-child{margin-top:30px}
pre.log{background:#0d1117;color:#c9d1d9;border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;max-height:420px}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary h3{margin:30px 0 10px}
details.fold>summary::after{content:"▸";color:var(--mut);margin-top:20px;transition:transform .15s}
details.fold[open]>summary::after{transform:rotate(90deg)}
.set{display:grid;grid-template-columns:minmax(140px,1fr) minmax(120px,170px) auto;gap:8px 12px;align-items:center;padding:10px 0;border-top:1px solid var(--bd)}
.set:first-child{border-top:0;padding-top:0}.set:last-child{padding-bottom:0}
.set label{font-weight:600;font-size:14px}.set label .muted{font-weight:400;display:block}
.empty{padding:22px;text-align:center;color:var(--mut);font-size:14px}
.chip{display:inline-block;font-size:11.5px;font-weight:700;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--idle) 18%,transparent);color:var(--mut);white-space:nowrap}
.chip.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}.chip.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.chip.run{background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--acc)}
/* ---- notifications et fenêtre de résultat */
#toasts{position:fixed;z-index:50;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}
.toast{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;background:var(--s1);color:var(--fg);border:1px solid var(--bd);border-left:4px solid var(--acc);border-radius:12px;padding:11px 14px;box-shadow:var(--shadow2);font-size:14px;animation:tin .22s ease-out}
.toast.ok{border-left-color:var(--ok)}.toast.bad{border-left-color:var(--bad)}
.toast .x{margin-left:auto;cursor:pointer;color:var(--mut);padding:0 2px}
.toast .sp{width:14px;height:14px;margin-top:3px;flex:none;border-radius:50%;border:2px solid var(--acc);border-right-color:transparent;animation:spin .7s linear infinite}
.toast.out{opacity:0;transform:translateY(8px);transition:all .25s}
@keyframes tin{from{opacity:0;transform:translateY(10px)}}
dialog#sheet{border:1px solid var(--bd);border-radius:18px;padding:0;background:var(--s1);color:var(--fg);box-shadow:var(--shadow2);width:min(560px,calc(100vw - 24px));max-height:min(80vh,720px)}
dialog#sheet::backdrop{background:rgba(8,10,16,.5);backdrop-filter:blur(3px)}
dialog#sheet .hd{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--bd)}
dialog#sheet .hd h2{flex:1}
dialog#sheet .bd{padding:16px 18px;white-space:pre-line;overflow:auto;max-height:calc(min(80vh,720px) - 70px);font-size:14.5px;line-height:1.6}
@media (max-width:640px){
  main{padding:14px 12px 72px}h1{font-size:22px}
  .live span{display:none}
  .hero{align-items:flex-start}.hero>.actions{width:100%}.hero>.actions form{flex:1}.hero>.actions button{width:100%}
  table.rt thead{display:none}
  table.rt,table.rt tbody,table.rt tr,table.rt td{display:block;width:100%}
  table.rt tr{padding:10px 12px;border-bottom:1px solid var(--bd)}
  table.rt tbody tr:last-child{border-bottom:0}
  table.rt td{border:0;padding:3px 0;display:flex;gap:10px}
  table.rt td::before{content:attr(data-label);flex:0 0 34%;color:var(--mut);font-size:12px;font-weight:600;padding-top:1px}
  table.rt td[data-label=""]::before{display:none}
  table.rt td .v{flex:1;min-width:0}
  table.rt td.act{padding-top:8px}
  tr.hl td:first-child{box-shadow:none}tr.hl{box-shadow:inset 3px 0 0 var(--ok)}
  .set{grid-template-columns:1fr auto}.set label{grid-column:1/-1}.set>input,.set>select{width:100%}
  #toasts{left:12px;right:12px;bottom:12px;max-width:none}
  dialog#sheet{margin:auto auto 0;width:100vw;max-width:100vw;border-radius:18px 18px 0 0;border-bottom:0}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// Formulaires envoyés sans rechargement, suivi des commandes jusqu'à la réponse du bot, rafraîchissement en direct.
const SCRIPT = `
(function(){
  var KEY=new URLSearchParams(location.search).get("key");
  function withKey(u){if(!KEY||/[?&]key=/.test(u))return u;return u+(u.indexOf("?")<0?"?":"&")+"key="+encodeURIComponent(KEY);}
  function rel(ts){var d=Math.max(0,Math.floor(Date.now()/1000)-ts);
    if(d<60)return"à l'instant";if(d<3600)return"il y a "+Math.round(d/60)+" min";
    if(d<86400)return"il y a "+Math.round(d/3600)+" h";return"il y a "+Math.round(d/86400)+" j";}
  function times(root){(root||document).querySelectorAll("time[data-ts]").forEach(function(t){
    if(!t.dataset.abs)t.dataset.abs=t.textContent;t.title=t.dataset.abs;
    t.textContent=Date.now()/1000-t.dataset.ts<86400?rel(+t.dataset.ts):t.dataset.abs;});}
  // ---- notifications
  var box=document.getElementById("toasts");
  function toast(text,kind,sticky){var el=document.createElement("div");el.className="toast "+(kind||"");
    if(kind==="run"){var s=document.createElement("i");s.className="sp";el.appendChild(s);}
    var m=document.createElement("div");m.textContent=text;el.appendChild(m);
    var x=document.createElement("span");x.className="x";x.textContent="✕";x.onclick=function(){kill(el)};el.appendChild(x);
    box.appendChild(el);if(!sticky)setTimeout(function(){kill(el)},kind==="bad"?9000:4500);return el;}
  function kill(el){if(!el||!el.parentNode)return;el.classList.add("out");setTimeout(function(){el.remove()},260);}
  // ---- fenêtre de résultat
  var sheet=document.getElementById("sheet");
  function showResult(title,text,ok){if(!sheet||!sheet.showModal){alert(title+"\\n\\n"+text);return;}
    sheet.querySelector("h2").textContent=title;var b=sheet.querySelector(".pill");b.className="pill "+(ok?"ok":"bad");b.textContent=ok?"Fait":"Échec";
    sheet.querySelector(".bd").textContent=text||"(aucun détail)";if(!sheet.open)sheet.showModal();}
  if(sheet){sheet.addEventListener("click",function(e){if(e.target===sheet||e.target.closest("[data-close]"))sheet.close();});}
  // ---- rafraîchissement en direct
  var busy=0,last=Date.now(),live=document.getElementById("live");
  var every=+(document.body.dataset.refresh||60)*1000;
  function refresh(force){
    if(!force&&(busy||document.visibilityState!=="visible"||(sheet&&sheet.open)))return Promise.resolve();
    var a=document.activeElement;if(!force&&a&&/INPUT|SELECT|TEXTAREA/.test(a.tagName))return Promise.resolve();
    return fetch(location.href,{credentials:"same-origin",headers:{"x-hub-fetch":"1"}}).then(function(r){
      if(!r.ok)throw new Error(r.status);return r.text();}).then(function(h){
      var d=new DOMParser().parseFromString(h,"text/html");var nm=d.querySelector("main"),nn=d.querySelector("nav.tabs");
      if(!nm)return;var open={};document.querySelectorAll("details[id]").forEach(function(x){open[x.id]=x.open});
      document.querySelector("main").innerHTML=nm.innerHTML;if(nn)document.querySelector("nav.tabs").innerHTML=nn.innerHTML;
      document.querySelectorAll("details[id]").forEach(function(x){if(x.id in open)x.open=open[x.id]});
      document.querySelectorAll("main .flash").forEach(function(f){f.remove()});
      document.title=d.title;last=Date.now();if(live)live.classList.remove("off");times();scrollLogs();
    }).catch(function(){if(live)live.classList.add("off");});}
  function scrollLogs(){document.querySelectorAll("pre.log").forEach(function(p){p.scrollTop=p.scrollHeight});}
  setInterval(function(){if(Date.now()-last>=every)refresh();},5000);
  setInterval(function(){times();if(live){var s=live.querySelector("span");var d=Math.round((Date.now()-last)/1000);
    s.textContent=d<5?"En direct":"Mis à jour il y a "+(d<60?d+" s":Math.round(d/60)+" min");}},1000);
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&Date.now()-last>10000)refresh();});
  // ---- suivi d'une commande envoyée à un bot
  function follow(c,label){var t0=Date.now(),t=toast(label+" : en attente du bot…","run",true);busy++;
    (function tick(){fetch(withKey("/api/cmd?bot="+encodeURIComponent(c.bot)+"&id="+c.id),{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){
      if(j.status==="done"||j.status==="error"){kill(t);busy--;var ok=j.status==="done";var txt=j.result||"";
        if(txt.length>90||txt.indexOf("\\n")>=0)showResult(label,txt,ok);else toast(txt||(ok?label+" : fait":label+" : échec"),ok?"ok":"bad");
        refresh(true);return;}
      if(j.status==="expired"){kill(t);busy--;toast(label+" : le bot n'a pas répondu (commande expirée).","bad");refresh(true);return;}
      if(Date.now()-t0>90000){kill(t);busy--;toast(label+" : toujours en attente, le résultat apparaîtra dans « Dernières commandes ».","bad");refresh(true);return;}
      if(j.status==="sent")t.querySelector("div").textContent=label+" : le bot traite la commande…";
      setTimeout(tick,Date.now()-t0<10000?800:2000);
    }).catch(function(){setTimeout(tick,3000)});})();}
  // ---- envoi des formulaires sans rechargement
  document.addEventListener("submit",function(e){var f=e.target;if(!f.matches||!f.matches("form[method=post]")||f.dataset.plain!==undefined)return;
    e.preventDefault();if(f.dataset.confirm&&!confirm(f.dataset.confirm))return;
    var btn=e.submitter||f.querySelector("button");if(btn&&btn.disabled)return;
    var label=(btn&&(btn.dataset.label||btn.textContent)||"Action").trim();
    if(btn){btn.disabled=true;btn.classList.add("busy");}busy++;
    var body=new URLSearchParams(new FormData(f));if(btn&&btn.name)body.set(btn.name,btn.value);
    fetch(f.getAttribute("action"),{method:"POST",body:body,credentials:"same-origin",headers:{"x-hub-fetch":"1",accept:"application/json"}})
    .then(function(r){return r.json()}).then(function(j){
      busy--;if(btn){btn.disabled=false;btn.classList.remove("busy");}
      if(j.cmd){follow(j.cmd,label);if(f.dataset.reset!==undefined)f.reset();return;}
      toast(j.text||(j.ok?"Fait.":"Échec."),j.ok?"ok":"bad");if(j.ok&&f.dataset.reset!==undefined)f.reset();refresh(true);
    }).catch(function(){busy--;if(btn){btn.disabled=false;btn.classList.remove("busy");}f.dataset.plain="";f.submit();});
  });
  // ---- au chargement
  times();scrollLogs();
  var fl=document.querySelector("main .flash");if(fl){toast(fl.textContent,fl.classList.contains("bad")?"bad":"ok");fl.remove();}
  if(/[?&](f|bad)=/.test(location.search)){var u=new URL(location.href);u.searchParams.delete("f");u.searchParams.delete("bad");history.replaceState(null,"",u.pathname+u.search+u.hash);}
})();`;

/**
 * nav = [{ href, label, status? }], active = href de l'onglet courant.
 * refresh = intervalle du rafraîchissement en direct (secondes).
 */
export function shell({ title, nav = [], active = '', body, refresh = 60 }) {
  const links = nav.map((n) => `<a href="${esc(n.href)}" class="${n.href === active ? 'on' : ''}">${n.status ? `<i class="dot ${esc(n.status)}"></i>` : ''}${esc(n.label)}</a>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#4f46e5"><title>${esc(title)}</title>
<style>${CSS}</style></head><body data-refresh="${Number(refresh) || 60}">
<header class="bar"><div class="in"><a class="brand" href="/"><b>◆</b>Hub</a><nav class="tabs">${links}</nav>
<div class="live" id="live" title="La page se met à jour toute seule"><i class="dot"></i><span>En direct</span></div></div></header>
<main>${body}</main>
<div id="toasts" role="status" aria-live="polite"></div>
<dialog id="sheet"><div class="hd"><h2>Résultat</h2><span class="pill">Fait</span><button class="sm ghost" type="button" data-close aria-label="Fermer">✕</button></div><div class="bd"></div></dialog>
<script>${SCRIPT}</script></body></html>`;
}

/** Tableau qui devient une liste de cartes sur mobile. cols = noms, rows = [[html déjà échappé]], opts.rowClass(i) */
export function tableHtml(cols, rows, opts = {}) {
  if (!rows.length) return `<div class="tw"><div class="empty">${esc(opts.empty || 'Rien pour le moment.')}</div></div>`;
  const head = opts.noHead ? '' : `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r, i) => `<tr${opts.rowClass ? ` class="${esc(opts.rowClass(i) || '')}"` : ''}>${r.map((cell, j) => {
    const cls = (opts.cellClass && opts.cellClass[j]) || '';
    return `<td data-label="${esc(cols[j] ?? '')}"${cls ? ` class="${cls}"` : ''}><div class="v">${cell}</div></td>`;
  }).join('')}</tr>`).join('');
  return `<div class="tw"><table class="rt">${head}<tbody>${body}</tbody></table></div>`;
}

const FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ts) => FMT.format(new Date(ts * 1000));
export const timeTag = (ts) => (ts ? `<time data-ts="${Number(ts)}">${esc(fmtTime(ts))}</time>` : '—');
export const badgeCls = { ok: 'ok', warn: 'warn', bad: 'bad', idle: '' };
