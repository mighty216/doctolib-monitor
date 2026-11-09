import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vinted_core as core  # noqa: E402
import vinted_hub  # noqa: E402
from vinted_source import SourceError, parse_item  # noqa: E402

SETTINGS = {"profit_min": 8, "margin_min": 40, "conf_min": 0.45, "discount": 10, "ship_in": 3.5}


class FakeHub:
    cfg = {}
    def __init__(self): self.msgs, self.events, self.results = [], [], []
    def message(self, text, html=False, markup=None): self.msgs.append((text, html, markup))
    def event(self, text, level="info"): self.events.append((level, text))
    def result(self, i, ok, text="", html=False, markup=None): self.results.append((i, ok, text))
    def flush(self, state=None): return True


def item(iid, title, price, status="Très bon état", seller="s1", ts=0, pro=False, fav=0):
    return {"id": str(iid), "title": title, "price": float(price), "total": 0.0, "status": status, "fav": fav,
            "seller": seller, "pro": pro, "url": f"https://www.vinted.fr/items/{iid}", "photo": "", "ts": ts, "brand": ""}


class FakeSource:
    """Simule Vinted : résultats par requête, état des annonces, erreurs."""
    def __init__(self):
        self.results, self.states, self.calls, self.fail = {}, {}, [], None
        self.last_status, self.min_gap = "OK", 3
    def search(self, text, order="newest_first", per_page=96, price_from=None, price_to=None):
        self.calls.append((text, order))
        if self.fail: raise self.fail
        return list(self.results.get((text, order), self.results.get(text, [])))
    def item_state(self, iid):
        return self.states.get(iid, "online")
    @property
    def calls_n(self): return len(self.calls)


class CoreTests(unittest.TestCase):
    def test_keys(self):
        k = core.product_key
        self.assertEqual(k("LEGO Technic 42083 Bugatti Chiron NEUF"), "lego:42083")
        self.assertEqual(k("Lego star wars 75192 de 2017"), "lego:75192")   # l'année n'est pas un n° de set
        self.assertIsNone(k("lego technic en vrac"))                           # pas de n° = pas de prix
        self.assertEqual(k("Naruto Tome 58"), "livre:naruto:58:std")
        self.assertEqual(k("One Piece T.12 édition originale"), "livre:one_piece:12:var")  # l'EO ne se mélange pas
        self.assertIsNone(k("Berserk tomes 1 à 5"))                            # un lot
        self.assertIsNone(k("Zelda boîte vide switch"))                        # pas le produit
        self.assertIsNone(k("jeux switch"))                                    # trop vague
        self.assertNotEqual(k("Final Fantasy 7 PS1"), k("Final Fantasy 9 PS1"))
        self.assertNotEqual(k("Pokemon Rouge Game Boy"), k("Pokemon Rouge 3DS"))
        self.assertTrue(core.same_product(k("Mario Kart 8 Deluxe - Nintendo Switch"), k("mario kart 8 deluxe switch très bon état")))
        self.assertFalse(core.same_product(k("Mario Kart 8 Deluxe switch"), k("Mario Kart 8 Deluxe switch collector")))

    def test_search_text_is_short(self):
        self.assertEqual(core.search_text("lego:42083"), "lego 42083")
        self.assertEqual(core.search_text("livre:one_piece:12:std"), "one piece tome 12")
        self.assertLessEqual(len(core.search_text(core.product_key("Mario Kart 8 Deluxe Nintendo Switch")).split()), 6)

    def test_market_prefers_sold_then_low_quartile_never_invents(self):
        self.assertIsNone(core.market_price([20, 25], []))
        m = core.market_price([20, 22, 30, 40, 45, 400], [])
        self.assertEqual(m["basis"], "en ligne (1er quartile)")
        self.assertLess(m["price"], 30)  # pas la médiane des prix demandés
        m = core.market_price([60, 70, 80, 90], [30, 32, 35])
        self.assertEqual((m["basis"], m["price"]), ("vendus", 32))

    def test_real_fees(self):
        self.assertEqual(core.buyer_cost(10, 3.5), 14.7)            # 10 + 0,70 + 0,50 + 3,50
        self.assertEqual(core.buyer_cost(10, 3.5, 11.2), 14.7)      # total Vinted déjà connu
        m = {"price": 40, "basis": "vendus", "n_sold": 5, "n_active": 10, "spread": 0.2, "low": 30, "high": 50}
        ev = core.evaluate(10, m, SETTINGS)
        self.assertTrue(ev["ok"])
        self.assertAlmostEqual(ev["profit"], 40 * 0.9 - 14.7, places=2)  # aucun frais vendeur sur Vinted
        ev = core.evaluate(25, m, SETTINGS)
        self.assertFalse(ev["ok"])
        self.assertIn("profit", ev["why"])
        self.assertTrue(core.evaluate(5, m, SETTINGS)["suspect"])
        self.assertFalse(core.evaluate(10, m, SETTINGS)["suspect"])

    def test_parse_item(self):
        it = parse_item({"id": 7, "title": " Lego 42083 ", "price": {"amount": "12.5"}, "total_item_price": {"amount": "13.83"},
                         "user": {"id": 9, "business": True}, "photo": {"high_resolution": {"timestamp": 1700000000}},
                         "status": "Neuf avec étiquette", "favourite_count": 4})
        self.assertEqual((it["id"], it["title"], it["price"], it["total"], it["seller"], it["pro"], it["ts"]),
                         ("7", "Lego 42083", 12.5, 13.83, "9", True, 1700000000))


class BotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.now = 1_800_000_000
        self.hub, self.src = FakeHub(), FakeSource()
        self.bot = vinted_hub.Bot(self.hub, source=self.src, store=vinted_hub.Store(os.path.join(self.tmp, "v.db")),
                                  config_file=os.path.join(self.tmp, "c.json"), clock=lambda: self.now)
        self.bot.queries = [{"q": "jeu switch", "prio": "haute", "seeded": False, "found": 0}]
        # marché : Mario Kart 8 Deluxe d'occasion autour de 35-45 €
        comps = [item(100 + i, "Mario Kart 8 Deluxe switch", p, seller=f"c{i}") for i, p in enumerate([35, 38, 40, 42, 45, 48])]
        self.src.results["8 deluxe kart mario switch"] = comps

    def tearDown(self):
        self.bot.store.db.close()

    def mature(self, title, prices, cond="occ", days=30, delay=5):
        """Simule un dossier mûr : produit suivi depuis `days` jours, ventes constatées aux prix donnés."""
        key = core.product_key(title)
        st = self.bot.store
        st.x("INSERT OR REPLACE INTO products (key, label, origin, added_at, last_refresh) VALUES (?, ?, 'auto', ?, ?)",
             (key, title, self.now - days * 86400, self.now))
        for i, p in enumerate(prices):
            st.x("""INSERT INTO listings (id, key, cond, title, price, seller, url, ts, first_seen, last_seen, state, sold_at, sold_price)
                    VALUES (?, ?, ?, ?, ?, 'old', '', 0, ?, ?, 'sold', ?, ?)""",
                 (f"sold{key}{i}", key, cond, title, p, self.now - (delay + 2) * 86400, self.now - 3 * 86400,
                  self.now - 2 * 86400, p))
        return key

    def cmd(self, name, **args):
        self.bot.run_command({"id": 1, "cmd": name, "args": args})
        return self.hub.results[-1]

    def test_first_scan_seeds_without_alert_then_alerts_new_deal(self):
        self.mature("Mario Kart 8 Deluxe switch", [36, 38, 40, 41, 42])
        self.src.results["jeu switch"] = [item(1, "Mario Kart 8 Deluxe switch", 9)]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])  # initialisation : rien n'est signalé
        self.src.results["jeu switch"] = [item(2, "Mario Kart 8 Deluxe Nintendo Switch", 9), item(1, "Mario Kart 8 Deluxe switch", 9)]
        self.bot.scan_round()
        self.assertEqual(len(self.hub.msgs), 1)
        text, is_html, markup = self.hub.msgs[0]
        self.assertTrue(is_html)
        self.assertIn("Profit", text)
        self.assertIn("5 ventes constatées", text)
        self.assertEqual(markup["inline_keyboard"][1][0]["callback_data"], "c:vinted:achete:2")
        self.assertEqual(markup["inline_keyboard"][0][0]["url"], "https://www.vinted.fr/items/2")
        # une seule recherche de comparables, en cache ensuite
        self.bot.analyse(item(3, "Mario Kart 8 Deluxe switch", 9, seller="z"), "jeu switch")
        self.assertEqual(sum(1 for c in self.src.calls if c[1] == "relevance"), 1)

    def test_no_alert_when_not_cheap_pro_or_unidentified(self):
        self.bot.queries[0]["seeded"] = True
        self.src.results["jeu switch"] = [item(5, "Mario Kart 8 Deluxe switch", 30), item(6, "Mario Kart 8 Deluxe switch", 9, pro=True),
                                          item(7, "lot jeux switch", 9)]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])

    def test_price_drop_is_reanalysed(self):
        self.mature("Mario Kart 8 Deluxe switch", [36, 38, 40, 41, 42])
        self.bot.queries[0]["seeded"] = True
        self.src.results["jeu switch"] = [item(8, "Mario Kart 8 Deluxe switch", 30)]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])
        self.src.results["jeu switch"] = [item(8, "Mario Kart 8 Deluxe switch", 12)]
        self.bot.scan_round()
        self.assertEqual(len(self.hub.msgs), 1)
        self.assertIn("baissé", self.hub.msgs[0][0])

    def test_old_bumped_listing_ignored(self):
        self.bot.queries[0]["seeded"] = True
        self.src.results["jeu switch"] = [item(9, "Mario Kart 8 Deluxe switch", 9, ts=self.now - 10 * 86400)]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])

    def test_learning_mode_stays_silent_until_dossier_is_mature(self):
        self.bot.queries[0]["seeded"] = True
        key = core.product_key("Mario Kart 8 Deluxe switch")
        for i in range(3):  # le produit revient 3 fois : un dossier s'ouvre tout seul
            self.src.results["jeu switch"] = [item(300 + i, "Mario Kart 8 Deluxe switch", 9, seller=f"m{i}")]
            self.bot.scan_round()
        self.assertTrue(self.bot.dossier(key, "occ")["tracked"])
        self.assertEqual(self.hub.msgs, [])  # aucune vente constatée : silence, même à 9 €
        self.mature("Mario Kart 8 Deluxe switch", [36, 38, 40, 41, 42], days=10)
        self.src.results["jeu switch"] = [item(310, "Mario Kart 8 Deluxe switch", 9, seller="n")]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])  # 5 ventes mais seulement 10 jours de suivi : toujours silence
        self.mature("Mario Kart 8 Deluxe switch", [], days=25)
        self.src.results["jeu switch"] = [item(311, "Mario Kart 8 Deluxe switch", 9, seller="o")]
        self.bot.scan_round()
        self.assertEqual(len(self.hub.msgs), 1)

    def test_slow_sellers_and_single_titles_ignored(self):
        self.mature("Mario Kart 8 Deluxe switch", [36, 38, 40, 41, 42], delay=60)  # se revend en 2 mois
        self.bot.queries[0]["seeded"] = True
        self.src.results["jeu switch"] = [item(320, "Mario Kart 8 Deluxe switch", 9)]
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])
        self.src.results["jeu switch"] = [item(321, "Zelda Echoes of Wisdom switch", 9)]
        self.bot.scan_round()
        self.assertFalse(self.bot.dossier(core.product_key("Zelda Echoes of Wisdom switch"), "occ")["tracked"])

    def test_sold_tracking_feeds_market(self):
        key = core.product_key("Mario Kart 8 Deluxe switch")
        self.bot.market(key, "occ")  # enregistre les comparables
        self.now += 2 * 86400        # ils ne sont plus revus dans les recherches
        for i in range(3):
            self.src.states[str(100 + i)] = "sold"
        self.bot.check_sold(limit=10)
        sold = self.bot.store.sold_prices(key, "occ", self.now - 86400 * 90)
        self.assertEqual(sorted(sold), [35, 38, 40])
        self.now += 7 * 3600  # cache expiré
        m = self.bot.market(key, "occ")
        self.assertEqual((m["basis"], m["price"]), ("vendus", 38))

    def test_false_positive_twice_excludes_product(self):
        self.mature("Mario Kart 8 Deluxe switch", [36, 38, 40, 41, 42])
        self.bot.queries[0]["seeded"] = True
        for iid in (11, 12):
            self.src.results["jeu switch"] = [item(iid, "Mario Kart 8 Deluxe switch", 9, seller=f"x{iid}")]
            self.bot.scan_round()
            self.cmd("fp", text=str(iid))
        self.src.results["jeu switch"] = [item(13, "Mario Kart 8 Deluxe switch", 9, seller="x13")]
        self.bot.scan_round()
        self.assertEqual(len(self.hub.msgs), 2)
        self.assertTrue(self.hub.results[-1][1])

    def test_commands(self):
        self.assertTrue(self.cmd("watch", text="zelda switch haute")[1])
        self.assertEqual(self.bot.queries[-1], {"q": "zelda switch", "prio": "haute", "seeded": False, "found": 0})
        self.assertFalse(self.cmd("watch", q="zelda switch")[1])
        self.assertTrue(self.cmd("prio", n="2", prio="basse")[1])
        self.assertTrue(self.cmd("retirer", n="2")[1])
        self.assertFalse(self.cmd("retirer", n="9")[1])
        self.assertTrue(self.cmd("set", key="profit_min", value="12,5")[1])
        self.assertEqual(self.bot.s["profit_min"], 12.5)
        self.assertFalse(self.cmd("set", key="gap", value="0.5")[1])
        self.assertTrue(self.cmd("estimer", titre="mario kart 8 deluxe switch")[1])
        self.assertTrue(self.cmd("suivre", titre="Lego 10305")[1])
        self.assertTrue(self.bot.dossier("lego:10305", "occ")["tracked"])
        self.assertTrue(self.cmd("produits")[1])
        self.assertTrue(self.cmd("oublier", key="lego:10305")[1])
        self.assertFalse(self.bot.dossier("lego:10305", "occ")["tracked"])
        self.assertFalse(self.cmd("estimer", titre="un truc")[1])
        self.assertTrue(self.cmd("stop")[1])
        self.assertFalse(self.bot.s["enabled"])
        with open(os.path.join(self.tmp, "c.json"), encoding="utf8") as f:
            saved = json.load(f)
        self.assertEqual(saved["settings"]["profit_min"], 12.5)

    def test_state_shape_and_source_problem(self):
        st = self.bot.state()
        for k in ("status", "summary", "metrics", "tables", "actions", "settings", "log", "telegram"):
            self.assertIn(k, st)
        self.src.fail = SourceError(404)
        self.bot.backoff = 0
        try:
            self.bot.scan_round()
        except SourceError as e:
            self.bot.problem = "Vinted refuse l'API catalogue (404)" if e.code == 404 else ""
        self.assertEqual(self.bot.state()["status"], "bad")

    def test_lego_cap(self):
        self.bot.queries = [{"q": "lego", "prio": "haute", "seeded": True, "found": 0}]
        self.src.results["lego 42083"] = [item(200 + i, "Lego 42083", p, seller=f"l{i}") for i, p in enumerate([40, 45, 50, 52, 55, 58, 60, 65, 70, 75])]
        self.mature("Lego 42083", [55, 60, 62, 65, 70])
        self.src.results["lego"] = [item(21, "LEGO technic 42083", 8)]  # au-dessus du plafond de 7 €
        self.bot.scan_round()
        self.assertEqual(self.hub.msgs, [])
        self.src.results["lego"] = [item(22, "LEGO technic 42083", 6)]
        self.bot.scan_round()
        self.assertEqual(len(self.hub.msgs), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
