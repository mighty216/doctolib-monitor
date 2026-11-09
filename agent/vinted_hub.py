#!/usr/bin/env python3
"""
Agent « Vinted pépites » pour le hub : repère les annonces Vinted vendues nettement sous leur prix de revente.

Approche « apprentissage » : peu d'alertes, mais fondées sur des semaines d'observation.
  1. Chaque annonce est rattachée à un produit précis (set Lego, série + tome, jeu + console) ; sinon elle est ignorée.
  2. Chaque produit rencontré ouvre un DOSSIER : le bot relève ses comparables toutes les 6 h et les suit jusqu'à leur
     vente. Il apprend ainsi le vrai prix de vente et le délai de revente de ce produit.
  3. Tant qu'un dossier n'est pas mûr (N ventes constatées ET N jours d'observation), le produit ne déclenche AUCUNE alerte.
  4. Produit mûr : coût réel (prix + 0,70 € + 5 % + port) contre médiane des ventes constatées (moins une décote),
     revente rapide exigée. Il réanalyse aussi une annonce connue dont le prix baisse.
Alerte Telegram (via le hub) avec « Ouvrir l'annonce », « Acheté », « Faux positif ». Le bot n'achète jamais rien.
"""
import html
import json
import os
import random
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

from hub_client import Hub, HERE, load_config
import vinted_core as core
from vinted_source import SourceError, Vinted

PARIS = ZoneInfo("Europe/Paris")
CONFIG_FILE = os.path.join(HERE, "vinted_config.json")
DB_FILE = os.path.join(HERE, "vinted.db")
STATE_EVERY = 30
PRIO_EVERY = {"haute": 1, "moyenne": 4, "basse": 15}  # un tour sur N
MARKET_TTL = 6 * 3600
DAY = 86400

DEFAULT_QUERIES = [
    ("jeu switch", "haute"), ("jeu ps5", "haute"), ("jeu ps4", "moyenne"), ("jeu game boy", "haute"),
    ("jeu gameboy advance", "haute"), ("jeu snes", "haute"), ("jeu nes", "moyenne"), ("jeu n64", "haute"),
    ("jeu gamecube", "haute"), ("jeu ps1", "moyenne"), ("jeu ps2", "moyenne"), ("jeu ds", "moyenne"), ("jeu 3ds", "moyenne"),
    ("lego technic", "haute"), ("lego star wars", "haute"), ("lego creator", "haute"), ("lego icons", "haute"),
    ("brio", "moyenne"),
    ("manga tome", "basse"), ("berserk tome", "basse"), ("vagabond tome", "basse"), ("junji ito", "basse"),
    ("bd edition originale", "basse"), ("spirou", "basse"), ("donjon trondheim", "basse"),
    # fautes de frappe : annonces vues par très peu d'acheteurs
    ("lgo", "basse"), ("nitendo switch", "basse"), ("pokemon jeux ds", "basse"),
]
DEFAULT_SETTINGS = {
    "enabled": True, "alerts": True,
    "profit_min": 8.0, "margin_min": 40.0, "conf_min": 0.45,
    "discount": 10.0,     # % retiré au prix de revente pour la négociation / la vente rapide
    "ship_in": 3.5,       # port payé pour te faire livrer (€)
    "max_price": 300.0, "min_price": 2.0,
    "cheap_cap": 7.0,     # Lego et Brio : seulement les annonces à ce prix ou moins
    "gap": 3.0,           # secondes minimum entre deux appels Vinted
    "max_age_h": 48,      # une annonce plus vieille n'est analysée que si son prix baisse
    "min_sold": 5,        # dossier mûr : au moins N ventes constatées...
    "min_days": 21,       # ... et au moins N jours d'observation du produit
    "max_sell_days": 30,  # on n'alerte que sur ce qui se revend vite (délai médian constaté)
    "auto_track": True,   # ouvrir un dossier pour chaque produit rencontré dans les recherches
    "max_products": 400,
}
NUM_SETTINGS = {"profit_min", "margin_min", "conf_min", "discount", "ship_in", "max_price", "min_price", "cheap_cap", "gap",
                "max_age_h", "min_sold", "min_days", "max_sell_days", "max_products"}
REFRESH_EVERY = 6 * 3600
IGNORE = ("lot de", "en lot", "vrac", "recherche", "echange")


def esc(s):
    return html.escape(str(s), quote=False)


def eur(x):
    return f"{x:.2f} €".replace(".", ",")


class Store:
    """SQLite local : annonces vues, comparables, ventes constatées, prix calculés, retours."""

    def __init__(self, path=DB_FILE):
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock, self.db:
            self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS listings (
              id TEXT PRIMARY KEY, key TEXT, cond TEXT, title TEXT, price REAL, seller TEXT, url TEXT, ts INTEGER,
              first_seen INTEGER, last_seen INTEGER, last_check INTEGER DEFAULT 0, state TEXT DEFAULT 'online',
              sold_at INTEGER, sold_price REAL, origin TEXT);
            CREATE INDEX IF NOT EXISTS i_key ON listings(key, cond, state);
            CREATE INDEX IF NOT EXISTS i_check ON listings(state, last_seen);
            CREATE TABLE IF NOT EXISTS market (key TEXT, cond TEXT, at INTEGER, data TEXT, PRIMARY KEY (key, cond));
            CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, at INTEGER, data TEXT, verdict TEXT);
            CREATE TABLE IF NOT EXISTS feedback (key TEXT, seller TEXT, kind TEXT, at INTEGER);
            CREATE TABLE IF NOT EXISTS products (key TEXT PRIMARY KEY, label TEXT, origin TEXT, added_at INTEGER,
              last_refresh INTEGER DEFAULT 0);
            """)

    def q(self, sql, args=(), one=False):
        with self.lock:
            cur = self.db.execute(sql, args)
            return cur.fetchone() if one else cur.fetchall()

    def x(self, sql, args=()):
        with self.lock, self.db:
            self.db.execute(sql, args)

    def get(self, iid):
        return self.q("SELECT * FROM listings WHERE id = ?", (iid,), one=True)

    def upsert(self, it, key, cond, origin, now):
        with self.lock, self.db:
            self.db.execute(
                """INSERT INTO listings (id, key, cond, title, price, seller, url, ts, first_seen, last_seen, origin)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET price = excluded.price, last_seen = excluded.last_seen,
                     key = COALESCE(listings.key, excluded.key), state = CASE WHEN listings.state = 'gone' THEN 'online' ELSE listings.state END""",
                (it["id"], key, cond, it["title"][:200], it["price"], it["seller"], it["url"], it["ts"], now, now, origin))

    def sold_rows(self, key, cond, since):
        head = key.rsplit(":", 1)[0] + ":%" if key.startswith(("jv:", "console:")) else key
        rows = self.q("""SELECT key, sold_price, sold_at, ts, first_seen FROM listings
                         WHERE key LIKE ? AND cond = ? AND state = 'sold' AND sold_at > ?""", (head, cond, since))
        return [r for r in rows if r["sold_price"] and core.same_product(key, r["key"])]

    def sold_prices(self, key, cond, since):
        return [r["sold_price"] for r in self.sold_rows(key, cond, since)]

    def excluded(self, key, seller):
        k = self.q("SELECT COUNT(*) n FROM feedback WHERE kind = 'fp' AND key = ?", (key,), one=True)["n"]
        s = self.q("SELECT COUNT(*) n FROM feedback WHERE kind = 'fp' AND seller = ? AND seller != ''", (seller,), one=True)["n"]
        return k >= 2 or s >= 3


class Bot:
    def __init__(self, hub, source=None, store=None, config_file=CONFIG_FILE, clock=time.time):
        self.hub = hub
        self.clock = clock
        self.config_file = config_file
        self.store = store or Store()
        self.lock = threading.RLock()
        self.logbuf = deque(maxlen=200)
        self.load_config()
        self.src = source or Vinted(proxy=self.proxy_from(hub.cfg), min_gap=self.s["gap"])
        self.round = 0
        self.started = clock()
        self.last_scan = 0.0
        self.backoff = 0
        self.problem = ""
        self.stats = {"seen": 0, "analysed": 0, "priced": 0, "deals": 0, "drops": 0, "sold_found": 0}
        self.stop = False
        self.wake = threading.Event()

    # ------------------------------------------------------------------ réglages
    @staticmethod
    def proxy_from(cfg):
        """Proxy facultatif : "vinted": {"proxy": "http://user:pass@hote:port"} dans hub.json. Sans lui, connexion directe."""
        return ((cfg or {}).get("vinted") or {}).get("proxy") or None

    def load_config(self):
        try:
            with open(self.config_file, encoding="utf8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        self.s = {**DEFAULT_SETTINGS, **(raw.get("settings") or {})}
        qs = raw.get("queries")
        if not isinstance(qs, list):
            qs = [{"q": q, "prio": p, "seeded": False} for q, p in DEFAULT_QUERIES]
        self.queries = [q for q in qs if isinstance(q, dict) and q.get("q")]
        for q in self.queries:
            q.setdefault("prio", "moyenne")
            q.setdefault("seeded", False)
            q.setdefault("found", 0)
        self.save_config()

    def save_config(self):
        tmp = self.config_file + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump({"settings": self.s, "queries": self.queries}, f, indent=1, ensure_ascii=False)
        os.replace(tmp, self.config_file)

    def log(self, msg, lvl="info"):
        line = f"{datetime.now(PARIS):%d/%m %H:%M:%S} {msg}"
        self.logbuf.append(line)
        print(line, flush=True)
        if lvl != "info":
            self.hub.event(msg, lvl)

    # ------------------------------------------------------------------ dossiers produits
    def track(self, key, label, origin="auto"):
        if not key:
            return False
        if self.store.q("SELECT 1 FROM products WHERE key = ?", (key,), one=True):
            return True
        n = self.store.q("SELECT COUNT(*) n FROM products", one=True)["n"]
        if origin == "auto" and n >= self.s["max_products"]:
            return False
        self.store.x("INSERT OR IGNORE INTO products (key, label, origin, added_at) VALUES (?, ?, ?, ?)",
                     (key, label[:80], origin, int(self.clock())))
        return True

    def maybe_track(self, key, label):
        """Un produit qui revient (3 annonces distinctes) mérite un dossier ; un titre isolé, non."""
        if self.store.q("SELECT 1 FROM products WHERE key = ?", (key,), one=True):
            return
        if key.startswith(("jv:", "console:")):
            head = key.rsplit(":", 1)[0] + ":%"
            rows = self.store.q("SELECT key FROM listings WHERE key LIKE ?", (head,))
            n = sum(1 for r in rows if core.same_product(key, r["key"]))
        else:
            n = self.store.q("SELECT COUNT(*) n FROM listings WHERE key = ?", (key,), one=True)["n"]
        if n >= 3:
            self.track(key, label)

    def dossier(self, key, cond):
        """Ce que le bot a appris sur un produit : ventes, prix, délai de revente, maturité."""
        now = int(self.clock())
        p = self.store.q("SELECT * FROM products WHERE key = ?", (key,), one=True)
        rows = self.store.sold_rows(key, cond, now - 120 * DAY)
        prices = sorted(r["sold_price"] for r in rows)
        delays = sorted(max(0, (r["sold_at"] - (r["ts"] or r["first_seen"]))) / DAY for r in rows)
        days = (now - p["added_at"]) / DAY if p else 0
        mid = lambda v: v[len(v) // 2] if v else None  # noqa: E731
        ready = bool(p) and len(prices) >= self.s["min_sold"] and days >= self.s["min_days"]
        return {"key": key, "cond": cond, "tracked": bool(p), "days": days, "n_sold": len(prices),
                "median": mid(prices), "delay": mid(delays), "ready": ready}

    def learn_step(self, limit=2):
        """Relève les comparables des dossiers les moins récemment mis à jour (pour les suivre jusqu'à leur vente)."""
        now = int(self.clock())
        rows = self.store.q("SELECT key FROM products WHERE last_refresh < ? ORDER BY last_refresh LIMIT ?",
                            (now - REFRESH_EVERY, limit))
        for r in rows:
            self.store.x("DELETE FROM market WHERE key = ?", (r["key"],))
            self.market(r["key"], "occ")  # enregistre aussi les comparables neufs
            self.store.x("UPDATE products SET last_refresh = ? WHERE key = ?", (now, r["key"]))

    # ------------------------------------------------------------------ analyse
    def accept(self, it):
        t = core.norm(it["title"])
        if it["pro"] or not it["title"]:
            return False
        if not (self.s["min_price"] <= it["price"] <= self.s["max_price"]):
            return False
        return not any(w in t for w in IGNORE)

    def market(self, key, cond, exclude_id="", exclude_seller=""):
        now = int(self.clock())
        row = self.store.q("SELECT at, data FROM market WHERE key = ? AND cond = ?", (key, cond), one=True)
        if row and now - row["at"] < MARKET_TTL:
            return json.loads(row["data"]) if row["data"] else None
        comps = self.src.search(core.search_text(key), order="relevance")
        active = []
        for c in comps:
            ck = core.product_key(c["title"])
            if not core.same_product(key, ck) or c["pro"]:
                continue
            ccond = core.condition_group(c["status"], c["title"])
            self.store.upsert(c, ck, ccond, "comparable", now)  # suivi jusqu'à la vente
            if ccond == cond and c["id"] != exclude_id and c["seller"] != exclude_seller:
                active.append(c["price"])
        m = core.market_price(active, self.store.sold_prices(key, cond, now - 90 * DAY))
        self.store.x("INSERT OR REPLACE INTO market (key, cond, at, data) VALUES (?, ?, ?, ?)",
                     (key, cond, now, json.dumps(m) if m else ""))
        return m

    def analyse(self, it, query, drop_from=None):
        key = core.product_key(it["title"])
        if not key:
            return None
        cat = core.category(key)
        if cat in ("lego", "brio") and it["price"] > self.s["cheap_cap"]:
            return None
        if self.store.excluded(key, it["seller"]):
            return None
        self.stats["analysed"] += 1
        cond = core.condition_group(it["status"], it["title"])
        dos = self.dossier(key, cond)
        if not dos["ready"]:
            self.stats["learning"] = self.stats.get("learning", 0) + 1
            return None  # dossier trop jeune : on apprend, on ne parle pas
        if dos["delay"] is not None and dos["delay"] > self.s["max_sell_days"]:
            return None  # se revend trop lentement
        self.market(key, cond, it["id"], it["seller"])  # garde les comparables à jour (suivi des ventes)
        sold = self.store.sold_prices(key, cond, int(self.clock()) - 120 * DAY)
        m = core.market_price([], sold, min_sold=int(self.s["min_sold"]))
        if m:
            self.stats["priced"] += 1
            m["delay"] = dos["delay"]
            m["days"] = round(dos["days"])
        ev = core.evaluate(it["price"], m, self.s, total_item_price=it["total"] or None, favourites=it["fav"])
        if not ev["ok"]:
            return None
        if self.store.q("SELECT 1 FROM deals WHERE id = ?", (it["id"],), one=True) and not drop_from:
            return None
        deal = {"id": it["id"], "title": it["title"], "url": it["url"], "price": it["price"], "key": key, "cat": cat,
                "cond": cond, "query": query, "market": m, "ev": ev, "drop_from": drop_from, "seller": it["seller"]}
        self.store.x("INSERT OR REPLACE INTO deals (id, at, data, verdict) VALUES (?, ?, ?, COALESCE((SELECT verdict FROM deals WHERE id = ?), ''))",
                     (it["id"], int(self.clock()), json.dumps(deal, ensure_ascii=False), it["id"]))
        self.stats["deals"] += 1
        for q in self.queries:
            if q["q"] == query:
                q["found"] = q.get("found", 0) + 1
        self.log(f"💎 {it['title'][:60]} : {eur(it['price'])} -> profit {eur(ev['profit'])}", "ok")
        if self.s["alerts"]:
            self.hub.message(self.deal_text(deal), html=True, markup=self.deal_buttons(deal))
        return deal

    @staticmethod
    def deal_text(d):
        ev, m = d["ev"], d["market"]
        basis = f"médiane de {m['n_sold']} ventes constatées en {m.get('days', '?')} j de suivi"
        if m.get("delay") is not None:
            basis += f", revente en ~{m['delay']:.0f} j"
        lines = [
            f"💎 <b>Pépite Vinted</b> · {esc(d['cat'])}{' · neuf' if d['cond'] == 'neuf' else ''}",
            f"<a href=\"{esc(d['url'])}\">{esc(d['title'][:90])}</a>",
            (f"📉 Prix baissé : {eur(d['drop_from'])} → <b>{eur(d['price'])}</b>" if d.get("drop_from")
             else f"Prix : <b>{eur(d['price'])}</b>") + f" (coût réel {eur(ev['cost'])} avec frais et port)",
            f"Revente visée : {eur(ev['resale'])} ({basis}, fourchette {eur(m['low'])}–{eur(m['high'])})",
            f"<b>Profit ≈ {eur(ev['profit'])} · marge {ev['margin']:.0f} %</b> · confiance {ev['conf']:.0%}",
        ]
        if ev["suspect"]:
            lines.append("⚠️ Prix très bas pour ce produit : vérifie les photos (boîte vide, copie, arnaque ?)")
        return "\n".join(lines)

    @staticmethod
    def deal_buttons(d):
        return {"inline_keyboard": [
            [{"text": "🛒 Ouvrir l'annonce", "url": d["url"]}],
            [{"text": "✅ Acheté", "callback_data": f"c:vinted:achete:{d['id']}"},
             {"text": "👎 Faux positif", "callback_data": f"c:vinted:fp:{d['id']}"}],
        ]}

    # ------------------------------------------------------------------ scan
    def scan_query(self, q):
        now = int(self.clock())
        items = self.src.search(q["q"], order="newest_first", per_page=48, price_to=self.s["max_price"])
        seed = not q.get("seeded")
        for it in items:
            self.stats["seen"] += 1
            old = self.store.get(it["id"])
            key = core.product_key(it["title"])
            cond = core.condition_group(it["status"], it["title"])
            self.store.upsert(it, key, cond, "scan", now)
            if key and self.s["auto_track"] and old is None:
                self.maybe_track(key, it["title"])
            if seed or not self.accept(it):
                continue
            if old is None:
                if it["ts"] and now - it["ts"] > self.s["max_age_h"] * 3600:
                    continue  # vieille annonce remontée : elle a déjà été vue par tout le monde
                self.analyse(it, q["q"])
            elif old["price"] and it["price"] <= old["price"] * 0.95 - 0.5:
                self.stats["drops"] += 1
                self.analyse(it, q["q"], drop_from=old["price"])
        if seed:
            q["seeded"] = True
            self.save_config()
            self.log(f"Recherche « {q['q']} » initialisée ({len(items)} annonces déjà en ligne, aucune alerte).")

    def check_sold(self, limit=6):
        """Suit les comparables disparus des recherches : c'est ce qui construit la base des VRAIS prix de vente."""
        now = int(self.clock())
        rows = self.store.q(
            """SELECT id, price, state FROM listings WHERE state IN ('online', 'reserved') AND key IS NOT NULL
               AND last_seen < ? AND last_check < ? AND first_seen > ?
               ORDER BY (key IN (SELECT key FROM products)) DESC, last_check, last_seen LIMIT ?""",
            (now - 6 * 3600, now - 12 * 3600, now - 45 * DAY, limit))
        for r in rows:
            st = self.src.item_state(r["id"])
            # « réservée puis disparue » : une vente quasi certaine ; disparue sans réservation : ambigu, on ne compte pas
            if st == "sold" or (st == "gone" and r["state"] == "reserved"):
                self.store.x("UPDATE listings SET state = 'sold', sold_at = ?, sold_price = price, last_check = ? WHERE id = ?",
                             (now, now, r["id"]))
                self.stats["sold_found"] += 1
            elif st == "unknown":
                self.store.x("UPDATE listings SET last_check = ? WHERE id = ?", (now, r["id"]))
                self.stats["unknown_pages"] = self.stats.get("unknown_pages", 0) + 1
            else:
                self.store.x("UPDATE listings SET state = ?, last_check = ? WHERE id = ?", (st, now, r["id"]))

    def due(self):
        with self.lock:
            return [q for q in self.queries if not q.get("paused") and self.round % PRIO_EVERY.get(q["prio"], 4) == 0]

    def scan_round(self):
        self.round += 1
        for q in self.due():
            if self.stop or not self.s["enabled"]:
                return
            self.scan_query(q)
        self.learn_step()
        self.check_sold()
        self.last_scan = self.clock()

    def scan_loop(self):
        while not self.stop:
            if not self.s["enabled"]:
                self.wake.wait(10)
                self.wake.clear()
                continue
            try:
                self.scan_round()
                if self.problem:
                    self.log("Vinted répond de nouveau normalement.", "ok")
                self.problem, self.backoff = "", 0
            except SourceError as e:
                self.backoff = min(1800, max(60, self.backoff * 2))
                first = not self.problem
                if e.code == 404:
                    self.problem = "Vinted refuse l'API catalogue (404) : la méthode d'accès doit être adaptée."
                elif e.code in (403, 429):
                    self.problem = f"Vinted bloque temporairement (HTTP {e.code}), pause de {self.backoff // 60} min."
                else:
                    self.problem = f"Vinted injoignable ({e}), nouvel essai dans {self.backoff // 60} min."
                self.log(self.problem, "bad" if first else "info")
                self.wake.wait(self.backoff)
                self.wake.clear()
                continue
            except Exception as e:  # une erreur imprévue ne doit jamais tuer le bot
                self.log(f"Erreur inattendue : {type(e).__name__}: {e}", "warn")
            self.wake.wait(random.uniform(8, 20))
            self.wake.clear()

    # ------------------------------------------------------------------ commandes
    @staticmethod
    def arg(args, *names):
        for n in names:
            v = str((args or {}).get(n, "") or "").strip()
            if v:
                return v
        return ""

    def deal_by_id(self, iid):
        row = self.store.q("SELECT data FROM deals WHERE id = ?", (iid,), one=True)
        return json.loads(row["data"]) if row else None

    def handle(self, c):
        cmd, args = c["cmd"], c.get("args") or {}
        s = self.s
        if cmd in ("fp", "achete"):
            iid = self.arg(args, "id", "text").split()[0] if self.arg(args, "id", "text") else ""
            d = self.deal_by_id(iid)
            if not d:
                return False, "Annonce inconnue.", False
            self.store.x("UPDATE deals SET verdict = ? WHERE id = ?", (cmd, iid))
            self.store.x("INSERT INTO feedback (key, seller, kind, at) VALUES (?, ?, ?, ?)", (d["key"], d.get("seller", ""), cmd, int(self.clock())))
            if cmd == "fp":
                return True, f"👎 Noté. Après 2 faux positifs sur « {d['key']} », ce produit n'est plus signalé.", False
            return True, f"✅ Achat noté : {d['title'][:60]} ({eur(d['price'])}).", False
        if cmd in ("pepites", "deals"):
            return True, self.deals_text(), True
        if cmd in ("watch", "ajouter_recherche"):
            text = self.arg(args, "q", "text")
            prio = self.arg(args, "prio") or "moyenne"
            words = text.split()
            if words and words[-1] in PRIO_EVERY:
                prio, text = words[-1], " ".join(words[:-1])
            if len(text) < 2:
                return False, "Usage : /watch zelda switch [haute|moyenne|basse]", False
            if prio not in PRIO_EVERY:
                prio = "moyenne"
            with self.lock:
                if any(q["q"].lower() == text.lower() for q in self.queries):
                    return False, f"« {text} » est déjà surveillé.", False
                self.queries.append({"q": text, "prio": prio, "seeded": False, "found": 0})
                self.save_config()
            return True, f"🔎 Recherche ajoutée : « {esc(text)} » (priorité {prio}).", False
        if cmd in ("unwatch", "retirer"):
            n = self.arg(args, "n", "text")
            with self.lock:
                if not n.isdigit() or not 1 <= int(n) <= len(self.queries):
                    return False, f"Numéro de recherche invalide (1 à {len(self.queries)}).", False
                q = self.queries.pop(int(n) - 1)
                self.save_config()
            return True, f"🗑 Recherche retirée : « {esc(q['q'])} ».", False
        if cmd == "prio":
            words = self.arg(args, "text").split()
            n = self.arg(args, "n") or (words[0] if words else "")
            p = self.arg(args, "prio") or (words[1] if len(words) > 1 else "")
            if not n.isdigit() or not 1 <= int(n) <= len(self.queries) or p not in PRIO_EVERY:
                return False, "Usage : prio <n°> haute|moyenne|basse", False
            self.queries[int(n) - 1]["prio"] = p
            self.save_config()
            return True, f"Priorité de « {self.queries[int(n) - 1]['q']} » : {p}.", False
        if cmd == "estimer":
            title = self.arg(args, "titre", "text")
            key = core.product_key(title)
            if not key:
                return False, "Produit non identifiable avec ce titre (ajoute le n° de set, le tome ou la console).", False
            cond = core.condition_group("", title)
            m = self.market(key, cond)
            if not m:
                return True, f"🔎 {esc(key)} : pas assez de comparables pour donner un prix.", True
            return True, (f"🔎 <b>{esc(key)}</b> ({cond})\nPrix de revente : <b>{eur(m['price'])}</b> "
                          f"({m['basis']}, {m['n_sold']} ventes, {m['n_active']} en ligne, {eur(m['low'])}–{eur(m['high'])})"), True
        if cmd == "suivre":
            title = self.arg(args, "titre", "text")
            key = core.product_key(title)
            if not key:
                return False, "Produit non identifiable (ajoute le n° de set, le tome ou la console).", False
            self.track(key, title, "manuel")
            self.store.x("UPDATE products SET origin = 'manuel' WHERE key = ?", (key,))
            return True, (f"📂 Dossier ouvert : <b>{esc(key)}</b>. Je relève ses ventes ; alertes possibles après "
                          f"{self.s['min_sold']:g} ventes constatées et {self.s['min_days']:g} jours de suivi."), True
        if cmd == "oublier":
            key = self.arg(args, "key", "text")
            k2 = core.product_key(key) or key
            row = self.store.q("SELECT key FROM products WHERE key = ?", (k2,), one=True)
            if not row:
                return False, "Dossier introuvable (donne la clé affichée dans le tableau, ex. lego:42083).", False
            self.store.x("DELETE FROM products WHERE key = ?", (k2,))
            return True, f"🗑 Dossier fermé : {esc(k2)}.", False
        if cmd == "produits":
            ds = self.dossiers(12)
            if not ds:
                return True, "Aucun dossier pour l'instant.", False
            return True, "📂 <b>Dossiers produits</b>\n" + "\n".join(
                f"• {esc(d['label'][:40])} : {d['n_sold']} ventes" + (f", ~{eur(d['median'])}" if d["median"] else "")
                + (" ✅ prêt" if d["ready"] else f" ({d['days']:.0f}/{self.s['min_days']:g} j)") for d in ds), True
        if cmd == "scan":
            self.wake.set()
            return True, "🔍 Scan lancé.", False
        if cmd in ("stop", "pause"):
            s["enabled"] = False
            self.save_config()
            return True, "⏹ Scans Vinted arrêtés.", False
        if cmd in ("resume", "reprendre"):
            s["enabled"] = True
            self.save_config()
            self.wake.set()
            return True, "▶ Scans Vinted repris.", False
        if cmd == "set":
            k, v = self.arg(args, "key"), self.arg(args, "value")
            if k in NUM_SETTINGS:
                try:
                    val = float(v.replace(",", "."))
                except ValueError:
                    return False, f"Valeur invalide pour {k}", False
                if val < 0 or (k == "gap" and val < 1.5) or (k == "conf_min" and val > 1):
                    return False, f"Valeur hors limites pour {k}", False
                s[k] = val
                if k == "gap":
                    self.src.min_gap = val
            elif k in ("alerts", "auto_track"):
                s[k] = v in ("1", "true", "oui", "Oui")
            else:
                return False, f"Réglage inconnu : {k}", False
            self.save_config()
            return True, f"Réglage {k} = {s[k]}", False
        if cmd == "log":
            return True, "📜 <b>Vinted</b>\n<pre>" + esc("\n".join(list(self.logbuf)[-12:]) or "(vide)") + "</pre>", True
        return False, f"Commande inconnue : {cmd}", False

    def run_command(self, c):
        try:
            ok, text, is_html = self.handle(c)
        except SourceError as e:
            ok, text, is_html = False, f"Vinted indisponible : {e}", False
        except Exception as e:  # une commande ne doit jamais tuer l'agent
            ok, text, is_html = False, f"Erreur : {str(e)[:200]}", False
        self.hub.result(c["id"], ok, text, html=is_html)

    # ------------------------------------------------------------------ affichage
    def recent_deals(self, days=7, limit=25):
        rows = self.store.q("SELECT data, verdict FROM deals WHERE at > ? ORDER BY at DESC LIMIT ?",
                            (int(self.clock()) - days * DAY, limit))
        return [{**json.loads(r["data"]), "verdict": r["verdict"]} for r in rows]

    def dossiers(self, limit=40):
        out = []
        for p in self.store.q("SELECT key, label, origin FROM products"):
            best = max((self.dossier(p["key"], c) for c in ("occ", "neuf")), key=lambda d: (d["ready"], d["n_sold"]))
            out.append({**best, "label": p["label"], "origin": p["origin"]})
        out.sort(key=lambda d: (d["ready"], d["origin"] == "manuel", d["n_sold"]), reverse=True)
        return out[:limit]

    def deals_text(self):
        ds = self.recent_deals(2, 8)
        if not ds:
            return "Aucune pépite ces 2 derniers jours."
        return "💎 <b>Dernières pépites</b>\n" + "\n".join(
            f"• <a href=\"{esc(d['url'])}\">{esc(d['title'][:50])}</a> {eur(d['price'])} → +{eur(d['ev']['profit'])}" for d in ds)

    def state(self):
        s = self.s
        st = self.store
        now = int(self.clock())
        n_listings = st.q("SELECT COUNT(*) n FROM listings", one=True)["n"]
        n_sold = st.q("SELECT COUNT(*) n FROM listings WHERE state = 'sold'", one=True)["n"]
        n_priced = st.q("SELECT COUNT(*) n FROM market WHERE data != '' AND at > ?", (now - DAY,), one=True)["n"]
        n_deals = st.q("SELECT COUNT(*) n FROM deals WHERE at > ?", (now - DAY,), one=True)["n"]
        n_bought = st.q("SELECT COUNT(*) n FROM deals WHERE verdict = 'achete'", one=True)["n"]
        n_fp = st.q("SELECT COUNT(*) n FROM deals WHERE verdict = 'fp'", one=True)["n"]
        dossiers = self.dossiers(400)
        n_ready = sum(1 for d in dossiers if d["ready"])
        if self.problem:
            status, summary = ("bad" if "404" in self.problem else "warn"), self.problem
        elif not s["enabled"]:
            status, summary = "idle", "Arrêté (bouton Reprendre pour relancer)"
        elif not self.last_scan:
            status, summary = "idle", "Premier tour en cours (les recherches sont initialisées sans alerte)"
        else:
            status, summary = "ok", (f"{n_deals} pépite(s) en 24 h · {n_ready}/{len(dossiers)} dossiers mûrs"
                                     if n_ready else f"Apprentissage : {len(dossiers)} dossiers ouverts, aucun encore mûr "
                                     f"({self.s['min_sold']:g} ventes + {self.s['min_days']:g} j requis)")
        deals = self.recent_deals()
        return {
            "status": status, "summary": summary,
            "metrics": [
                {"label": "Pépites 24 h", "value": str(n_deals)},
                {"label": "Dossiers mûrs / ouverts", "value": f"{n_ready} / {len(dossiers)}"},
                {"label": "Achetées / faux positifs", "value": f"{n_bought} / {n_fp}"},
                {"label": "Annonces suivies", "value": str(n_listings)},
                {"label": "Ventes constatées", "value": str(n_sold)},
                {"label": "Pages annonce illisibles", "value": str(self.stats.get("unknown_pages", 0))},
                {"label": "Produits chiffrés (24 h)", "value": str(n_priced)},
                {"label": "Baisses de prix vues", "value": str(self.stats["drops"])},
                {"label": "Appels Vinted", "value": str(self.src.calls)},
                {"label": "Source", "value": self.src.last_status},
                {"label": "Dernier tour", "value": f"il y a {int(self.clock() - self.last_scan)} s" if self.last_scan else "—"},
            ],
            "tables": [
                {"title": "Pépites (7 jours)", "columns": ["Annonce", "Prix", "Revente", "Profit", "Marge", "Avis", "Id"], "highlight": 3,
                 "rows": [[d["title"][:70], eur(d["price"]), eur(d["ev"]["resale"]), eur(d["ev"]["profit"]), f"{d['ev']['margin']:.0f} %",
                           {"achete": "✅ acheté", "fp": "👎 faux"}.get(d["verdict"], ""), d["id"]] for d in deals],
                 "rowActions": [{"action": "achete", "label": "✅ Acheté", "args": {"id": "{6}"}},
                                {"action": "fp", "label": "👎 Faux positif", "args": {"id": "{6}"}}]},
                {"title": "Dossiers produits", "columns": ["Produit", "Clé", "Ventes", "Prix vendu", "Revente", "Suivi", "État"],
                 "highlight": 6,
                 "rows": [[d["label"][:50], d["key"][:60], str(d["n_sold"]), eur(d["median"]) if d["median"] else "—",
                           f"~{d['delay']:.0f} j" if d["delay"] is not None else "—", f"{d['days']:.0f} j",
                           "✅ prêt" if d["ready"] else "📚 apprend"] for d in dossiers[:40]],
                 "rowActions": [{"action": "oublier", "label": "Fermer", "args": {"key": "{1}"}, "danger": True,
                                 "confirm": "Fermer le dossier « {0} » ?"}]},
                {"title": "Recherches surveillées", "columns": ["N°", "Recherche", "Priorité", "Pépites"],
                 "rows": [[str(i + 1), q["q"] + ("" if q.get("seeded") else " (initialisation)"), q["prio"], str(q.get("found", 0))]
                          for i, q in enumerate(self.queries)],
                 "rowActions": [{"action": "retirer", "label": "🗑 Retirer", "args": {"n": "{0}"}, "danger": True,
                                 "confirm": "Ne plus surveiller « {1} » ?"}]},
            ],
            "actions": [
                {"id": "pepites", "label": "💎 Dernières pépites"},
                {"id": "scan", "label": "🔍 Scanner maintenant"},
                ({"id": "stop", "label": "⏹ Arrêter les scans", "danger": True, "confirm": "Arrêter les scans Vinted ?"} if s["enabled"]
                 else {"id": "resume", "label": "▶ Reprendre les scans"}),
                {"id": "watch", "label": "Ajouter une recherche", "args": [{"name": "q", "label": "Recherche", "placeholder": "zelda switch"},
                                                                           {"name": "prio", "label": "Priorité", "placeholder": "haute / moyenne / basse"}]},
                {"id": "suivre", "label": "Suivre un produit", "args": [{"name": "titre", "label": "Produit", "placeholder": "lego 42083 / berserk tome 1"}]},
                {"id": "produits", "label": "📂 Dossiers produits"},
                {"id": "oublier", "label": "Fermer", "hidden": True, "args": [{"name": "key", "label": "Clé"}]},
                {"id": "estimer", "label": "Estimer un produit", "args": [{"name": "titre", "label": "Titre", "placeholder": "lego 10305 / naruto tome 12"}]},
                {"id": "prio", "label": "Changer une priorité", "args": [{"name": "n", "label": "N°"}, {"name": "prio", "label": "haute / moyenne / basse"}]},
                {"id": "log", "label": "📜 Journal"},
                {"id": "retirer", "label": "Retirer", "hidden": True, "args": [{"name": "n", "label": "N°"}]},
                {"id": "achete", "label": "Acheté", "hidden": True, "args": [{"name": "id", "label": "Id"}]},
                {"id": "fp", "label": "Faux positif", "hidden": True, "args": [{"name": "id", "label": "Id"}]},
            ],
            "settings": [
                {"key": "min_sold", "label": "Ventes constatées avant alerte", "type": "number", "value": f"{s['min_sold']:g}",
                 "help": "Un produit n'est signalé qu'une fois ce nombre de ventes observé."},
                {"key": "min_days", "label": "Jours d'observation avant alerte", "type": "number", "value": f"{s['min_days']:g}"},
                {"key": "max_sell_days", "label": "Délai de revente max (jours)", "type": "number", "value": f"{s['max_sell_days']:g}"},
                {"key": "auto_track", "label": "Ouvrir un dossier pour chaque produit qui revient", "type": "bool",
                 "value": "1" if s["auto_track"] else "0"},
                {"key": "profit_min", "label": "Profit minimum (€)", "type": "number", "value": f"{s['profit_min']:g}"},
                {"key": "margin_min", "label": "Marge minimum (%)", "type": "number", "value": f"{s['margin_min']:g}"},
                {"key": "conf_min", "label": "Confiance minimum (0 à 1)", "type": "number", "value": f"{s['conf_min']:g}",
                 "help": "Monte-la si tu reçois trop d'alertes douteuses."},
                {"key": "discount", "label": "Décote de revente (%)", "type": "number", "value": f"{s['discount']:g}",
                 "help": "Retirée au prix de revente : négociation et vente rapide."},
                {"key": "ship_in", "label": "Port à l'achat (€)", "type": "number", "value": f"{s['ship_in']:g}"},
                {"key": "cheap_cap", "label": "Lego / Brio : prix max (€)", "type": "number", "value": f"{s['cheap_cap']:g}"},
                {"key": "max_price", "label": "Prix max d'une annonce (€)", "type": "number", "value": f"{s['max_price']:g}"},
                {"key": "gap", "label": "Écart entre appels Vinted (s)", "type": "number", "value": f"{s['gap']:g}",
                 "help": "Minimum 1,5 s. Plus bas = plus rapide mais plus de blocages."},
                {"key": "alerts", "label": "Alertes Telegram", "type": "bool", "value": "1" if s["alerts"] else "0"},
            ],
            "log": list(self.logbuf)[-40:],
            "telegram": [{"cmd": "pepites", "text": "dernières pépites Vinted"},
                         {"cmd": "suivre", "text": "ouvrir le dossier d'un produit"},
                         {"cmd": "produits", "text": "dossiers produits Vinted"},
                         {"cmd": "watch", "text": "surveiller une recherche Vinted"},
                         {"cmd": "estimer", "text": "prix de revente d'un produit"}],
        }

    # ------------------------------------------------------------------ boucle
    def run(self):
        threading.Thread(target=self.scan_loop, daemon=True).start()
        self.hub.message(f"🟢 <b>Vinted pépites</b> démarré en mode apprentissage · {len(self.queries)} recherches. "
                         f"Un produit n'est signalé qu'après {self.s['min_sold']:g} ventes constatées et "
                         f"{self.s['min_days']:g} jours de suivi. /produits pour voir les dossiers.", html=True)
        last_state = 0.0
        while not self.stop:
            if time.time() - last_state > STATE_EVERY:
                self.hub.flush(self.state())
                last_state = time.time()
            for c in self.hub.poll(wait=15):
                self.run_command(c)
                self.hub.flush(self.state())
                last_state = time.time()


def main():
    cfg = load_config()
    hub = Hub("vinted", "Vinted pépites", cfg, log=lambda m: print(m, flush=True))
    Bot(hub).run()


if __name__ == "__main__":
    main()
