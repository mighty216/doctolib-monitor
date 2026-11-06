import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { buildInstallScript } from '../src/agent_install.js';
import worker from '../src/index.js';
import { makeEnv } from './helpers.js';

const KEY = 'a'.repeat(32);

test('le Worker sert le script d\'installation seulement avec la clé de l\'agent', async () => {
  const env = makeEnv({ AGENT_KEY: KEY });
  const get = (h = {}) => worker.fetch(new Request('https://hub.example.workers.dev/agent/install.sh', { headers: h }), env);
  assert.equal((await get()).status, 401);
  assert.equal((await get({ authorization: 'Bearer faux' })).status, 401);
  const r = await get({ authorization: `Bearer ${KEY}` });
  assert.equal(r.status, 200);
  const sh = await r.text();
  assert.match(sh, /HUB_URL="https:\/\/hub.example.workers.dev"/);
  assert.ok(sh.includes(`HUB_KEY="${KEY}"`));
  assert.match(sh, /cat > tgtg_hub.py <<'__BOT_HUB_EOF__'/);
  assert.ok(!sh.includes('__FILES__'));
  assert.ok(!sh.includes('8728540812'), 'aucun jeton Telegram dans l\'installeur');
});

test('installeur du serveur : reprend jetons + proxy, coupe l\'ancien service, crée les services', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const log = path.join(home, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = "cat" ]; then echo "ExecStart=/usr/bin/python3 ${home}/tgtg_monitor.py"; fi\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pkill'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // ancien état du serveur
  fs.writeFileSync(path.join(home, 'tgtg_monitor.py'), 'PROXY_BASE      = "p.webshare.io"\nPROXY_PORT      = 80\nPROXY_PASS      = "pw-secret"\nPROXY_USER_BASE = "user-fr-"\nPROXY_COUNT     = 9\nTELEGRAM_BOT_TOKEN = "111:SECRETTOKENSECRETTOKENSECRETTOKEN"\n');
  fs.writeFileSync(path.join(home, 'tgtg_tokens.json'), '{"access_token":"A","refresh_token":"R"}');
  fs.writeFileSync(path.join(home, 'tgtg_config.json'), '{"hour_start": 7}');
  fs.mkdirSync(path.join(home, 'ali-coins')); fs.writeFileSync(path.join(home, 'ali-coins', 'run_all.sh'), '#!/bin/sh\n', { mode: 0o755 });
  // faux paquet tgtg_scanner pour que l'installeur n'essaie pas d'installer quoi que ce soit
  const pp = path.join(home, 'pp', 'tgtg_scanner'); fs.mkdirSync(pp, { recursive: true }); fs.writeFileSync(path.join(pp, '__init__.py'), '');
  // faux hub
  const polled = [];
  const srv = http.createServer((req, res) => { polled.push([req.url, req.headers.authorization]); res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"commands":[]}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const script = path.join(home, 'install.sh'); fs.writeFileSync(script, buildInstallScript(origin, KEY));
  const units = path.join(home, 'units'); fs.mkdirSync(units);
  const child = spawn('bash', [script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PYTHONPATH: path.join(home, 'pp'), SYSTEMCTL: path.join(bin, 'systemctl'), UNIT_DIR: units, SUDO_CMD: '', BOT_HUB_DIR: path.join(home, 'bot-hub') } });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  srv.close();
  assert.equal(code, 0, out);
  const d = path.join(home, 'bot-hub');
  for (const f of ['hub_client.py', 'tgtg_hub.py', 'script_agent.py', 'hub.json', 'tgtg_tokens.json', 'scripts.json']) assert.ok(fs.existsSync(path.join(d, f)), f);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'hub.json'), 'utf8'));
  assert.equal(cfg.url, origin); assert.equal(cfg.key, KEY);
  assert.deepEqual(cfg.tgtg.proxy, { host: 'p.webshare.io', port: 80, user_base: 'user-fr-', password: 'pw-secret', count: 9 });
  assert.ok(!JSON.stringify(cfg).includes('SECRETTOKEN'), 'le jeton Telegram n\'est pas recopié');
  assert.equal(fs.statSync(path.join(d, 'hub.json')).mode & 0o077, 0, 'hub.json privé');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'scripts.json'), 'utf8'))[0].id, 'alicoins');
  assert.ok(fs.existsSync(path.join(d, 'tgtg_config.json')), 'ancien réglage repris');
  const sc = fs.readFileSync(log, 'utf8');
  assert.match(sc, /disable --now tgtg/); assert.match(sc, /enable hub-tgtg/); assert.match(sc, /restart hub-tgtg/); assert.match(sc, /restart hub-scripts/);
  assert.match(fs.readFileSync(path.join(units, 'hub-tgtg.service'), 'utf8'), /ExecStart=\/usr\/bin\/python3 .*tgtg_hub.py/);
  assert.ok(polled.some(([u, a]) => u.includes('bot=ping') && a === `Bearer ${KEY}`), 'test de connexion au hub');
  assert.match(out, /joint bien le hub/);
  // le script Python généré compile
  for (const f of ['hub_client.py', 'tgtg_hub.py', 'script_agent.py']) {
    const c = spawnSync('python3', ['-m', 'py_compile', path.join(d, f)]);
    assert.equal(c.status, 0, f);
  }
  // relancer l'installeur ne casse rien (idempotent)
  const again = spawnSync('bash', [script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PYTHONPATH: path.join(home, 'pp'), SYSTEMCTL: path.join(bin, 'systemctl'), UNIT_DIR: units, SUDO_CMD: '', BOT_HUB_DIR: d }, encoding: 'utf8', timeout: 30000 });
  assert.equal(again.status, 0, again.stdout + again.stderr);
});
