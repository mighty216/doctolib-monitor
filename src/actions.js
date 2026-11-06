// Actions partagées par l'interface web et Telegram.
import { addWatch } from './watches.js';
import { forceCheck } from './github.js';
import { metaStmt } from './store.js';
import { nowSec } from './util.js';

/** Ajoute une surveillance puis lance tout de suite une première vérification. */
export async function addAndStart(env, url, name) {
  const r = await addWatch(env, url, name);
  if (!r.ok) return { ok: false, text: r.error };
  await metaStmt(env.DB, `new:${r.key}`, nowSec()).run();
  const f = await forceCheck(env);
  const head = r.resumed ? 'Surveillance reprise' : 'Surveillance ajoutée';
  return {
    ok: true, key: r.key,
    text: f.ok
      ? `${head}. Première vérification lancée : résultat dans 1 à 2 minutes (un message Telegram te le confirmera).`
      : `${head}. La première vérification aura lieu toute seule dans quelques minutes. (${f.error})`,
  };
}
