#!/usr/bin/env python3
"""
Cross-reference the mid-size and big brands against a list of well-known chains, to catch names that only LOOK like a
chain because unrelated shops share a name ("Happy Garden", "China King").

    python scripts/check_known_chains.py            # brands with 10+ locations
    python scripts/check_known_chains.py --min 5

Reads public/data/restaurants.csv and public/data/review/known_chains.csv (columns: brand, aliases separated by |, scope).
Writes public/data/review/brand_verification.csv. A brand is "verified" if it matches the known list (names are normalized
and match exactly or as a prefix); everything else is "unverified" and should be checked by a quick search such as
"<name> restaurant NYC locations". The known list is hand-built and incomplete, so unverified does NOT mean "not a chain".
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from preprocess import normalize_name


def load_known(path: Path) -> list[tuple[str, str, str]]:
    """(normalized alias, canonical brand, scope) triples, longest first. scope 'not_chain' marks names shared by
    unrelated places (generic names, numbered stadium stands, ...)."""
    rows = []
    for r in pd.read_csv(path).fillna("").itertuples():
        for name in [r.brand, *[a for a in str(r.aliases).split("|") if a.strip()]]:
            key = normalize_name(name)
            if key:
                rows.append((key, r.brand, r.scope))
    return sorted(rows, key=lambda p: len(p[0]), reverse=True)


def match_known(key: str, known: list[tuple[str, str, str]]) -> tuple[str, str] | None:
    """(brand, scope) of the first match. Chains match exactly or as a prefix; 'not_chain' names match exactly only."""
    for alias, brand, scope in known:
        if key == alias or (scope != "not_chain" and key.startswith(alias + " ")):
            return brand, scope
    return None


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--restaurants", type=Path, default=root / "public/data/restaurants.csv")
    ap.add_argument("--known", type=Path, default=root / "public/data/review/known_chains.csv")
    ap.add_argument("--out", type=Path, default=root / "public/data/review/brand_verification.csv")
    ap.add_argument("--min", type=int, default=10, help="check brands with at least this many locations")
    args = ap.parse_args()

    d = pd.read_csv(args.restaurants)
    g = d.groupby("brand").agg(
        locations=("camis", "size"), boroughs=("boro", "nunique"), neighborhoods=("nbhd_id", "nunique"),
        cuisine=("cuisine", lambda s: s.mode().iat[0]),
    )
    g = g[g["locations"] >= args.min].sort_values("locations", ascending=False)
    known = load_known(args.known)
    hits = [match_known(normalize_name(b), known) for b in g.index]
    g["known_as"] = [h[0] if h else "" for h in hits]
    g["status"] = ["unverified" if h is None else "not_chain" if h[1] == "not_chain" else "verified" for h in hits]
    # Hints for the manual check: a name spread over many shops of a generic cuisine is the usual false positive
    g["search"] = [f"{b} restaurant NYC locations" for b in g.index]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    g.reset_index().to_csv(args.out, index=False)

    print(f"{len(g)} brands with {args.min}+ locations -> {args.out}")
    print(g["status"].value_counts().to_string())
    for status, title in (("unverified", "unverified (check these)"), ("not_chain", "marked not a chain")):
        sub = g[g["status"] == status]
        print(f"\n{title}:")
        print(sub[["locations", "boroughs", "neighborhoods", "cuisine"]].to_string() if len(sub) else "  none")
    un = g[g["status"] == "unverified"]
    print(f"\nunverified share of locations: {un['locations'].sum() / g['locations'].sum():.1%}")


if __name__ == "__main__":
    main()
