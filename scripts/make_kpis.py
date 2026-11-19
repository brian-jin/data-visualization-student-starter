#!/usr/bin/env python3
"""
KPI scorecard from the two snapshots (March 2022 and September 2026).

    python scripts/make_kpis.py

Needs public/data/restaurants.csv (2026) and public/data/snapshots/2022-03/restaurants.csv (see make_temporal_stats.py).
Writes public/data/stats/kpis.csv (long format, one row per KPI x scope) with columns:
  group, kpi_id, kpi, scope, unit, value_2022, value_2026, change, definition, how_to_read
State KPIs have both values and a change; period KPIs (survival, entrants, brand growth) describe 2022 to 2026 as a whole and
only fill value_2026 (with value_2022 empty). Scopes are nyc and the five boroughs. Shares are 0-1; "pts" changes are in
percentage points. Both files list only restaurants active on their pull dates.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from make_temporal_stats import BOROS, SNAP, load

MIN_RESTAURANTS = 20  # neighborhoods compared, same as the dashboard


def state_kpis(d: pd.DataFrame, scope: str, five_brands: set[str]) -> dict[str, float]:
    x = d if scope == "nyc" else d[d.boro == scope]
    chains = x[x.is_chain]
    vc = chains["key"].value_counts()
    s = vc / vc.sum()
    g = x.groupby("nbhd_id").agg(n=("camis", "size"), chain=("is_chain", "mean"),
                                   big=("tier", lambda t: (t == "big_chain").mean()))
    g = g[g.n >= MIN_RESTAURANTS]
    return {
        "restaurants": len(x),
        "chain_penetration": len(chains) / len(x),
        "mini_share": (x.tier == "mini_chain").mean(),
        "mid_share": (x.tier == "chain").mean(),
        "big_share": (x.tier == "big_chain").mean(),
        "chain_brands": len(vc),
        "top_brand_share": s.iloc[0],
        "top10_share": s.head(10).sum(),
        "herfindahl": (s ** 2).sum(),
        "national_brand_reliance": chains["key"].isin(five_brands).mean(),
        "median_nbhd_chain_share": g.chain.median(),
        "pct_nbhds_40plus_chain": (g.chain >= 0.40).mean(),
        "pct_nbhds_15plus_big": (g.big >= 0.15).mean(),
        "nbhds_compared": len(g),
    }


DEFS = {
    "chain_penetration": ("Market structure", "Chain penetration", "share of restaurants",
                          "Restaurants whose brand has 3+ locations citywide, divided by all restaurants.",
                          "Higher = more chain-heavy. Bronx and Manhattan tie; Brooklyn is lowest."),
    "mini_share": ("Market structure", "Mini-chain share (3-9 locations)", "share of restaurants",
                   "Restaurants in brands with 3 to 9 citywide locations.", "Small multi-location brands; Manhattan leads."),
    "mid_share": ("Market structure", "Mid-size chain share (10-49)", "share of restaurants",
                  "Restaurants in brands with 10 to 49 citywide locations.", "Scaling brands (Blank Street, Sweetgreen)."),
    "big_share": ("Market structure", "Big-chain share (50+)", "share of restaurants",
                  "Restaurants in brands with 50+ citywide locations.", "Established national names; the Bronx leads."),
    "chain_brands": ("Brand diversity", "Distinct chain brands", "brands",
                     "Brands with 3+ locations in the snapshot.", "Higher = a more varied chain landscape."),
    "top_brand_share": ("Brand concentration", "Top brand's share of chain locations (Dunkin)", "share of chain locations",
                        "Locations of the largest chain brand divided by all chain locations.",
                        "Higher = chains depend on one name; Staten Island and the Bronx are highest."),
    "top10_share": ("Brand concentration", "Top 10 brands' share of chain locations", "share of chain locations",
                    "Locations of the 10 largest chain brands divided by all chain locations.", "Lower = more diverse."),
    "herfindahl": ("Brand concentration", "Herfindahl index of chain locations", "index 0-1",
                   "Sum of squared brand shares of chain locations.", "Higher = more concentrated."),
    "national_brand_reliance": ("Brand concentration", "Chain locations from five-borough brands", "share of chain locations",
                                "Share of chain locations belonging to brands present in all five boroughs.",
                                "High in the Bronx and Staten Island, low in Manhattan."),
    "median_nbhd_chain_share": ("Neighborhood spread", "Median neighborhood chain share", "share of restaurants",
                                "Median chain share across neighborhoods with 20+ restaurants.", "Typical neighborhood, not the pooled borough."),
    "pct_nbhds_40plus_chain": ("Neighborhood spread", "Neighborhoods at 40%+ chains", "share of neighborhoods",
                               "Neighborhoods (20+ restaurants) where at least 40% of restaurants are chains.", "A hot-spot count."),
    "pct_nbhds_15plus_big": ("Neighborhood spread", "Neighborhoods at 15%+ big chains", "share of neighborhoods",
                             "Neighborhoods (20+ restaurants) where at least 15% of restaurants are 50+ location chains.",
                             "Where established chains dominate (mostly the Bronx)."),
}


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--new", type=Path, default=root / "public/data/restaurants.csv")
    ap.add_argument("--old", type=Path, default=root / "public/data/snapshots/2022-03/restaurants.csv")
    ap.add_argument("--raw-new", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--raw-old", type=Path, default=root / "public/data/raw/restaurants_2016_2022.csv")
    ap.add_argument("--aliases", type=Path, default=root / "public/data/review/chain_aliases.json")
    ap.add_argument("--out", type=Path, default=root / "public/data/stats/kpis.csv")
    args = ap.parse_args()

    a = load(args.old, args.raw_old, SNAP["2022"], args.aliases)
    b = load(args.new, args.raw_new, SNAP["2026"], args.aliases)

    def five(d: pd.DataFrame) -> set[str]:
        c = d[d.is_chain].groupby("key").boro.nunique()
        return set(c[c == 5].index)

    fa, fb = five(a), five(b)
    rows = []
    for scope in ["nyc"] + BOROS:
        ka, kb = state_kpis(a, scope, fa), state_kpis(b, scope, fb)
        for k, (grp, name, unit, definition, read) in DEFS.items():
            ch = kb[k] - ka[k]
            rows.append({"group": grp, "kpi_id": k, "kpi": name, "scope": scope, "unit": unit, "value_2022": ka[k],
                         "value_2026": kb[k], "change": ch, "definition": definition, "how_to_read": read})
        rows.append({"group": "Context", "kpi_id": "restaurants", "kpi": "Restaurants (active at the pull date)", "scope": scope,
                     "unit": "restaurants", "value_2022": ka["restaurants"], "value_2026": kb["restaurants"],
                     "change": kb["restaurants"] - ka["restaurants"], "definition": "Restaurants in the cleaned snapshot.",
                     "how_to_read": "Includes restaurants awaiting their first inspection."})

    # Period KPIs: who is still there, who is new, which brands grew
    sa, sb = set(a.camis), set(b.camis)
    for scope in ["nyc"] + BOROS:
        xa = a if scope == "nyc" else a[a.boro == scope]
        xb = b if scope == "nyc" else b[b.boro == scope]
        ch_a, ch_b = xa[xa.is_chain], xb[xb.is_chain]
        in_a, in_b = xa[~xa.is_chain], xb[~xb.is_chain]
        surv_c, surv_i = ch_a.camis.isin(sb).mean(), in_a.camis.isin(sb).mean()
        period = {
            "chain_survival": ("Dynamics", "Chain survival, 2022 to 2026", "share of 2022 chain restaurants",
                               surv_c, "Chain restaurants active in Mar 2022 that are still listed in Sept 2026 (includes id changes).",
                               "Higher = more stable. Compare with independents."),
            "independent_survival": ("Dynamics", "Independent survival, 2022 to 2026", "share of 2022 independents",
                                     surv_i, "Independent restaurants active in Mar 2022 still listed in Sept 2026.",
                                     "About 53% citywide."),
            "survival_gap": ("Dynamics", "Survival gap (chain minus independent)", "percentage points",
                             surv_c - surv_i, "Chain survival minus independent survival.", "Positive = chains last longer."),
            "big_survival": ("Dynamics", "Big-chain survival", "share of 2022 big-chain restaurants",
                             ch_a[ch_a.tier == "big_chain"].camis.isin(sb).mean(), "Same, for 50+ location brands.",
                             "The most stable tier."),
            "entrant_share_chains": ("Dynamics", "Entrant share, chains", "share of 2026 chain restaurants",
                                     (~ch_b.camis.isin(sa)).mean(), "2026 chain restaurants not listed in 2022.",
                                     "Includes brand-new owners of old addresses."),
            "entrant_share_independents": ("Dynamics", "Entrant share, independents", "share of 2026 independents",
                                           (~in_b.camis.isin(sa)).mean(), "2026 independents not listed in 2022.", ""),
            "net_chain_locations": ("Dynamics", "Net change in chain locations", "restaurants",
                                    len(ch_b) - len(ch_a), "Chain restaurants in 2026 minus 2022.", "Positive = chains added."),
            "net_independents": ("Dynamics", "Net change in independents", "restaurants",
                                 len(in_b) - len(in_a), "Independent restaurants in 2026 minus 2022.",
                                 "Compare with chain change: independents also grew."),
        }
        for k, (grp, name, unit, val, definition, read) in period.items():
            rows.append({"group": grp, "kpi_id": k, "kpi": name, "scope": scope, "unit": unit, "value_2022": np.nan,
                         "value_2026": val, "change": np.nan, "definition": definition, "how_to_read": read})

    # Brand movement (citywide only): brands with 10+ locations in either year
    def brand_sizes(d):
        g = d[d.is_chain].groupby("key").agg(n=("camis", "size"), tier=("tier", "first"))
        return g
    ga, gb = brand_sizes(a), brand_sizes(b)
    j = ga.join(gb, how="outer", lsuffix="_22", rsuffix="_26").fillna({"n_22": 0, "n_26": 0})
    big = j[(j.n_22 >= 10) | (j.n_26 >= 10)]
    rank = {"mini_chain": 1, "chain": 2, "big_chain": 3}
    r22, r26 = big.tier_22.map(rank), big.tier_26.map(rank)
    up = (r22.notna() & (r26 > r22)).sum()  # chains in 2022 that are in a higher tier in 2026
    down = (r22.notna() & (r26.fillna(0) < r22)).sum()  # chains in 2022 that are lower in 2026 or no longer a chain
    movers = {
        "brands_10plus": ("Brand movement", "Brands with 10+ locations (2022 / 2026)", "brands", int((j.n_26 >= 10).sum()),
                          "Brands with 10+ locations in 2026 (2022 value in the note).", f"2022: {int((j.n_22 >= 10).sum())}."),
        "brands_growing": ("Brand movement", "Brands that added locations (of those with 10+ in either year)", "brands",
                           int((big.n_26 > big.n_22).sum()), "Brands whose location count rose.", ""),
        "brands_shrinking": ("Brand movement", "Brands that lost locations (of those with 10+ in either year)", "brands",
                             int((big.n_26 < big.n_22).sum()), "Brands whose location count fell.", ""),
        "brands_moving_up": ("Brand movement", "Brands that moved up a tier", "brands", int(up),
                             "Brands that were mini or mid-size in 2022 and are in a higher tier in 2026.", "Growth signal."),
        "brands_moving_down": ("Brand movement", "Brands that moved down a tier or disappeared", "brands", int(down),
                               "Brands in a higher tier in 2022 than in 2026 (or gone).", "Contraction signal."),
    }
    for k, (grp, name, unit, val, definition, read) in movers.items():
        rows.append({"group": grp, "kpi_id": k, "kpi": name, "scope": "nyc", "unit": unit, "value_2022": np.nan, "value_2026": val,
                     "change": np.nan, "definition": definition, "how_to_read": read})

    # Neighborhood movement: share of compared neighborhoods where chain share rose
    def nb(d):
        g = d.groupby(["nbhd_id", "boro"]).agg(n=("camis", "size"), chain=("is_chain", "mean")).reset_index()
        return g
    n1 = nb(a).merge(nb(b), on=["nbhd_id", "boro"], suffixes=("_22", "_26"))
    n1 = n1[(n1.n_22 >= MIN_RESTAURANTS) & (n1.n_26 >= MIN_RESTAURANTS)]
    n1["d"] = n1.chain_26 - n1.chain_22
    for scope in ["nyc"] + BOROS:
        x = n1 if scope == "nyc" else n1[n1.boro == scope]
        rows.append({"group": "Dynamics", "kpi_id": "pct_nbhds_chain_up", "kpi": "Neighborhoods where chain share rose", "scope": scope,
                     "unit": "share of neighborhoods", "value_2022": np.nan, "value_2026": (x.d > 0).mean(), "change": np.nan,
                     "definition": "Neighborhoods with 20+ restaurants in both snapshots whose chain share is higher in 2026.",
                     "how_to_read": "Breadth of the change, not its size."})
        rows.append({"group": "Dynamics", "kpi_id": "median_nbhd_change", "kpi": "Median neighborhood change in chain share", "scope": scope,
                     "unit": "percentage points", "value_2022": np.nan, "value_2026": x.d.median(), "change": np.nan,
                     "definition": "Median of (2026 chain share minus 2022 chain share) across compared neighborhoods.",
                     "how_to_read": "Typical movement; small neighborhoods swing a lot."})

    out = pd.DataFrame(rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.round(4).to_csv(args.out, index=False)
    print(f"wrote {len(out)} KPI rows to {args.out}")
    nyc = out[out.scope == "nyc"][["kpi_id", "value_2022", "value_2026", "change"]]
    print(nyc.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
