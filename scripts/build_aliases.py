#!/usr/bin/env python3
"""
Write the approved brand-name variants into public/data/review/chain_aliases.json (existing entries are kept).

    python scripts/find_name_variants.py     # 1. find candidates (public/data/review/alias_candidates.csv)
    python scripts/build_aliases.py          # 2. turn the approved ones into aliases
    python scripts/preprocess.py             # 3. rebuild the data with them

What is approved:
  - every "auto" row in alias_candidates.csv (known chain + only descriptor/location/code words added),
  - every "spelling" row except the pairs in REJECT_VARIANTS (checked by hand),
  - base names of "cobrand" rows that are known chains, so a co-branded store ("Dunkin Jimmy Johns") counts for the
    brand named first rather than standing alone as a one-location brand,
  - any alias spelled out in known_chains.csv,
  - names marked not_chain in known_chains.csv are written under "_not_chains" (each stays a one-off).
Names are matched as a prefix, so one entry for "Popeyes" also covers "Popeyes Louisiana Kitchen".
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from check_known_chains import load_known, match_known
from preprocess import normalize_name

def skeleton(key: str) -> str:
    s = key.replace(" ", "")
    return s[:-1] if len(s) > 5 and s.endswith("S") else s


# Spelling candidates that are DIFFERENT brands (confirmed by hand)
REJECT_VARIANTS = {"JETS PIZZA", "JOEYS PIZZA", "SMASHY BURGER"}
MIN_ALIAS_LEN = 5  # a shorter known alias ("Dig") would prefix-match unrelated names


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", type=Path, default=root / "public/data/review/alias_candidates.csv")
    ap.add_argument("--known", type=Path, default=root / "public/data/review/known_chains.csv")
    ap.add_argument("--manual", type=Path, default=root / "public/data/review/chain_aliases_manual.json",
                    help="hand-written aliases that are always kept")
    ap.add_argument("--aliases", type=Path, default=root / "public/data/review/chain_aliases.json")
    args = ap.parse_args()

    known = load_known(args.known)
    cand = pd.read_csv(args.candidates, keep_default_na=False)
    # Start from the hand-written entries only, so removed candidates do not linger in the generated file
    aliases = json.loads(args.manual.read_text()) if args.manual.exists() else {}
    existing = {normalize_name(c): c for c in aliases if not c.startswith("_")}

    def canonical(key: str) -> str:
        """The known chain's own name when the key belongs to one, else the key itself in title case."""
        hit = match_known(key, known)
        if hit and hit[1] != "not_chain":
            return hit[0]
        if key in existing:
            return existing[key]
        for ek, name in existing.items():  # same name with different spacing/plural already has an entry
            if skeleton(ek) == skeleton(key):
                return name
        return key.title()

    def add(canon: str, variant: str | None, exact: bool = False) -> None:
        """exact=True writes the variant as "=name": it matches only that whole name, never as a prefix."""
        name = existing.get(normalize_name(canon)) or canon
        existing[normalize_name(canon)] = name
        lst = aliases.setdefault(name, [])
        covered = variant and not exact and normalize_name(variant).startswith(normalize_name(name) + " ")
        if variant and not covered and normalize_name(variant) != normalize_name(name):
            entry = ("=" if exact else "") + variant
            if entry not in lst:
                lst.append(entry)

    # Spelling fixes need a known chain as the base ("Lucky" must not become "Lucky's"); all non-prefix variants are exact-only
    spelling_ok = cand["confidence"].eq("review") & cand["kind"].eq("spelling") & cand["anchor_known_chain"].ne("")
    keep = cand["confidence"].eq("auto") | (spelling_ok & ~cand["variant"].isin(REJECT_VARIANTS))
    for r in cand[keep].itertuples():
        canon = canonical(r.anchor)
        exact = r.kind in ("spelling", "skeleton", "glued", "contains")
        add(canon, r.variant, exact=exact)
        if normalize_name(canon) != r.anchor:
            add(canon, r.anchor.title(), exact=exact)  # the base name itself belongs to the same brand
    for r in cand[cand["confidence"].eq("cobrand") & cand["anchor_known_chain"].ne("")].itertuples():
        add(canonical(r.anchor), None)
    for r in pd.read_csv(args.known).fillna("").itertuples():
        if r.scope == "not_chain":
            continue
        for a in [x for x in str(r.aliases).split("|") if len(normalize_name(x)) >= MIN_ALIAS_LEN]:
            add(r.brand, a)

    not_chains = sorted(pd.read_csv(args.known).fillna("").query("scope == 'not_chain'")["brand"])
    out = {"_note": aliases.get("_note", ""), "_not_chains": not_chains}
    out.update({k: v for k, v in sorted(aliases.items(), key=lambda kv: kv[0].lower()) if not k.startswith("_")})
    args.aliases.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    n_var = sum(len(v) for k, v in out.items() if not k.startswith("_"))
    print(f"wrote {args.aliases}: {len(out) - 2} brands, {n_var} variants, {len(not_chains)} not-chain names")


if __name__ == "__main__":
    main()
