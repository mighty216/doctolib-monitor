"""
Moteur des pépites Vinted : logique pure, sans réseau (testable).

Principes (tirés des erreurs de la v1) :
  - Un prix se calcule pour UN produit précis (« clé produit ») et jamais pour une recherche texte :
    numéro de set Lego, série + tome + édition, jeu + console. Pas de clé = pas de prix = pas d'alerte.
  - Les prix demandés des annonces en ligne surestiment le marché (ce qui reste en ligne est souvent trop cher).
    Référence : médiane des VENTES constatées par le bot si on en a 3, sinon le 1er quartile des annonces en ligne.
  - Aucun prix inventé : pas assez de comparables -> None -> l'annonce est ignorée.
  - Frais réels 2026 : l'acheteur paie 0,70 € + 5 % + le port ; le vendeur particulier ne paie rien.
"""
import re
import statistics
import unicodedata

# ------------------------------------------------------------------ texte

STOP = {
    "le", "la", "les", "de", "du", "des", "un", "une", "et", "en", "au", "aux", "a", "the", "of", "and",
    "jeu", "jeux", "video", "videos", "game", "games", "neuf", "neuve", "new", "occasion", "bon", "tres", "etat",
    "comme", "parfait", "complet", "complete", "cib", "boite", "boitier", "notice", "avec", "sans", "pour", "fr",
    "francais", "francaise", "version", "pal", "fra", "eur", "vf", "scelle", "scellee", "sealed", "blister",
    "sous", "film", "envoi", "rapide", "livraison", "offerte", "vends", "vend", "vendu", "lot", "tome", "tomes",
    "vol", "volume", "livre", "manga", "bd", "album", "edition", "nintendo", "sony", "playstation", "microsoft",
    "console", "officiel", "officielle", "original", "originale", "rare", "top",
}

PLATFORMS = [  # (motif, nom canonique) : du plus précis au plus général
    (r"\bps ?5\b|playstation ?5", "ps5"), (r"\bps ?4\b|playstation ?4", "ps4"), (r"\bps ?3\b|playstation ?3", "ps3"),
    (r"\bps ?2\b|playstation ?2", "ps2"), (r"\bps ?1\b|\bpsx\b|\bpsone\b|playstation ?1", "ps1"),
    (r"\bpsp\b", "psp"), (r"\bps ?vita\b", "vita"),
    (r"\bswitch ?2\b", "switch2"), (r"\bswitch\b", "switch"),
    (r"\bxbox ?series\b", "xboxseries"), (r"\bxbox ?one\b", "xboxone"), (r"\bxbox ?360\b", "xbox360"), (r"\bxbox\b", "xbox"),
    (r"\bgame ?boy ?advance\b|\bgba\b", "gba"), (r"\bgame ?boy ?color\b|\bgbc\b", "gbc"), (r"\bgame ?boy\b|\bgameboy\b", "gb"),
    (r"\b3ds\b|\b2ds\b", "3ds"), (r"\bnintendo ds\b|\bds lite\b|\bdsi\b|\bds\b", "ds"),
    (r"\bwii ?u\b", "wiiu"), (r"\bwii\b", "wii"), (r"\bgame ?cube\b|\bngc\b", "gamecube"), (r"\bn ?64\b|nintendo 64", "n64"),
    (r"\bsuper nintendo\b|\bsnes\b", "snes"), (r"\bnes\b", "nes"),
    (r"\bmega ?drive\b|\bgenesis\b", "megadrive"), (r"\bdreamcast\b", "dreamcast"), (r"\bsaturn\b", "saturn"),
    (r"\bmaster system\b", "mastersystem"),
]
PLATFORM_WORDS = {"ps5", "ps4", "ps3", "ps2", "ps1", "psx", "psp", "vita", "switch", "xbox", "series", "one", "360",
                  "game", "boy", "gameboy", "advance", "color", "gba", "gbc", "gb", "3ds", "2ds", "ds", "lite", "dsi",
                  "wii", "wiiu", "gamecube", "cube", "ngc", "n64", "64", "super", "snes", "nes", "mega", "drive",
                  "megadrive", "genesis", "dreamcast", "saturn", "master", "system", "playstation", "x", "s"}

# Séries connues (manga + BD) : la plus longue gagne (« one punch man » avant « one piece »...)
SERIES = sorted({
    "one piece", "naruto", "boruto", "bleach", "dragon ball", "dragon ball super", "hunter x hunter", "berserk", "vagabond",
    "vinland saga", "fullmetal alchemist", "death note", "attack on titan", "l attaque des titans", "chainsaw man",
    "demon slayer", "jujutsu kaisen", "my hero academia", "tokyo ghoul", "gunnm", "akira", "evangelion", "gantz", "claymore",
    "fruits basket", "sailor moon", "saint seiya", "city hunter", "nicky larson", "jojo", "dorohedoro", "dungeon meshi",
    "oyasumi punpun", "homunculus", "spy x family", "blue lock", "kingdom", "monster", "20th century boys", "pluto",
    "uzumaki", "tomie", "gyo", "les decapitees", "cauchemars de mimi", "junji ito",
    "tintin", "asterix", "lucky luke", "spirou", "gaston", "blake et mortimer", "xiii", "largo winch", "thorgal",
    "lanfeust", "donjon", "les schtroumpfs", "yoko tsuno", "buck danny", "titeuf", "corto maltese", "blacksad",
    "les vieux fourneaux", "la quete de l oiseau du temps", "valerian", "les tuniques bleues", "boule et bill",
    "les legendaires", "seuls", "lastman", "mortelle adele", "l arabe du futur", "walking dead", "saga",
}, key=len, reverse=True)

VARIANT = re.compile(r"\b(integrale|coffret|collector|edition deluxe|prestige|perfect edition|ultimate|edition originale|eo|"
                     r"tirage de tete|numerote|dedicace|signe|grand format|steelbook|limited|limitee|big box)\b")
TOME = re.compile(r"\b(?:t|tome|tomes|vol|volume|n|no|numero)\s*\.?\s*0*(\d{1,3})\b")
YEAR = re.compile(r"^(19[5-9]\d|20[0-3]\d)$")

# Annonces qui ne sont pas le produit (ou pas en entier) : rejet pur et simple
JUNK = re.compile(r"\b(boite vide|boitier seul|boitier vide|jaquette seule|notice seule|sans (le )?jeu|sans cartouche|"
                  r"pieces detachees|incomplet|incomplete|manque|manquant|replique|repro|reproduction|copie|faux|fake|"
                  r"contrefacon|custom|compatible|moc|lot de|en lot|vrac|recherche|cherche|echange|hs|ne fonctionne pas|"
                  r"pour pieces|defectueux|abime|dechire|non complet)\b")


def norm(text):
    t = unicodedata.normalize("NFKD", str(text or "").lower()).encode("ascii", "ignore").decode()
    t = t.replace("'", " ").replace("’", " ")
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def platform(t):
    for rx, name in PLATFORMS:
        if re.search(rx, t):
            return name
    return ""


def condition_group(status, title=""):
    """'neuf' ou 'occ' : deux groupes seulement, sinon jamais assez de comparables."""
    s = norm(status) + " " + norm(title)
    return "neuf" if re.search(r"\bneuf\b|\bscelle|\bsealed\b|\bsous blister\b|\bjamais ouvert\b", s) else "occ"


# ------------------------------------------------------------------ identité produit

def product_key(title):
    """Clé du produit (str) ou None quand on ne peut pas être sûr de ce que c'est."""
    t = norm(title)
    if not t or JUNK.search(t):
        return None
    words = t.split()
    variant = "var" if VARIANT.search(t) else "std"

    if "lego" in words:
        for w in words:
            if w.isdigit() and 4 <= len(w) <= 7 and not YEAR.match(w):
                return f"lego:{w}"
        return None

    if "brio" in words:
        m = re.search(r"\b(33\d{3})\b", t)
        return f"brio:{m.group(1)}" if m else None

    p = platform(t)
    if p:
        core = [w for w in words if w not in STOP and w not in PLATFORM_WORDS and not YEAR.match(w) and (len(w) > 1 or w.isdigit())]
        core = sorted(set(core))[:6]
        if not core:
            return None  # « jeu switch » tout court : impossible à identifier
        kind = "console" if "console" in words else "jv"
        return f"{kind}:{p}:{variant}:{' '.join(core)}"

    for s in SERIES:
        if re.search(r"\b" + re.escape(s) + r"\b", t):
            m = TOME.search(t)
            if not m:
                return None
            if re.search(r"\b\d{1,3}\s*(a|-|et)\s*\d{1,3}\b", t):
                return None  # plusieurs tomes = un lot
            return f"livre:{s.replace(' ', '_')}:{int(m.group(1))}:{variant}"
    return None


def category(key):
    if not key:
        return ""
    head = key.split(":", 1)[0]
    return {"lego": "lego", "brio": "brio", "jv": "jeux_video", "console": "jeux_video", "livre": "livres"}.get(head, head)


def search_text(key):
    """Requête courte pour chercher les comparables d'une clé (2-4 mots, jamais le titre brut)."""
    parts = key.split(":")
    if parts[0] == "lego":
        return f"lego {parts[1]}"
    if parts[0] == "brio":
        return f"brio {parts[1]}"
    if parts[0] == "livre":
        return f"{parts[1].replace('_', ' ')} tome {parts[2]}"
    if parts[0] in ("jv", "console"):
        names = {"ps1": "ps1", "gb": "game boy", "gba": "gba", "gbc": "game boy color", "xboxseries": "xbox series",
                 "xboxone": "xbox one", "xbox360": "xbox 360", "wiiu": "wii u", "switch2": "switch 2"}
        return f"{parts[3]} {names.get(parts[1], parts[1])}"
    return key


def same_product(a, b):
    """Les livres et Lego doivent avoir la même clé ; les jeux tolèrent un mot d'écart (titres très variables)."""
    if not a or not b:
        return False
    if a == b:
        return True
    pa, pb = a.split(":", 3), b.split(":", 3)
    if pa[0] not in ("jv", "console") or pa[:3] != pb[:3] or len(pa) < 4 or len(pb) < 4:
        return False
    ta, tb = set(pa[3].split()), set(pb[3].split())
    inter = len(ta & tb)
    return inter >= 2 and inter / len(ta | tb) >= 0.75


# ------------------------------------------------------------------ prix

def _q(sorted_vals, q):
    """Quantile par interpolation linéaire (liste déjà triée)."""
    if not sorted_vals:
        return 0.0
    pos = (len(sorted_vals) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def clean(prices):
    """Écarte les valeurs aberrantes (Tukey). Garde la liste si le nettoyage la vide trop."""
    s = sorted(p for p in prices if p and p > 0)
    if len(s) < 4:
        return s
    q1, q3 = _q(s, 0.25), _q(s, 0.75)
    iqr = q3 - q1
    kept = [p for p in s if q1 - 1.5 * iqr <= p <= q3 + 1.5 * iqr]
    return kept if len(kept) >= 3 else s


def market_price(active, sold, min_sold=3, min_active=4):
    """
    Prix auquel on peut raisonnablement revendre, ou None.
    active : prix demandés des annonces comparables en ligne ; sold : prix des comparables vendus (constatés).
    """
    sold, active = clean(sold), clean(active)
    if len(sold) >= min_sold:
        ref, basis, base = statistics.median(sold), "vendus", sold
    elif len(active) >= min_active:
        ref, basis, base = _q(active, 0.25), "en ligne (1er quartile)", active
    else:
        return None
    spread = (_q(base, 0.75) - _q(base, 0.25)) / statistics.median(base) if statistics.median(base) else 1.0
    return {"price": round(ref, 2), "basis": basis, "n_sold": len(sold), "n_active": len(active),
            "spread": round(spread, 2), "low": round(min(base), 2), "high": round(max(base), 2)}


def buyer_cost(price, ship_in, total_item_price=None):
    """Ce que tu paies vraiment : article + frais Vinted (0,70 € + 5 %) + port jusqu'à toi."""
    if total_item_price and total_item_price >= price:
        return round(total_item_price + ship_in, 2)
    return round(price + 0.70 + 0.05 * price + ship_in, 2)


def evaluate(price, market, s, total_item_price=None, favourites=0):
    """
    Décide si c'est une pépite. s = réglages (profit_min, margin_min, discount, ship_in, conf_min).
    Retourne un dict toujours renseigné ; 'ok' dit si on alerte, 'why' explique un refus.
    """
    out = {"ok": False, "why": "", "profit": 0.0, "margin": 0.0, "cost": 0.0, "resale": 0.0, "conf": 0.0,
           "suspect": False, "score": 0.0}
    if not market:
        out["why"] = "pas assez de comparables"
        return out
    cost = buyer_cost(price, s["ship_in"], total_item_price)
    resale = market["price"] * (1 - s["discount"] / 100.0)
    profit = resale - cost
    margin = profit / cost * 100 if cost else 0
    n = market["n_sold"] * 2 + market["n_active"]
    conf = min(1.0, n / 10) * 0.5 + (0.3 if market["basis"] == "vendus" else 0.0) + 0.2 * max(0.0, 1 - market["spread"])
    conf += 0.05 if favourites >= 5 else 0.0
    suspect = price < 0.2 * market["price"]  # trop beau : souvent une boîte vide, une notice, une arnaque
    if suspect:
        conf *= 0.85  # on prévient quand même : c'est aussi la tête des vraies pépites
    out.update(cost=round(cost, 2), resale=round(resale, 2), profit=round(profit, 2), margin=round(margin, 1),
               conf=round(min(conf, 1.0), 2), suspect=suspect, score=round(profit * min(conf, 1.0), 2))
    if profit < s["profit_min"]:
        out["why"] = f"profit {profit:.2f} € < {s['profit_min']} €"
    elif margin < s["margin_min"]:
        out["why"] = f"marge {margin:.0f} % < {s['margin_min']} %"
    elif out["conf"] < s["conf_min"]:
        out["why"] = f"confiance {out['conf']:.0%} trop faible"
    else:
        out["ok"] = True
    return out
