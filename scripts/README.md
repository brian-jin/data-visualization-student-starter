# Mapping the Same-ification of NYC: Python Scripts

These scripts were used for data preprocessing, preparation, and ML model training for deployment in the interactive visualization.
- The preprocessing scripts take NYC Open Data datasets and prepare them for the web app visualization and ML.
- The machine learning scripts are WIP.

## Preprocessing
Assigns restaurants to the NYC neighborhood boundaries and classifies each by how many locations its brand has citywide.

### Data

To begin, save files into `public/data/raw/` with the following names. You can find the data at the links:

- `restaurants_2022_2026.csv`: [DOHMH Restaurant Inspection Results](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j/about_data), Last Updated: Sep 29, 2026, Updates Daily (the current snapshot; the dashboard uses this)
- `restaurants_2016_2022.csv`: an earlier snapshot of the same file (Kaggle copy, record date Mar 23, 2022; inspections 2016-2022), used for the change-over-time tables. Run it with `python scripts/preprocess.py --restaurants public/data/raw/restaurants_2016_2022.csv --out-dir public/data/snapshots/2022-03 --review-dir <scratch>`
- `neighborhoods.geo.json`: [Neighborhood boundaries from Zillow (2017), via Chris Whong (CC BY-SA 4.0)](https://github.com/chriswhong/nyc-neighborhood-boundaries), Last Updated: Jul 19, 2026, Uses Data from Zillow 2017

In the future, my project may consider using the NYC Open Data API to automate a portion of this process, so that the data may be refreshed monthly, or yearly. In current considerations, I am thinking about how this may affect my analysis as I look for temporal data, especially since the restaurants data is updated daily.

### Run

```bash
pip install -r scripts/requirements.txt
python scripts/preprocess.py
```

Flags: `--mini-min 3`, `--chain-min 10`, `--big-min 50`, `--simplify 0.0001` (these are the defaults).

### Categories

| Category | Citywide locations of the same brand |
| --- | --- |
| independent | 1 |
| mini_chain | 3-9 (two similarly named shops are not a chain) |
| chain | 10-49 (mid-size) |
| big_chain | 50+ |

### Outputs (`public/data/`)

- `restaurants.csv`: one row per restaurant: `camis, name, brand, brand_locations, tier, cuisine, lat, lon, nta_id, nta_name, boro, not_yet_inspected`
- `neighborhoods.geo.json`: simplified neighborhood polygons with stats in each feature's properties: `id, name, boro, type, n_restaurants, counts, shares` (counts/shares keyed by category)

### Reviewing Chains

1. Run the script and open `data/review/brand_review.csv` (this file contains every brand with 2+ locations, its raw name variants, and its classification category).
2. If one brand is split across rows (`Blank Street`, `Blank St.`), add it to `data/review/chain_aliases.json`:
   `{ "Blank Street": ["Blank St", "Blank Street Coffee"] }`
   Variants are normalized and match exactly or as a prefix.

### Cleaning brand names (run before `preprocess.py`)

1. `python scripts/find_name_variants.py` lists names that probably belong to one brand ("Popeyes" / "Popeyes Louisiana Kitchen") in `data/review/alias_candidates.csv`, labelled auto / cobrand / review / skip.
2. `python scripts/check_known_chains.py` checks every brand with 10+ locations against `data/review/known_chains.csv` (hand-built, incomplete). Rows with scope `not_chain` mark names shared by unrelated shops ("Happy Garden", "China King").
3. `python scripts/build_aliases.py` writes the approved variants into `data/review/chain_aliases.json`. Co-branded stores ("Dunkin Jimmy Johns") count for the brand named first. Names under `_not_chains` stay one-offs.
4. Trailing numbers are dropped from names ("Sweetgreen 2") except after words like STAND, BAR, CAFE, UNIT, TABLE, where the number tells places apart.

### Timeline (feeds the Week 13 year slider)

`python scripts/build_timeline.py` pools both raw snapshots into `public/data/restaurants_timeline.csv`: every restaurant seen in either file, with `first_seen` / `last_seen` inspection dates, `in_latest` (still in the 2026 file), `not_yet_inspected` and `solo` (one-off names). The dashboard decides who is open in a year from those dates and recomputes brand tiers for that year.

### Notes

- One row per restaurant (`CAMIS`); the source has one row per violation.
- Brands are matched on a normalized name (uppercase, no punctuation, no suffixes such as LLC/INC, no store numbers, etc.), then merged using the alias file.
- Counts are citywide within NYC only, and the DOHMH file only includes currently active restaurants. Temporal data will need to be found, if possible.