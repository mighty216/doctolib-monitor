"""Mise à jour de l'agent depuis GitHub (commande /maj). Bibliothèque standard seulement.

Principe : on lit le dernier commit de `main`, on télécharge les fichiers agent/*.py À CE COMMIT (pas de cache CDN périmé),
on vérifie qu'ils compilent, on remplace atomiquement (copie de sécurité dans .bak/), puis on redémarre les services hub-*."""
import json
import os
import py_compile
import shutil
import subprocess
import tempfile
import threading
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("HUB_REPO", "mighty216/doctolib-monitor")
BRANCH = "main"
VERSION_FILE = os.path.join(HERE, ".version")


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "bot-hub-updater", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def current_version():
    try:
        with open(VERSION_FILE, encoding="utf8") as f:
            return f.read().strip()
    except OSError:
        return ""


def update_files(fetch=_get, here=HERE):
    """Retourne (changés, sha). Lève une exception sans rien modifier si un fichier est invalide."""
    sha = json.loads(fetch(f"https://api.github.com/repos/{REPO}/commits/{BRANCH}"))["sha"]
    tree = json.loads(fetch(f"https://api.github.com/repos/{REPO}/git/trees/{sha}?recursive=1"))["tree"]
    names = sorted(t["path"][len("agent/"):] for t in tree
                   if t["type"] == "blob" and t["path"].startswith("agent/") and t["path"].count("/") == 1
                   and t["path"].endswith(".py") and not t["path"].split("/")[1].startswith("test_"))
    if not names:
        raise RuntimeError("aucun fichier agent trouvé sur GitHub")
    new = {}
    tmp = tempfile.mkdtemp(prefix="hubupd_")
    try:
        for n in names:
            data = fetch(f"https://raw.githubusercontent.com/{REPO}/{sha}/agent/{n}")
            p = os.path.join(tmp, n)
            with open(p, "wb") as f:
                f.write(data)
            py_compile.compile(p, doraise=True)       # fichier cassé -> on s'arrête avant de toucher quoi que ce soit
            new[n] = data
        changed = []
        for n, data in new.items():
            dest = os.path.join(here, n)
            try:
                with open(dest, "rb") as f:
                    if f.read() == data:
                        continue
            except OSError:
                pass
            changed.append(n)
        if changed:
            bak = os.path.join(here, ".bak")
            os.makedirs(bak, exist_ok=True)
            for n in changed:
                dest = os.path.join(here, n)
                if os.path.exists(dest):
                    shutil.copy2(dest, os.path.join(bak, n))
                with open(dest + ".new", "wb") as f:
                    f.write(new[n])
                os.replace(dest + ".new", dest)
        with open(os.path.join(here, ".version"), "w", encoding="utf8") as f:
            f.write(sha)
        return changed, sha
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def hub_services():
    try:
        out = subprocess.run(["systemctl", "list-unit-files", "hub-*.service", "--no-legend"], capture_output=True, text=True, timeout=20).stdout
        return [l.split()[0].replace(".service", "") for l in out.splitlines() if l.strip()]
    except Exception:
        return []


def restart_all(log=print, delay=4):
    """Redémarre tous les services hub-* après un court délai (le temps d'envoyer la réponse). Repli : on quitte, systemd relance."""
    def go():
        svcs = hub_services()
        if svcs:
            try:
                r = subprocess.run(["sudo", "-n", "systemctl", "restart", *svcs], capture_output=True, text=True, timeout=60)
                if r.returncode == 0:
                    return
                log(f"Redémarrage global refusé ({r.stderr.strip()[:120]}) : redémarrage de ce bot seul")
            except Exception as e:
                log(f"Redémarrage global impossible ({e}) : redémarrage de ce bot seul")
        os._exit(0)  # systemd (Restart=always) relance ce bot avec le nouveau code
    t = threading.Timer(delay, go)
    t.daemon = True
    t.start()
