"""
Accès à Vinted : une seule session HTTP qui imite Chrome (empreinte TLS/HTTP2 via curl_cffi), cookie de session
renouvelé tout seul. Lecture seule : recherche du catalogue et état d'une annonce. Aucun achat, aucun message.
"""
import json
import random
import re
import threading
import time

try:
    from curl_cffi import requests as cffi
except ImportError:  # l'installeur l'ajoute ; sans lui Vinted répond 403 à coup sûr
    cffi = None

BASE = "https://www.vinted.fr"


class SourceError(Exception):
    def __init__(self, code, msg=""):
        super().__init__(msg or f"HTTP {code}")
        self.code = code


def _amount(v):
    if isinstance(v, dict):
        v = v.get("amount")
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def parse_item(it):
    """Annonce brute (JSON Vinted) -> dict simple. Les champs absents restent vides plutôt que de casser."""
    user = it.get("user") or {}
    photo = it.get("photo") or {}
    hr = photo.get("high_resolution") or {}
    iid = str(it.get("id") or "")
    return {
        "id": iid,
        "title": str(it.get("title") or "").strip(),
        "price": _amount(it.get("price")),
        "total": _amount(it.get("total_item_price")),
        "status": str(it.get("status") or ""),
        "fav": int(it.get("favourite_count") or 0),
        "seller": str(user.get("id") or ""),
        "pro": bool(user.get("business")),
        "url": str(it.get("url") or f"{BASE}/items/{iid}"),
        "photo": str(photo.get("url") or ""),
        "ts": int(hr.get("timestamp") or 0),  # date de mise en ligne de la photo = âge réel de l'annonce
        "brand": str(it.get("brand_title") or ""),
    }


class Vinted:
    def __init__(self, proxy=None, min_gap=2.5):
        self.proxy = proxy
        self.min_gap = min_gap
        self.session = None
        self.lock = threading.Lock()
        self.last_call = 0.0
        self.last_status = "jamais appelé"
        self.calls = 0
        self.mode = "api"  # bascule sur "html" si Vinted refuse la route JSON du catalogue

    def _new_session(self):
        if cffi is None:
            raise SourceError(0, "curl_cffi manquant : relance l'installation de l'agent")
        s = cffi.Session(impersonate="chrome")
        if self.proxy:
            s.proxies = {"http": self.proxy, "https": self.proxy}
        s.headers.update({"Accept-Language": "fr-FR,fr;q=0.9", "Accept": "application/json, text/plain, */*"})
        r = s.get(BASE + "/", timeout=25)
        if r.status_code >= 400:
            self.last_status = f"page d'accueil : HTTP {r.status_code}"
            raise SourceError(r.status_code, self.last_status)
        self.session = s

    def _get(self, path, params=None, retry=True):
        with self.lock:  # un seul appel à la fois, espacé et irrégulier
            wait = self.min_gap * random.uniform(0.8, 1.6) - (time.time() - self.last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                if self.session is None:
                    self._new_session()
                r = self.session.get(BASE + path, params=params, timeout=25)
            except SourceError:
                raise
            except Exception as e:
                self.session = None
                self.last_status = f"réseau : {type(e).__name__}"
                raise SourceError(0, self.last_status)
            finally:
                self.last_call = time.time()
                self.calls += 1
        if r.status_code == 401 and retry:  # cookie expiré : nouvelle session, un seul essai
            self.session = None
            return self._get(path, params, retry=False)
        if r.status_code >= 400:
            if r.status_code in (403, 429):
                self.session = None
            self.last_status = f"{path.split('?')[0]} : HTTP {r.status_code}"
            raise SourceError(r.status_code, self.last_status)
        self.last_status = "OK"
        try:
            return r.json()
        except ValueError:
            self.last_status = "réponse non JSON (page anti-robot ?)"
            raise SourceError(200, self.last_status)

    def search(self, text, order="newest_first", per_page=96, price_from=None, price_to=None):
        params = {"search_text": text, "order": order, "per_page": per_page, "page": 1}
        if price_from:
            params["price_from"] = price_from
        if price_to:
            params["price_to"] = price_to
        if self.mode == "api":
            try:
                data = self._get("/api/v2/catalog/items", params)
                return [parse_item(i) for i in data.get("items", []) if i.get("id")]
            except SourceError as e:
                if e.code not in (404, 200):  # 403/429/réseau : vrai blocage, on ne change pas de méthode
                    raise
                self.mode = "html"  # route fermée ou réponse non JSON : pages publiques du catalogue
        from urllib.parse import urlencode
        code, html_text = self.page("/catalog?" + urlencode({k: v for k, v in params.items() if k != "per_page"}))
        if code >= 400:
            raise SourceError(code, f"catalogue HTML : HTTP {code}")
        items = parse_catalog_html(html_text)
        if not items and "/items/" in html_text:
            self.last_status = "catalogue HTML illisible (format Vinted changé)"
            raise SourceError(200, self.last_status)
        self.last_status = "OK (pages HTML)"
        return items

    def page(self, path):
        """Page HTML publique (statut HTTP, texte). 404 n'est pas une erreur ici : c'est une information."""
        with self.lock:
            wait = self.min_gap * random.uniform(0.8, 1.6) - (time.time() - self.last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                if self.session is None:
                    self._new_session()
                r = self.session.get(BASE + path, timeout=25, allow_redirects=True,
                                     headers={"Accept": "text/html,application/xhtml+xml"})
            except SourceError:
                raise
            except Exception as e:
                self.session = None
                self.last_status = f"réseau : {type(e).__name__}"
                raise SourceError(0, self.last_status)
            finally:
                self.last_call = time.time()
                self.calls += 1
        if r.status_code in (403, 429) or r.status_code >= 500:
            self.session = None
            self.last_status = f"page annonce : HTTP {r.status_code}"
            raise SourceError(r.status_code, self.last_status)
        return r.status_code, r.text

    def item_state(self, item_id):
        """
        État d'une annonce lu sur sa page publique, comme le font les outils de suivi des ventes :
          - données produit (JSON-LD) « SoldOut » / « OutOfStock »  -> 'sold'
          - drapeau de réservation dans la page                    -> 'reserved'
          - « InStock »                                           -> 'online'
          - 404                                                   -> 'gone' (vendue OU supprimée : on ne sait pas)
        L'ancienne route /api/v2/items/<id> n'est plus utilisable.
        """
        code, text = self.page(f"/items/{item_id}")
        return parse_item_page(code, text)


AVAIL = re.compile(r'"availability"\s*:\s*"(?:https?://schema\.org/)?(\w+)"', re.I)
RESERVED = re.compile(r'\\?"is_reserved\\?"\s*:\s*true', re.I)


def parse_item_page(code, text):
    if code == 404:
        return "gone"
    if code >= 400:
        return "unknown"
    m = AVAIL.search(text or "")
    avail = m.group(1).lower() if m else ""
    if avail in ("soldout", "outofstock", "discontinued"):
        return "sold"
    if RESERVED.search(text or ""):
        return "reserved"
    if avail == "instock":
        return "online"
    return "unknown"


_ITEM_START = re.compile(r'\{"id":(\d{6,}),')


def _field(chunk, rx, default=""):
    m = re.search(rx, chunk)
    return m.group(1) if m else default


def parse_catalog_html(text):
    """
    Annonces d'une page /catalog : Vinted embarque les données des articles (JSON, souvent échappé) dans la page.
    Lecture tolérante champ par champ, bornée à chaque objet article, pour survivre à l'ordre des champs.
    """
    t = (text or "").replace('\\"', '"').replace("\\u0026", "&")
    starts = [m for m in _ITEM_START.finditer(t)]
    out, seen = [], set()
    for i, m in enumerate(starts):
        end = starts[i + 1].start() if i + 1 < len(starts) else m.start() + 4000
        chunk = t[m.start():min(end, m.start() + 4000)]
        title = _field(chunk, r'"title":"((?:[^"\\]|\\.)*)"')
        price = _field(chunk, r'"price":\{[^}]*?"amount":"?([\d.]+)')
        iid = m.group(1)
        if not title or not price or iid in seen:
            continue  # pas un article (ex. objet utilisateur ou photo)
        seen.add(iid)
        try:
            title = json.loads('"' + title + '"')
        except ValueError:
            pass
        out.append(parse_item({
            "id": iid, "title": title, "price": {"amount": price},
            "total_item_price": {"amount": _field(chunk, r'"total_item_price":\{[^}]*?"amount":"?([\d.]+)', "0")},
            "status": _field(chunk, r'"status":"([^"]*)"'),
            "favourite_count": _field(chunk, r'"favourite_count":(\d+)', "0"),
            "user": {"id": _field(chunk, r'"user":\{[^{}]*?"id":(\d+)'),
                     "business": _field(chunk, r'"business":(true|false)') == "true"},
            "photo": {"high_resolution": {"timestamp": _field(chunk, r'"timestamp":(\d{9,})', "0")}},
            "url": _field(chunk, r'"url":"(https://www\.vinted\.[a-z.]+/items/[^"]+)"'),
            "brand_title": _field(chunk, r'"brand_title":"([^"]*)"'),
        }))
    return out
