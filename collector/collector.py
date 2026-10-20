#!/usr/bin/env python3
"""Collecteur Doctolib Monitor.

Interroge Doctolib (empreinte Chrome, via un proxy résidentiel si PROXY_URL est défini) puis envoie
les résultats au Worker Cloudflare, qui décide des alertes Telegram et alimente le tableau de bord.

Variables d'environnement :
  WORKER_URL   adresse du Worker (https://doctolib-monitor.xxx.workers.dev)
  INGEST_KEY   clé d'ingestion (secret partagé avec le Worker)
  PROXY_URL    optionnel : http://user:pass@hote:port (proxy rotatif résidentiel)
  FORCE=1      ignore le tirage au sort et passe tout de suite (lancement manuel)
Test uniquement : DOCTOLIB_BASE, NO_SLEEP=1.
"""
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
INFO_PATH = "/online_booking/api/slot_selection_funnel/v1/info.json"
AVAIL_PATH = "/availabilities.json"
UA = "doctolib-monitor-collector/1.0"
FAST = os.environ.get("NO_SLEEP") == "1"


class Fatal(Exception):
    def __init__(self, msg, http=None):
        super().__init__(msg)
        self.http = http


class Blocked(Fatal):
    pass


class Schema(Fatal):
    pass


def log(*a):
    print(*a, flush=True)


def pause(lo, hi):
    if not FAST:
        time.sleep(random.uniform(lo, hi))


def redact(text, *secrets):
    t = str(text)
    for s in secrets:
        if s and len(s) >= 6:
            t = t.replace(s, "***")
    return t


# --------------------------------------------------------------------------- HTTP vers Doctolib
PROXY = os.environ.get("PROXY_URL", "").strip() or None
BASE = os.environ.get("DOCTOLIB_BASE", "https://www.doctolib.fr").rstrip("/")

try:
    from curl_cffi import requests as cffi
except Exception:  # pragma: no cover
    cffi = None


def http_get(url):
    """Une connexion neuve à chaque appel : avec un proxy rotatif, chaque appel sort par une autre IP."""
    headers = {"Accept": "application/json", "Accept-Language": "fr-FR,fr;q=0.9", "Referer": BASE + "/"}
    if cffi is not None:
        kw = {"headers": headers, "timeout": 25, "impersonate": "chrome"}
        if PROXY:
            kw["proxies"] = {"http": PROXY, "https": PROXY}
        r = cffi.get(url, **kw)
        return r.status_code, r.text, r.headers.get("Retry-After")
    # Repli sans curl_cffi (tests locaux) : urllib, avec proxy si demandé
    req = urllib.request.Request(url, headers={**headers, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0"})
    handlers = [urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})] if PROXY else []
    try:
        with urllib.request.build_opener(*handlers).open(req, timeout=25) as r:
            return r.status, r.read().decode("utf8", "replace"), r.headers.get("Retry-After")
    except urllib.error.HTTPError as e:
        return e.code, "", e.headers.get("Retry-After")


def api_get(path, params, attempts=3):
    if PROXY:
        attempts *= 2  # proxy rotatif : chaque essai sort par une autre IP, une IP refusée ne doit pas faire échouer le passage
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    last, last_http = "inconnu", None
    for i in range(attempts):
        wait = 4 if i == 0 else 10
        try:
            code, text, retry = http_get(url)
        except Exception as e:  # réseau / proxy
            last, last_http = redact(f"réseau ({type(e).__name__})"), None
            code = None
        if code == 200:
            try:
                return json.loads(text)
            except ValueError:
                raise Schema("réponse non-JSON (page de protection anti-bot ?)", 200)
        if code is not None:
            if code in (400, 404, 422):
                raise Fatal(f"HTTP {code} sur {path} : IDs invalides ou endpoint modifié", code)
            last_http = code
            if code == 429:
                last = "HTTP 429 (trop de requêtes)"
                if retry and retry.isdigit() and int(retry) > 0:
                    wait = min(60, int(retry))
            elif code == 403:
                last = "HTTP 403 (IP ou client bloqué)"
                wait = 1.5 if PROXY else wait  # nouvelle connexion = nouvelle IP
            else:
                last = f"HTTP {code}"
        if i < attempts - 1:
            pause(wait, wait + 1.5)
    raise Blocked(last, last_http)


# --------------------------------------------------------------------------- logique Doctolib
def norm(v):
    return re.sub(r"^practice-", "", str(v if v is not None else ""))


def paris_today():
    return datetime.now(ZoneInfo("Europe/Paris")).date()


def get_info(w, cache):
    ck = "|".join(w["slugCandidates"])
    if ck in cache:
        return cache[ck]
    for slug in w["slugCandidates"]:
        try:
            data = api_get(INFO_PATH, {"profile_slug": slug}, 2)
        except Blocked:
            raise
        except Schema:
            raise
        except Fatal:
            continue
        info = data.get("data") if isinstance(data, dict) else None
        if isinstance(info, dict) and isinstance(info.get("agendas"), list) and info["agendas"]:
            cache[ck] = info
            return info
    raise Fatal(f"Profil introuvable via l'API (slug testé : {', '.join(w['slugCandidates'])})")


def resolve_agendas(w, info):
    wanted = set(w["motives"])
    out = []
    for a in info.get("agendas") or []:
        motives = {str(m) for m in (a.get("visit_motive_ids") or [])}
        practices = {norm(a.get("practice_id"))}
        by = a.get("visit_motive_ids_by_practice_id")
        if isinstance(by, dict):
            for k, v in by.items():
                practices.add(norm(k))
                if norm(k) == w["practice"]:
                    motives |= {str(m) for m in (v or [])}
        if w["practice"] in practices and motives & wanted:
            out.append(str(a["id"]))
    return out


def place_label(info, practice):
    for p in info.get("places") or []:
        if isinstance(p, dict) and norm(p.get("id")) == practice:
            txt = ", ".join(x for x in [p.get("name") or p.get("formal_name"), p.get("city")] if x)
            if txt:
                return txt
    return f"Cabinet {practice}"


def fetch_slots(w, agendas, horizon, today):
    end = (today + timedelta(days=horizon)).isoformat()
    cursor = today.isoformat()
    calls, nxt_min, slots = 0, None, set()
    while cursor <= end and calls < 8:
        calls += 1
        data = api_get(AVAIL_PATH, {
            "start_date": cursor, "visit_motive_ids": "-".join(w["motives"]), "agenda_ids": "-".join(agendas),
            "practice_ids": w["practice"], "telehealth": w["telehealth"], "limit": 7,
        })
        if not isinstance(data, dict) or not isinstance(data.get("availabilities"), list):
            raise Schema("clé 'availabilities' absente de la réponse (API modifiée ?)", 200)
        found = False
        for day in data["availabilities"]:
            for s in (day or {}).get("slots") or []:
                ts = s if isinstance(s, str) else (s or {}).get("start_date")
                if isinstance(ts, str) and SLOT_RE.match(ts):
                    slots.add(ts)
                    found = True
        step = (date.fromisoformat(cursor) + timedelta(days=7)).isoformat()
        nxt = data.get("next_slot")
        if isinstance(nxt, str) and SLOT_RE.match(nxt):
            if nxt_min is None or nxt < nxt_min:
                nxt_min = nxt
            if not found and nxt[:10] > cursor:
                step = nxt[:10]
        cursor = step
        if cursor <= end:
            pause(1.0, 2.5)
    return sorted(s for s in slots if s[:10] <= end), nxt_min


def check_watch(w, horizon, today, cache):
    t = time.time()
    res = {"key": w["key"], "status": "ok", "http": 200, "error": None, "slots": [], "next": None, "label": None, "agendas": []}
    try:
        info = get_info(w, cache)
        agendas = resolve_agendas(w, info)
        if not agendas:
            motifs = ", ".join(f"{m.get('id')}={m.get('name')}" for m in info.get("visit_motives") or [])
            raise Fatal(f"Aucun agenda pour le cabinet {w['practice']} et le motif {'-'.join(w['motives'])} (motifs connus : {motifs or '?'})")
        res["label"] = place_label(info, w["practice"])
        res["agendas"] = agendas
        pause(1.0, 2.5)
        res["slots"], res["next"] = fetch_slots(w, agendas, horizon, today)
    except Blocked as e:
        res.update(status="blocked", http=e.http, error=str(e))
    except Schema as e:
        res.update(status="schema", http=e.http, error=str(e))
    except Fatal as e:
        res.update(status="fatal", http=e.http, error=str(e))
    except Exception as e:  # filet de sécurité : ne jamais planter sans rien dire au Worker
        res.update(status="error", http=None, error=f"{type(e).__name__}: {e}")
    res["error"] = redact(res["error"], PROXY, os.environ.get("INGEST_KEY"))[:300] if res["error"] else None
    res["ms"] = int((time.time() - t) * 1000)
    return res


# --------------------------------------------------------------------------- Worker
WORKER = os.environ.get("WORKER_URL", "").strip().rstrip("/")
KEY = os.environ.get("INGEST_KEY", "").strip()


def worker(method, path, body=None, tries=3):
    data = json.dumps(body).encode() if body is not None else None
    last = ""
    for i in range(tries):
        req = urllib.request.Request(WORKER + path, data=data, method=method, headers={
            "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "User-Agent": UA,
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf8") or "{}")
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf8", "replace")[:200]
            last = f"HTTP {e.code} {txt}"
            if e.code in (400, 401, 403, 404, 413, 503):
                break  # inutile de réessayer
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        if i < tries - 1:
            pause(3, 6)
    raise RuntimeError(redact(f"Worker injoignable ou refus : {last}", KEY))


def should_run(cfg):
    """Rythme irrégulier : jamais deux passages à moins de 40 % de l'intervalle,
    passage forcé au-delà de 170 %, tirage au sort entre les deux."""
    if os.environ.get("FORCE") == "1":
        return True, "lancement forcé"
    since, interval = cfg.get("sinceLastSec"), cfg.get("intervalMin", 15) * 60
    if since is None:
        return True, "premier passage"
    if since < 0.4 * interval:
        return False, f"dernier passage il y a {since // 60} min : trop tôt"
    if since >= 1.7 * interval:
        return True, f"dernier passage il y a {since // 60} min : passage obligatoire"
    if random.random() < 0.4:
        return True, f"tirage favorable ({since // 60} min depuis le dernier passage)"
    return False, f"tirage défavorable ({since // 60} min depuis le dernier passage)"


def main():
    if not WORKER.startswith("http") or len(KEY) < 16:
        log("WORKER_URL ou INGEST_KEY manquant : voir les secrets du dépôt GitHub.")
        return 2
    log(f"proxy : {'oui' if PROXY else 'non (IP du serveur : Doctolib risque de refuser)'}; empreinte Chrome : {'oui' if cffi else 'non'}")
    cfg = worker("GET", "/api/ingest/config")
    if not cfg.get("watches"):
        log("Le Worker n'a aucun cabinet valide :", cfg.get("errors"))
        return 3
    go, why = should_run(cfg)
    log(("Passage : " if go else "Pas de passage : ") + why)
    if not go:
        return 0
    if os.environ.get("FORCE") != "1":
        pause(0, 40)  # décalage aléatoire en plus de celui de GitHub
    horizon, today, cache, results = int(cfg.get("horizon", 21)), paris_today(), {}, []
    watches = cfg["watches"]
    random.shuffle(watches)
    for i, w in enumerate(watches):
        if i:
            pause(3, 8)
        r = check_watch(w, horizon, today, cache)
        results.append(r)
        log(f"- {r['label'] or w['practice']}: {r['status']} ({len(r['slots'])} créneau(x)){' - ' + r['error'] if r['error'] else ''}")
    out = worker("POST", "/api/ingest", {"collector": "github-actions" if os.environ.get("GITHUB_ACTIONS") else "collecteur", "results": results})
    log("Envoyé au Worker :", "OK" if out.get("ok") else out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        log(str(e))
        sys.exit(1)
