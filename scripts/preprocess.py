#!/usr/bin/env python3
"""
Assign NYC restaurants to neighborhoods (Zillow-derived polygons from chriswhong/nyc-neighborhood-boundaries, CC BY-SA 4.0) and classify each one by how many locations its brand has citywide.
See README.md for more information.
"""
from __future__ import annotations

import argparse
import json
import re
import string
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

TIERS = ["independent", "mini_chain", "chain", "big_chain"]
LEGAL_SUFFIXES = {"LLC", "INC", "CORP", "CORPORATION", "CO", "LTD", "LP", "LLP", "DBA"}
# A trailing number after one of these words is part of the name (a numbered stand, bar or unit), not a store number.
# Without this, every "STAND 205", "BAR 13" and "CAFE 9" would collapse into one fake brand.
NUMBERED_PLACE_WORDS = {"STAND", "BAR", "CAFE", "UNIT", "TABLE", "KIOSK", "CART", "ROOM", "SUITE", "FLOOR", "GATE", "TERMINAL"}

# Rough NYC boundaries used to drop outlier coordinates
LAT_RANGE = (40.45, 40.95)
LON_RANGE = (-74.30, -73.65)


# Normalization
def normalize_name(raw: object) -> str:
    """Matching key only: uppercase, no punctuation & legal suffixes & store numbers."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return ""
    s = str(raw).upper().replace("&", " AND ")
    s = re.sub(r"['\u2019`]", "", s)  # JOE'S -> JOES
    s = re.sub(r"#\s*\d+", " ", s)  # "#12"
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)  # punctuation is changed to spaces
    tokens = [t for t in s.split() if t not in LEGAL_SUFFIXES]
    if len(tokens) > 1 and tokens[0] == "THE":
        tokens = tokens[1:]
    # "SWEETGREEN 2" -> "SWEETGREEN", but not "STAND 107" / "BAR 13" / "CAFE 9": there the number tells places apart
    while len(tokens) > 1 and tokens[-1].isdigit() and tokens[-2] not in NUMBERED_PLACE_WORDS:
        tokens.pop()
    return " ".join(tokens)


def clean_display(raw: object) -> str:
    """For showing restaurant names: keep punctuation and 'The' but drop store numbers and LLC/INC."""
    s = re.sub(r"#\s*\d+", " ", str(raw))
    s = re.sub(r"[,\s]+(LLC|INC|CORP|LTD)\.?(?=\s|$)", " ", s, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", s).strip(" ,")


def load_not_chains(path: Path) -> set[str]:
    """Names shared by unrelated places ("Happy Garden"): each stays a one-off even if many share the name.
    Listed under "_not_chains" in the alias file; matched exactly after normalization."""
    if not path.exists():
        return set()
    return {normalize_name(n) for n in json.loads(path.read_text()).get("_not_chains", [])}


def load_aliases(path: Path) -> list[tuple[str, str, bool]]:
    """{ "Canonical": ["variant", ...], ... } -> (normalized alias, normalized canonical, exact_only), longest first.
    A name starting with "=" matches exactly only; others also match as a prefix ("SWEETGREEN" covers "SWEETGREEN DUMBO")."""
    if not path.exists():
        print(f"no alias file at {path}; matching on normalized names only")
        return []
    rows = []
    for canonical, variants in json.loads(path.read_text()).items():
        if canonical.startswith("_"):
            continue
        canon = normalize_name(canonical.lstrip("="))
        for v in [canonical, *variants]:
            alias = normalize_name(v.lstrip("="))
            if alias:
                rows.append((alias, canon, v.startswith("=")))
    return sorted(rows, key=lambda p: len(p[0]), reverse=True)


def apply_alias(name: str, lookup: list[tuple[str, str, bool]]) -> str:
    for alias, canonical, exact in lookup:
        if name == alias:
            return canonical
        # also the alias followed by more words ("SWEETGREEN DUMBO") or glued-on digits ("DUNKIN99")
        if not exact and (name.startswith(alias + " ") or (name.startswith(alias) and name[len(alias):].isdigit())):
            return canonical
    return name


# Loading
def address_key(df: pd.DataFrame) -> pd.Series:
    """Building + street + zip, upper-cased with single spaces; empty when the address is missing."""
    def clean(col):
        return df[col].fillna("").astype(str).str.upper().str.replace(r"\s+", " ", regex=True).str.strip()
    key = clean("BUILDING") + "|" + clean("STREET") + "|" + clean("ZIPCODE")
    return key.where((clean("BUILDING") != "") & (clean("STREET") != ""), "")


def merge_same_address(df: pd.DataFrame) -> pd.DataFrame:
    """One restaurant per (brand, address). A theater, stadium or food hall often holds several permits (CAMIS ids) for the same
    brand at the same address: a concession stand, a bar, a 3rd-floor cafe, or an old permit that was never retired. Those are one
    location, so keep the most recently inspected permit (a real inspection beats a permit-only record)."""
    solo = df["brand_key"].str.startswith("__UNNAMED_")
    eligible = (df["addr_key"] != "") & ~solo
    order = df.assign(_rank=df["not_yet_inspected"].astype(int)).sort_values(
        ["_rank", "INSPECTION DATE"], ascending=[False, True]
    )  # permit-only first, newest inspection last, so keep="last" picks the best record
    dup = order[eligible.reindex(order.index)].duplicated(["brand_key", "addr_key"], keep="last")
    drop = dup[dup].index
    print(f"  Merged {len(drop):,} extra permits at the same brand + address (theaters, stadiums, food halls, re-registrations)")
    return df.drop(index=drop)


def load_restaurants(path: Path) -> pd.DataFrame:
    usecols = ["CAMIS", "DBA", "BUILDING", "STREET", "ZIPCODE", "CUISINE DESCRIPTION", "INSPECTION DATE", "Latitude", "Longitude"]
    df = pd.read_csv(path, usecols=usecols, dtype={"CAMIS": str}, low_memory=False)
    n_rows = len(df)

    df["INSPECTION DATE"] = pd.to_datetime(df["INSPECTION DATE"], errors="coerce")
    # The source has one row per violation so keep the most recent row per restaurant
    df = df.sort_values("INSPECTION DATE").drop_duplicates("CAMIS", keep="last").copy()
    print(f"Restaurant Violations: {n_rows:,} rows, Unique Restaurants (CAMIS): {len(df):,}")

    # 1/1/1900 = applied for a permit but the restaurant is not yet inspected. Keep but flag
    df["not_yet_inspected"] = df["INSPECTION DATE"].dt.year == 1900

    df["lat"] = pd.to_numeric(df["Latitude"], errors="coerce")
    df["lon"] = pd.to_numeric(df["Longitude"], errors="coerce")
    ok = df["lat"].between(*LAT_RANGE) & df["lon"].between(*LON_RANGE)
    print(f"  Dropped {(~ok).sum():,} with missing/invalid coordinates")
    df = df[ok].copy()

    df["cuisine"] = df["CUISINE DESCRIPTION"].fillna("Unknown").astype(str).str.strip()
    df.loc[df["cuisine"] == "", "cuisine"] = "Unknown"
    df["addr_key"] = address_key(df)
    return df[["CAMIS", "DBA", "cuisine", "not_yet_inspected", "lat", "lon", "INSPECTION DATE", "addr_key"]]


def pick_col(columns, candidates) -> str | None:
    lower = {c.lower(): c for c in columns}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


BORO_BY_COUNTY = {
    "NEW YORK": "Manhattan",
    "KINGS": "Brooklyn",
    "QUEENS": "Queens",
    "BRONX": "Bronx",
    "RICHMOND": "Staten Island",
}


def load_nbhds(path: Path) -> gpd.GeoDataFrame:
    """Load neighborhood polygons. Column names are guessed; the columns found are printed."""
    gdf = gpd.read_file(path).to_crs("EPSG:4326")

    name_col = pick_col(gdf.columns, ["name", "neighborhood", "nbhdname", "nbhd_name"])
    if name_col is None:
        raise SystemExit(f"Could not find a neighborhood name column. Columns: {list(gdf.columns)}")
    id_col = pick_col(gdf.columns, ["regionid", "region_id", "id", "nbhd2020", "nbhdcode", "nbhd_code"])
    boro_col = pick_col(gdf.columns, ["boroname", "boro_name", "borough", "boro"])
    county_col = pick_col(gdf.columns, ["county"])

    # Ids must be unique strings. Zillow's RegionID is numeric so fall back to a running number.
    ids = None
    if id_col:
        ids = gdf[id_col].astype(str).str.replace(r"\.0$", "", regex=True)
    if ids is None or ids.duplicated().any():
        ids = pd.Series([f"N{i:03d}" for i in range(len(gdf))], index=gdf.index)

    if boro_col:
        boro = gdf[boro_col]
    elif county_col:
        county = gdf[county_col].astype(str).str.upper().str.replace(" COUNTY", "", regex=False).str.strip()
        boro = county.map(BORO_BY_COUNTY)
    else:
        boro = None

    out = gpd.GeoDataFrame(
        {"id": ids, "name": gdf[name_col].where(gdf[name_col].notna(), ids), "boro": boro, "type": None},
        geometry=gdf.geometry.apply(shapely.make_valid),
        crs="EPSG:4326",
    )
    print(f"Neighborhoods: {len(out)} polygons (name: {name_col}, id: {id_col or 'generated'})")
    return out


# Brands + tiers
def add_tiers(df: pd.DataFrame, aliases: Path, mini_min: int, chain_min: int, big_min: int) -> pd.DataFrame:
    df = df.copy()
    lookup = load_aliases(aliases)
    norm = df["DBA"].map(normalize_name)
    mapping = {n: apply_alias(n, lookup) for n in norm.unique()}
    df["brand_key"] = norm.map(mapping)
    # Blank names and names marked "not a chain" each become their own one-off brand
    blank = (df["brand_key"] == "") | df["brand_key"].isin(load_not_chains(aliases))
    df.loc[blank, "brand_key"] = "__UNNAMED_" + df.loc[blank, "CAMIS"]
    df = merge_same_address(df)

    df["brand_locations"] = df["brand_key"].map(df.groupby("brand_key")["CAMIS"].nunique())
    # Brand label = most common cleaned raw name for that brand
    label = df["DBA"].map(clean_display).groupby(df["brand_key"]).agg(lambda s: s.mode().iat[0])
    df["brand"] = df["brand_key"].map(label).map(lambda x: string.capwords(str(x)))

    df["tier"] = np.select(
        [df["brand_locations"] >= big_min, df["brand_locations"] >= chain_min, df["brand_locations"] >= mini_min],
        ["big_chain", "chain", "mini_chain"],
        default="independent",
    )
    print()
    print("Chain Categories:", df["tier"].value_counts().reindex(TIERS, fill_value=0).to_dict())
    return df


# Write csv for brands that might need review. This is not used by the app but is for manual checking brand matching.
def write_brand_review(df: pd.DataFrame, path: Path) -> None:
    g = df[~df["brand_key"].str.startswith("__UNNAMED_")].groupby("brand_key")
    review = pd.DataFrame(
        {
            "brand": g["brand"].first(),
            "locations": g["CAMIS"].nunique(),
            "raw_name_variants": g["DBA"].nunique(),
            "sample_raw_names": g["DBA"].agg(lambda s: " | ".join(list(dict.fromkeys(s))[:4])),
            "tier": g["tier"].first(),
        }
    )
    review = review[review["locations"] >= 2].sort_values("locations", ascending=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    review.to_csv(path)
    print()
    print(f"Wrote brand review file for manual check. ({len(review):,} brands with 2+ locations)")
    print()

def round_coords(c, nd: int = 5):
    return round(c, nd) if isinstance(c, (int, float)) else [round_coords(x, nd) for x in c]


NEAREST_FT = 300  # points this close to a polygon still get assigned to it


def simplify_for_output(nbhds: gpd.GeoDataFrame, tol: float) -> gpd.GeoDataFrame:
    out = nbhds.copy()
    if tol > 0:
        out["geometry"] = out.geometry.simplify(tol, preserve_topology=True)
    out["geometry"] = out.geometry.apply(lambda g: shapely.set_precision(g, 1e-5))
    return out


def assign_neighborhoods(pts: gpd.GeoDataFrame, nbhds: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Point-in-polygon join. Overlaps -> smallest polygon wins; small gaps -> nearest polygon."""
    polys = nbhds.assign(_area=nbhds.geometry.area)[["id", "_area", "geometry"]]
    joined = gpd.sjoin(pts, polys, how="left", predicate="intersects")
    joined = joined.sort_values("_area", na_position="last")
    joined = joined[~joined.index.duplicated(keep="first")].drop(columns=["index_right"])
    n_direct = int(joined["id"].notna().sum())

    lost = joined["id"].isna()
    n_rescued = 0
    if lost.any():
        near = gpd.sjoin_nearest(
            pts.loc[joined.index[lost]].to_crs("EPSG:2263"),
            polys.to_crs("EPSG:2263"),
            how="left",
            max_distance=NEAREST_FT,
            distance_col="_dist",
        ).sort_values("_dist", na_position="last")
        near = near[~near.index.duplicated(keep="first")]
        found = near[near["id"].notna()]
        joined.loc[found.index, "id"] = found["id"]
        n_rescued = len(found)
    n_dropped = int(joined["id"].isna().sum())
    print()
    print(
        f"Spatial join: {n_direct:,} inside a polygon, {n_rescued:,} within {NEAREST_FT} ft of one (assigned), "
        f"{n_dropped:,} of {len(joined):,} too far from any neighborhood (dropped)"
    )
    return joined.drop(columns=["_area"])


def debug_neighborhood(query: str, nbhds: gpd.GeoDataFrame, joined: gpd.GeoDataFrame) -> None:
    """Explain why a neighborhood has the restaurant count it has."""
    hit = nbhds[nbhds["name"].astype(str).str.contains(query, case=False, na=False)]
    print(f"\nDEBUGGING: neighborhoods matching {query!r}")
    if hit.empty:
        print("No match. Some names:", sorted(nbhds["name"].astype(str))[:25])
        return
    for _, r in hit.iterrows():
        g = r.geometry
        minx, miny, maxx, maxy = g.bounds
        w_km, h_km = (maxx - minx) * 84.3, (maxy - miny) * 111.0  # rough, at NYC's latitude
        print(f"\n{r['name']} ({r['boro']}, id {r['id']}): about {w_km:.2f} km wide x {h_km:.2f} km tall")
        box = joined[joined["lon"].between(minx - 0.003, maxx + 0.003) & joined["lat"].between(miny - 0.003, maxy + 0.003)]
        inside = box[box.geometry.intersects(g)]
        print(f"  restaurants geographically inside this polygon: {len(inside):,}")
        print(f"  restaurants assigned to it in the output:       {int((joined['nbhd_id'] == r['id']).sum()):,}")
        print("  what restaurants in and around its bounding box were assigned to:")
        print(box["nbhd_name"].value_counts().head(8).to_string())
        ov = nbhds[(nbhds["id"] != r["id"]) & (nbhds.geometry.intersection(g).area > 0.05 * g.area)]
        if len(ov):
            print("  polygons overlapping it by more than 5%:", list(ov["name"]))


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--restaurants", type=Path, default=root / "public/data/raw/restaurants_2022_2026.csv")
    ap.add_argument("--nbhd", type=Path, default=root / "public/data/raw/neighborhoods.geo.json")
    ap.add_argument("--aliases", type=Path, default=root / "public/data/review/chain_aliases.json")
    ap.add_argument("--review-dir", type=Path, default=root / "public/data/review")
    ap.add_argument("--out-dir", type=Path, default=root / "public/data/")
    ap.add_argument("--mini-min", type=int, default=3, help="locations for mini_chain (2 similarly named shops are not a chain)")
    ap.add_argument("--chain-min", type=int, default=10, help="locations for chain (mid-size)")
    ap.add_argument("--big-min", type=int, default=50, help="locations for big_chain (established national names)")
    ap.add_argument("--simplify", type=float, default=0.0001, help="polygon simplification tolerance (degrees)")
    ap.add_argument("--debug", metavar="NAME", help="print diagnostics for neighborhoods whose name contains NAME")
    args = ap.parse_args()

    rest = add_tiers(load_restaurants(args.restaurants), args.aliases, args.mini_min, args.chain_min, args.big_min)
    write_brand_review(rest, args.review_dir / "brand_review.csv")
    nbhds = load_nbhds(args.nbhd)

    pts = gpd.GeoDataFrame(rest, geometry=gpd.points_from_xy(rest["lon"], rest["lat"]), crs="EPSG:4326")
    joined = assign_neighborhoods(pts, nbhds).rename(columns={"id": "nbhd_id"})
    joined = joined[joined["nbhd_id"].notna()].copy()

    meta = nbhds.set_index("id")
    joined["nbhd_name"] = joined["nbhd_id"].map(meta["name"])
    joined["boro"] = joined["nbhd_id"].map(meta["boro"])
    if args.debug:
        debug_neighborhood(args.debug, nbhds, joined)

    # Per-neighborhood stats
    all_ids = list(nbhds["id"])
    counts = (
        joined.groupby(["nbhd_id", "tier"]).size().unstack(fill_value=0)
        .reindex(index=all_ids, columns=TIERS, fill_value=0)
    )
    n = counts.sum(axis=1)
    stats = {}
    for nid in all_ids:
        total = int(n[nid])
        stats[nid] = {
            "id": nid,
            "name": meta.at[nid, "name"],
            "boro": meta.at[nid, "boro"],
            "type": meta.at[nid, "type"],
            "n_restaurants": total,
            "counts": {t: int(counts.at[nid, t]) for t in TIERS},
            "shares": {t: round(float(counts.at[nid, t] / total), 4) if total else 0.0 for t in TIERS},
        }

    # Write
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_cols = {
        "CAMIS": "camis", "DBA": "name", "brand": "brand", "brand_locations": "brand_locations",
        "tier": "tier", "cuisine": "cuisine", "lat": "lat", "lon": "lon",
        "nbhd_id": "nbhd_id", "nbhd_name": "nbhd_name", "boro": "boro", "not_yet_inspected": "not_yet_inspected",
    }
    out = joined[list(out_cols)].rename(columns=out_cols)
    out = out.sort_values(["brand_locations", "brand", "nbhd_id"], ascending=[False, True, True])
    out.to_csv(args.out_dir / "restaurants.csv", index=False)
    fc = json.loads(simplify_for_output(nbhds, args.simplify).to_json(drop_id=True))
    for feat in fc["features"]:
        feat["properties"] = stats[feat["properties"]["id"]]  # polygons + stats in one file
        feat["geometry"]["coordinates"] = round_coords(feat["geometry"]["coordinates"])
    (args.out_dir / "nbhd.geo.json").write_text(json.dumps(fc, separators=(",", ":"), allow_nan=False))
    print()
    for f in ("restaurants.csv", "nbhd.geo.json"):
        print(f"Wrote {args.out_dir / f}  ({(args.out_dir / f).stat().st_size / 1024:,.0f} KB)")

    print("\nTop brands by citywide locations:")
    top = out.drop_duplicates("brand").head(15)[["brand", "brand_locations", "tier"]]
    print(top.to_string(index=False))


if __name__ == "__main__":
    main()