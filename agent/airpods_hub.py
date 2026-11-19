#!/usr/bin/env python3
"""
Agent « AirPods » pour le hub, à lancer sur le PC Windows auquel les AirPods Pro 2 sont associés.

« Faire sonner » (web ou Telegram : /airpods, /sonner, /silence) joue un bip de localisation répétitif sur la sortie
audio Bluetooth des AirPods. Ce n'est pas le protocole « Localiser » d'Apple : les AirPods doivent être sortis du boîtier
et connectés au PC. Installé par : irm -Headers @{Authorization="Bearer CLE"} URL/agent/install-airpods.ps1 | iex
Dépendances : numpy, sounddevice (installées par l'installeur dans un venv).
"""
import json
import os
import socket
import threading
import time

from hub_client import Hub, HERE, load_config

try:
    import numpy as np
except ImportError:
    np = None
try:
    import sounddevice as sd
except (ImportError, OSError):  # paquet ou PortAudio absents : l'état web l'indique
    sd = None
if np is None:
    sd = None

BOT_ID = "airpods"
SETTINGS_FILE = os.path.join(HERE, "airpods.json")
LOG_FILE = os.path.join(HERE, "airpods.log")
DEFAULTS = {"volume": 100, "duree": 180, "sortie": ""}
STATE_EVERY = 20
# Motif bip-bip-bip : (durée s, fréquence Hz) ; 0 = silence. 2,7-3,2 kHz : zone où l'oreille est la plus sensible
PATTERN = ((0.3, 2700), (0.07, 0), (0.3, 3200), (0.07, 0), (0.3, 2700), (0.6, 0))
DRIVE = 4.0  # sinus saturé -> presque carré : bien plus fort à crête égale, sans clipper
# Profil Bluetooth « mains libres » (mono 16 kHz) à éviter quand le profil stéréo existe
HANDSFREE = ("hands-free", "handsfree", "mains libres", "mains-libres", "ag audio", "headset")
HOSTAPI_PREF = ("Windows WASAPI", "Windows DirectSound", "MME")


def log(msg):
    line = time.strftime("%d/%m %H:%M:%S ") + msg
    print(line, flush=True)  # sans effet sous pythonw
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 500_000:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def choose_device(snd, hint=""):
    """(index, nom, fréquence, canaux, cible_trouvée). Cherche « hint » ou « AirPods », sinon sortie par défaut."""
    devices = snd.query_devices()
    apis = snd.query_hostapis()
    outs = [(i, d, apis[d["hostapi"]]["name"]) for i, d in enumerate(devices) if d["max_output_channels"] > 0]
    key = (hint or "airpods").lower()
    found = [o for o in outs if key in o[1]["name"].lower()]
    if found:
        stereo = [o for o in found if not any(w in o[1]["name"].lower() for w in HANDSFREE)]
        found = sorted(stereo or found, key=lambda o: HOSTAPI_PREF.index(o[2]) if o[2] in HOSTAPI_PREF else 99)
        i, d, _ = found[0]
        return i, d["name"], int(d["default_samplerate"]), min(2, d["max_output_channels"]), True
    default = snd.default.device[1]
    if default is None or default < 0:
        raise RuntimeError("aucune sortie audio sur ce PC")
    d = snd.query_devices(int(default))
    return int(default), d["name"], int(d["default_samplerate"]), min(2, d["max_output_channels"]), False


def build_cycle(samplerate, channels, volume):
    parts = []
    for duration, freq in PATTERN:
        n = int(samplerate * duration)
        if not freq:
            parts.append(np.zeros(n, dtype=np.float32))
            continue
        t = np.arange(n, dtype=np.float32) / samplerate
        env = np.ones(n, dtype=np.float32)
        fade = min(n // 2, int(samplerate * 0.01))  # anti-clic
        env[:fade] = np.linspace(0, 1, fade)
        env[-fade:] = np.linspace(1, 0, fade)
        wave = np.tanh(DRIVE * np.sin(2 * np.pi * freq * t)) / np.tanh(DRIVE)
        parts.append((volume * env * wave).astype(np.float32))
    mono = np.concatenate(parts)
    return np.repeat(mono[:, None], channels, axis=1)


class Player:
    def __init__(self, snd):
        self.sd = snd
        self.stop_event = threading.Event()
        self.thread = None
        self.playing = False
        self.error = None
        self.started = 0.0
        self.on_end = None

    def start(self, device, samplerate, channels, volume, seconds):
        self.error = None
        self.stop_event.clear()
        self.playing = True
        self.started = time.time()
        self.thread = threading.Thread(target=self._loop, args=(device, samplerate, channels, volume, seconds), daemon=True)
        self.thread.start()
        time.sleep(0.5)  # une ouverture de flux qui échoue échoue tout de suite
        return self.error

    def _loop(self, device, samplerate, channels, volume, seconds):
        reason = "arrêt"
        try:
            cycle = build_cycle(samplerate, channels, volume)
            deadline = time.time() + seconds
            with self.sd.OutputStream(device=device, channels=channels, samplerate=samplerate, dtype="float32", blocksize=1024) as st:
                while not self.stop_event.is_set():
                    if time.time() >= deadline:
                        reason = "durée max atteinte"
                        break
                    for s in range(0, len(cycle), 1024):
                        if self.stop_event.is_set():
                            break
                        st.write(cycle[s:s + 1024])
        except Exception as e:  # sortie disparue (AirPods rangés), pilote...
            self.error = str(e)[:200]
            reason = f"erreur audio : {self.error}"
        finally:
            self.playing = False
            if self.on_end and not self.stop_event.is_set():
                self.on_end(reason)

    def stop(self):
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)
        self.playing = False


class Bot:
    def __init__(self, hub, snd=sd):
        self.hub = hub
        self.sd = snd
        self.settings = dict(DEFAULTS)
        self.load_settings()
        self.player = Player(snd) if snd else None
        if self.player:
            self.player.on_end = self._ended
        self.device = None  # (index, nom, fréquence, canaux, trouvée)
        self.scan_error = None
        self.last_scan = 0.0
        self.logbuf = []
        self.rings = 0

    # ------------------------------------------------------------------ réglages
    def load_settings(self):
        try:
            with open(SETTINGS_FILE, encoding="utf8") as f:
                saved = json.load(f)
            self.settings.update({k: saved[k] for k in DEFAULTS if k in saved})
        except (OSError, ValueError):
            pass

    def save_settings(self):
        try:
            with open(SETTINGS_FILE, "w", encoding="utf8") as f:
                json.dump(self.settings, f, indent=2)
        except OSError as e:
            self.note(f"Réglages non enregistrés : {e}", "warn")

    def note(self, text, level="info"):
        log(text)
        self.logbuf = (self.logbuf + [time.strftime("%H:%M:%S ") + text])[-40:]
        self.hub.event(text, level)

    # ------------------------------------------------------------------ audio
    def scan(self, force=False):
        """Relit la liste des sorties (des AirPods connectés après coup apparaissent). Jamais pendant une sonnerie."""
        if not self.sd or (self.player and self.player.playing) or (not force and time.time() - self.last_scan < 30):
            return
        self.last_scan = time.time()
        try:
            self.sd._terminate()
            self.sd._initialize()
        except Exception:
            pass
        try:
            self.device = choose_device(self.sd, self.settings["sortie"])
            self.scan_error = None
        except Exception as e:
            self.device, self.scan_error = None, str(e)[:200]

    def ring(self):
        if not self.player:
            return False, "numpy/sounddevice absents sur le PC : relance l'installeur."
        if self.player.playing:
            return True, "🔊 Ça sonne déjà."
        self.scan(force=True)
        if not self.device:
            return False, f"Aucune sortie audio : {self.scan_error or 'inconnue'}"
        idx, name, sr, ch, found = self.device
        err = self.player.start(idx, sr, ch, max(5, min(100, self.settings["volume"])) / 100, self.settings["duree"])
        if err:
            self.note(f"Sonnerie impossible : {err}", "bad")
            return False, f"Sonnerie impossible sur « {name} » : {err}"
        self.rings += 1
        if found:
            msg = f"🔊 Ça sonne sur « {name} » (arrêt auto dans {self.settings['duree']} s)."
        else:
            msg = (f"🔊 AirPods non connectés au PC : ça sonne sur la sortie par défaut « {name} ». "
                   "Sors-les du boîtier près du PC, ou utilise « Sonner sur cet appareil » depuis le téléphone.")
        self.note(msg, "ok" if found else "warn")
        return True, msg

    def stop(self):
        if self.player and self.player.playing:
            self.player.stop()
            self.note("Sonnerie arrêtée.")
            return "⏹ Sonnerie arrêtée."
        return "Rien ne sonnait."

    def _ended(self, reason):
        if time.time() - self.player.started < 1:  # échec à l'ouverture : déjà signalé par ring()
            return
        self.note(f"Sonnerie terminée ({reason}).", "warn" if "erreur" in reason else "info")
        self.hub.flush(self.state())

    # ------------------------------------------------------------------ commandes
    def handle(self, c):
        cmd = c.get("cmd")
        args = c.get("args") or {}
        if cmd in ("ring", "sonner"):
            return self.ring()
        if cmd in ("stop", "silence"):
            return True, self.stop()
        if cmd == "scan":
            self.scan(force=True)
            return True, f"Sortie : {self.device[1] if self.device else 'aucune'}" + (" (AirPods trouvés)" if self.device and self.device[4] else "")
        if cmd == "log":
            return True, "📜 " + ("\n".join(self.logbuf[-10:]) or "(vide)")
        if cmd == "set":
            k, v = args.get("key"), str(args.get("value", "")).strip()
            if k not in DEFAULTS:
                return False, f"Réglage inconnu : {k}"
            try:
                if k == "volume":
                    self.settings[k] = max(5, min(100, int(v)))
                elif k == "duree":
                    self.settings[k] = max(10, min(900, int(v)))
                else:
                    self.settings[k] = v[:60]
            except ValueError:
                return False, f"Valeur invalide pour {k}"
            self.save_settings()
            if k == "sortie":
                self.scan(force=True)
            return True, f"Réglage {k} = {self.settings[k]}"
        return False, f"Commande inconnue pour AirPods : {cmd}"

    def run_command(self, c):
        try:
            ok, text = self.handle(c)
        except Exception as e:
            ok, text = False, f"Erreur : {str(e)[:200]}"
            log(f"Commande {c.get('cmd')} en erreur : {e}")
        self.hub.result(c["id"], ok, text)

    # ------------------------------------------------------------------ état pour l'interface
    def state(self):
        playing = bool(self.player and self.player.playing)
        found = bool(self.device and self.device[4])
        if not self.sd:
            status, summary = "bad", "numpy/sounddevice absents : relance l'installeur sur le PC"
        elif playing:
            status, summary = "ok", f"🔊 Ça sonne sur {self.device[1] if self.device else '?'}"
        elif found:
            status, summary = "ok", "AirPods connectés au PC : prêts à sonner"
        else:
            status, summary = "warn", "AirPods non connectés au PC (sonnerie possible sur cet appareil)"
        return {
            "status": status, "summary": summary,
            "metrics": [
                {"label": "PC", "value": socket.gethostname()},
                {"label": "Sortie audio", "value": self.device[1] if self.device else (self.scan_error or "—")},
                {"label": "AirPods sur le PC", "value": "oui" if found else "non"},
                {"label": "Sonnerie", "value": f"en cours ({int(time.time() - self.player.started)} s)" if playing else "arrêtée"},
            ],
            "actions": [
                {"id": "stop", "label": "⏹ Arrêter la sonnerie", "danger": True} if playing else {"id": "ring", "label": "🔊 Faire sonner (PC)"},
                {"id": "scan", "label": "🔄 Rechercher la sortie audio"},
            ],
            "settings": [
                {"key": "volume", "label": "Volume (%)", "type": "number", "value": str(self.settings["volume"]),
                 "help": "5 à 100. Le volume Windows s'applique en plus."},
                {"key": "duree", "label": "Arrêt automatique après (s)", "type": "number", "value": str(self.settings["duree"])},
                {"key": "sortie", "label": "Nom de la sortie audio", "type": "text", "value": self.settings["sortie"],
                 "help": "Vide = cherche « AirPods ». Sinon un morceau du nom affiché dans Windows."},
            ],
            "log": self.logbuf[-40:],
            "offlineAlert": False,  # le PC est souvent éteint : pas d'alerte Telegram « ne répond plus »
            "telegram": [{"cmd": "sonner", "text": "Faire sonner les AirPods (PC)"}, {"cmd": "silence", "text": "Arrêter la sonnerie"}],
        }

    def run(self):
        self.scan(force=True)
        self.note(f"Agent démarré sur {socket.gethostname()} (sortie : {self.device[1] if self.device else 'aucune'}).")
        last_state = 0.0
        while True:
            if time.time() - last_state > STATE_EVERY:
                self.scan()
                self.hub.flush(self.state())
                last_state = time.time()
            for c in self.hub.poll(wait=20):
                self.run_command(c)
                self.hub.flush(self.state())
                last_state = time.time()


def main():
    cfg = load_config()
    hub = Hub(BOT_ID, "AirPods", cfg, log=log)
    try:
        Bot(hub).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
