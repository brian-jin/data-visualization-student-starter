#!/usr/bin/env python3
"""
Build public/data/restaurants_timeline.csv: every restaurant seen in EITHER snapshot, with the dates it was first and last
inspected, so the dashboard can show which restaurants existed in each year.

    python scripts/build_timeline.py

Inputs (public/data/raw/): restaurants_2016_2022.csv (record date 2022-03-23) and restaurants_2022_2026.csv (2026-09-29).
Both files list the same kind of records, so inspection dates are pooled per CAMIS id. A restaurant that appears only in
the older file is treated as open on the older record date (DOHMH lists only active restaurants) and as no longer listed
after that: it closed, or was re-registered under a new id after an owner change, some time before the newer record date.
Restaurants in the newer file count as still open.

Columns: camis, name, brand, cuisine, lat, lon, nbhd_id, nbhd_name, boro, first_seen, last_seen, in_latest, not_yet_inspected, solo
(solo = 1 for a one-off: a blank name or a name marked "not a chain", which is never counted as part of a brand)
Brand names use the same cleaning and alias file as preprocess.py; the dashboard recomputes tiers per year from the brand's
number of open locations (3 / 10 / 50), because a brand's size changes over time.
"""
from __future__ import annotations

import argparse
import string
from pathlib import Path

import geopandas as gpd
import pandas as pd

from preprocess import (
    apply_alias, assign_neighborhoods, clean_display, load_aliases, load_nbhds, load_not_chains, load_restaurants,
    normalize_name,
)

SNAPSHOTS = {"old": pd.Timestamp("2022-03-23"), "new": pd.Timestamp("2026-09-29")}


def inspection_dates(path: Path) -> pd.DataFrame:
    r = pd.read_csv(path, usecols=["CAMIS", "INSPECTION DATE"], dtype={"CAMIS": str}, low_memory=False)
    r["dt"] = pd.to_datetime(r["INSPECTION DATE"], errors="coerce")
    return r[r["dt"].dt.year > 1900][["CAMIS", "dt"]]  # 1/1/1900 means "applied for a permit, not inspected yet"


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old", type=Path, default=root / "public/data/raw/restaurants_2016_2022.csv")
    ap.add_argument("--new", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--nbhd", type=Path, default=root / "public/data/raw/neighborhoods.geo.json")
    ap.add_argument("--aliases", type=Path, default=root / "public/data/review/chain_aliases.json")
    ap.add_argument("--out", type=Path, default=root / "public/data/restaurants_timeline.csv")
    args = ap.parse_args()

    new = load_restaurants(args.new)
    old = load_restaurants(args.old)
    new["in_latest"] = True
    old["in_latest"] = False
    # Attributes (name, cuisine, location) come from the newest record we have for each restaurant
    both = pd.concat([new, old[~old["CAMIS"].isin(new["CAMIS"])]], ignore_index=True)
    new_ids = set(pd.read_csv(args.new, usecols=["CAMIS"], dtype={"CAMIS": str})["CAMIS"])
    # ...but a restaurant whose newest row has no usable coordinates cannot be placed on today's map, so it is left out
    unplaceable = both["CAMIS"].isin(new_ids) & ~both["CAMIS"].isin(new["CAMIS"])
    print(f"Dropped {int(unplaceable.sum()):,} restaurants listed in the newer file without usable coordinates")
    both = both[~unplaceable].copy()
    both["source_year"] = both["in_latest"].map({True: SNAPSHOTS["new"].year, False: SNAPSHOTS["old"].year})
    # Permit-only restaurants (never inspected) are kept for the year of the file they came from, like the 3,827 in the newer file,
    # so 2022 and 2026 compare like with like. Older-file ones that never reappear count only for 2022.
    dates = pd.concat([inspection_dates(args.new), inspection_dates(args.old)])
    span = dates.groupby("CAMIS")["dt"].agg(first_seen="min", last_seen="max")
    both = both.join(span, on="CAMIS")
    # Never inspected: no real date, so treat as present only in the year of the file it came from
    for col in ("first_seen", "last_seen"):
        fill = both["source_year"].map(lambda y: pd.Timestamp(year=int(y), month=6, day=30))
        both[col] = both[col].fillna(fill)
    both["last_seen"] = both["last_seen"].where(~both["in_latest"], both["last_seen"].clip(upper=SNAPSHOTS["new"]))
    # DOHMH only lists restaurants that are ACTIVE on the record date, so every restaurant in the older file was open on
    # 2022-03-23 even if its last inspection was years earlier (inspections were rare during COVID). Restaurants missing from
    # the newer file therefore closed (or were re-registered) some time between the two record dates.
    stale = ~both["in_latest"]
    both.loc[stale, "last_seen"] = both.loc[stale, "last_seen"].clip(lower=SNAPSHOTS["old"])
    both.loc[stale, "last_seen"] = SNAPSHOTS["old"]
    both["first_seen"] = both[["first_seen", "last_seen"]].min(axis=1)  # a permit-only restaurant: present on the record date

    # Brands: same cleaning as preprocess.add_tiers
    lookup, nots = load_aliases(args.aliases), load_not_chains(args.aliases)
    norm = both["DBA"].map(normalize_name)
    mapping = {n: apply_alias(n, lookup) for n in norm.unique()}
    both["brand_key"] = norm.map(mapping)
    solo = (both["brand_key"] == "") | both["brand_key"].isin(nots)
    both.loc[solo, "brand_key"] = "__UNNAMED_" + both.loc[solo, "CAMIS"]
    # One place per (brand, address): several permits for the same brand at one address (a theater's concession stands, an old
    # permit that was never retired, or a new permit id after an owner change) are one restaurant whose life spans all of them.
    solo = both["brand_key"].str.startswith("__UNNAMED_")
    elig = (both["addr_key"] != "") & ~solo
    keys = ["brand_key", "addr_key"]
    agg = both[elig].groupby(keys).agg(
        first_seen=("first_seen", "min"), last_seen=("last_seen", "max"), in_latest=("in_latest", "max"),
        not_yet_inspected=("not_yet_inspected", "min"),
    )
    rep = both[elig].sort_values(["in_latest", "last_seen"]).drop_duplicates(keys, keep="last")
    rep = rep.drop(columns=["first_seen", "last_seen", "in_latest", "not_yet_inspected"]).join(agg, on=keys)
    merged = int(elig.sum() - len(rep))
    print(f"Merged {merged:,} extra permits at the same brand + address into one place")
    both = pd.concat([both[~elig], rep], ignore_index=True)
    label = both["DBA"].map(clean_display).groupby(both["brand_key"]).agg(lambda s: s.mode().iat[0])
    both["brand"] = both["brand_key"].map(label).map(lambda x: string.capwords(str(x)))

    # Neighborhoods
    nbhds = load_nbhds(args.nbhd)
    pts = gpd.GeoDataFrame(both, geometry=gpd.points_from_xy(both["lon"], both["lat"]), crs="EPSG:4326")
    joined = assign_neighborhoods(pts, nbhds).rename(columns={"id": "nbhd_id"})
    joined = joined[joined["nbhd_id"].notna()].copy()
    meta = nbhds.set_index("id")
    joined["nbhd_name"] = joined["nbhd_id"].map(meta["name"])
    joined["boro"] = joined["nbhd_id"].map(meta["boro"])

    out = pd.DataFrame({
        "camis": joined["CAMIS"], "name": joined["DBA"], "brand": joined["brand"], "cuisine": joined["cuisine"],
        "lat": joined["lat"].round(5), "lon": joined["lon"].round(5), "nbhd_id": joined["nbhd_id"],
        "nbhd_name": joined["nbhd_name"], "boro": joined["boro"],
        "first_seen": joined["first_seen"].dt.strftime("%Y-%m-%d"), "last_seen": joined["last_seen"].dt.strftime("%Y-%m-%d"),
        "in_latest": joined["in_latest"].astype(int), "not_yet_inspected": joined["not_yet_inspected"].astype(int),
        "solo": joined["brand_key"].str.startswith("__UNNAMED_").astype(int),
    }).sort_values(["brand", "camis"])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.out, index=False)

    yrs = range(2016, 2027)
    first_y, last_y = out["first_seen"].str[:4].astype(int), out["last_seen"].str[:4].astype(int)
    end_y = last_y.where(out["in_latest"] == 0, 2026)
    print(f"\nWrote {args.out}  ({args.out.stat().st_size / 1024:,.0f} KB), {len(out):,} restaurants; {int(out.in_latest.sum()):,} open in 2026")
    print("year  open  first-seen-this-year  last-seen-this-year(not in latest file)")
    for y in yrs:
        print(y, int(((first_y <= y) & (end_y >= y)).sum()), int((first_y == y).sum()), int(((last_y == y) & (out.in_latest == 0)).sum()))


if __name__ == "__main__":
    main()
