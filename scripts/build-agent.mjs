// Génère src/agent_files.js : les fichiers de l'agent + le script d'installation, servis par le Worker
// (le serveur n'a qu'une ligne à copier-coller). À relancer après toute modification de agent/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['hub_client.py', 'tgtg_hub.py', 'script_agent.py', 'medinlyon.py', 'vinted_core.py', 'vinted_source.py', 'vinted_hub.py', 'updater.py'];
const files = {};
for (const f of FILES) files[f] = fs.readFileSync(path.join(root, 'agent', f), 'utf8');
const template = fs.readFileSync(path.join(root, 'agent', 'install-agent.sh'), 'utf8');
// Agent AirPods (PC Windows) : fichiers en base64 (aucun souci d'encodage ni d'échappement dans PowerShell)
const WIN_FILES = ['hub_client.py', 'airpods_hub.py'];
const winFiles = {};
for (const f of WIN_FILES) winFiles[f] = fs.readFileSync(path.join(root, 'agent', f)).toString('base64');
const winTemplate = fs.readFileSync(path.join(root, 'agent', 'install-airpods.ps1'), 'utf8');
const out = `// FICHIER GÉNÉRÉ par scripts/build-agent.mjs : ne pas modifier à la main.
export const AGENT_FILES = ${JSON.stringify(files, null, 1)};
export const INSTALL_TEMPLATE = ${JSON.stringify(template)};
export const WIN_FILES = ${JSON.stringify(winFiles, null, 1)};
export const WIN_TEMPLATE = ${JSON.stringify(winTemplate)};
`;
const dest = path.join(root, 'src', 'agent_files.js');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  if (cur !== out) { console.error('src/agent_files.js est périmé : lance « node scripts/build-agent.mjs »'); process.exit(1); }
  console.log('agent_files.js à jour');
} else {
  fs.writeFileSync(dest, out);
  console.log('src/agent_files.js généré');
}
