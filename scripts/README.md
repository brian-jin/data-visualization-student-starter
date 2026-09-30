# Mapping the Same-ification of NYC: Python Scripts

These scripts were used for data preprocessing, preparation, and ML model training for deployment in the interactive visualization.
- The preprocessing scripts take NYC Open Data datasets and prepare them for the web app visualization and ML.
- The machine learning scripts are WIP.

## Preprocessing
Assigns restaurants to the NYC neighborhood boundaries and classifies each by how many locations its brand has citywide.

### Data

To begin, save files into `public/data/raw/` with the following names. You can find the data at the links:

- `restaurants.csv`: [DOHMH Restaurant Inspection Results](https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j/about_data), Last Updated: Sep 29, 2026, Updates Daily
- `neighborhoods.geo.json`: [Neighborhood boundaries from Zillow (2017), via Chris Whong (CC BY-SA 4.0)](https://github.com/chriswhong/nyc-neighborhood-boundaries), Last Updated: Jul 19, 2026, Uses Data from Zillow 2017

In the future, my project may consider using the NYC Open Data API to automate a portion of this process, so that the data may be refreshed monthly, or yearly. In current considerations, I am thinking about how this may affect my analysis as I look for temporal data, especially since the restaurants data is updated daily.

### Run

```bash
pip install -r scripts/requirements.txt
python scripts/preprocess.py
```

Flags: `--mini-min 2`, `--chain-min 10`, `--big-min 30`, `--simplify 0.0001`.

### Categories

| Category | Citywide locations of the same brand |
| --- | --- |
| independent | 1 |
| mini_chain | 2-9 |
| chain | 10-29 |
| big_chain | 30+ |

### Outputs (`public/data/`)

- `restaurants.csv`: one row per restaurant: `camis, name, brand, brand_locations, tier, cuisine, lat, lon, nta_id, nta_name, boro, not_yet_inspected`
- `neighborhoods.geo.json`: simplified neighborhood polygons with stats in each feature's properties: `id, name, boro, type, n_restaurants, counts, shares` (counts/shares keyed by category)

### Reviewing Chains

1. Run the script and open `data/review/brand_review.csv` (this file contains every brand with 2+ locations, its raw name variants, and its classification category).
2. If one brand is split across rows (`Blank Street`, `Blank St.`), add it to `data/review/chain_aliases.json`:
   `{ "Blank Street": ["Blank St", "Blank Street Coffee"] }`
   Variants are normalized and match exactly or as a prefix.

### Notes

- One row per restaurant (`CAMIS`); the source has one row per violation.
- Brands are matched on a normalized name (uppercase, no punctuation, no suffixes such as LLC/INC, no store numbers, etc.), then merged using the alias file.
- Counts are citywide within NYC only, and the DOHMH file only includes currently active restaurants. Temporal data will need to be found, if possible.

## Machine Learning
To be added as the project progresses!