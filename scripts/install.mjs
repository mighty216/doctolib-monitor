// Installeur Doctolib Monitor : à lancer via install.bat (Windows).
// Relancer = mettre à jour (base, clé d'accès, Telegram conservés).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const NAME = 'doctolib-monitor';
const STATE_FILE = '.install-state.json';
const URLS_FILE = 'doctolib-urls.txt';
const INFOS_FILE = 'INFOS.txt';
const TMP_SECRETS = '.secrets.tmp.json';
const WR = process.env.WRANGLER_CMD || 'npx wrangler';
const TG = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const TOTAL = 8;
const GH = process.env.GH_CMD || 'gh';

const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
const step = (n, t) => console.log(`\n${c.b}[${n}/${TOTAL}] ${t}${c.x}`);
const ok = (t) => console.log(`${c.g}  ✓ ${t}${c.x}`);
const info = (t) => console.log(`  ${t}`);
const warn = (t) => console.log(`${c.y}  ! ${t}${c.x}`);
const fail = (t) => { console.log(`\n${c.r}  ✗ ${t}${c.x}\n`); cleanup(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() { try { fs.rmSync(TMP_SECRETS, { force: true }); } catch { /* ignoré */ } }

function run(cmd, { inherit = false, input } = {}) {
  const r = spawnSync(cmd, {
    shell: true, encoding: 'utf8', input,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(`  ${question} `)).trim(); } finally { rl.close(); }
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function tg(method, token, body) {
  try {
    const r = await fetch(`${TG}/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  } catch (e) { return { ok: false, description: e?.message || 'réseau' }; }
}

// ---------------------------------------------------------------------------
console.log(`\n${c.b}=== Doctolib Monitor : installation ===${c.x}`);
const state = loadState();

// 1/8 --------------------------------------------------------------------
step(1, 'Préparation');
const major = Number.parseInt(process.versions.node, 10);
if (major < 22) {
  fail(`Node.js ${process.versions.node} est trop ancien (version 22 ou plus requise).\n`
    + '  Ouvre PowerShell et lance : winget install -e --id OpenJS.NodeJS.LTS\n  Puis ferme cette fenêtre et relance install.bat.');
}
ok(`Node.js ${process.versions.node}`);
for (const [cmd, id, label] of [['git', 'Git.Git', 'Git'], [GH, 'GitHub.cli', 'GitHub CLI']]) {
  if (run(`${cmd} --version`).code === 0) { ok(label); continue; }
  if (process.platform === 'win32') {
    info(`Installation de ${label}...`);
    run(`winget install -e --id ${id} --accept-source-agreements --accept-package-agreements`, { inherit: true });
  }
  fail(`${label} est nécessaire (il ${process.platform === 'win32' ? 'vient d\'être installé' : 'manque'}).\n`
    + '  FERME cette fenêtre puis double-clique à nouveau sur install.bat.');
}
if (!fs.existsSync(path.join('node_modules', 'wrangler'))) {
  info('Installation des composants (1 à 2 minutes)...');
  const r = run('npm install --no-audit --no-fund', { inherit: true });
  if (r.code !== 0) fail("L'installation des composants a échoué. Vérifie ta connexion Internet et relance install.bat.");
}
ok('Composants installés');

// 2/8 --------------------------------------------------------------------
step(2, 'Connexion à Cloudflare');
const whoami = () => run(`${WR} whoami`);
let w = whoami();
if (/not authenticated|not logged in/i.test(w.out + w.err)) {
  info('Une page va s’ouvrir dans ton navigateur : connecte-toi puis clique sur « Allow ».');
  run(`${WR} login`, { inherit: true });
  w = whoami();
  if (/not authenticated|not logged in/i.test(w.out + w.err)) fail('Connexion à Cloudflare non réussie. Relance install.bat.');
}
const accounts = [];
for (const line of (w.out + w.err).split('\n')) {
  const id = line.match(/[0-9a-f]{32}/i);
  if (id && !accounts.some((a) => a.id === id[0])) {
    accounts.push({ id: id[0], name: line.split(/[│|]/).map((s) => s.trim()).find((s) => s && !/^[0-9a-f]{32}$/i.test(s)) || id[0] });
  }
}
if (accounts.length > 1) {
  let pick = accounts.find((a) => a.id === state.accountId);
  if (!pick) {
    info('Plusieurs comptes Cloudflare :');
    accounts.forEach((a, i) => info(`  ${i + 1}) ${a.name}`));
    const n = Number.parseInt(await ask('Numéro du compte à utiliser (celui de pellicule) :'), 10);
    pick = accounts[n - 1];
    if (!pick) fail('Numéro invalide. Relance install.bat.');
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = pick.id;
  state.accountId = pick.id;
  ok(`Compte : ${pick.name}`);
} else if (accounts.length === 1) {
  process.env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  ok(`Compte : ${accounts[0].name}`);
} else {
  ok('Connecté');
}
saveState(state);

// 3/8 --------------------------------------------------------------------
step(3, 'Base de données');
const findDb = () => {
  const r = run(`${WR} d1 list --json`);
  if (r.code !== 0) return { error: (r.err || r.out).trim().split('\n').slice(-3).join(' ') };
  try {
    const start = r.out.search(/\[\s*[{\]]/);
    const list = JSON.parse(r.out.slice(start));
    const d = list.find((x) => x.name === NAME);
    return { id: d && (d.uuid || d.database_id || d.id) };
  } catch { return { error: 'réponse illisible de Cloudflare' }; }
};
let db = findDb();
if (db.error) fail(`Impossible de lister les bases : ${db.error}`);
if (!db.id) {
  info('Création de la base (hébergée en Europe)...');
  const r = run(`${WR} d1 create ${NAME} --location weur`);
  if (r.code !== 0 && !/already exists/i.test(r.out + r.err)) {
    fail(`Création de la base impossible : ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`);
  }
  db = findDb();
  if (!db.id) fail("Base créée mais introuvable. Relance install.bat.");
}
{
  let toml = fs.readFileSync('wrangler.toml', 'utf8');
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${db.id}"`);
  fs.writeFileSync('wrangler.toml', toml);
}
ok('Base prête (séparée de celle de pellicule)');

// 4/8 --------------------------------------------------------------------
step(4, 'Telegram');
let tries = 0;
while (true) {
  if (!state.token) state.token = await ask('Colle le token de ton bot Telegram (celui de ton ancien fichier .env) :');
  const me = await tg('getMe', state.token);
  if (me.ok) { ok(`Bot : @${me.result.username}`); break; }
  warn(`Token refusé par Telegram (${me.description || 'erreur'}).`);
  state.token = '';
  if (++tries >= 3) fail('Token invalide. Relance install.bat avec le bon token.');
}
saveState(state);
if (!state.chatId) {
  const upd = await tg('getUpdates', state.token);
  const last = (upd.result || []).map((u) => u.message?.chat?.id).filter(Boolean).pop();
  if (last) state.chatId = String(last);
}
tries = 0;
while (true) {
  if (!state.chatId) {
    const a = await ask('Envoie un message à ton bot dans Telegram, puis appuie sur Entrée (ou tape ton chat ID) :');
    if (/^-?\d+$/.test(a)) state.chatId = a;
    else {
      const upd = await tg('getUpdates', state.token);
      const last = (upd.result || []).map((u) => u.message?.chat?.id).filter(Boolean).pop();
      if (last) state.chatId = String(last);
    }
  }
  if (state.chatId) {
    const sent = await tg('sendChatAction', state.token, { chat_id: state.chatId, action: 'typing' });
    if (sent.ok) { ok('Ton chat Telegram est joignable'); break; }
    warn(`Telegram refuse l'envoi (${sent.description || 'erreur'}). Ouvre ton bot, envoie /start, puis réessaie.`);
    state.chatId = '';
  }
  if (++tries >= 3) fail('Impossible d’envoyer sur Telegram. Vérifie le token et que tu as écrit à ton bot, puis relance.');
}
saveState(state);

// 5/8 --------------------------------------------------------------------
step(5, 'Mise en ligne');
const dep = run(`${WR} deploy`);
if (dep.code !== 0) {
  fail(`Le déploiement a échoué :\n${(dep.err + dep.out).trim().split('\n').slice(-8).join('\n')}`);
}
let baseUrl = process.env.DM_TEST_URL || ((dep.out + dep.err).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
if (!baseUrl) {
  warn("Déployé, mais l'adresse n'a pas été détectée.");
  baseUrl = (await ask("Colle l'adresse https://doctolib-monitor.xxx.workers.dev :")).replace(/\/$/, '');
}
state.baseUrl = baseUrl;
saveState(state);
ok(`En ligne : ${baseUrl}`);

// 6/8 --------------------------------------------------------------------
step(6, 'Réglages');
if (!state.key) state.key = crypto.randomBytes(16).toString('hex');
if (!state.ingestKey) state.ingestKey = crypto.randomBytes(24).toString('hex');
if (!fs.existsSync(URLS_FILE)) fs.writeFileSync(URLS_FILE, '# Une URL Doctolib par ligne (étape calendrier des créneaux)\n');
let urls = fs.readFileSync(URLS_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (!urls.length) {
  const pasted = await ask('Colle l’URL Doctolib du calendrier (plusieurs possibles, séparées par un espace) :');
  urls = pasted.split(/\s+/).filter(Boolean);
  fs.appendFileSync(URLS_FILE, `${urls.join('\n')}\n`);
}
const bad = urls.filter((u) => !/\/booking\//.test(u) || !/placeId=practice-\d+/.test(u) || !/motiveIds/.test(u));
if (bad.length) fail(`URL Doctolib incomplète (il faut celle de l'étape calendrier, avec placeId et motiveIds) :\n  ${bad[0]}`);
fs.writeFileSync(TMP_SECRETS, JSON.stringify({
  TELEGRAM_BOT_TOKEN: state.token,
  TELEGRAM_CHAT_ID: state.chatId,
  DASHBOARD_KEY: state.key,
  INGEST_KEY: state.ingestKey,
  DOCTOLIB_URLS: urls.join(' '),
}));
const sec = run(`${WR} secret bulk ${TMP_SECRETS}`);
cleanup();
if (sec.code !== 0) fail(`Enregistrement des réglages impossible :\n${(sec.err + sec.out).trim().split('\n').slice(-6).join('\n')}`);
saveState(state);
ok(`${urls.length} cabinet(s) à surveiller, Telegram et clés d'accès enregistrés`);

// 7/8 --------------------------------------------------------------------
step(7, 'GitHub (le collecteur qui interroge Doctolib)');
let au = run(`${GH} auth status`);
if (au.code !== 0) {
  info('Une page va s’ouvrir : recopie le code affiché dans le terminal, puis valide.');
  run(`${GH} auth login --hostname github.com --git-protocol https --web --scopes repo,workflow`, { inherit: true });
  au = run(`${GH} auth status`);
  if (au.code !== 0) fail('Connexion à GitHub non réussie. Relance install.bat.');
} else if (!/workflow/.test(au.out + au.err)) {
  run(`${GH} auth refresh --hostname github.com --scopes workflow`, { inherit: true });
}
run(`${GH} auth setup-git`);
let me;
try { me = JSON.parse(run(`${GH} api user`).out); } catch { me = null; }
if (!me?.login) fail('Impossible de lire ton compte GitHub. Relance install.bat.');
ok(`Compte GitHub : ${me.login}`);

if (!fs.existsSync('.git')) { run('git init'); run('git symbolic-ref HEAD refs/heads/main'); }
if (!run('git config user.email').out.trim()) {
  run(`git config user.email "${me.id}+${me.login}@users.noreply.github.com"`);
  run(`git config user.name "${me.login}"`);
}
run('git add -A');
const forbidden = ['.install-state.json', 'doctolib-urls.txt', 'INFOS.txt', '.secrets.tmp.json', '.dev.vars', '.env'];
const tracked = run('git ls-files').out.split('\n').map((l) => l.trim());
const leak = forbidden.filter((f) => tracked.includes(f));
if (leak.length) fail(`Fichier privé détecté dans le dépôt (${leak.join(', ')}). Rien n'a été envoyé sur GitHub.`);
run('git commit -m "Doctolib Monitor"');

const full = `${me.login}/${NAME}`;
if (run(`${GH} repo view ${full} --json name`).code !== 0) {
  const cr = run(`${GH} repo create ${NAME} --public --description "Doctolib Monitor (collecteur de créneaux)"`);
  if (cr.code !== 0) fail(`Création du dépôt GitHub impossible :\n${(cr.err + cr.out).trim().split('\n').slice(-4).join('\n')}`);
}
const remoteUrl = process.env.DM_REMOTE_URL || `https://github.com/${full}.git`;
if (run('git remote get-url origin').code !== 0) run(`git remote add origin ${remoteUrl}`);
else run(`git remote set-url origin ${remoteUrl}`);
let push = run('git push -u origin main');
if (push.code !== 0 && /rejected|non-fast-forward|fetch first/i.test(push.out + push.err)) {
  // Dépôt déjà créé par une installation précédente (autre historique) : il ne contient que ce projet, on le remplace.
  info('Le dépôt existe déjà avec un ancien historique : mise à jour forcée (il ne contient que ce projet).');
  run('git fetch origin main');
  push = run('git push -u --force-with-lease origin main');
}
if (push.code !== 0) fail(`Envoi du code sur GitHub impossible :\n${(push.err + push.out).trim().split('\n').slice(-5).join('\n')}`);
state.repo = full;
ok(`Dépôt : https://github.com/${full} (public : minutes GitHub gratuites illimitées, aucun secret dedans)`);

const setSecret = (name, value) => run(`${GH} secret set ${name} --repo ${full}`, { input: value });
if (setSecret('WORKER_URL', baseUrl).code !== 0 || setSecret('INGEST_KEY', state.ingestKey).code !== 0) {
  fail('Impossible d’enregistrer les secrets sur GitHub. Relance install.bat.');
}
let haveSecrets = [];
try { haveSecrets = JSON.parse(run(`${GH} secret list --repo ${full} --json name`).out).map((x) => x.name); } catch { /* inconnu */ }
if (!haveSecrets.includes('PROXY_URL')) {
  let proxy = '';
  for (const f of ['.env', '../.env', '../doctolib-watch/.env', 'doctolib-watch/.env']) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*PROXY_URL\s*=\s*["']?([^\s"']+)/m);
      if (m) { proxy = m[1]; info(`Proxy trouvé dans ${f}`); break; }
    } catch { /* absent */ }
  }
  while (!proxy) {
    const a = await ask('Colle ton proxy (http://utilisateur:motdepasse@p.webshare.io:80), ou Entrée pour continuer sans :');
    if (!a) break;
    if (/^https?:\/\/\S+:\d+\/?$/.test(a)) proxy = a; else warn('Format inattendu : il doit ressembler à http://utilisateur:motdepasse@p.webshare.io:80');
  }
  if (proxy) {
    if (setSecret('PROXY_URL', proxy).code !== 0) fail('Impossible d’enregistrer le proxy sur GitHub. Relance install.bat.');
    ok('Proxy enregistré (uniquement chez GitHub, chiffré)');
  } else {
    warn('Pas de proxy : GitHub est un serveur, Doctolib refusera très probablement. Relance install.bat pour en ajouter un.');
  }
} else {
  ok('Proxy déjà enregistré');
}
run(`${GH} workflow enable collector.yml --repo ${full}`);

// Jeton limité à ce dépôt : permet à Cloudflare de lancer le collecteur (le planning de GitHub est trop peu fiable)
const API = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const ghApi = async (method, p, token, body) => {
  try {
    const r = await fetch(`${API}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'doctolib-monitor-installer', ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return r.status;
  } catch { return 0; }
};
const WF = `/repos/${full}/actions/workflows/collector.yml`;
const putSecrets = (obj) => {
  fs.writeFileSync(TMP_SECRETS, JSON.stringify(obj));
  const r = run(`${WR} secret bulk ${TMP_SECRETS}`);
  cleanup();
  return r;
};
if (state.ghToken && (await ghApi('GET', WF, state.ghToken)) !== 200) state.ghToken = '';
if (!state.ghToken) {
  info('Cloudflare doit pouvoir lancer le collecteur lui-même (le planning de GitHub est trop peu fiable).');
  info('Il faut pour cela un jeton limité à ce seul dépôt. Une page va s’ouvrir, puis :');
  info('  1. Token name : doctolib-monitor      Expiration : 1 year (le plus long possible)');
  info(`  2. Repository access : « Only select repositories » puis ${NAME}`);
  info('  3. Permissions > Repository permissions > Actions : « Read and write »');
  info('  4. « Generate token », puis copie le jeton (il commence par github_pat_) et colle-le ici.');
  if (process.platform === 'win32' && !process.env.DM_TEST_URL) run('start "" "https://github.com/settings/personal-access-tokens/new"');
  for (let t = 0; t < 3 && !state.ghToken; t++) {
    const tok = await ask('Jeton GitHub (Entrée pour passer, moins fiable) :');
    if (!tok) break;
    if (!/^(github_pat_|ghp_)[\w]+$/.test(tok)) { warn('Ce n’est pas un jeton GitHub (il commence par github_pat_).'); continue; }
    const code = await ghApi('GET', WF, tok);
    if (code === 200) state.ghToken = tok;
    else warn(`GitHub refuse ce jeton (HTTP ${code || 'réseau'}). Vérifie « Only select repositories » = ${NAME} et « Actions : Read and write ».`);
  }
}
if (state.ghToken) {
  const r = putSecrets({ GITHUB_TOKEN: state.ghToken, GITHUB_REPO: full });
  if (r.code !== 0) fail(`Enregistrement du jeton impossible :\n${(r.err + r.out).trim().split('\n').slice(-4).join('\n')}`);
  ok('Jeton enregistré chez Cloudflare : il lancera le collecteur à intervalle irrégulier');
} else {
  warn('Sans jeton, seul le planning de GitHub déclenche le collecteur : il peut rester silencieux des heures. Relance install.bat pour en ajouter un.');
}
saveState(state);

// 8/8 --------------------------------------------------------------------
step(8, 'Vérification');
const link = `${baseUrl}/?key=${state.key}`;
let cookie = '';
for (let i = 0; i < 40 && !cookie; i++) {
  try {
    const r = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const sc = r.headers.get('set-cookie');
    if (r.status === 302 && sc) cookie = sc.split(';')[0];
  } catch { /* adresse pas encore joignable */ }
  if (!cookie) { if (i === 0) info('Attente de la mise en ligne (jusqu’à 2 minutes la toute première fois)...'); await sleep(3000); }
}
if (!cookie) fail(`Le site ne répond pas encore. Attends 2 minutes puis relance install.bat. (${baseUrl})`);
const call = async (p, method = 'GET') => fetch(`${baseUrl}${p}`, { method, headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(60000) });

const listRuns = () => {
  try { return JSON.parse(run(`${GH} run list --repo ${full} --workflow collector.yml --event workflow_dispatch --limit 3 --json databaseId,status,conclusion`).out); } catch { return []; }
};
const before = Math.max(0, ...listRuns().map((r) => r.databaseId));
info('Premier passage du collecteur sur GitHub (1 à 2 minutes)...');
let launched = false;
if (state.ghToken) {
  for (let i = 0; i < 12 && !launched; i++) {
    const code = await ghApi('POST', `${WF}/dispatches`, state.ghToken, { ref: 'main', inputs: { force: 'true' } });
    if (code === 204) launched = true;
    else if (code === 401 || code === 403) {
      warn('GitHub refuse le jeton pour lancer le collecteur (permission « Actions : Read and write » manquante ?).');
      state.ghToken = '';
      saveState(state);
      break;
    } else await sleep(5000);
  }
}
for (let i = 0; i < 12 && !launched; i++) {
  launched = run(`${GH} workflow run collector.yml --repo ${full} -f force=true`).code === 0;
  if (!launched) await sleep(5000);
}
let finished = null;
if (launched) {
  for (let i = 0; i < 60 && !finished; i++) {
    await sleep(i < 3 ? 3000 : 6000);
    finished = listRuns().find((r) => r.databaseId > before && r.status === 'completed') || null;
  }
}
let allOk = true;
if (!launched) {
  allOk = false;
  warn('Le collecteur n’a pas pu être lancé automatiquement. Sur GitHub : onglet Actions > Collecteur Doctolib > Run workflow.');
} else if (!finished) {
  allOk = false;
  warn('Le collecteur met plus de temps que prévu. Regarde l’onglet Actions du dépôt.');
} else if (finished.conclusion !== 'success') {
  allOk = false;
  warn('Le collecteur a échoué. Extrait du journal :');
  const lg = run(`${GH} run view ${finished.databaseId} --repo ${full} --log-failed`);
  console.log((lg.out + lg.err).trim().split('\n').slice(-12).map((l) => `    ${l.slice(0, 200)}`).join('\n'));
}
const stj = await (await call('/api/status')).json().catch(() => null);
if (!stj || !stj.watches) {
  warn("Impossible de lire l'état. Ouvre le tableau de bord pour voir le détail.");
  allOk = false;
} else {
  for (const wch of stj.watches) {
    const st = wch.last?.status;
    if (st === 'ok') ok(`${wch.label} : OK (${wch.slots.length} créneau(x) en ce moment)`);
    else {
      allOk = false;
      warn(`${wch.label} : ${st || 'pas encore vérifié'}${wch.last?.error ? ` - ${wch.last.error}` : ''}`);
    }
  }
}
const tgTest = await call('/test-telegram', 'POST').catch(() => null);
if (tgTest && tgTest.status === 303) ok('Test Telegram envoyé par le site (vérifie ton téléphone)');

fs.writeFileSync(INFOS_FILE, [
  'Doctolib Monitor',
  '',
  `Tableau de bord : ${link}`,
  `Adresse         : ${baseUrl}`,
  `Clé d'accès     : ${state.key}`,
  `Collecteur      : https://github.com/${full}/actions`,
  '',
  "Pour mettre à jour ou changer de cabinet : modifie doctolib-urls.txt puis relance install.bat.",
  '',
].join('\n'));
await tg('sendMessage', state.token, {
  chat_id: state.chatId,
  text: `Doctolib Monitor est en ligne.\nTableau de bord (ouvre ce lien une fois sur ton téléphone) :\n${link}`,
});

console.log(`\n${c.b}${allOk ? c.g : c.y}=== ${allOk ? 'Installation terminée' : 'Installé, mais à vérifier'} ===${c.x}`);
console.log(`\n  Tableau de bord : ${link}`);
console.log(`  (adresse et clé gardées dans ${INFOS_FILE}, le lien t'a aussi été envoyé sur Telegram)`);
if (allOk) {
  console.log(`\n  ${state.ghToken ? 'Cloudflare lance' : 'GitHub lance'} le contrôle tout seul environ toutes les 15 minutes, à intervalle irrégulier.`);
  console.log('  Tu n\'as plus rien à faire : Telegram te prévient d\'un créneau, ou si la surveillance s\'arrête.\n');
} else {
  console.log(`\n${c.y}  Quelque chose n'a pas répondu normalement (détails ci-dessus).`);
  console.log('  Si tu vois « HTTP 403 » ou « Bloqué » : Doctolib refuse l\'IP du proxy ou aucun proxy n\'est configuré.');
  console.log(`  Copie-moi ce message et on adapte.${c.x}\n`);
}
if (process.platform === 'win32' && !process.env.DM_TEST_URL) run(`start "" "${link}"`);
