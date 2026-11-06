#!/usr/bin/env python3
"""
Agent MédinLyon : tu coches « Aujourd'hui » et/ou « Demain » (rien n'est surveillé au départ). Pour chaque date, le bot relève
les horaires, garde le dernier relevé, et te prévient sur Telegram UNIQUEMENT quand un créneau PLUS TÔT que le
meilleur connu apparaît. Un créneau plus tardif ou rien de neuf : silence.

Source : GET https://medinlyon.fr/consultation/creneaux?centre=1&date=AAAA-MM-JJ
(fragment HTML avec les horaires ; aucune session ni cookie n'est nécessaire pour LIRE les créneaux).
La réservation se fait sur la page normale (lien dans l'alerte) : elle demande une session et tes coordonnées,
donc elle reste manuelle. Bibliothèque standard seulement.
"""
from concurrent.futures import ThreadPoolExecutor
import html as htmlmod
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from hub_client import Hub, HERE, load_config

PARIS = ZoneInfo("Europe/Paris")
BASE = "https://medinlyon.fr"
BOOK_URL = BASE + "/consultation/cabinet"
SETTINGS_FILE = os.path.join(HERE, "medinlyon_config.json")
DATA_FILE = os.path.join(HERE, "medinlyon_releves.json")  # derniers relevés, conservés après redémarrage
STATE_EVERY = 30
MIN_INTERVAL = 5
DAYS_FR = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
TIME_RE = re.compile(r"\b([01]?\d|2[0-3])\s*[:hH]\s*([0-5]\d)\b")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")


def parse_slots(fragment):
    """Extrait les horaires (« 21:30 ») d'un fragment HTML de créneaux. Retourne une liste triée sans doublon."""
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", fragment or "", flags=re.S | re.I)
    # un horaire peut figurer dans value="…", un label ou le texte du bouton : on lit attributs + texte
    attrs = " ".join(re.findall(r'(?:value|data-[\w-]+|title|aria-label)="([^"]*)"', text, flags=re.I))
    visible = htmlmod.unescape(re.sub(r"<[^>]+>", " ", text))
    found = set()
    for chunk in (visible, htmlmod.unescape(attrs)):
        for h, m in TIME_RE.findall(chunk):
            found.add(f"{int(h):02d}:{m}")
    return sorted(found)


def fetch_day(centre, day, timeout=20):
    url = f"{BASE}/consultation/creneaux?centre={centre}&date={day:%Y-%m-%d}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*",
                                               "Accept-Language": "fr-FR,fr;q=0.9", "X-Requested-With": "XMLHttpRequest"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf8", "replace")


def label(day):
    return f"{DAYS_FR[day.weekday()]} {day:%d/%m}"



def parse_date(txt, today=None):
    """« aujourd'hui », « demain », « 09/11 », « 9/11/2026 », « 2026-11-09 » -> date (jamais dans le passé)."""
    today = today or datetime.now(PARIS).date()
    t = str(txt or "").strip().lower().replace("’", "'")
    if t in ("aujourd'hui", "aujourdhui", "auj", "today", "ce soir", "ce_soir"):
        return today
    if t in ("demain", "tomorrow"):
        return today + timedelta(days=1)
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", t)
    if m:
        y, mo, d = (int(x) for x in m.groups())
    else:
        m = re.match(r"^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$", t)
        if not m:
            raise ValueError("date non comprise (exemples : aujourd'hui, demain, 09/11)")
        d, mo = int(m.group(1)), int(m.group(2))
        y = int(m.group(3)) if m.group(3) else today.year
        if y < 100:
            y += 2000
    try:
        out = date(y, mo, d)
    except ValueError:
        raise ValueError("date impossible")
    if out < today:
        raise ValueError("cette date est passée")
    return out


class Bot:
    def __init__(self, hub, fetch=fetch_day):
        self.hub = hub
        self.fetch = fetch
        self.lock = threading.Lock()
        self.settings = self.load_settings()
        self.data = self.load_data()        # "AAAA-MM-JJ" -> {"times": [...], "best": "HH:MM"|None, "seen": epoch, "known": bool}
        self.last_scan = 0.0
        self.last_ok = time.time()
        self.fail_count = 0
        self.down_alerted = False
        self.started = time.time()
        self.logbuf = []
        self.wake = threading.Event()

    # ------------------------------------------------------------------ outils
    def log(self, msg, lvl="info"):
        line = f"{datetime.now(PARIS):%H:%M:%S} {msg}"
        self.logbuf = (self.logbuf + [line])[-80:]
        print(line, flush=True)
        if lvl in ("warn", "bad", "ok"):
            self.hub.event(msg, lvl)

    def load_settings(self):
        s = {"enabled": True, "centre": 1, "interval": 30, "today": False, "tomorrow": False}
        try:
            with open(SETTINGS_FILE, encoding="utf8") as f:
                s.update({k: v for k, v in json.load(f).items() if k in s})
        except Exception:
            pass
        return self.clean(s)

    @staticmethod
    def clean(s):
        s["enabled"] = bool(s["enabled"])
        s["centre"] = max(1, int(s["centre"]))
        s["interval"] = max(MIN_INTERVAL, int(s["interval"]))
        s["today"], s["tomorrow"] = bool(s["today"]), bool(s["tomorrow"])
        return s

    def watched(self):
        """Dates surveillées : « aujourd'hui » et « demain » glissent avec le calendrier."""
        t = datetime.now(PARIS).date()
        return [f"{d:%Y-%m-%d}" for d, on in ((t, self.settings["today"]), (t + timedelta(days=1), self.settings["tomorrow"])) if on]

    def save_settings(self):
        with open(SETTINGS_FILE, "w", encoding="utf8") as f:
            json.dump(self.settings, f, indent=2)

    def load_data(self):
        try:
            with open(DATA_FILE, encoding="utf8") as f:
                return json.load(f)
        except Exception:
            return {}

    def save_data(self):
        try:
            with open(DATA_FILE, "w", encoding="utf8") as f:
                json.dump(self.data, f, indent=1)
        except OSError:
            pass

    def prune(self):
        """Les relevés de dates qui ne sont plus surveillées (passées ou décochées) sont oubliés."""
        w = self.watched()
        self.data = {d: v for d, v in self.data.items() if d in w}

    # ------------------------------------------------------------------ scan
    def scan_once(self):
        self.prune()
        days = self.watched()
        if not days:
            self.last_scan = self.last_ok = time.time()
            return
        s = self.settings

        def one(day):
            try:
                return day, parse_slots(self.fetch(s["centre"], date.fromisoformat(day))), None
            except (urllib.error.URLError, OSError, ValueError) as e:
                return day, None, e

        errors, last = 0, None
        with ThreadPoolExecutor(max_workers=4) as ex:  # dates en parallèle
            results = list(ex.map(one, days))
        for day, times, err in results:
            if err is not None:
                errors, last = errors + 1, err
                continue
            self.record(day, times)
        if errors == len(days):
            raise RuntimeError(f"MédinLyon injoignable ({type(last).__name__}: {str(last)[:80]})")
        self.last_scan = self.last_ok = time.time()
        if self.fail_count >= 3 or self.down_alerted:
            self.hub.message("✅ MédinLyon : les scans fonctionnent de nouveau.")
        self.fail_count, self.down_alerted = 0, False
        self.save_data()

    def record(self, day, times):
        """Enregistre le relevé d'une date et alerte si le meilleur (plus tôt) créneau s'est amélioré."""
        with self.lock:
            prev = self.data.get(day) or {"known": False, "best": None, "times": []}
            best = times[0] if times else None
            self.data[day] = {"times": times, "best": best, "seen": int(time.time()), "known": True}
        if not prev["known"]:
            self.log(f"{label(date.fromisoformat(day))} : relevé de départ ({', '.join(times) or 'aucun créneau'})")
            return
        if best and (prev["best"] is None or best < prev["best"]):
            self.alert(day, best, prev["best"], times)

    def alert(self, day, best, before, times):
        d = date.fromisoformat(day)
        self.log(f"Créneau plus tôt {label(d)} : {best} (avant : {before or 'aucun'})", "ok")
        self.hub.message(
            f"🩺 <b>MédinLyon : créneau plus tôt !</b>\n📅 {label(d)}\n⏰ <b>{best}</b>"
            + (f" (le meilleur d'avant : {before})" if before else " (il n'y avait rien avant)")
            + f"\nTous les créneaux du jour : {', '.join(times)}\n\n"
            f'<a href="{BOOK_URL}">Réserver sur MédinLyon</a>', html=True)
        self.hub.flush(self.state())

    def scan_loop(self):
        while True:
            if self.settings["enabled"]:
                try:
                    self.scan_once()
                except Exception as e:
                    self.fail_count += 1
                    self.log(f"Scan en erreur ({self.fail_count}) : {str(e)[:150]}", "warn")
                    if time.time() - self.last_ok > 900 and not self.down_alerted:
                        self.down_alerted = True
                        self.hub.message(f"🔴 MédinLyon : plus aucun scan réussi depuis 15 min ({str(e)[:100]}).")
            self.wake.wait(self.settings["interval"])
            self.wake.clear()

    # ------------------------------------------------------------------ texte
    def slots_text(self):
        if not self.watched():
            return "📭 Rien n'est surveillé. Envoie /medinlyon aujourdhui ou /medinlyon demain (ou coche sur le site)."
        lines = ["🩺 <b>MédinLyon</b>\n"]
        for day in self.watched():
            v = self.data.get(day)
            lab = label(date.fromisoformat(day))
            if not v:
                lines.append(f"• {lab} : relevé en cours…")
            elif v["times"]:
                lines.append(f"• {lab} : <b>{v['best']}</b> au plus tôt ({', '.join(v['times'])})")
            else:
                lines.append(f"• {lab} : aucun créneau")
        lines.append(f'\n<a href="{BOOK_URL}">Réserver</a>')
        return "\n".join(lines)

    # ------------------------------------------------------------------ commandes
    def toggle(self, key, args_text=""):
        s = self.settings
        t = args_text.strip().lower()
        s[key] = True if t in ("on", "oui", "1") else False if t in ("off", "non", "0") else not s[key]
        if s[key]:
            s["enabled"] = True
        self.save_settings()
        self.wake.set()
        name = "aujourd'hui" if key == "today" else "demain"
        return f"{'✅ Surveillé' if s[key] else '⛔ Plus surveillé'} : {name}." + (
            " Je te préviens si un créneau plus tôt apparaît." if s[key] else "")

    def handle(self, c):
        cmd, args = c["cmd"], c.get("args") or {}
        s = self.settings
        raw = str(args.get("date") or args.get("text") or "").strip()
        if cmd in ("today", "aujourdhui", "auj"):
            return True, self.toggle("today", raw), False
        if cmd in ("tomorrow", "demain"):
            return True, self.toggle("tomorrow", raw), False
        if cmd in ("date", "ajouter", "add", "surveiller", "retirer", "remove"):
            try:
                d = parse_date(raw)
            except ValueError as e:
                return False, f"{e}. Utilise /medinlyon aujourdhui ou /medinlyon demain.", False
            gap = (d - datetime.now(PARIS).date()).days
            if gap not in (0, 1):
                return False, "Seuls aujourd'hui et demain sont surveillés.", False
            return True, self.toggle("today" if gap == 0 else "tomorrow", "off" if cmd in ("retirer", "remove") else "on"), False
        if cmd in ("creneaux", "slots", "scan", "status", "etat", "ok", "dates"):
            if cmd == "scan":
                self.scan_once()
            return True, self.slots_text(), True
        if cmd in ("pause", "stop"):
            s["enabled"] = False
            self.save_settings()
            return True, "⏸ Surveillance MédinLyon en pause.", False
        if cmd in ("resume", "reprendre", "start"):
            s["enabled"] = True
            self.save_settings()
            self.wake.set()
            return True, "▶ Surveillance MédinLyon reprise.", False
        if cmd == "set":
            k, v = str(args.get("key", "")), str(args.get("value", "")).strip()
            if k not in ("enabled", "centre", "interval"):
                return False, f"Réglage inconnu : {k}", False
            try:
                s[k] = (v in ("1", "true", "Oui", "oui")) if k == "enabled" else int(v)
                self.settings = self.clean(s)
            except ValueError:
                return False, f"Valeur invalide pour {k}", False
            self.save_settings()
            self.wake.set()
            return True, f"Réglage {k} = {self.settings[k]}", False
        if cmd == "log":
            return True, "📜 " + ("\n".join(self.logbuf[-10:]) or "(vide)"), False
        return False, f"Commande inconnue pour MédinLyon : {cmd}", False

    def run_command(self, c):
        try:
            ok, text, html = self.handle(c)
        except Exception as e:
            ok, text, html = False, f"Erreur : {str(e)[:200]}", False
            self.log(f"Commande {c.get('cmd')} en erreur : {e}", "warn")
        self.hub.result(c["id"], ok, text, html=html)

    # ------------------------------------------------------------------ état pour l'interface
    def state(self):
        s = self.settings
        rows = []
        for day in self.watched():
            v = self.data.get(day)
            lab = label(date.fromisoformat(day))
            rows.append([lab, (v["best"] or "—") if v else "…", ", ".join(v["times"]) if v and v["times"] else ("aucun" if v else "relevé en cours"),
                         f"il y a {int(time.time() - v['seen'])} s" if v else "—"])
        if not s["enabled"]:
            status, summary = "idle", "En pause"
        elif not self.watched():
            status, summary = "idle", "Rien de surveillé : coche Aujourd'hui et/ou Demain"
        elif self.fail_count >= 3:
            status, summary = "bad", f"Scans en échec ({self.fail_count} d'affilée)"
        elif not self.last_scan:
            status, summary = "idle", "Premier relevé en cours"
        else:
            status = "ok"
            found = [r for r in rows if r[1] not in ("—", "…")]
            summary = f"{len(self.watched())} jour(s) · " + (f"meilleur créneau {found[0][0]} {found[0][1]}" if found else "aucun créneau pour le moment")
        return {
            "status": status, "summary": summary,
            "metrics": [
                {"label": "Jours surveillés", "value": str(len(self.watched()))}, {"label": "Intervalle", "value": f"{s['interval']} s"},
                {"label": "Dernier scan", "value": f"il y a {int(time.time() - self.last_scan)} s" if self.last_scan else "—"},
            ],
            "tables": [{"title": "Jours surveillés", "columns": ["Jour", "Meilleur créneau", "Tous les créneaux", "Relevé"], "rows": rows}],
            "actions": [
                {"id": "today", "label": ("✅ Aujourd'hui surveillé (cliquer pour arrêter)" if s["today"] else "Surveiller aujourd'hui")},
                {"id": "tomorrow", "label": ("✅ Demain surveillé (cliquer pour arrêter)" if s["tomorrow"] else "Surveiller demain")},
                {"id": "scan", "label": "Scanner maintenant"},
                {"id": "pause" if s["enabled"] else "resume", "label": "Mettre en pause" if s["enabled"] else "Reprendre"},
            ],
            "settings": [
                {"key": "enabled", "label": "Surveillance active", "type": "bool", "value": "1" if s["enabled"] else "0"},
                {"key": "interval", "label": "Intervalle entre scans (s)", "type": "number", "value": str(s["interval"]),
                 "help": f"Minimum {MIN_INTERVAL} s. Plus c'est court, plus tu es prévenu vite (ex. 10 s)."},
                {"key": "centre", "label": "Numéro du centre", "type": "number", "value": str(s["centre"])},
            ],
            "log": self.logbuf[-40:],
            "telegram": [],
        }

    def run(self):
        threading.Thread(target=self.scan_loop, daemon=True).start()
        self.hub.message("🟢 <b>MédinLyon démarré</b> (hub)\nChoisis aujourd'hui et/ou demain : /medinlyon aujourdhui · /medinlyon demain. Je te préviens seulement si un créneau plus tôt apparaît.", html=True)
        last_state = 0.0
        while True:
            if time.time() - last_state > STATE_EVERY:
                self.hub.flush(self.state())
                last_state = time.time()
            for c in self.hub.poll(wait=15):
                self.run_command(c)
                self.hub.flush(self.state())
                last_state = time.time()


def main():
    cfg = load_config()
    hub = Hub("medinlyon", "MédinLyon", cfg, log=lambda m: print(m, flush=True))
    Bot(hub).run()


if __name__ == "__main__":
    main()
