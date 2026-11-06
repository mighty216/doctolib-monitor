import { AGENT_FILES, INSTALL_TEMPLATE } from './agent_files.js';

/** Script d'installation de l'agent, prêt à être exécuté sur le serveur (clé et adresse déjà remplies). */
export function buildInstallScript(origin, key) {
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new Error('origine invalide');
  if (!/^[\w.-]{16,128}$/.test(key)) throw new Error('clé invalide');
  const files = Object.entries(AGENT_FILES).map(([name, content]) => {
    if (content.includes('__BOT_HUB_EOF__')) throw new Error(`${name} contient le délimiteur`);
    return `cat > ${name} <<'__BOT_HUB_EOF__'\n${content.replace(/\n?$/, '\n')}__BOT_HUB_EOF__\nchmod 600 ${name}`;
  }).join('\n');
  return INSTALL_TEMPLATE.replace('__HUB_URL__', origin).replace('__HUB_KEY__', key).replace('__FILES__', () => files);
}
