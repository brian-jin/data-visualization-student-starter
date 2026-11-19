#!/usr/bin/env python3
"""
Change over time: the March 2022 snapshot (restaurants_2016_2022.csv) against the September 2026 snapshot.

    python scripts/preprocess.py                                   # 2026 -> public/data/
    python scripts/preprocess.py --restaurants public/data/raw/restaurants_2016_2022.csv \
        --out-dir public/data/snapshots/2022-03 --review-dir <any scratch folder>
    python scripts/make_temporal_stats.py

Both snapshots go through the same cleaning (aliases, cutoffs 3 / 10 / 50 applied inside each snapshot). DOHMH lists only
restaurants active on each file's record date, so each file is a snapshot of open restaurants. Two caveats: the 2022 file followed the
COVID inspection pause (many restaurants had no recent inspection), and a restaurant that changes owner usually gets a new CAMIS id.

Writes public/data/stats/temporal_*.csv (shares are 0-1).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from preprocess import apply_alias, load_aliases, load_not_chains, normalize_name

BOROS = ["bronx", "brooklyn", "manhattan", "queens", "staten-island"]
TIERS = ["independent", "mini_chain", "chain", "big_chain"]
SHORT = {"independent": "independent", "mini_chain": "mini", "chain": "mid", "big_chain": "big", "absent": "absent"}
SNAP = {"2022": pd.Timestamp("2022-03-23"), "2026": pd.Timestamp("2026-09-29")}


def load(path: Path, raw: Path, snap: pd.Timestamp, aliases: Path) -> pd.DataFrame:
    d = pd.read_csv(path)
    d["camis"] = d["camis"].astype(str)
    d["is_chain"] = d["tier"] != "independent"
    # brand key with the same cleaning as preprocess.py, so brand names line up between snapshots
    lookup, nots = load_aliases(aliases), load_not_chains(aliases)
    norm = d["name"].map(normalize_name)
    mapped = {n: apply_alias(n, lookup) for n in norm.unique()}
    d["key"] = norm.map(mapped)
    d.loc[d["key"].isin(nots) | (d["key"] == ""), "key"] = "__ONE_" + d["camis"]
    # last real inspection date, to tell restaurants that were still being inspected from ones that went quiet
    r = pd.read_csv(raw, usecols=["CAMIS", "INSPECTION DATE"], dtype={"CAMIS": str}, low_memory=False)
    r["dt"] = pd.to_datetime(r["INSPECTION DATE"], errors="coerce")
    r = r[r["dt"].dt.year > 1900]
    d["last_insp"] = d["camis"].map(r.groupby("CAMIS")["dt"].max())
    d["first_insp"] = d["camis"].map(r.groupby("CAMIS")["dt"].min())
    d["recent"] = (snap - d["last_insp"]).dt.days <= 730  # inspected in the 2 years before the snapshot
    d["recent"] |= d["not_yet_inspected"].fillna(False).astype(bool)
    return d


def kpis(d: pd.DataFrame, label: str) -> pd.DataFrame:
    rows = []
    for b in BOROS + ["nyc"]:
        x = d if b == "nyc" else d[d.boro == b]
        chains = x[x.is_chain]
        vc = chains["key"].value_counts()
        s = vc / vc.sum()
        rows.append({
            "snapshot": label, "borough": b, "restaurants": len(x), "chain_locations": len(chains),
            "chain_share": chains.shape[0] / len(x),
            "mini_share": (x.tier == "mini_chain").mean(), "mid_share": (x.tier == "chain").mean(),
            "big_share": (x.tier == "big_chain").mean(), "chain_brands": len(vc),
            "dunkin_share_of_chains": (chains["key"] == "DUNKIN").mean(), "top3_share": s.head(3).sum(),
            "top10_share": s.head(10).sum(), "herfindahl": (s ** 2).sum(),
        })
    return pd.DataFrame(rows)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--new", type=Path, default=root / "public/data/restaurants.csv")
    ap.add_argument("--old", type=Path, default=root / "public/data/snapshots/2022-03/restaurants.csv")
    ap.add_argument("--raw-new", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--raw-old", type=Path, default=root / "public/data/raw/restaurants_2016_2022.csv")
    ap.add_argument("--aliases", type=Path, default=root / "public/data/review/chain_aliases.json")
    ap.add_argument("--out", type=Path, default=root / "public/data/stats")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    a = load(args.old, args.raw_old, SNAP["2022"], args.aliases)
    b = load(args.new, args.raw_new, SNAP["2026"], args.aliases)
    out = args.out

    # 1. KPIs in each snapshot, their change, and a version limited to restaurants still being inspected
    k = pd.concat([kpis(a, "2022-03"), kpis(b, "2026-09"), kpis(a[a.recent], "2022-03_recent"),
                   kpis(b[b.recent], "2026-09_recent")])
    k.round(4).to_csv(out / "temporal_kpis.csv", index=False)
    for suffix, (s0, s1) in {"": ("2022-03", "2026-09"), "_recent": ("2022-03_recent", "2026-09_recent")}.items():
        p0 = k[k.snapshot == s0].set_index("borough")
        p1 = k[k.snapshot == s1].set_index("borough")
        ch = (p1.drop(columns="snapshot") - p0.drop(columns="snapshot"))
        ch.columns = [c + "_change" for c in ch.columns]
        pd.concat([p0.drop(columns="snapshot").add_suffix("_2022"), p1.drop(columns="snapshot").add_suffix("_2026"), ch],
                  axis=1).round(4).reset_index().to_csv(out / f"temporal_kpi_change{suffix}.csv", index=False)

    # 2. brand-level change
    def brand_table(d):
        g = d.groupby("key").agg(locations=("camis", "size"), tier=("tier", "first"), label=("brand", lambda s: s.mode().iat[0]))
        return g[~g.index.str.startswith("__ONE_")]
    ba, bb = brand_table(a), brand_table(b)
    br = ba.join(bb, how="outer", lsuffix="_2022", rsuffix="_2026")
    br["locations_2022"] = br["locations_2022"].fillna(0).astype(int)
    br["locations_2026"] = br["locations_2026"].fillna(0).astype(int)
    br["tier_2022"] = br["tier_2022"].fillna("absent")
    br["tier_2026"] = br["tier_2026"].fillna("absent")
    br["label"] = br["label_2026"].fillna(br["label_2022"])
    br["change"] = br["locations_2026"] - br["locations_2022"]
    br["pct_change"] = (br["change"] / br["locations_2022"].replace(0, np.nan)).round(3)
    br = br.drop(columns=["label_2022", "label_2026"]).reset_index().rename(columns={"key": "brand_key"})
    for c in ("tier_2022", "tier_2026"):
        br[c] = br[c].map(SHORT)
    keep = br[(br.locations_2022 >= 10) | (br.locations_2026 >= 10)].sort_values("change", ascending=False)
    keep.to_csv(out / "temporal_brand_change.csv", index=False)

    # tier migration of brands (rows: tier in 2022, columns: tier in 2026), chains only plus 'independent' and 'absent'
    mig = pd.crosstab(br["tier_2022"], br["tier_2026"])
    mig.to_csv(out / "temporal_brand_tier_migration.csv")

    # 3. restaurant flow by CAMIS: who is still there, who left, who is new
    sa, sb = set(a.camis), set(b.camis)
    flows = []
    for scope, da in (("all", a), ("recent_2yr", a[a.recent])):
        for borough in BOROS + ["nyc"]:
            xa = da if borough == "nyc" else da[da.boro == borough]
            for t in TIERS + ["any_chain"]:
                y = xa[xa.is_chain] if t == "any_chain" else xa[xa.tier == t]
                if len(y):
                    flows.append({"scope_2022": scope, "borough": borough, "tier_2022": SHORT.get(t, t),
                                  "restaurants_2022": len(y), "still_listed_2026": round(y.camis.isin(sb).mean(), 4)})
    pd.DataFrame(flows).to_csv(out / "temporal_persistence.csv", index=False)
    ent = []
    for borough in BOROS + ["nyc"]:
        xb = b if borough == "nyc" else b[b.boro == borough]
        for t in TIERS + ["any_chain"]:
            y = xb[xb.is_chain] if t == "any_chain" else xb[xb.tier == t]
            if len(y):
                ent.append({"borough": borough, "tier_2026": SHORT.get(t, t), "restaurants_2026": len(y),
                            "not_listed_in_2022": round((~y.camis.isin(sa)).mean(), 4)})
    pd.DataFrame(ent).to_csv(out / "temporal_entrants.csv", index=False)

    # 4. how good is the "first inspected 2025-26" newness proxy used elsewhere?
    new_proxy = (b["first_insp"] >= "2025-01-01") | b["not_yet_inspected"].fillna(False).astype(bool)
    truly_new = ~b.camis.isin(sa)
    val = {"restaurants_2026": len(b), "truly_new_vs_2022": float(truly_new.mean()), "proxy_new": float(new_proxy.mean()),
           "proxy_precision": float((truly_new & new_proxy).sum() / new_proxy.sum()),
           "proxy_recall": float((truly_new & new_proxy).sum() / truly_new.sum())}
    pd.DataFrame([val]).round(4).to_csv(out / "temporal_proxy_check.csv", index=False)

    # 5. neighborhoods: change in chain share (20+ restaurants in both snapshots)
    def nb(d):
        g = d.groupby(["nbhd_id", "nbhd_name", "boro"]).agg(restaurants=("camis", "size"), chain_share=("is_chain", "mean"),
                                                            big_share=("tier", lambda s: (s == "big_chain").mean()),
                                                            mid_share=("tier", lambda s: (s == "chain").mean()),
                                                            mini_share=("tier", lambda s: (s == "mini_chain").mean()))
        return g
    na, nbb = nb(a), nb(b)
    nj = na.join(nbb, lsuffix="_2022", rsuffix="_2026", how="inner").reset_index()
    nj = nj[(nj.restaurants_2022 >= 20) & (nj.restaurants_2026 >= 20)]
    for c in ("chain_share", "big_share", "mid_share", "mini_share"):
        nj[c + "_change"] = nj[c + "_2026"] - nj[c + "_2022"]
    nj.round(4).sort_values("chain_share_change", ascending=False).to_csv(out / "temporal_neighborhoods.csv", index=False)

    print(f"wrote temporal tables to {out}")
    print(k[k.snapshot.isin(["2022-03", "2026-09"])][["snapshot", "borough", "restaurants", "chain_share", "mini_share", "mid_share",
                                                      "big_share"]].round(4).to_string(index=False))
    print(val)


if __name__ == "__main__":
    main()
