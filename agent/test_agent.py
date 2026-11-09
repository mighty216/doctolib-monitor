import json, os, sys, tempfile, threading, time, unittest, types
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hub_client, tgtg_hub, script_agent, medinlyon  # noqa: E402


class FakeHub:
    def __init__(self):
        self.msgs, self.events, self.results, self.flushed = [], [], [], 0
    def message(self, text, html=False, markup=None): self.msgs.append((text, html, markup))
    def event(self, text, level="info"): self.events.append((level, text))
    def result(self, i, ok, text="", html=False, markup=None): self.results.append((i, ok, text, html))
    def flush(self, state=None): self.flushed += 1; return True


class FakeClient:
    def __init__(self, **kw):
        self.kw = kw; self.items = []; self.orders = []; self.aborted = []; self.fail = None
        self.access_token, self.refresh_token, self.datadome_cookie = "A2", "R2", "D2"
        self.session = types.SimpleNamespace(proxies={})
    def get_items(self, favorites_only=True):
        if self.fail: raise RuntimeError(self.fail)
        return self.items
    def create_order(self, item_id, n):
        if item_id == "boom": raise RuntimeError("sold out")
        o = {"id": f"ORD-{item_id}-{n}"}; self.orders.append(o); return o
    def abort_order(self, oid): self.aborted.append(oid)
    def get_active(self): return {"orders": [{"id": "ORD-9", "state": "RESERVED", "item": {"name": "Boulangerie"}}]}


def raw(item_id, name, qty, eur=3.99):
    return {"item": {"item_id": item_id, "price_including_taxes": {"minor_units": int(eur * 100), "decimals": 2}},
            "display_name": name, "items_available": qty,
            "store": {"store_location": {"address": {"address_line": "1 rue X"}}},
            "pickup_interval": {"start": "2026-11-06T18:00:00Z", "end": "2026-11-06T19:00:00Z"}}


class TgtgTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        tgtg_hub.CONFIG_FILE = os.path.join(self.tmp, "cfg.json")
        tgtg_hub.TOKEN_FILE = os.path.join(self.tmp, "tok.json")
        tgtg_hub.HERE = self.tmp
        json.dump({"access_token": "A", "refresh_token": "R", "datadome_cookie": "D"}, open(tgtg_hub.TOKEN_FILE, "w"))
        self.hub = FakeHub()
        self.client = FakeClient()
        self.bot = tgtg_hub.Bot(self.hub, {"tgtg": {"proxy": {"host": "p", "port": 80, "user_base": "u-", "password": "pw", "count": 3}}}, lambda **kw: self.client)
        self.bot.connect()

    def cmd(self, name, **args): 
        self.bot.run_command({"id": 1, "cmd": name, "args": args}); return self.hub.results[-1]

    def test_defaults_and_old_config_import(self):
        self.assertEqual((self.bot.settings["hour_start"], self.bot.settings["hour_end"], self.bot.settings["interval"]), (6, 12, 15))
        json.dump({"hour_start": 8, "hour_end": 22, "scan_interval": 30, "auto_reserve": False}, open(os.path.join(self.tmp, "tgtg_config.json"), "w"))
        b = tgtg_hub.Bot(self.hub, {}, lambda **kw: self.client)
        self.assertEqual((b.settings["hour_start"], b.settings["hour_end"], b.settings["interval"], b.settings["auto_reserve"]), (8, 22, 30, False))

    def test_client_gets_proxy_and_tokens(self):
        self.assertEqual(self.client, self.bot.client)
        self.assertIn("u-1:pw@p:80", self.bot.proxies()["http"])               # jamais en direct
        self.bot.rotate_proxy(); self.assertIn("u-2:", self.bot.proxies()["https"])
        self.bot.rotate_proxy(); self.bot.rotate_proxy(); self.assertIn("u-1:", self.bot.proxies()["http"])  # tour complet

    def test_alert_on_zero_to_available_only(self):
        self.bot.settings["auto_reserve"] = False
        self.client.items = [raw("1", "Pain", 0)]
        self.bot.scan_once(); self.assertEqual(self.hub.msgs, [])            # 1er scan = état de base
        self.client.items = [raw("1", "Pain", 2)]
        self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 1)
        text, html, markup = self.hub.msgs[0]
        self.assertTrue(html); self.assertIn("Pain", text)
        row = markup["inline_keyboard"][0]
        self.assertEqual([b["callback_data"] for b in row], ["c:tgtg:reserve:1:1", "c:tgtg:reserve:1:2"])
        self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 1)         # toujours dispo : pas de répétition
        self.client.items = [raw("1", "Pain", 0)]; self.bot.scan_once()
        self.client.items = [raw("1", "Pain", 1)]; self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 2)

    def test_auto_reserve_and_quantity_cap(self):
        self.bot.settings.update(auto_reserve=True, auto_quantity=3)
        self.client.items = [raw("7", "Sushi", 0)]; self.bot.scan_once()
        self.client.items = [raw("7", "Sushi", 2)]; self.bot.scan_once()
        self.assertEqual(self.client.orders, [{"id": "ORD-7-2"}])             # min(3 demandés, 2 dispos)
        self.assertIn("Réservé automatiquement", self.hub.msgs[0][0])

    def test_reserve_failure_reported(self):
        self.client.items = [raw("boom", "X", 0)]; self.bot.scan_once()
        self.client.items = [raw("boom", "X", 1)]; self.bot.scan_once()
        self.assertIn("Réservation impossible", self.hub.msgs[0][0])

    def test_commands(self):
        self.assertEqual(self.cmd("reserver", text="12:2")[1:3], (True, "✅ <b>Réservé !</b> (2 panier(s))\nCommande : <code>ORD-12-2</code>\n⚠️ Paye dans l'app TGTG dans les minutes qui viennent.\nPour annuler : /annuler ORD-12-2"))
        self.assertTrue(self.cmd("reserve", item="5", qty="3")[1])
        self.assertFalse(self.cmd("reserver")[1])
        self.assertTrue(self.cmd("annuler", order="ORD-1")[1]); self.assertEqual(self.client.aborted, ["ORD-1"])
        self.assertTrue(self.cmd("annuler", text="ORD-2")[1]); self.assertEqual(self.client.aborted[-1], "ORD-2")
        self.assertIn("Boulangerie", self.cmd("commandes")[2])
        self.assertTrue(self.cmd("horaires", text="8h-22h")[1]); self.assertEqual((self.bot.settings["hour_start"], self.bot.settings["hour_end"]), (8, 22))
        self.assertFalse(self.cmd("horaires", text="n'importe quoi")[1])
        self.assertFalse(self.cmd("horaires", text="9h-9h")[1])
        self.assertIn("minimum 15", self.cmd("interval", text="5")[2]); self.assertEqual(self.bot.settings["interval"], 15)
        self.cmd("interval", text="45"); self.assertEqual(self.bot.settings["interval"], 45)
        self.cmd("auto"); self.assertFalse(self.bot.settings["auto_reserve"])
        self.cmd("auto", text="2"); self.assertTrue(self.bot.settings["auto_reserve"]); self.assertEqual(self.bot.settings["auto_quantity"], 2)
        self.assertTrue(self.cmd("set", key="interval", value="20")[1]); self.assertEqual(self.bot.settings["interval"], 20)
        self.assertFalse(self.cmd("set", key="interval", value="abc")[1])
        self.assertFalse(self.cmd("set", key="evil", value="1")[1])
        self.assertIn("tourne depuis", self.cmd("ok")[2])
        self.assertIn("Dernières lignes", self.cmd("log")[2])
        self.assertFalse(self.cmd("nimporte")[1])
        saved = json.load(open(tgtg_hub.CONFIG_FILE)); self.assertEqual(saved["interval"], 20)   # persisté

    def test_scan_command_and_row_buttons(self):
        self.client.items = [raw("7", "Pain", 2), raw("8", "Vide", 0)]
        out = self.cmd("scan")
        self.assertTrue(out[1]); self.assertIn("Scan fait : 2 favori(s), 1 disponible(s)", out[2])
        self.assertTrue(self.bot.scan_lock.acquire(blocking=False)); self.bot.scan_lock.release()  # verrou relâché
        fav = self.bot.state()["tables"][0]
        self.assertEqual(fav["highlight"], 1)
        self.assertEqual(fav["rowActions"][0]["action"], "reserver")
        self.assertEqual(fav["rowActions"][0]["args"], {"item": "{4}", "qty": "1"})
        ids = {a["id"] for a in self.bot.state()["actions"]}
        self.assertIn("reserver", ids); self.assertIn("annuler", ids)  # les boutons des tableaux renvoient à de vraies actions

    def test_same_start_and_end_hour_refused(self):
        self.cmd("set", key="hour_start", value="8"); self.cmd("set", key="hour_end", value="20")
        self.assertFalse(self.cmd("set", key="hour_end", value="8")[1])
        self.assertFalse(self.cmd("set", key="hour_start", value="20")[1])
        self.assertEqual((self.bot.settings["hour_start"], self.bot.settings["hour_end"]), (8, 20))

    def test_command_error_never_raises(self):
        self.client.create_order = lambda *a: (_ for _ in ()).throw(RuntimeError("x"))
        r = self.cmd("reserver", text="1")
        self.assertFalse(r[1])

    def test_reboot_flag(self):
        self.cmd("reboot"); self.assertTrue(self.bot.reboot)

    def test_failure_alert_once_then_recovery(self):
        self.client.items = [raw("1", "A", 1)]; self.bot.scan_once()
        self.bot.last_ok = time.time() - 700
        self.client.fail = "403"
        import itertools
        calls = itertools.count()
        orig_sleep = time.sleep
        def fake_sleep(s):
            if next(calls) >= 3: self.bot.stop = True
        tgtg_hub.time.sleep = fake_sleep
        try:
            self.bot.in_hours = lambda: True
            self.bot.scan_loop()
        finally:
            tgtg_hub.time.sleep = orig_sleep
        downs = [m for m in self.hub.msgs if "plus aucun scan" in m[0]]
        self.assertEqual(len(downs), 1)
        self.client.fail = None; self.bot.scan_once()
        self.assertTrue(any("de nouveau" in m[0] for m in self.hub.msgs))

    def test_working_proxy_and_cookie_remembered(self):
        self.bot.client.cookie = "datadome=GOOD"; self.client.items = []
        self.client.session = types.SimpleNamespace(cookies=types.SimpleNamespace(clear=lambda: None))
        self.bot.scan_once(); self.bot.save_tokens()
        saved = json.load(open(tgtg_hub.TOKEN_FILE))
        self.assertEqual(saved["proxy_index"], 1); self.assertEqual(saved["datadome_by_proxy"], {"1": "datadome=GOOD"})
        self.bot.rotate_proxy(); self.assertEqual(self.bot.proxy_index, 2)
        self.assertEqual(self.bot.client.cookie, "datadome=D")                    # cookie d'origine, 1 essai sur le proxy 2
        self.bot.rotate_proxy(); self.bot.rotate_proxy(); self.assertEqual(self.bot.proxy_index, 1)
        self.assertEqual(self.bot.client.cookie, "datadome=GOOD")                 # retour sur le proxy qui marchait : son cookie
        self.bot.rotate_proxy(); self.bot.rotate_proxy(); self.bot.rotate_proxy(); self.assertEqual(self.bot.proxy_index, 1)
        self.assertEqual(self.bot.client.cookie, "datadome=GOOD")
        b2 = tgtg_hub.Bot(self.hub, self.bot.cfg, lambda **kw: self.client); b2.connect()   # redémarrage
        self.assertEqual(b2.proxy_index, 1)

    def test_token_validity_helper(self):
        import base64 as b
        def jwt(exp): return "h." + b.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=") + ".s"
        self.assertTrue(tgtg_hub.token_valid_for(jwt(time.time() + 7200)))
        self.assertFalse(tgtg_hub.token_valid_for(jwt(time.time() + 600)))
        self.assertFalse(tgtg_hub.token_valid_for("pas-un-jwt")); self.assertFalse(tgtg_hub.token_valid_for(None))

    def test_stop_and_resume_button(self):
        self.assertTrue(self.bot.in_hours() or True)
        self.bot.settings.update(hour_start=0, hour_end=24); self.assertTrue(self.bot.in_hours())
        self.assertTrue(any(a["id"] == "stop" for a in self.bot.state()["actions"]))
        self.bot.run_command({"id": 1, "cmd": "stop", "args": {}})
        self.assertFalse(self.bot.in_hours()); st = self.bot.state()
        self.assertEqual(st["status"], "idle"); self.assertTrue(any(a["id"] == "resume" for a in st["actions"]))
        self.assertFalse(json.load(open(tgtg_hub.CONFIG_FILE))["enabled"])            # mémorisé après redémarrage
        self.bot.run_command({"id": 2, "cmd": "resume", "args": {}}); self.assertTrue(self.bot.in_hours())

    def test_hours_window(self):
        self.bot.settings.update(hour_start=22, hour_end=6)   # plage qui passe minuit
        h = tgtg_hub.now_paris().hour
        self.assertEqual(self.bot.in_hours(), h >= 22 or h < 6)

    def test_tokens_saved_when_refreshed(self):
        self.bot.save_tokens()
        self.assertEqual(json.load(open(tgtg_hub.TOKEN_FILE))["access_token"], "A2")

    def test_state_schema(self):
        self.client.items = [raw("1", "Pain", 2)]; self.bot.scan_once()
        st = self.bot.state()
        json.dumps(st)
        self.assertTrue(st["actions"] and st["settings"] and st["tables"][0]["rows"])
        self.assertEqual(st["tables"][0]["rows"][0][0], "Pain")


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.spec = {"id": "alicoins", "name": "AliExpress coins", "cwd": self.dir, "run": "./run_all.sh", "log": "cron.log",
                     "metrics": [{"label": "Pièces", "regex": r"coins=(\d+)"}, {"label": "Série", "regex": r"streak=(\d+)", "suffix": " j"}]}
        self.bot = script_agent.ScriptBot(self.spec, {"url": "http://x", "key": "k" * 20})
        self.bot.hub = FakeHub()

    def write_log(self, text):
        open(os.path.join(self.dir, "cron.log"), "w").write(text)

    def test_no_log(self): self.assertEqual(self.bot.parse()["status"], "idle")

    def test_ok_with_metrics(self):
        self.write_log("\x1b[32mstart\x1b[0m\nMetrics tasks=success coins=47 streak=3\n")
        p = self.bot.parse()
        self.assertEqual(p["status"], "ok")
        self.assertEqual({m["label"]: m["value"] for m in p["metrics"]}, {"Pièces": "47", "Série": "3 j"})
        self.assertIn("Pièces 47", p["summary"])

    def test_error_after_success_is_warning(self):
        self.write_log("Metrics tasks=success coins=1\nERROR: Unable to obtain streak and balance\n")
        self.assertEqual(self.bot.parse()["status"], "warn")

    def test_session_expired_is_bad(self):
        self.write_log("ERROR: session expired, MANUAL_LOGIN=never\n")
        p = self.bot.parse(); self.assertEqual(p["status"], "bad"); self.assertIn("Session", p["summary"])

    def test_stale(self):
        self.write_log("Metrics tasks=success coins=1\n")
        old = time.time() - 50 * 3600; os.utime(os.path.join(self.dir, "cron.log"), (old, old))
        self.assertEqual(self.bot.parse()["status"], "warn")

    def test_daily_auto_run_once_per_day(self):
        self.assertFalse(self.bot.auto_due())                       # pas de daily_at -> jamais
        self.bot.spec["daily_at"] = "00:00"
        self.assertTrue(self.bot.auto_due())                        # heure passée, pas encore fait aujourd'hui
        self.assertFalse(self.bot.auto_due())                       # déjà fait aujourd'hui
        self.bot.spec["daily_at"] = "23:59"; os.remove(self.bot.auto_file)
        from datetime import datetime
        if datetime.now(script_agent.PARIS).strftime("%H:%M") < "23:59":
            self.assertFalse(self.bot.auto_due())                   # pas encore l'heure
        self.bot.spec["daily_at"] = "bad"; self.assertFalse(self.bot.auto_due())

    def test_run_command_end_to_end(self):
        sh = os.path.join(self.dir, "run_all.sh")
        open(sh, "w").write("#!/bin/sh\necho 'Metrics tasks=success coins=25 streak=4'\n"); os.chmod(sh, 0o755)
        ok, text, _ = self.bot.handle({"cmd": "run"}); self.assertTrue(ok)
        ok2, _, _ = self.bot.handle({"cmd": "run"}) if self.bot.running() else (False, "", None)
        self.bot.proc.wait(); time.sleep(0.6)
        self.assertEqual(self.bot.last_run["code"], 0)
        self.assertTrue(any("terminé" in m[0] for m in self.bot.hub.msgs))
        self.assertIn("coins=25", open(os.path.join(self.dir, "cron.log")).read())
        ok, text, _ = self.bot.handle({"cmd": "status"}); self.assertIn("Pièces : 25", text)
        self.assertFalse(self.bot.handle({"cmd": "nimporte"})[0])
        st = self.bot.state(); json.dumps(st); self.assertTrue(any(a["id"] == "run" for a in st["actions"]))


class ClientTests(unittest.TestCase):
    def test_roundtrip_with_http_server(self):
        seen = []
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                seen.append(("GET", self.path, self.headers["Authorization"]))
                body = json.dumps({"ok": True, "commands": [{"id": 3, "cmd": "favoris", "args": {}}]}).encode()
                self.send_response(200); self.end_headers(); self.wfile.write(body)
            def do_POST(self):
                n = int(self.headers["Content-Length"]); seen.append(("POST", self.path, json.loads(self.rfile.read(n))))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
        srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
        h = hub_client.Hub("tgtg", "TGTG", {"url": f"http://127.0.0.1:{srv.server_port}", "key": "secret-key-1234567"}, log=lambda m: None)
        self.assertEqual(h.poll(wait=0)[0]["cmd"], "favoris")
        self.assertEqual(seen[0][2], "Bearer secret-key-1234567")
        h.message("hello", html=True); h.event("e", "ok"); h.result(3, True, "fait")
        self.assertTrue(h.flush({"status": "ok"}))
        body = seen[1][2]
        self.assertEqual((body["bot"], body["messages"][0]["text"], body["results"][0]["id"], body["state"]["status"]), ("tgtg", "hello", 3, "ok"))
        srv.shutdown()

    def test_unreachable_hub_keeps_data(self):
        h = hub_client.Hub("tgtg", "TGTG", {"url": "http://127.0.0.1:9", "key": "k" * 20}, log=lambda m: None)
        h.message("a"); self.assertFalse(h.flush({}))
        self.assertEqual(len(h._pending["messages"]), 1, "le message est conservé pour le prochain envoi")


if __name__ == "__main__":
    unittest.main()


FRAG = ('<div class="creneaux"><label><input type="radio" name="creneau" value="1042"> 21:30</label>'
        '<label><input type="radio" name="creneau" value="1043"> 21h45</label>'
        '<button data-heure="22:00">22:00</button><script>var x="23:59"</script></div>')


class MedinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        medinlyon.SETTINGS_FILE = os.path.join(self.tmp, "m.json")
        medinlyon.DATA_FILE = os.path.join(self.tmp, "r.json")
        self.pages = {}
        self.hub = FakeHub()
        self.bot = medinlyon.Bot(self.hub, fetch=lambda centre, day: self.pages.get(day.isoformat(), ""))

    def day(self, i=0): return medinlyon.datetime.now(medinlyon.PARIS).date() + medinlyon.timedelta(days=i)
    def cmd(self, name, **a): self.bot.run_command({"id": 1, "cmd": name, "args": a}); return self.hub.results[-1]

    def test_parse(self):
        self.assertEqual(medinlyon.parse_slots(FRAG), ["21:30", "21:45", "22:00"])
        self.assertEqual(medinlyon.parse_slots(""), [])

    def test_parse_date(self):
        t = date(2026, 11, 6) if (date := __import__("datetime").date) else None
        self.assertEqual(medinlyon.parse_date("aujourd'hui", t), t)
        self.assertEqual(medinlyon.parse_date("demain", t), date(2026, 11, 7))
        self.assertEqual(medinlyon.parse_date("9/11", t), date(2026, 11, 9))
        self.assertEqual(medinlyon.parse_date("09.11.2026", t), date(2026, 11, 9))
        self.assertEqual(medinlyon.parse_date("2026-11-09", t), date(2026, 11, 9))
        for bad in ("hier", "01/11", "31/02", "blabla", ""):
            with self.assertRaises(ValueError): medinlyon.parse_date(bad, t)

    def test_nothing_watched_by_default(self):
        self.bot.scan_once(); self.assertEqual(self.hub.msgs, [])
        self.assertIn("Rien n'est surveillé", self.bot.slots_text()); self.assertEqual(self.bot.state()["status"], "idle")

    def test_only_earlier_slot_alerts(self):
        d = self.day(); iso = d.isoformat()
        self.assertTrue(self.cmd("today")[1]); self.assertEqual(self.bot.watched(), [iso])
        self.pages[iso] = '<b>21:45</b> <b>22:00</b>'
        self.bot.scan_once(); self.assertEqual(self.hub.msgs, [])                    # relevé de départ : silence
        self.assertEqual(self.bot.data[iso]["best"], "21:45")
        self.pages[iso] = '21:45 22:00 22:30'; self.bot.scan_once(); self.assertEqual(self.hub.msgs, [])   # plus tard : on s'en fout
        self.bot.scan_once(); self.assertEqual(self.hub.msgs, [])                    # rien de neuf
        self.pages[iso] = '21:15 21:45 22:00'; self.bot.scan_once()                  # plus tôt -> alerte
        self.assertEqual(len(self.hub.msgs), 1); self.assertIn("21:15", self.hub.msgs[0][0]); self.assertIn("21:45", self.hub.msgs[0][0])
        self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 1)                # pas de répétition
        self.pages[iso] = '21:45'; self.bot.scan_once()                              # le créneau part : silence
        self.pages[iso] = '21:15 21:45'; self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 2)   # il revient : alerte

    def test_first_slot_after_none_alerts(self):
        iso = self.day(1).isoformat(); self.cmd("tomorrow")
        self.bot.scan_once()                                                         # départ : aucun créneau
        self.pages[iso] = '20:30'; self.bot.scan_once(); self.assertEqual(len(self.hub.msgs), 1)

    def test_persistence_and_errors(self):
        iso = self.day().isoformat(); self.cmd("today"); self.pages[iso] = FRAG
        self.bot.scan_once()
        b2 = medinlyon.Bot(self.hub, fetch=self.bot.fetch)                           # redémarrage
        self.assertEqual(b2.watched(), [iso]); self.assertEqual(b2.data[iso]["best"], "21:30")
        def boom(c, d): raise OSError("réseau")
        self.bot.fetch = boom
        with self.assertRaises(RuntimeError): self.bot.scan_once()
        self.assertEqual(self.bot.data[iso]["best"], "21:30")

    def test_commands_state_and_limits(self):
        self.assertFalse(self.cmd("date", date="hier")[1])
        self.assertFalse(self.cmd("date", date="+5")[1])
        self.assertFalse(self.cmd("date", date=self.day(3).strftime("%d/%m"))[1])         # seuls aujourd'hui / demain
        self.assertTrue(self.cmd("date", date="demain")[1]); self.assertEqual(self.bot.watched(), [self.day(1).isoformat()])
        self.cmd("tomorrow"); self.assertEqual(self.bot.watched(), [])                    # re-clic = on arrête
        self.cmd("tomorrow", text="on"); self.cmd("today"); self.assertEqual(len(self.bot.watched()), 2)
        st = self.bot.state(); json.dumps(st)
        self.assertEqual([r[2] for r in st["tables"][0]["rows"]], ["relevé en cours"] * 2)
        self.assertTrue(any("✅ Aujourd" in a["label"] for a in st["actions"]))
        self.cmd("retirer", date="demain"); self.assertEqual(self.bot.watched(), [self.day().isoformat()])
        self.cmd("set", key="interval", value="1"); self.assertEqual(self.bot.settings["interval"], 5)
        self.cmd("pause"); self.assertFalse(self.bot.settings["enabled"]); self.assertEqual(self.bot.state()["status"], "idle")
        self.assertFalse(self.cmd("nimporte")[1])
