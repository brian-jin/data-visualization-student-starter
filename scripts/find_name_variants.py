#!/usr/bin/env python3
"""
Find restaurant-name variants that probably belong to one brand ("Popeyes" / "Popeyes Louisiana Kitchen") so they can be
reviewed BEFORE choosing the chain-size cutoffs. Read-only: it never changes the data or the alias file.

    python scripts/find_name_variants.py

Writes public/data/review/alias_candidates.csv (one row per variant name) and prints a summary. Each row has a
confidence label:
  auto     remainder is only descriptor words / location words / store codes, and the base name looks like a brand
  cobrand  the remainder is itself another brand ("Carvel Cinnabon"), so the location could count for either
  review   plausible but needs a human look (new words after the brand, spelling variants, or a generic-sounding name)
  skip     base name is a common word ("Cafe", "Pizza") so this is almost certainly a coincidence; listed for transparency
"""
from __future__ import annotations

import argparse
import difflib
import re
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from check_known_chains import load_known, match_known
from preprocess import load_restaurants, normalize_name

# Words that describe a place but do not change which brand it is
DESCRIPTOR = set(
    "PIZZA PIZZERIA COFFEE CAFE RESTAURANT RESTAURANTS GRILL GRILLE KITCHEN BAKERY BAR AND THE EXPRESS DELI FOOD FOODS "
    "CHICKEN BURGER BURGERS SANDWICH SANDWICHES SALAD COMPANY CO NYC NY USA FRIED LOUISIANA TAQUERIA MEXICAN CHINESE "
    "JAPANESE ICE CREAM DONUTS BAGELS BAGEL PRETZELS PRETZEL SUBS TEA JUICE SMOOTHIES SMOOTHIE CUISINE HOUSE ORIGINAL "
    "FAMOUS NEIGHBORHOOD SUITES WINGS BISCUITS FRIES GO TO".split()
)
# Words that say where a location is
LOCATION = set(
    "AIRPORT TERMINAL JFK LGA LAGUARDIA EWR MANHATTAN BROOKLYN QUEENS BRONX STATEN ISLAND HARLEM MIDTOWN DOWNTOWN UPTOWN "
    "TIMES SQUARE SOHO TRIBECA CHELSEA FLUSHING JAMAICA ASTORIA BROADWAY AVENUE AVE STREET ST PARK PLAZA CENTER MALL "
    "STATION FERRY HOSPITAL UNIVERSITY CAMPUS MARKET FLOOR LOBBY".split()
)
CODE = re.compile(r"^([A-Z]{0,3}\d+[A-Z0-9]*|\d+[A-Z]*)$")  # "B37", "FA6050", "68TH"
GENERIC_DF = 40  # a base name whose rarest word appears in this many other names is too common to trust


def classify(rem: str) -> str:
    t = rem.split()
    if all(CODE.match(x) for x in t):
        return "code"
    if all(x in DESCRIPTOR or CODE.match(x) for x in t):
        return "descriptor"
    if all(x in DESCRIPTOR or x in LOCATION or CODE.match(x) for x in t):
        return "descriptor+location"
    return "other"


def tier_of(n: int, mini: int, chain: int, big: int) -> str:
    return "big" if n >= big else "mid" if n >= chain else "mini" if n >= mini else "indep"


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--restaurants", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--out", type=Path, default=root / "public/data/review/alias_candidates.csv")
    ap.add_argument("--known", type=Path, default=root / "public/data/review/known_chains.csv")
    ap.add_argument("--mini-min", type=int, default=3)
    ap.add_argument("--chain-min", type=int, default=10)
    ap.add_argument("--big-min", type=int, default=50)
    args = ap.parse_args()

    df = load_restaurants(args.restaurants)
    df["key"] = df["DBA"].map(normalize_name)
    df = df[df["key"] != ""]
    k = df.groupby("key").agg(n=("CAMIS", "nunique"), cuisine=("cuisine", lambda s: s.mode().iat[0]))
    n, cuis = k["n"].to_dict(), k["cuisine"].to_dict()
    keys = list(k.index)

    word_df = Counter(t for key in keys for t in set(key.split()))

    def rarest_df(anchor: str) -> int:
        """How many OTHER names contain the base name's rarest word (high = generic, e.g. CAFE)."""
        own = {x for x in keys if x == anchor or x.startswith(anchor + " ")}
        c = Counter(t for x in keys if x not in own for t in set(x.split()))
        return min(c.get(t, 0) for t in anchor.split())

    anchors = [a for a in keys if n[a] >= 2 and len(a) >= 4]
    by_first = defaultdict(list)
    for a in anchors:
        by_first[a.split()[0]].append(a)

    known = load_known(args.known) if args.known.exists() else []
    big_known = [a for a in keys if n[a] >= args.big_min and len(a) >= 5 and match_known(a, known)]
    big_known_re = re.compile("|".join(rf"(^| ){re.escape(a)}( |$)" for a in big_known)) if big_known else None
    rows, paired = [], set()
    for b in keys:  # prefix variants: "POPEYES LOUISIANA KITCHEN" starts with "POPEYES"
        if big_known_re and big_known_re.search(b):
            continue  # "GARDEN MARKET DUNKIN" belongs to Dunkin, not to the host "GARDEN MARKET" (handled below)
        best = None
        for a in by_first.get(b.split()[0], []):
            if a != b and b.startswith(a + " ") and (best is None or len(a) > len(best)):
                best = a
        if best:
            rows.append((best, b, b[len(best) + 1 :], "prefix"))
            paired.add(b)
    big_anchors = [a for a in keys if n[a] >= 10]
    for b in keys:  # spelling variants: "STARBUCKS COFFE", "CHIPOTLE MEXCAN GRILL", "DOS TOROS" / "DOSTOROS"
        if b in paired or n[b] > 5:
            continue
        for a in big_anchors:
            if a == b or abs(len(a) - len(b)) > 3 or a[0] != b[0]:
                continue
            if a.replace(" ", "") == b.replace(" ", "") or difflib.SequenceMatcher(None, a, b).ratio() >= 0.9:
                rows.append((a, b, "", "spelling"))
                paired.add(b)
                break

    def skeleton(key: str) -> str:
        """Spacing and plural-insensitive form: 'POP UP BAGELS', 'POPUP BAGELS' and 'POPUP BAGEL' all become 'POPUPBAGEL'."""
        s = key.replace(" ", "")
        return s[:-1] if len(s) > 5 and s.endswith("S") else s

    groups = defaultdict(list)
    for b in keys:
        if b not in paired:
            groups[skeleton(b)].append(b)
    for members in groups.values():  # same name written differently (3+ locations in total)
        if len(members) > 1 and sum(n[m] for m in members) >= 3:
            head = max(members, key=lambda m: (n[m], len(m)))
            for m in members:
                if m != head:
                    rows.append((head, m, "", "skeleton"))
                    paired.add(m)
    for a in big_known:
        for b in keys:  # big known chains inside another name ("GARDEN MARKET DUNKIN") or with digits glued on ("DUNKIN99")
            if b in paired or b == a:
                continue
            if b.startswith(a) and b[len(a) :].isdigit():
                rows.append((a, b, b[len(a) :], "glued"))
                paired.add(b)
            elif re.search(rf"(^| ){re.escape(a)}( |$)", b):
                rows.append((a, b, b.replace(a, "").strip(), "contains"))
                paired.add(b)

    c = pd.DataFrame(rows, columns=["anchor", "variant", "remainder", "how"])
    c["n_anchor"] = c["anchor"].map(n)
    c["n_variant"] = c["variant"].map(n)
    c["anchor_cuisine"] = c["anchor"].map(cuis)
    c["variant_cuisine"] = c["variant"].map(cuis)
    c["anchor_rarest_word_df"] = [rarest_df(a) for a in c["anchor"]]
    c["kind"] = [(h if h != "prefix" else classify(r)) for h, r in zip(c["how"], c["remainder"])]

    brandish = set(a for a in keys if n[a] >= 2)
    def cobrand(rem: str, anchor: str) -> bool:
        if classify(rem) != "other":  # only descriptor / location / code words: not another brand ("RESTAURANT" is not a brand)
            return False
        return any(rem == x or rem.startswith(x + " ") for x in brandish if x != anchor and len(x) >= 5)

    hits = [match_known(a, known) for a in c["anchor"]]
    c["anchor_known_chain"] = [h[0] if h and h[1] != "not_chain" else "" for h in hits]
    c["anchor_not_chain"] = [bool(h and h[1] == "not_chain") for h in hits]

    def label(r) -> tuple[str, str]:
        generic = r.anchor_rarest_word_df >= GENERIC_DF
        if r.anchor_not_chain:
            return "skip", "base name is marked not a chain in known_chains.csv"
        if r.kind == "skeleton":
            return "auto", "same name with different spacing or a plural"
        if r.kind in ("glued", "contains"):
            return "auto", "big known chain inside the name"
        # A known chain with 10+ locations owns every name that starts with it: "Sweetgreen Dumbo", "Pizza Hut Wing Street"
        if (
            r.kind in ("other", "code", "descriptor", "descriptor+location")
            and r.anchor_known_chain and r.n_anchor >= 10 and not generic and not cobrand(r.remainder, r.anchor)
        ):
            return "auto", "known chain with 10+ locations plus extra words (location, host or descriptor)"
        # A base name ("Smith", "Sakura", "Serafina") is only auto-merged when it is on the known-chain list
        if r.kind in ("code", "descriptor", "descriptor+location") and not r.anchor_known_chain:
            return "review", "base name not on the known-chain list; search '<name> NYC locations' before merging"
        same_cuisine = r.variant_cuisine in (r.anchor_cuisine, "Unknown") or r.anchor_cuisine == "Unknown"
        if r.kind == "other" and cobrand(r.remainder, r.anchor):
            return "cobrand", f"remainder '{r.remainder}' is itself a brand"
        if generic and r.kind == "other":
            return "skip", "base name is a common word"
        if generic:
            return "review", "generic-sounding base name (could be unrelated shops with a similar name)"
        if r.kind == "spelling":
            return "review", "spelling variant of a larger brand"
        if r.kind in ("code", "descriptor", "descriptor+location"):
            if r.n_anchor >= 3 and same_cuisine and (r.n_anchor >= 10 or r.anchor_rarest_word_df < 10):
                return "auto", f"only {r.kind} words added"
            return "review", "small or common-sounding base name, or a different cuisine"
        return "review", "extra words after the brand name"

    lab = [label(r) for r in c.itertuples()]
    c["confidence"] = [x[0] for x in lab]
    c["reason"] = [x[1] for x in lab]

    # Total locations per base name if its auto variants were merged in, and the tier before/after
    merged = c[c["confidence"] == "auto"].groupby("anchor")["n_variant"].sum()
    c["anchor_total_auto"] = c["anchor"].map(n) + c["anchor"].map(merged).fillna(0).astype(int)
    t = lambda x: tier_of(int(x), args.mini_min, args.chain_min, args.big_min)  # noqa: E731
    c["anchor_tier_now"] = c["n_anchor"].map(t)
    c["anchor_tier_if_auto_merged"] = c["anchor_total_auto"].map(t)
    c["variant_tier_now"] = c["n_variant"].map(t)
    order = {"auto": 0, "cobrand": 1, "review": 2, "skip": 3}
    c = c.sort_values(["confidence", "n_anchor"], key=lambda s: s.map(order) if s.name == "confidence" else -s)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    c.drop(columns=["how"]).to_csv(args.out, index=False)

    print(f"{len(keys):,} distinct normalized names; {len(c):,} candidate variants -> {args.out}")
    print(c["confidence"].value_counts().reindex(order, fill_value=0).to_string())
    a = c[c["confidence"] == "auto"]
    print(f"\nauto: {len(a):,} variant names, {a['n_variant'].sum():,} restaurants, {a['anchor'].nunique():,} base names")
    moved = a.groupby("anchor").agg(
        now=("anchor_tier_now", "first"), after=("anchor_tier_if_auto_merged", "first"), n=("n_anchor", "first"),
        total=("anchor_total_auto", "first"),
    )
    moved = moved[moved["now"] != moved["after"]].sort_values("total", ascending=False)
    print(f"base names that change tier at {args.mini_min}/{args.chain_min}/{args.big_min}: {len(moved)}")
    print(moved.head(25).to_string())


if __name__ == "__main__":
    main()
