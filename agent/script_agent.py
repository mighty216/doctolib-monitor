#!/usr/bin/env python3
"""
Agent « script » : branche sur le hub un programme qui tourne de temps en temps (ali-coins, MédinLyon...).
Configuration dans scripts.json (voir l'exemple écrit par l'installeur). Le hub peut :
  - voir l'état du dernier passage (extrait du fichier journal du script) ;
  - lancer le script tout de suite (« run ») et suivre son déroulement ;
  - afficher la fin du journal.
Le planning reste celui de ton cron : l'agent ne programme rien.
"""
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from hub_client import Hub, HERE, load_config

PARIS = ZoneInfo("Europe/Paris")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
STATE_EVERY = 30


def tail(path, n=200):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 60000))
            lines = f.read().decode("utf8", "replace").splitlines()
        return [ANSI.sub("", l) for l in lines[-n:]]
    except OSError:
        return []


def fmt_age(sec):
    if sec < 90: return "à l'instant"
    if sec < 3600: return f"il y a {sec // 60} min"
    if sec < 86400: return f"il y a {sec // 3600} h"
    return f"il y a {sec // 86400} j"


class ScriptBot:
    def __init__(self, spec, cfg):
        self.spec = spec
        self.id = spec["id"]
        self.name = spec.get("name", self.id)
        self.cwd = os.path.expanduser(spec["cwd"])
        self.log_path = os.path.join(self.cwd, spec.get("log", "cron.log"))
        self.hub = Hub(self.id, self.name, cfg, log=lambda m: print(f"[{self.id}] {m}", flush=True))
        self.proc = None
        self.run_started = 0.0
        self.last_run = {"ts": 0, "code": None, "secs": 0}
        self.out = []
        self.lock = threading.Lock()
        self.stale_hours = float(spec.get("stale_hours", 36))

    # ------------------------------------------------------------------ exécution
    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self, args=""):
        if self.running():
            return False, f"{self.name} est déjà en cours d'exécution."
        cmd = self.spec["run"] + ((" " + args) if args else "")
        self.out = []
        try:
            self.proc = subprocess.Popen(cmd, shell=True, cwd=self.cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, errors="replace", start_new_session=True)
        except OSError as e:
            return False, f"Impossible de lancer : {e}"
        self.run_started = time.time()
        threading.Thread(target=self._pump, daemon=True).start()
        return True, f"▶ {self.name} lancé. Je te dis quand c'est fini."

    def _pump(self):
        p = self.proc
        for line in p.stdout:
            line = ANSI.sub("", line.rstrip("\n"))
            self.out.append(line)
            self.out = self.out[-300:]
            try:  # le script ne journalise pas forcément dans le même fichier que le cron
                with open(self.log_path, "a", encoding="utf8") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        code = p.wait()
        secs = int(time.time() - self.run_started)
        self.last_run = {"ts": int(time.time()), "code": code, "secs": secs}
        info = self.parse()
        icon = "✅" if code == 0 and info["status"] != "bad" else "🔴"
        self.hub.event(f"Passage terminé (code {code}, {secs} s) : {info['summary']}", "ok" if icon == "✅" else "bad")
        self.hub.message(f"{icon} {self.name} : passage terminé en {secs} s (code {code})\n{info['summary']}")
        self.hub.flush(self.state())

    # ------------------------------------------------------------------ lecture du journal
    def parse(self):
        lines = tail(self.log_path, 250) if not self.running() else self.out[-250:]
        text = "\n".join(lines)
        metrics = []
        for m in self.spec.get("metrics", []):
            hits = re.findall(m["regex"], text, re.I)
            if hits:
                v = hits[-1]
                metrics.append({"label": m["label"], "value": (v if isinstance(v, str) else v[0]) + m.get("suffix", "")})
        last_err = max([i for i, l in enumerate(lines) if re.search(self.spec.get("error_regex", r"\bERROR\b|Traceback|\bFAILED\b"), l)], default=-1)
        last_ok = max([i for i, l in enumerate(lines) if re.search(self.spec.get("ok_regex", r"success|termin|done|OK\b"), l, re.I)], default=-1)
        session_bad = bool(re.search(self.spec.get("session_regex", r"session.*(expir|invalid|invalide)|MANUAL_LOGIN|login required"), text, re.I))
        try:
            mtime = os.path.getmtime(self.log_path)
        except OSError:
            mtime = 0
        age = time.time() - mtime if mtime else None
        if session_bad and last_err > last_ok:
            status, summary = "bad", "Session expirée : refais le login sur ton PC puis réimporte la session"
        elif age is None:
            status, summary = "idle", "Aucun journal pour le moment"
        elif last_err > last_ok:
            err = ANSI.sub("", lines[last_err])[:140]
            status, summary = "warn", f"Dernier passage avec erreur : {err}"
        elif age > self.stale_hours * 3600:
            status, summary = "warn", f"Pas de passage depuis {fmt_age(int(age))}"
        else:
            status, summary = "ok", f"Dernier passage {fmt_age(int(age))}" + (" · " + ", ".join(f"{m['label']} {m['value']}" for m in metrics[:3]) if metrics else "")
        return {"status": status, "summary": summary, "metrics": metrics, "lines": lines, "age": age}

    # ------------------------------------------------------------------ commandes
    def handle(self, c):
        cmd = c["cmd"]
        if cmd in ("run", "lancer", "start"):
            ok, text = self.start()
            return ok, text, False
        if cmd == "dry":
            ok, text = self.start(self.spec.get("dry_args", "--dry-run --notify"))
            return ok, text, False
        if cmd in ("log", "journal"):
            lines = (self.out if self.running() else tail(self.log_path, 12))[-12:]
            return True, "📜 " + (self.name + "\n" + "\n".join(lines) if lines else "journal vide"), False
        if cmd in ("status", "etat", "ok"):
            info = self.parse()
            extra = "\n".join(f"• {m['label']} : {m['value']}" for m in info["metrics"])
            return True, f"{self.name}\n{info['summary']}" + (f"\n{extra}" if extra else "") + ("\n⏳ en cours d'exécution" if self.running() else ""), False
        if cmd == "stop":
            if self.running():
                try:
                    os.killpg(os.getpgid(self.proc.pid), 15)
                except OSError:
                    self.proc.terminate()
                return True, "⏹ Arrêt demandé.", False
            return False, "Rien à arrêter.", False
        return False, f"Commande inconnue pour {self.name} : {cmd}", False

    def state(self):
        info = self.parse()
        running = self.running()
        status, summary = info["status"], info["summary"]
        if running:
            status, summary = "ok", f"En cours depuis {int(time.time() - self.run_started)} s"
        return {
            "status": status, "summary": summary,
            "metrics": info["metrics"] + ([{"label": "Dernier lancement manuel", "value": f"{fmt_age(int(time.time() - self.last_run['ts']))} (code {self.last_run['code']})"}] if self.last_run["ts"] else []),
            "actions": [a for a in [
                {"id": "run", "label": "Lancer maintenant", "confirm": f"Lancer {self.name} maintenant ?"},
                {"id": "dry", "label": "Test à blanc"} if self.spec.get("dry_args", "--dry-run --notify") else None,
                {"id": "stop", "label": "Arrêter le passage en cours"},
            ] if a],
            "settings": [],
            "tables": [],
            "log": (self.out if running else info["lines"])[-40:],
            "telegram": [],
        }


def main():
    cfg = load_config()
    with open(os.path.join(HERE, "scripts.json"), encoding="utf8") as f:
        specs = json.load(f)
    bots = [ScriptBot(s, cfg) for s in specs if os.path.isdir(os.path.expanduser(s["cwd"]))]
    if not bots:
        raise SystemExit("scripts.json : aucun dossier existant.")
    last = {b.id: 0.0 for b in bots}

    def serve(b):
        while True:
            if time.time() - last[b.id] > STATE_EVERY:
                b.hub.flush(b.state())
                last[b.id] = time.time()
            for c in b.hub.poll(wait=15):
                try:
                    ok, text, html = b.handle(c)
                except Exception as e:  # une commande ne doit jamais tuer l'agent
                    ok, text, html = False, f"Erreur : {str(e)[:200]}", False
                b.hub.result(c["id"], ok, text, html=html)
                b.hub.flush(b.state())
                last[b.id] = time.time()

    threads = [threading.Thread(target=serve, args=(b,), daemon=True) for b in bots]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
