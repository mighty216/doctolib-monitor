# Doctolib Monitor

Surveille les créneaux Doctolib d'un ou plusieurs cabinets, prévient sur **Telegram** quand un
**nouveau** créneau apparaît, et affiche l'état dans un **tableau de bord** protégé (Cloudflare).
Aucune réservation automatique : l'alerte contient le lien, tu réserves toi-même.

## Comment ça marche

```
Cron Cloudflare (toutes les 5 min, tirage au sort)
   └─► demande à GitHub de lancer le collecteur  ──►  Collecteur Python (proxy résidentiel)
                                                          │ interroge Doctolib
Worker Cloudflare  ◄───────────── envoie les résultats ───┘
   décide, enregistre (D1), tableau de bord  ──►  Telegram
```

- **Pourquoi pas directement depuis Cloudflare ?** Doctolib répond « 403 » aux serveurs Cloudflare
  (et à la plupart des datacenters). Le collecteur passe donc par ton **proxy résidentiel rotatif**
  (Webshare) : chaque appel sort par une IP différente, avec une empreinte de navigateur Chrome.
- **Qui déclenche ?** Le cron du Worker, via l'API GitHub (jeton limité à ce dépôt, permission Actions).
  Le planning propre à GitHub est trop peu fiable (il peut rester muet des heures) ; il reste en secours.
- **Rythme irrégulier** : à chaque tick de 5 min, tirage au sort (jamais deux passages à moins de 6 min,
  passage obligatoire au-delà de 25 min), puis ordre des cabinets mélangé et pauses aléatoires.
  Moyenne : ~15 min, jamais d'horloge régulière.
- **Chien de garde** : si le Worker ne reçoit plus rien pendant 75 min, message Telegram (une seule fois par
  silence), puis un message à la reprise. Si Cloudflare n'arrive plus à lancer GitHub (jeton expiré…), message aussi.
- Les URL Doctolib restent **dans un secret du Worker** : rien de personnel dans le dépôt GitHub.
- Quotas Cloudflare : un tick de 5 min = quelques lectures D1, un passage reçu = une quinzaine de requêtes.
  Très loin des limites gratuites : aucun risque pour tes autres applications.

## Installation facile (Windows)

1. Dézippe le dossier.
2. Double-clique sur **install.bat**. S'il installe Node.js, Git ou GitHub CLI, ferme la fenêtre et relance install.bat.
3. Tu n'interviens que pour : la **connexion Cloudflare** (clic sur « Allow »), la **connexion GitHub**
   (recopier un code affiché), le **token Telegram**, ton **proxy** (retrouvé tout seul s'il est dans un ancien `.env`)
   et un **jeton GitHub limité au dépôt** (l'installeur affiche les 4 réglages à cocher, 1 minute).
4. L'installeur crée la base, déploie le Worker, crée le dépôt GitHub (public, sans aucun secret dedans),
   pose les secrets, lance un premier passage et affiche le résultat par cabinet. Le lien du tableau de bord
   est aussi envoyé sur Telegram.

Adresse et clé : `INFOS.txt`. Cabinets : `doctolib-urls.txt` (une URL par ligne, 4 maximum).
Pour **changer de cabinet ou mettre à jour** : modifie ce fichier puis relance `install.bat`.
Pour **changer de proxy** : `gh secret set PROXY_URL --repo TON_COMPTE/doctolib-monitor`.
Quand le jeton GitHub arrive à expiration (au plus 1 an), Telegram te prévient : relance `install.bat` et recolle un nouveau jeton.

Pourquoi un dépôt **public** ? Les minutes GitHub Actions y sont gratuites et illimitées. Un dépôt privé
n'offre que 2000 min/mois, insuffisant pour ce rythme. Les secrets (proxy, clés) ne sont jamais dans le code.

## Installation manuelle

```bash
npm install
npx wrangler login
npx wrangler d1 create doctolib-monitor      # copie le database_id dans wrangler.toml
npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put DASHBOARD_KEY        # 12 caractères minimum
npx wrangler secret put INGEST_KEY           # 16 caractères minimum, aléatoire
npx wrangler secret put DOCTOLIB_URLS        # URL(s) de l'étape calendrier, séparées par un espace
npx wrangler secret put GITHUB_TOKEN         # jeton fine-grained limité au dépôt, permission Actions : Read and write
npx wrangler secret put GITHUB_REPO          # compte/doctolib-monitor
```

Puis pousse le dépôt sur GitHub et crée trois secrets d'Actions : `WORKER_URL` (adresse du Worker),
`INGEST_KEY` (la même que ci-dessus), `PROXY_URL` (`http://utilisateur:motdepasse@p.webshare.io:80`).
Lance ensuite le workflow « Collecteur Doctolib » à la main (Actions > Run workflow).

`DOCTOLIB_URLS` : liens `.../booking/availabilities?...placeId=practice-XXXX&motiveIds[]=YYYY...`
(jusqu'à 4 cabinets, séparés par espace, retour ligne, virgule ou `|`).

## Réglages (`wrangler.toml`)

| Variable | Défaut | Rôle |
|---|---|---|
| `MODE` | `ingest` | `ingest` = collecteur GitHub ; `direct` = le Worker appelle Doctolib (refusé depuis Cloudflare) |
| cron `[triggers]` | `*/5 * * * *` | fréquence des « ticks » (tirage au sort à chaque tick) |
| `INTERVAL_MIN` | 15 | rythme moyen visé entre deux passages |
| `COLLECTOR_STALE_MIN` | 75 | alerte si aucun résultat reçu depuis N min |
| `MAX_DAYS` | 21 | n'alerte que pour les créneaux dans les N prochains jours |
| `HEARTBEAT_HOURS` | 24 | message « toujours actif » (0 = désactivé) |
| `FAIL_ALERT_AFTER` | 4 | alerte après N passages en échec d'affilée pour un cabinet |

Pour espacer davantage les passages (30 min en moyenne), mets `INTERVAL_MIN = "30"` (puis `npx wrangler deploy`).

## Limites à connaître

- API Doctolib **non officielle** et usage contraire à leurs conditions : elle peut changer ou bloquer. Le tableau de bord
  et Telegram te préviennent (badge « Bloqué » / « Réponse inattendue », alerte après N échecs), le bot ne reste jamais muet.
- Un proxy rotatif peut tomber sur une IP refusée : le collecteur réessaie (nouvelle IP à chaque appel) avant de déclarer un échec.
- Sans jeton GitHub, seul le planning de GitHub déclenche le collecteur : il a déjà été observé muet pendant plus d'1h30.
- GitHub désactive les plannings des dépôts sans activité depuis 60 jours. Une étape du workflow tente de le ré-activer
  (non vérifiable ici) ; si le collecteur se tait, Telegram te prévient et il suffit de cliquer sur « Enable workflow ».
- Le tableau de bord affiche le nom et la ville des cabinets : garde `DASHBOARD_KEY` privée.

## Développement

```bash
npm test                                   # 48 tests (Doctolib et Telegram simulés, D1 en mémoire)
npm run dev                                # mettre les secrets dans .dev.vars (ignoré par git)
WORKER_URL=... INGEST_KEY=... PROXY_URL=... FORCE=1 python collector/collector.py
```
