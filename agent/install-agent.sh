#!/usr/bin/env bash
# Installe l'agent du hub sur ton serveur (OVH). Lancé par : curl -fsSL -H "Authorization: Bearer CLE" URL/agent/install.sh | bash
# Idempotent : tu peux le relancer pour mettre à jour. Rien n'est supprimé, les anciens fichiers sont sauvegardés.
set -euo pipefail

HUB_URL="__HUB_URL__"
HUB_KEY="__HUB_KEY__"
DIR="${BOT_HUB_DIR:-$HOME/bot-hub}"
SYSTEMCTL="${SYSTEMCTL:-sudo systemctl}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SUDO="${SUDO_CMD-sudo}"

say() { printf '\n== %s\n' "$*"; }
ok()  { printf '   ✓ %s\n' "$*"; }
warn(){ printf '   ! %s\n' "$*"; }

say "Dossier $DIR"
mkdir -p "$DIR"
cd "$DIR"

# --- fichiers de l'agent (intégrés à ce script) -----------------------------------------------
__FILES__

printf '{\n  "url": "%s",\n  "key": "%s"\n}\n' "$HUB_URL" "$HUB_KEY" > hub.json
chmod 600 hub.json
ok "Fichiers de l'agent écrits"

command -v python3 >/dev/null || { echo "python3 est requis."; exit 1; }
PY="$(command -v python3)"

# --- TGTG : on reprend les jetons et le proxy de l'ancien script -------------------------------
say "Too Good To Go"
OLD_UNIT=""
if $SYSTEMCTL cat tgtg >/dev/null 2>&1; then OLD_UNIT="tgtg"; fi
OLD_SCRIPT=""
for c in "$HOME/tgtg_monitor.py" "$HOME/tgtgAl/tgtg_monitor.py" "$HOME/tgtg/tgtg_monitor.py"; do
  [ -f "$c" ] && OLD_SCRIPT="$c" && break
done
if [ -z "$OLD_SCRIPT" ] && [ -n "$OLD_UNIT" ]; then
  OLD_SCRIPT="$($SYSTEMCTL cat tgtg 2>/dev/null | grep -Eo '/[^ ]*tgtg_monitor\.py' | head -1 || true)"
fi
if [ -n "$OLD_UNIT" ]; then
  UPY="$($SYSTEMCTL cat tgtg 2>/dev/null | sed -n 's/^ExecStart=\([^ ]*python[^ ]*\).*/\1/p' | head -1 || true)"
  [ -n "$UPY" ] && [ -x "$UPY" ] && PY="$UPY"
fi
OLD_DIR=""; [ -n "$OLD_SCRIPT" ] && OLD_DIR="$(dirname "$OLD_SCRIPT")"

if [ -n "$OLD_DIR" ] && [ -f "$OLD_DIR/tgtg_tokens.json" ] && [ ! -f tgtg_tokens.json ]; then
  cp "$OLD_DIR/tgtg_tokens.json" tgtg_tokens.json; chmod 600 tgtg_tokens.json; ok "Jetons TGTG repris de $OLD_DIR"
fi
if [ -n "$OLD_DIR" ] && [ -f "$OLD_DIR/tgtg_config.json" ] && [ ! -f tgtg_config.json ]; then
  cp "$OLD_DIR/tgtg_config.json" tgtg_config.json; ok "Réglages (horaires, intervalle, auto) repris"
fi

if [ -f tgtg_tokens.json ]; then
  # proxy Webshare lu dans l'ancien script (le jeton Telegram n'est PAS recopié)
  if [ -n "$OLD_SCRIPT" ] && [ -f "$OLD_SCRIPT" ]; then
    "$PY" - "$OLD_SCRIPT" <<'PYEOF'
import json, re, sys
src = open(sys.argv[1], encoding="utf8").read()
def get(name, default=None):
    m = re.search(r'^%s\s*=\s*["\']?([^"\'\n#]+?)["\']?\s*(?:#.*)?$' % name, src, re.M)
    return m.group(1).strip() if m else default
cfg = json.load(open("hub.json"))
if get("PROXY_PASS"):
    cfg["tgtg"] = {"proxy": {"host": get("PROXY_BASE", "p.webshare.io"), "port": int(get("PROXY_PORT", "80")),
                             "user_base": get("PROXY_USER_BASE", ""), "password": get("PROXY_PASS"), "count": int(get("PROXY_COUNT", "1"))}}
    json.dump(cfg, open("hub.json", "w"), indent=2)
    print("   ✓ Proxy Webshare repris de l'ancien script")
PYEOF
  else
    warn "Ancien script introuvable : TGTG tournera sans proxy (ajoute \"tgtg\": {\"proxy\": ...} dans hub.json sinon)."
  fi
  if ! "$PY" -c "import tgtg_scanner" 2>/dev/null; then
    say "Installation de la bibliothèque TGTG"
    "$PY" -m pip install --user --break-system-packages "git+https://github.com/Der-Henning/tgtg.git" requests >/dev/null 2>&1 \
      || "$PY" -m pip install --user "git+https://github.com/Der-Henning/tgtg.git" requests
  fi
  # on coupe l'ancien bot (sinon deux scripts se disputent le même Telegram)
  if [ -n "$OLD_UNIT" ]; then $SYSTEMCTL disable --now tgtg >/dev/null 2>&1 && ok "Ancien service « tgtg » arrêté et désactivé (il n'est pas supprimé)"; fi
  pkill -f tgtg_monitor.py 2>/dev/null && ok "Ancien processus arrêté" || true
  if crontab -l 2>/dev/null | grep -q tgtg_monitor; then
    crontab -l > "crontab.avant-hub.txt" 2>/dev/null || true
    crontab -l 2>/dev/null | grep -v tgtg_monitor | crontab - && ok "Ancien relanceur cron retiré (sauvegarde : $DIR/crontab.avant-hub.txt)"
  fi
  TGTG=1
else
  warn "Aucun jeton TGTG trouvé : TGTG n'est pas branché (copie tgtg_tokens.json dans $DIR puis relance)."
  TGTG=0
fi

# --- scripts à surveiller (ali-coins...) ----------------------------------------------------
say "Autres bots"
if [ ! -f scripts.json ]; then
  "$PY" - <<'PYEOF'
import json, os
specs = []
home = os.path.expanduser("~")
ali = os.path.join(home, "ali-coins")
if os.path.isfile(os.path.join(ali, "run_all.sh")):
    specs.append({"id": "alicoins", "name": "AliExpress coins", "cwd": ali, "run": "./run_all.sh --no-delay", "log": "cron.log",
                  "dry_args": "--dry-run --notify", "stale_hours": 36,
                  "metrics": [{"label": "Pièces gagnées", "regex": r"coins[=: ]+(\d+)"},
                              {"label": "Série (jours)", "regex": r"streak[=: ]+(\d+)"},
                              {"label": "Solde", "regex": r"balance[=: ]+(\d+)"}]})
json.dump(specs, open("scripts.json", "w"), indent=2, ensure_ascii=False)
print("   ✓ AliExpress coins détecté" if specs else "   ! ali-coins non trouvé dans ~/ali-coins (scripts.json vide : ajoute-le à la main plus tard)")
PYEOF
fi
SCRIPTS=0
"$PY" -c "import json,sys; sys.exit(0 if json.load(open('scripts.json')) else 1)" 2>/dev/null && SCRIPTS=1

# --- services systemd ---------------------------------------------------------------------------
say "Services"
unit() { # nom, description, commande
  $SUDO tee "$UNIT_DIR/$1.service" >/dev/null <<UNIT
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$3
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
}
if [ "$TGTG" = 1 ]; then unit hub-tgtg "Bot hub - Too Good To Go" "$PY $DIR/tgtg_hub.py"; fi
if [ "$SCRIPTS" = 1 ]; then unit hub-scripts "Bot hub - scripts (ali-coins...)" "$PY $DIR/script_agent.py"; fi
$SYSTEMCTL daemon-reload
[ "$TGTG" = 1 ] && $SYSTEMCTL enable hub-tgtg >/dev/null 2>&1 && $SYSTEMCTL restart hub-tgtg && ok "hub-tgtg démarré"
[ "$SCRIPTS" = 1 ] && $SYSTEMCTL enable hub-scripts >/dev/null 2>&1 && $SYSTEMCTL restart hub-scripts && ok "hub-scripts démarré"

# --- vérification --------------------------------------------------------------------------------
say "Vérification"
sleep 4
if curl -fsS -m 20 -H "Authorization: Bearer $HUB_KEY" "$HUB_URL/api/agent/poll?bot=ping&wait=0" >/dev/null; then
  ok "Le serveur joint bien le hub"
else
  warn "Le serveur ne joint pas le hub ($HUB_URL). Vérifie sa connexion internet."
fi
echo
echo "Terminé. Dans Telegram, envoie /menu : tes bots doivent apparaître dans la minute."
echo "Journaux : journalctl -u hub-tgtg -f   (ou hub-scripts)"
