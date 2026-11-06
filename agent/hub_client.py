"""Client du hub (Cloudflare Worker) : sondage des commandes + envoi d'état. Bibliothèque standard seulement."""
import json
import os
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(path=None):
    path = path or os.path.join(HERE, "hub.json")
    with open(path, encoding="utf8") as f:
        cfg = json.load(f)
    cfg["url"] = cfg["url"].rstrip("/")
    return cfg


class Hub:
    """Une instance par bot. Thread-safe : on peut appeler report() depuis plusieurs threads."""

    def __init__(self, bot, name, cfg=None, log=print):
        self.cfg = cfg or load_config()
        self.bot = bot
        self.name = name
        self.log = log
        self._lock = threading.Lock()
        self._pending = {"messages": [], "events": [], "results": []}
        self._fails = 0
        self.online = False

    # ------------------------------------------------------------------ HTTP
    def _req(self, method, path, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.cfg["url"] + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self.cfg["key"], "Content-Type": "application/json",
                     "User-Agent": "bot-hub-agent/1"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf8") or "{}")

    # ------------------------------------------------------------------ API
    def poll(self, wait=20):
        """Retourne la liste des commandes à exécuter ([] si rien). Ne lève jamais."""
        try:
            out = self._req("GET", f"/api/agent/poll?bot={self.bot}&wait={int(wait)}", timeout=wait + 15)
            self._ok()
            return out.get("commands", [])
        except urllib.error.HTTPError as e:
            self._fail(f"HTTP {e.code}")
            if e.code in (401, 503):
                self.log("Le hub refuse la clé de l'agent (AGENT_KEY) : relance l'installation de l'agent.")
        except Exception as e:  # réseau coupé, Worker en maintenance...
            self._fail(f"{type(e).__name__}")
        time.sleep(min(60, 3 * self._fails))
        return []

    def message(self, text, html=False, markup=None):
        with self._lock:
            self._pending["messages"].append({"text": text, "html": html, **({"markup": markup} if markup else {})})

    def event(self, text, level="info"):
        with self._lock:
            self._pending["events"].append({"level": level, "text": text})

    def result(self, cmd_id, ok, text="", html=False, markup=None):
        with self._lock:
            self._pending["results"].append({"id": cmd_id, "ok": ok, "text": text, "html": html, **({"markup": markup} if markup else {})})

    def flush(self, state=None):
        """Envoie l'état + tout ce qui est en attente. Si le hub est injoignable, on garde pour la prochaine fois."""
        with self._lock:
            batch = {k: v[:] for k, v in self._pending.items()}
            for k in self._pending:
                self._pending[k] = []
        body = {"bot": self.bot, "name": self.name, **batch}
        if state is not None:
            body["state"] = state
        try:
            self._req("POST", "/api/agent/report", body)
            self._ok()
            return True
        except Exception as e:
            self._fail(f"{type(e).__name__}")
            with self._lock:  # on remet en file (borné)
                for k, v in batch.items():
                    self._pending[k] = (v + self._pending[k])[-100:]
            return False

    # ------------------------------------------------------------------ suivi de connexion
    def _ok(self):
        if not self.online:
            self.log("Hub joignable.")
        self.online, self._fails = True, 0

    def _fail(self, why):
        self._fails += 1
        if self.online or self._fails == 1:
            self.log(f"Hub injoignable ({why}), nouvel essai bientôt.")
        self.online = False
