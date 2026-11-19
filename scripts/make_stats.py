#!/usr/bin/env python3
"""
Summary tables for the website, computed from the cleaned public/data/restaurants.csv (run preprocess.py first).

    python scripts/make_stats.py

Writes CSVs to public/data/stats/ (all shares are 0-1):
  borough_summary.csv        one row per borough: counts and shares per tier, margin of error, over/under-representation
  borough_neighborhoods.csv  spread of neighborhood chain shares inside each borough (min, quartiles, median, max, mean)
  borough_top_brands.csv     the biggest brands of each tier in each borough
  borough_cuisine.csv        chain share by cuisine for each borough (cuisines with 200+ restaurants citywide)
  tier_cuisine.csv           cuisine mix of each tier citywide
  borough_concentration.csv  how dominant the top brands are inside each borough
  borough_newness.csv        share of locations first inspected in 2025-26 or not yet inspected, by borough and tier
  brands.csv                 every chain brand with 10+ locations: tier, locations, neighborhoods, locations per borough
  neighborhoods.csv          the 233 neighborhoods with 20+ restaurants: counts and shares per tier
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

TIERS = ["independent", "mini_chain", "chain", "big_chain"]
SHORT = {"independent": "independent", "mini_chain": "mini", "chain": "mid", "big_chain": "big"}
BOROS = ["bronx", "brooklyn", "manhattan", "queens", "staten-island"]
MIN_RESTAURANTS = 20  # same as the dashboard


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--restaurants", type=Path, default=root / "public/data/restaurants.csv")
    ap.add_argument("--raw", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--out", type=Path, default=root / "public/data/stats")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    d = pd.read_csv(args.restaurants)
    d = d[d["nbhd_id"].notna()].copy()
    d["is_chain"] = d["tier"] != "independent"
    N = len(d)

    # 1. borough summary
    counts = pd.crosstab(d["boro"], d["tier"]).reindex(index=BOROS, columns=TIERS, fill_value=0)
    n = counts.sum(axis=1)
    rows = []
    for b in BOROS:
        r = {"borough": b, "restaurants": int(n[b]), "neighborhoods": int(d[d.boro == b].nbhd_id.nunique())}
        for t in TIERS:
            r[f"{SHORT[t]}_count"] = int(counts.at[b, t])
            r[f"{SHORT[t]}_share"] = round(counts.at[b, t] / n[b], 4)
        chain = 1 - counts.at[b, "independent"] / n[b]
        r["chain_count"] = int(n[b] - counts.at[b, "independent"])
        r["chain_share"] = round(chain, 4)
        r["chain_share_moe95"] = round(1.96 * np.sqrt(chain * (1 - chain) / n[b]), 4)
        for t in TIERS[1:]:
            r[f"{SHORT[t]}_vs_fair_share"] = round((counts.at[b, t] / counts[t].sum()) / (n[b] / N), 2)
        rows.append(r)
    city = {"borough": "nyc", "restaurants": N, "neighborhoods": int(d.nbhd_id.nunique())}
    for t in TIERS:
        city[f"{SHORT[t]}_count"] = int(counts[t].sum())
        city[f"{SHORT[t]}_share"] = round(counts[t].sum() / N, 4)
    city["chain_count"] = int(N - counts["independent"].sum())
    city["chain_share"] = round(1 - counts["independent"].sum() / N, 4)
    summary = pd.DataFrame(rows + [city])
    summary.to_csv(args.out / "borough_summary.csv", index=False)

    # 2. neighborhoods (20+ restaurants) and their spread inside each borough
    g = d.groupby(["nbhd_id", "nbhd_name", "boro"]).agg(restaurants=("tier", "size")).reset_index()
    for t in TIERS:
        g[f"{SHORT[t]}_count"] = g["nbhd_id"].map(d[d.tier == t].groupby("nbhd_id").size()).fillna(0).astype(int)
        g[f"{SHORT[t]}_share"] = (g[f"{SHORT[t]}_count"] / g["restaurants"]).round(4)
    g["chain_share"] = (1 - g["independent_share"]).round(4)
    elig = g[g["restaurants"] >= MIN_RESTAURANTS].sort_values("chain_share", ascending=False)
    elig.to_csv(args.out / "neighborhoods.csv", index=False)
    spread = []
    for b in BOROS + ["nyc"]:
        x = elig if b == "nyc" else elig[elig.boro == b]
        for metric in ["chain_share", "mini_share", "mid_share", "big_share"]:
            v = x[metric]
            spread.append({"borough": b, "metric": metric, "neighborhoods": len(x), "min": v.min(), "p25": v.quantile(.25),
                           "median": v.median(), "p75": v.quantile(.75), "max": v.max(), "mean": v.mean()})
    pd.DataFrame(spread).round(4).to_csv(args.out / "borough_neighborhoods.csv", index=False)

    # 3. top brands per borough and tier
    top = []
    for b in BOROS:
        for t in TIERS[1:]:
            x = d[(d.boro == b) & (d.tier == t)]
            vc = x.groupby("brand").agg(locations=("camis", "size"), neighborhoods=("nbhd_id", "nunique")).sort_values(
                "locations", ascending=False).head(10)
            for rank, (brand, row) in enumerate(vc.iterrows(), 1):
                top.append({"borough": b, "tier": SHORT[t], "rank": rank, "brand": brand, "locations": int(row.locations),
                            "neighborhoods": int(row.neighborhoods), "share_of_tier_in_borough": round(row.locations / len(x), 4)})
    pd.DataFrame(top).to_csv(args.out / "borough_top_brands.csv", index=False)

    # 4. cuisine
    skip = {"Unknown", "Other", "Not Listed/Not Applicable"}
    cuis = d[~d.cuisine.isin(skip)]
    big_cuis = cuis.cuisine.value_counts()
    big_cuis = big_cuis[big_cuis >= 200].index
    bc = []
    for b in BOROS + ["nyc"]:
        x = cuis if b == "nyc" else cuis[cuis.boro == b]
        for c in big_cuis:
            y = x[x.cuisine == c]
            if len(y) >= 20:
                bc.append({"borough": b, "cuisine": c, "restaurants": len(y), "chain_share": round(y.is_chain.mean(), 4),
                           "mini_share": round((y.tier == "mini_chain").mean(), 4), "mid_share": round((y.tier == "chain").mean(), 4),
                           "big_share": round((y.tier == "big_chain").mean(), 4)})
    pd.DataFrame(bc).to_csv(args.out / "borough_cuisine.csv", index=False)
    tc = []
    for t in TIERS:
        x = cuis[cuis.tier == t]
        for c, k in x.cuisine.value_counts().head(12).items():
            tc.append({"tier": SHORT[t], "cuisine": c, "restaurants": int(k), "share_of_tier": round(k / len(x), 4)})
    pd.DataFrame(tc).to_csv(args.out / "tier_cuisine.csv", index=False)

    # 5. concentration inside each borough: how much of the chain base is the top brand(s)
    conc = []
    for b in BOROS + ["nyc"]:
        x = d[d.is_chain] if b == "nyc" else d[d.is_chain & (d.boro == b)]
        vc = x.brand.value_counts()
        s = vc / vc.sum()
        conc.append({"borough": b, "chain_locations": len(x), "chain_brands": len(vc), "top_brand": vc.index[0],
                     "top_brand_share": round(s.iloc[0], 4), "top3_share": round(s.head(3).sum(), 4),
                     "top10_share": round(s.head(10).sum(), 4), "herfindahl": round((s ** 2).sum(), 4),
                     "brands_citywide_in_borough": int((d[d.is_chain].groupby("brand").boro.nunique() == 5).sum()) if b == "nyc" else None,
                     "share_from_five_borough_brands": None if b == "nyc" else round(
                         x.brand.isin(d[d.is_chain].groupby("brand").boro.nunique().loc[lambda v: v == 5].index).mean(), 4)})
    pd.DataFrame(conc).to_csv(args.out / "borough_concentration.csv", index=False)

    # 6. newness: first inspection in 2025-26 or not yet inspected (rough opening proxy; the data window starts about 2022)
    raw = pd.read_csv(args.raw, usecols=["CAMIS", "INSPECTION DATE"], dtype={"CAMIS": str}, low_memory=False)
    raw["dt"] = pd.to_datetime(raw["INSPECTION DATE"], errors="coerce")
    first = raw.groupby("CAMIS").dt.min()
    d["camis_s"] = d["camis"].astype(str)
    fs = d["camis_s"].map(first)
    d["new"] = (fs >= "2025-01-01") | (fs < "2000-01-01") | fs.isna()
    nw = []
    for b in BOROS + ["nyc"]:
        x = d if b == "nyc" else d[d.boro == b]
        for t in TIERS + ["all_chains"]:
            y = x[x.is_chain] if t == "all_chains" else x[x.tier == t]
            nw.append({"borough": b, "tier": SHORT.get(t, t), "restaurants": len(y), "new_share": round(y.new.mean(), 4)})
    pd.DataFrame(nw).to_csv(args.out / "borough_newness.csv", index=False)

    # 7. brand table (10+ locations)
    bt = d[d.is_chain].groupby("brand").agg(tier=("tier", "first"), locations=("camis", "size"),
                                              neighborhoods=("nbhd_id", "nunique"), new_share=("new", "mean"),
                                              cuisine=("cuisine", lambda s: s.mode().iat[0]))
    bt = bt[bt.locations >= 10].sort_values("locations", ascending=False)
    for b in BOROS:
        bt[b] = d[d.is_chain & (d.boro == b)].groupby("brand").size().reindex(bt.index).fillna(0).astype(int)
    bt["tier"] = bt["tier"].map(SHORT)
    bt["new_share"] = bt["new_share"].round(3)
    bt.reset_index().to_csv(args.out / "brands.csv", index=False)

    print(f"wrote 9 tables to {args.out}")
    print(summary.to_string(index=False))


if __name__ == "__main__":
    main()
