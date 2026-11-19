"""Tests de l'agent AirPods (sans carte son : sounddevice simulé)."""
import os, sys, tempfile, time, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import airpods_hub  # noqa: E402

try:
    import numpy  # noqa: F401
    HAS_NP = True
except ImportError:
    HAS_NP = False


class FakeHub:
    def __init__(self): self.events, self.results, self.flushed = [], [], 0
    def event(self, text, level="info"): self.events.append((level, text))
    def result(self, i, ok, text="", html=False, markup=None): self.results.append((i, ok, text))
    def flush(self, state=None): self.flushed += 1; return True
    def message(self, *a, **k): pass


def fake_sd(devices, default=0, fail_open=False):
    sd = types.SimpleNamespace()
    sd.query_devices = lambda i=None: devices if i is None else devices[i]
    sd.query_hostapis = lambda: [{"name": "MME"}, {"name": "Windows WASAPI"}]
    sd.default = types.SimpleNamespace(device=[None, default])
    sd._terminate = sd._initialize = lambda: None
    sd.opened = []

    class Stream:
        def __init__(self, **kw):
            if fail_open: raise RuntimeError("Invalid sample rate")
            sd.opened.append(kw)
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def write(self, data): time.sleep(0.001)
    sd.OutputStream = Stream
    return sd


DEVS = [
    {"name": "Haut-parleurs (Realtek)", "max_output_channels": 2, "hostapi": 0, "default_samplerate": 48000},
    {"name": "Casque (AirPods Pro Hands-Free AG Audio)", "max_output_channels": 1, "hostapi": 1, "default_samplerate": 16000},
    {"name": "Écouteurs (AirPods Pro de Pierrick)", "max_output_channels": 2, "hostapi": 0, "default_samplerate": 44100},
    {"name": "Écouteurs (AirPods Pro de Pierrick)", "max_output_channels": 2, "hostapi": 1, "default_samplerate": 48000},
]


class AirpodsTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        airpods_hub.SETTINGS_FILE = os.path.join(d, "airpods.json")
        airpods_hub.LOG_FILE = os.path.join(d, "airpods.log")

    def test_choix_sortie_stereo_wasapi_et_repli(self):
        sd = fake_sd(DEVS)
        self.assertEqual(airpods_hub.choose_device(sd), (3, "Écouteurs (AirPods Pro de Pierrick)", 48000, 2, True))
        self.assertEqual(airpods_hub.choose_device(sd, "realtek")[0], 0)
        idx, _, _, _, found = airpods_hub.choose_device(fake_sd(DEVS[:1]))
        self.assertEqual((idx, found), (0, False))

    def test_etat_sans_dependances(self):
        bot = airpods_hub.Bot(FakeHub(), snd=None)
        self.assertEqual(bot.state()["status"], "bad")
        ok, text = bot.handle({"cmd": "ring"})
        self.assertFalse(ok)

    def test_reglages_bornes_et_enregistres(self):
        bot = airpods_hub.Bot(FakeHub(), snd=fake_sd(DEVS))
        self.assertTrue(bot.handle({"cmd": "set", "args": {"key": "volume", "value": "250"}})[0])
        self.assertEqual(bot.settings["volume"], 100)
        self.assertFalse(bot.handle({"cmd": "set", "args": {"key": "duree", "value": "abc"}})[0])
        self.assertFalse(bot.handle({"cmd": "set", "args": {"key": "inconnu", "value": "1"}})[0])
        self.assertEqual(airpods_hub.Bot(FakeHub(), snd=fake_sd(DEVS)).settings["volume"], 100)

    @unittest.skipUnless(HAS_NP, "numpy absent")
    def test_bip_fort_sans_saturer(self):
        import numpy as np
        c = airpods_hub.build_cycle(48000, 2, 1.0)
        self.assertLessEqual(float(np.abs(c).max()), 1.0)
        bips = c[c != 0]
        self.assertGreater(float(np.sqrt((bips ** 2).mean())), 0.85, "plus fort qu'un sinus (0,71)")
        self.assertEqual(airpods_hub.DEFAULTS["volume"], 100)

    @unittest.skipUnless(HAS_NP, "numpy absent")
    def test_sonner_puis_arreter(self):
        sd = fake_sd(DEVS)
        bot = airpods_hub.Bot(FakeHub(), snd=sd)
        ok, text = bot.handle({"cmd": "sonner"})
        self.assertTrue(ok, text)
        self.assertIn("AirPods Pro", text)
        self.assertEqual(sd.opened[0]["samplerate"], 48000)
        st = bot.state()
        self.assertEqual(st["actions"][0]["id"], "stop")
        self.assertFalse(st["offlineAlert"])
        self.assertIn("arrêtée", bot.handle({"cmd": "silence"})[1])
        self.assertFalse(bot.player.playing)
        self.assertEqual(bot.state()["actions"][0]["id"], "ring")

    @unittest.skipUnless(HAS_NP, "numpy absent")
    def test_sans_airpods_sonne_sur_defaut_et_previent(self):
        bot = airpods_hub.Bot(FakeHub(), snd=fake_sd(DEVS[:1]))
        ok, text = bot.handle({"cmd": "ring"})
        self.assertTrue(ok)
        self.assertIn("non connectés", text)
        bot.handle({"cmd": "stop"})
        self.assertEqual(bot.state()["status"], "warn")

    @unittest.skipUnless(HAS_NP, "numpy absent")
    def test_echec_ouverture_flux(self):
        bot = airpods_hub.Bot(FakeHub(), snd=fake_sd(DEVS, fail_open=True))
        ok, text = bot.handle({"cmd": "ring"})
        self.assertFalse(ok)
        self.assertIn("Invalid sample rate", text)

    @unittest.skipUnless(HAS_NP, "numpy absent")
    def test_arret_automatique(self):
        bot = airpods_hub.Bot(FakeHub(), snd=fake_sd(DEVS))
        bot.settings["duree"] = 1
        bot.handle({"cmd": "ring"})
        time.sleep(2.5)
        self.assertFalse(bot.player.playing)
        self.assertTrue(any("durée max" in t for _, t in bot.hub.events))


if __name__ == "__main__":
    unittest.main()
