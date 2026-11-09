#!/usr/bin/env python3
"""
Bot Too Good To Go branché sur le hub. Remplace tgtg_monitor.py (mêmes jetons, mêmes fonctions) :
plus de polling Telegram ici, le hub reçoit les commandes et les relaie. Tout se pilote aussi depuis l'interface web.
"""
import base64
import collections
import json
import os
import re
import sys
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from hub_client import Hub, HERE, load_config

PARIS = ZoneInfo("Europe/Paris")
TOKEN_FILE = os.path.join(HERE, "tgtg_tokens.json")

UA_FILE = os.path.join(HERE, "tgtg_ua.txt")
DEFAULT_UA = "TGTG/26.7.2 Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Pro Build/UP1A.231005.007)"


def stable_user_agent():
    """UA de l'app TGTG récent et fixe. Surcharge : variable TGTG_USER_AGENT ou fichier tgtg_ua.txt."""
    env = os.environ.get("TGTG_USER_AGENT", "").strip()
    if env:
        return env
    try:
        with open(UA_FILE, encoding="utf8") as f:
            v = f.read().strip()
            if v:
                return v
    except OSError:
        pass
    return DEFAULT_UA

CONFIG_FILE = os.path.join(HERE, "tgtg_hub_config.json")
MIN_INTERVAL = 15
STATE_EVERY = 20  # s


BACKOFF = (5, 5, 30, 60, 120, 300, 600)  # secondes d'attente après le 1er, 2e, 3e… échec 403 d'affilée


def token_valid_for(access_token, minutes=30):
    """Vrai si le jeton d'accès (JWT) reste valable au moins `minutes` : inutile de le renouveler au démarrage."""
    try:
        part = str(access_token).split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["exp"]
        return exp - time.time() > minutes * 60
    except Exception:
        return False


def now_paris():
    return datetime.now(PARIS)


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Bot:
    def __init__(self, hub, cfg, client_factory):
        self.hub, self.cfg, self.client_factory = hub, cfg, client_factory
        self.client = None
        self.started = time.time()
        self.lock = threading.RLock()
        self.logbuf = collections.deque(maxlen=200)
        self.settings = self.load_settings()
        self.items = {}            # item_id -> dict(name, qty, price, store)
        self.prev = {}             # item_id -> qty
        self.first_scan = True
        self.last_scan = 0.0
        self.last_ok = time.time()
        self.fail_count = 0
        self.down_alerted = False
        self.proxy_index = 1  # toujours via les proxys Webshare tournants (comme l'ancien script), jamais l'IP du serveur
        self.cookies = {}        # n° de proxy -> cookie DataDome qui a FONCTIONNÉ avec ce proxy (il est lié à son IP)
        self.saved_cookie = None  # cookie d'origine du fichier de jetons, essayé une fois sur chaque proxy
        self.tried_saved = set()
        self.orders = []
        self.force_refresh = False
        self.last_refresh_try = 0.0
        self.ok_count, self.last_beat = 0, time.time()  # bilan périodique des scans réussis dans le journal
        self.stop = False
        self.scan_lock = threading.Lock()  # « Scanner maintenant » et la boucle de scan ne doivent jamais appeler TGTG en même temps
        self.reboot = False

    # ------------------------------------------------------------------ journal
    def log(self, msg, lvl="info"):
        line = f"{now_paris():%H:%M:%S} {msg}"
        self.logbuf.append(line)
        print(line, flush=True)
        if lvl in ("warn", "bad", "ok"):
            self.hub.event(msg, lvl)

    # ------------------------------------------------------------------ réglages
    def load_settings(self):
        s = {"enabled": True, "hour_start": 6, "hour_end": 12, "interval": 15, "auto_reserve": True, "auto_quantity": 1}
        # reprise des réglages de l'ancien script s'ils existent
        old = os.path.join(HERE, "tgtg_config.json")
        for path in (old, CONFIG_FILE):
            try:
                with open(path, encoding="utf8") as f:
                    raw = json.load(f)
            except Exception:
                continue
            alias = {"hour_start": ("hour_start", "HOUR_START", "start", "heure_debut"),
                     "hour_end": ("hour_end", "HOUR_END", "end", "heure_fin"),
                     "interval": ("interval", "scan_interval", "SCAN_INTERVAL"),
                     "auto_reserve": ("auto_reserve", "auto", "AUTO_RESERVE"),
                     "auto_quantity": ("auto_quantity", "auto_qty", "AUTO_QUANTITY", "quantity"),
                     "enabled": ("enabled",)}
            for k, names in alias.items():
                for n in names:
                    if n in raw:
                        s[k] = raw[n]
                        break
        s["hour_start"] = int(s["hour_start"]) % 24
        he = int(s["hour_end"])
        s["hour_end"] = 24 if he % 24 == 0 else he % 24
        s["interval"] = max(MIN_INTERVAL, int(s["interval"]))
        s["enabled"] = bool(s["enabled"])
        s["auto_reserve"] = bool(s["auto_reserve"])
        s["auto_quantity"] = min(3, max(1, int(s["auto_quantity"])))
        return s

    def save_settings(self):
        with open(CONFIG_FILE, "w", encoding="utf8") as f:
            json.dump(self.settings, f, indent=2)

    def in_hours(self):
        if not self.settings.get("enabled", True):  # bouton « Arrêter » : aucun scan, quelle que soit l'heure
            return False
        h, a, b = now_paris().hour, self.settings["hour_start"], self.settings["hour_end"]
        return a <= h < b if a < b else (h >= a or h < b)

    # ------------------------------------------------------------------ client TGTG
    def proxies(self):
        p = self.cfg.get("tgtg", {}).get("proxy")
        if not p:
            return None
        user = f"{p['user_base']}{self.proxy_index}"
        url = f"http://{user}:{p['password']}@{p['host']}:{p.get('port', 80)}"
        return {"http": url, "https": url}

    def connect(self):
        try:
            with open(TOKEN_FILE, encoding="utf8") as f:
                t = json.load(f)
        except Exception as e:
            raise SystemExit(f"Jetons TGTG introuvables ({TOKEN_FILE}) : {e}")
        self.cookies = {str(k): v for k, v in (t.get("datadome_by_proxy") or {}).items() if v}
        self.saved_cookie = t.get("datadome_cookie") or None
        count = int((self.cfg.get("tgtg", {}).get("proxy") or {}).get("count", 1) or 1)
        try:
            self.proxy_index = min(max(1, int(t.get("proxy_index") or 1)), count)  # on repart du dernier proxy qui marchait
        except (TypeError, ValueError):
            self.proxy_index = 1
        self.tried_saved.add(self.proxy_index)
        self.client = self.client_factory(
            access_token=t.get("access_token", ""), refresh_token=t.get("refresh_token", ""),
            datadome_cookie=self.cookies.get(str(self.proxy_index)) or self.saved_cookie, proxies=self.proxies())
        self.tokens_snapshot = json.dumps(t, sort_keys=True)

    def save_tokens(self):
        c = self.client
        cur = {"access_token": getattr(c, "access_token", None), "refresh_token": getattr(c, "refresh_token", None)}
        if not cur["access_token"] or not cur["refresh_token"]:
            return
        try:
            with open(TOKEN_FILE, encoding="utf8") as f:
                old = json.load(f)
        except Exception:
            old = {}
        new = {**old, **{k: v for k, v in cur.items() if v}}
        new["proxy_index"] = self.proxy_index
        if self.cookies:
            new["datadome_by_proxy"] = dict(self.cookies)
        if json.dumps(new, sort_keys=True) != json.dumps(old, sort_keys=True):
            tmp = TOKEN_FILE + ".tmp"
            with open(tmp, "w", encoding="utf8") as f:
                json.dump(new, f, indent=2)
            os.replace(tmp, TOKEN_FILE)
            self.log("Jetons TGTG renouvelés et sauvegardés.")

    def fresh_cookie(self):
        """Cookie DataDome neuf, demandé via le proxy en cours (le cookie est lié à l'IP qui le demande)."""
        c, mod = self.client, getattr(self, "tgtg_mod", None)
        c.cookie = "datadome=init"
        if mod is None or not hasattr(c, "_fetch_datadome_cookie"):
            return
        orig = mod.requests.post
        mod.requests.post = lambda *a, **k: orig(*a, **({"proxies": c.proxies, **k} if c.proxies else k))
        try:
            c._fetch_datadome_cookie("https://apptoogoodtogo.com/api/")
        finally:
            mod.requests.post = orig
        fresh = [x.value for x in c.session.cookies if x.name == "datadome" and x.value]
        if fresh:
            c.cookie = f"datadome={fresh[-1]}"

    def refresh_if_due(self):
        """Renouvellement du jeton (toutes les 4 h) : l'appel le plus surveillé par DataDome. Il passe en direct depuis le
        serveur ; on remet ensuite proxy ET cookie d'avant (le cookie reçu en direct est lié à l'IP du serveur)."""
        c = self.client
        if not hasattr(c, "_refresh_token"):
            return
        # Échéance réelle du jeton (JWT, 48 h chez TGTG) au lieu des 4 h supposées par la lib ; renouvellement si < 6 h
        # restantes ou après un 401. Jamais plus d'une tentative toutes les 10 min (pas de martèlement si ça échoue).
        if not self.force_refresh and token_valid_for(c.access_token, 360):
            return
        if time.time() - self.last_refresh_try < 600:
            return
        self.last_refresh_try, self.force_refresh = time.time(), False
        keep_px, keep_ck = c.proxies, c.cookie
        try:
            c.proxies, c.last_time_token_refreshed = None, None
            c._refresh_token()
        except Exception:
            c.proxies, c.cookie, c.last_time_token_refreshed = keep_px, keep_ck, None
            c._refresh_token()  # dernier recours : via le proxy
        finally:
            c.proxies, c.cookie = keep_px, keep_ck
        self.log("Jeton TGTG renouvelé")
        self.save_tokens()  # tout de suite : sinon, si le scan qui suit échoue, les nouveaux jetons sont perdus au redémarrage

    def rotate_proxy(self):
        p = self.cfg.get("tgtg", {}).get("proxy")
        if not p:
            return
        self.proxy_index = (self.proxy_index % int(p.get("count", 1))) + 1
        try:
            self.client.proxies = self.proxies()
            self.client.session.cookies.clear()  # nouvelle IP : cookie connu pour ce proxy, sinon l'original (1 essai), sinon neuf
            key = str(self.proxy_index)
            if self.cookies.get(key):
                self.client.cookie = self.cookies[key]
            elif self.saved_cookie and self.proxy_index not in self.tried_saved:
                self.tried_saved.add(self.proxy_index)
                self.client.cookie = self.saved_cookie if "=" in self.saved_cookie else "datadome=" + self.saved_cookie
            else:
                self.fresh_cookie()
        except Exception:
            pass
        self.log(f"Rotation du proxy -> {p['user_base']}{self.proxy_index}", "warn")

    # ------------------------------------------------------------------ extraction d'un favori
    @staticmethod
    def parse_item(it):
        item = it.get("item", {})
        price = item.get("price_including_taxes", {}) or {}
        eur = price.get("minor_units", 0) / (10 ** price.get("decimals", 2))
        addr = ((it.get("store", {}) or {}).get("store_location", {}) or {}).get("address", {}) or {}
        slot = it.get("pickup_interval") or {}
        pick = ""
        if slot.get("start"):
            pick = f"{slot['start'][11:16]}-{(slot.get('end') or '')[11:16]}"
        return {
            "id": str(item.get("item_id", "?")), "name": it.get("display_name", "Inconnu"),
            "qty": int(it.get("items_available", 0) or 0), "price": eur,
            "address": addr.get("address_line", ""), "pickup": pick,
            "slot_start": (slot.get("start") or "")[:16].replace("T", " "),
            "slot_end": (slot.get("end") or "")[:16].replace("T", " "),
        }

    # ------------------------------------------------------------------ scan
    def scan_once(self):
        with self.scan_lock:
            self._scan_once()

    def _scan_once(self):
        self.refresh_if_due()
        raw = self.client.get_items(favorites_only=True)
        found = {}
        for it in raw:
            p = self.parse_item(it)
            found[p["id"]] = p
        with self.lock:
            self.items = found
        self.last_scan = time.time()
        self.last_ok = self.last_scan
        ck = getattr(self.client, "cookie", None)
        if isinstance(ck, str) and ck.startswith("datadome=") and "datadome=init" not in ck:
            self.cookies[str(self.proxy_index)] = ck  # cette paire proxy + cookie fonctionne : on la mémorise
        if self.fail_count >= 3 or self.down_alerted:
            self.hub.message("✅ TGTG : les scans fonctionnent de nouveau.")
            self.log("Scans de nouveau OK", "ok")
        self.fail_count, self.down_alerted = 0, False
        self.ok_count += 1
        if time.time() - self.last_beat >= 300:
            self.log(f"{self.ok_count} scan(s) OK en {int(time.time() - self.last_beat) // 60} min (proxy {self.proxy_index})")
            self.ok_count, self.last_beat = 0, time.time()
        if self.first_scan:
            self.prev = {k: v["qty"] for k, v in found.items()}
            self.first_scan = False
            self.log(f"{len(found)} favori(s) suivis")
            return
        for k, p in found.items():
            before = self.prev.get(k, 0)
            if before == 0 and p["qty"] >= 1:
                self.on_available(p)
            self.prev[k] = p["qty"]

    def on_available(self, p):
        self.log(f"DISPO : {p['name']} x{p['qty']} à {p['price']:.2f}€", "ok")
        qty = min(self.settings["auto_quantity"], p["qty"])
        reserved = None
        if self.settings["auto_reserve"]:
            reserved = self.reserve(p["id"], qty, auto=True)
        n = max(1, min(3, p["qty"]))
        row = [{"text": f"🛒 {i} panier{'s' if i > 1 else ''}", "callback_data": f"c:tgtg:reserve:{p['id']}:{i}"} for i in range(1, n + 1)]
        pick = f"\n⏰ <b>Retrait :</b> {esc(p['slot_start'])} → {esc(p['slot_end'])}" if p["slot_start"] else ""
        text = (f"🛍️ <b>{esc(p['name'])}</b>\n✅ {p['qty']} panier(s) disponible(s)\n💶 <b>{p['price']:.2f} €</b>\n📍 {esc(p['address'])}{pick}"
                + (f"\n\n{reserved}" if reserved else ""))
        self.hub.message(text, html=True, markup={"inline_keyboard": [row]})
        self.hub.flush(self.state())  # une alerte ne doit pas attendre le prochain envoi périodique

    def reserve(self, item_id, qty, auto=False):
        try:
            order = self.client.create_order(item_id, qty)
            oid = order.get("id", "?")
            self.log(f"Réservation {'auto ' if auto else ''}OK : {oid}", "ok")
            return (f"✅ <b>{'Réservé automatiquement' if auto else 'Réservé'} !</b> ({qty} panier(s))\nCommande : <code>{esc(oid)}</code>\n"
                    f"⚠️ Paye dans l'app TGTG dans les minutes qui viennent.\nPour annuler : /annuler {esc(oid)}")
        except Exception as e:
            self.log(f"Réservation impossible : {e}", "bad")
            return f"❌ Réservation impossible : {esc(e)}"

    def scan_loop(self):
        while not self.stop:
            try:
                if not self.in_hours():
                    self.last_ok = time.time()  # hors plage : le compteur « sans succès depuis 10 min » repart de zéro à l'ouverture
                    self.down_alerted = False
                    time.sleep(30)
                    continue
                self.scan_once()
                self.save_tokens()
            except Exception as e:
                self.fail_count += 1
                self.log(f"Scan en erreur ({self.fail_count}) : {str(e)[:150]}", "warn")
                blocked = "403" in str(e)
                if "401" in str(e)[:6]:
                    # jeton refusé : un changement de proxy n'y peut rien, on force un renouvellement au prochain scan
                    self.force_refresh = True
                elif self.fail_count >= 10 and self.fail_count % 5 == 0:  # on reste sur le proxy + cookie qui marchent ; changement seulement après un long échec
                    self.rotate_proxy()
                if time.time() - self.last_ok > 600 and not self.down_alerted:
                    self.down_alerted = True
                    self.hub.message(f"🔴 TGTG : plus aucun scan réussi depuis 10 min ({str(e)[:100]}). Jeton mort, proxy HS ou blocage ?")
                    self.log("Plus de scan réussi depuis 10 min", "bad")
                # blocage DataDome : on ralentit de plus en plus (le blocage dépend du rythme des requêtes et est
                # temporaire ; marteler toutes les 4 s sur tous les proxys l'entretient)
                time.sleep(BACKOFF[min(self.fail_count - 1, len(BACKOFF) - 1)] if blocked else 15)
                continue
            time.sleep(self.settings["interval"])

    # ------------------------------------------------------------------ commandes
    def fav_text(self):
        with self.lock:
            items = list(self.items.values())
        if not items:
            return "Aucun favori lu pour le moment (scan hors plage horaire ou en attente)."
        lines = ["📋 <b>Tes favoris</b>\n"]
        for p in sorted(items, key=lambda x: -x["qty"]):
            lines.append(f"{'🟢' if p['qty'] else '🔴'} <b>{esc(p['name'])}</b> — {p['qty']} dispo · {p['price']:.2f} €")
        return "\n".join(lines)

    def fetch_orders(self):
        c = self.client
        if hasattr(c, "get_active"):
            r = c.get_active()
            orders = r.get("orders", []) if isinstance(r, dict) else (r or [])
        else:
            orders = c._post("order/v8/active").json().get("orders", [])
        self.orders = orders
        return orders

    def orders_text(self):
        orders = self.fetch_orders()
        if not orders:
            return "📭 Aucune commande active."
        lines = ["📦 <b>Commandes actives</b>\n"]
        for o in orders:
            name = (o.get("item", {}) or {}).get("name") or o.get("item_name") or "?"
            lines.append(f"• <b>{esc(name)}</b> — {esc(o.get('state', '?'))}\n  <code>{esc(o.get('id', '?'))}</code>")
        return "\n".join(lines)

    def refresh_orders_quietly(self):
        """Relit les commandes actives pour que le tableau de la page web soit à jour (sans jamais faire échouer l'action)."""
        try:
            self.fetch_orders()
        except Exception as e:
            self.log(f"Lecture des commandes impossible : {str(e)[:120]}")

    @staticmethod
    def words(args):
        t = str(args.get("text", "") or "").strip()
        return [w for w in re.split(r"[\s:]+", t) if w]

    def handle(self, c):
        cmd, args = c["cmd"], c.get("args") or {}
        w = self.words(args)
        s = self.settings
        if cmd in ("favoris", "scan"):
            if cmd == "scan":
                self.scan_once()
                with self.lock:
                    n, avail = len(self.items), sum(1 for p in self.items.values() if p["qty"] > 0)
                return True, f"🔄 Scan fait : {n} favori(s), {avail} disponible(s).\n\n" + self.fav_text(), True
            return True, self.fav_text(), True
        if cmd == "commandes":
            return True, self.orders_text(), True
        if cmd == "annuler":
            oid = args.get("order") or (w[0] if w else "")
            if not oid:
                return False, "Usage : /annuler <numéro de commande>", False
            self.client.abort_order(oid)
            self.log(f"Commande {oid} annulée", "ok")
            self.refresh_orders_quietly()
            return True, f"❌ Commande <code>{esc(oid)}</code> annulée.", True
        if cmd in ("reserver", "reserve"):
            item = args.get("item") or (w[0] if w else "")
            q = args.get("qty") or (w[1] if len(w) > 1 else "1")
            if not item:
                return False, "Usage : /reserver <id du panier> [quantité]", False
            q = min(3, max(1, int(q))) if str(q).isdigit() else 1
            text = self.reserve(item, q)
            if not text.startswith("❌"):
                self.refresh_orders_quietly()
            return not text.startswith("❌"), text, True
        if cmd == "horaires":
            m = re.match(r"^(\d{1,2})\s*h?\s*-\s*(\d{1,2})\s*h?$", str(args.get("text", "")).strip().lower())
            if not m:
                return False, f"Usage : /horaires 6h-22h (actuellement {s['hour_start']}h-{s['hour_end']}h)", False
            a, b = int(m.group(1)), int(m.group(2))
            if not (0 <= a <= 23 and 1 <= b <= 24 and a != b):
                return False, "Heures invalides (0-23 pour le début, 1-24 pour la fin).", False
            s["hour_start"], s["hour_end"] = a, b
            self.save_settings()
            return True, f"⏰ Plage de scan : {a}h → {b}h.", False
        if cmd in ("stop", "pause", "arreter"):
            s["enabled"] = False
            self.save_settings()
            self.log("Scans arrêtés (bouton Arrêter)", "warn")
            return True, "⏹ Scans TGTG arrêtés. Reprends avec le bouton « Reprendre » ou /tgtg resume.", False
        if cmd in ("resume", "reprendre", "start"):
            s["enabled"] = True
            self.fail_count = 0
            self.last_ok = time.time()
            self.save_settings()
            self.log("Scans repris", "ok")
            return True, "▶ Scans TGTG repris.", False
        if cmd == "interval":
            if not w or not w[0].isdigit():
                return False, f"Usage : /interval 30 (secondes, minimum {MIN_INTERVAL}). Actuellement {s['interval']} s.", False
            s["interval"] = max(MIN_INTERVAL, int(w[0]))
            self.save_settings()
            return True, f"⏱ Intervalle : {s['interval']} s" + (f" (minimum {MIN_INTERVAL})" if int(w[0]) < MIN_INTERVAL else "") + ".", False
        if cmd == "auto":
            if w and w[0].isdigit():
                s["auto_quantity"] = min(3, max(1, int(w[0])))
                s["auto_reserve"] = True
            else:
                s["auto_reserve"] = not s["auto_reserve"]
            self.save_settings()
            return True, f"🤖 Auto-réservation : {'✅ activée' if s['auto_reserve'] else '⛔ désactivée'} (quantité {s['auto_quantity']}).", False
        if cmd == "set":
            k, v = str(args.get("key", "")), str(args.get("value", "")).strip()
            try:
                if k in ("hour_start", "hour_end"):
                    h = int(v) % 24 if k == "hour_start" else min(24, max(1, int(v)))
                    other = s["hour_end" if k == "hour_start" else "hour_start"]
                    if h % 24 == other % 24:
                        return False, "Le début et la fin de la plage ne peuvent pas être à la même heure.", False
                    s[k] = h
                elif k == "interval": s[k] = max(MIN_INTERVAL, int(v))
                elif k == "auto_reserve": s[k] = v in ("1", "true", "Oui", "oui")
                elif k == "auto_quantity": s[k] = min(3, max(1, int(v)))
                else: return False, f"Réglage inconnu : {k}", False
            except ValueError:
                return False, f"Valeur invalide pour {k}", False
            self.save_settings()
            return True, f"Réglage {k} = {s[k]}", False
        if cmd == "log":
            tail = "\n".join(list(self.logbuf)[-10:]) or "(vide)"
            return True, f"📜 <b>Dernières lignes</b>\n<pre>{esc(tail)}</pre>", True
        if cmd == "ok":
            up = int(time.time() - self.started)
            last = f"il y a {int(time.time() - self.last_scan)} s" if self.last_scan else "jamais"
            return True, (f"✅ TGTG tourne depuis {up // 3600} h {up % 3600 // 60} min\n"
                          f"Dernier scan : {last}\nPlage : {s['hour_start']}h → {s['hour_end']}h "
                          f"({'actif' if self.in_hours() else 'hors plage'})\nIntervalle : {s['interval']} s\n"
                          f"Auto-réservation : {'✅' if s['auto_reserve'] else '⛔'} (x{s['auto_quantity']})"), False
        if cmd == "reboot":
            self.reboot = True
            return True, "🔄 Redémarrage du bot TGTG…", False
        return False, f"Commande inconnue pour TGTG : {cmd}", False

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
        with self.lock:
            items = sorted(self.items.values(), key=lambda x: (-x["qty"], x["name"]))
        avail = sum(1 for p in items if p["qty"] > 0)
        if self.fail_count >= 3 and s.get("enabled", True):
            status, summary = "bad", f"Scans en échec ({self.fail_count} d'affilée)"
        elif not s.get("enabled", True):
            status, summary = "idle", "Arrêté (bouton Reprendre pour relancer)"
        elif not self.in_hours():
            status, summary = "ok", f"En veille (plage {s['hour_start']}h–{s['hour_end']}h)"
        elif not self.last_scan:
            status, summary = "idle", "Premier scan en cours"
        else:
            status, summary = "ok", f"{len(items)} favori(s), {avail} disponible(s)"
        up = int(time.time() - self.started)
        return {
            "status": status, "summary": summary,
            "metrics": [
                {"label": "Favoris", "value": str(len(items))}, {"label": "Disponibles", "value": str(avail)},
                {"label": "Plage", "value": f"{s['hour_start']}h–{s['hour_end']}h"}, {"label": "Intervalle", "value": f"{s['interval']} s"},
                {"label": "Auto-résa", "value": f"{'oui' if s['auto_reserve'] else 'non'} (x{s['auto_quantity']})"},
                {"label": "Dernier scan", "value": f"il y a {int(time.time() - self.last_scan)} s" if self.last_scan else "—"},
                {"label": "Actif depuis", "value": f"{up // 3600} h {up % 3600 // 60} min"},
            ],
            "tables": [
                {"title": "Favoris", "columns": ["Panier", "Dispo", "Prix", "Retrait", "Id"], "highlight": 1,
                 "rows": [[p["name"], p["qty"], f"{p['price']:.2f} €", p["pickup"], p["id"]] for p in items],
                 "rowActions": [{"action": "reserver", "label": "🛒 Réserver", "args": {"item": "{4}", "qty": "1"}, "when": 1,
                                 "confirm": "Réserver 1 panier « {0} » ?"}]},
                {"title": "Commandes actives (dernière lecture)", "columns": ["Panier", "État", "Numéro"],
                 "rows": [[((o.get("item", {}) or {}).get("name") or o.get("item_name") or "?"), o.get("state", "?"), o.get("id", "?")] for o in self.orders],
                 "rowActions": [{"action": "annuler", "label": "Annuler", "args": {"order": "{2}"}, "danger": True,
                                 "confirm": "Annuler la commande « {0} » ?"}]},
            ],
            "actions": [
                {"id": "favoris", "label": "📋 Voir les favoris"},
                {"id": "commandes", "label": "📦 Mes commandes"},
                {"id": "scan", "label": "🔍 Scanner maintenant"},
                ({"id": "stop", "label": "⏹ Arrêter les scans", "danger": True, "confirm": "Arrêter les scans TGTG ?"} if s.get("enabled", True)
                 else {"id": "resume", "label": "▶ Reprendre les scans"}),
                {"id": "reserver", "label": "Réserver", "args": [{"name": "item", "label": "Id du panier"}, {"name": "qty", "label": "Quantité (1-3)"}]},
                {"id": "annuler", "label": "Annuler une commande", "args": [{"name": "order", "label": "Numéro de commande"}]},
                {"id": "reboot", "label": "🔄 Redémarrer le bot", "danger": True, "confirm": "Redémarrer le bot TGTG ?"},
            ],
            "settings": [
                {"key": "hour_start", "label": "Début du scan (heure)", "type": "number", "value": str(s["hour_start"])},
                {"key": "hour_end", "label": "Fin du scan (heure)", "type": "number", "value": str(s["hour_end"])},
                {"key": "interval", "label": "Intervalle entre scans (s)", "type": "number", "value": str(s["interval"]), "help": f"Minimum {MIN_INTERVAL} s : en dessous, risque de blocage."},
                {"key": "auto_reserve", "label": "Réservation automatique", "type": "bool", "value": "1" if s["auto_reserve"] else "0"},
                {"key": "auto_quantity", "label": "Paniers réservés automatiquement", "type": "select", "options": ["1", "2", "3"], "value": str(s["auto_quantity"])},
            ],
            "log": list(self.logbuf)[-40:],
            "telegram": [],
        }

    # ------------------------------------------------------------------ boucle principale
    def run(self):
        self.connect()
        threading.Thread(target=self.scan_loop, daemon=True).start()
        self.hub.message(
            f"🟢 <b>TGTG démarré</b> (hub)\nPlage : {self.settings['hour_start']}h → {self.settings['hour_end']}h · "
            f"intervalle {self.settings['interval']} s · auto-résa {'✅' if self.settings['auto_reserve'] else '⛔'}\n"
            "Commandes : /menu pour tout voir.", html=True)
        last_state = 0.0
        while not self.stop:
            if time.time() - last_state > STATE_EVERY:
                self.hub.flush(self.state())
                last_state = time.time()
            for c in self.hub.poll(wait=15):
                self.run_command(c)
                self.hub.flush(self.state())
                last_state = time.time()
                if self.reboot:
                    self.log("Redémarrage demandé")
                    time.sleep(1)
                    os._exit(0)  # systemd relance le service (Restart=always)
        return 0


def main():
    cfg = load_config()
    try:
        import tgtg as _tgtg_mod
        from tgtg_scanner.tgtg_client import TgtgClient, normalize_cookie
    except ImportError as e:
        sys.exit(f"Bibliotheque TGTG introuvable ({e})")

    ua = stable_user_agent()
    print(f"User-Agent TGTG: {ua}", flush=True)

    def factory(access_token, refresh_token, datadome_cookie, proxies):
        # Client de la bibliothèque + UN user-agent récent et STABLE (la lib en tire un au hasard, avec une vieille
        # version d'app si Google Play ne répond pas ; le cookie DataDome est lié au UA -> 403 à chaque redémarrage).
        kw = dict(access_token=access_token, refresh_token=refresh_token, proxies=proxies,
                  cookie=normalize_cookie(datadome_cookie) or "datadome=init",
                  last_time_token_refreshed=datetime.now(),
                  # la lib renouvellerait d'elle-même toutes les 4 h (via timedelta.seconds) : avec 86400 elle ne le fait
                  # jamais, c'est refresh_if_due qui décide selon l'échéance réelle du jeton
                  access_token_lifetime=86400)
        try:
            c = TgtgClient(user_agent=ua, **kw)
        except TypeError:
            c = TgtgClient(**kw)
        try:
            c.user_agent = ua
            c.session.headers["user-agent"] = ua
        except Exception:
            pass
        return c

    hub = Hub("tgtg", "Too Good To Go", cfg, log=lambda m: print(m, flush=True))
    bot = Bot(hub, cfg, factory)
    bot.tgtg_mod = _tgtg_mod
    bot.run()


if __name__ == "__main__":
    main()
