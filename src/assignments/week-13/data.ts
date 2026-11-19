// Loads the pipeline outputs in public/data and derives everything the app shows.
// Nothing here is invented: every number comes from nbhd.geo.json, restaurants.csv, or stats/kpis.csv.
import { useCallback, useEffect, useState } from 'react';
import { csvParse, geoMercator, geoPath } from 'd3';
import type { GeoProjection } from 'd3';
import type { FeatureCollection, Geometry } from 'geojson';

export type Tier = 'independent' | 'mini_chain' | 'chain' | 'big_chain';
export type Mode = 'share' | 'mini' | 'mid' | 'big' | 'sim';
export type Bounds = [[number, number], [number, number]];

export const MIN_RESTAURANTS = 20; // neighborhoods below this are mapped but not ranked or colored
export const MIN_CHAIN_RESTAURANTS = 5; // ranked neighborhoods below this get no similarity score: one or two chains make a profile of noise
// Two ways to compare chain lists. 'mix': cosine on location counts (same chains in the same proportions).
// 'set': cosine on present or absent (same chains, however many of each).
export type SimKind = 'mix' | 'set';
export const SIM_KINDS: SimKind[] = ['mix', 'set'];
export const MAP_SIZE = 1000; // side of the square the projection is fitted to
export const CLASSES = 5; // one class per ramp color

export const TIERS: { key: Tier; label: string; range: string; token: string }[] = [
  { key: 'independent', label: 'Independent', range: '1 or 2 locations', token: 'var(--tier-independent)' },
  { key: 'mini_chain', label: 'Mini chain', range: '3 to 9', token: 'var(--tier-mini)' },
  { key: 'chain', label: 'Mid-size chain', range: '10 to 49', token: 'var(--tier-mid)' },
  { key: 'big_chain', label: 'Big chain', range: '50 or more', token: 'var(--tier-big)' },
];
export const BOROS = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten-island'];

interface RawProps {
  id: string;
  name: string | null;
  boro: string | null;
  n_restaurants: number;
  counts: Record<Tier, number>;
  shares: Record<Tier, number>;
}

export interface Nbhd {
  id: string;
  name: string;
  boro: string;
  n: number;
  counts: Record<Tier, number>;
  shares: Record<Tier, number>;
  chainShare: number;
  eligible: boolean;
  chainBrands: number; // distinct chain brands with a location here
  chainCount: number; // chain restaurants here
  simOk: boolean; // ranked and at least MIN_CHAIN_RESTAURANTS chain restaurants
  simScore: number | null; // mean similarity to every other scored neighborhood, for the active SimKind
  simScores: Record<SimKind, number | null>;
  rank: number | null; // by chain share among ranked neighborhoods, 1 = most chains
  idx: number; // row in the similarity matrix, -1 when not ranked
  path: string;
  bounds: Bounds;
  cx: number; // label anchor
  cy: number;
}
export interface Place {
  name: string;
  cuisine: string;
  nbhd: string;
  x: number;
  y: number;
  brand?: string; // the brand this restaurant belongs to (every independent is a brand of one)
  tier?: Tier;
}
export interface Brand {
  name: string;
  key: string; // lowercase, apostrophes removed, for search
  tier: Tier;
  total: number;
  nbhds: Map<string, number>;
  boros: Record<string, number>;
  places: Place[];
}
export interface BoroStat {
  key: string;
  label: string;
  restaurants: number;
  chainShare: number;
  shares: Record<Tier, number>;
  chainBrands: number;
  ranked: number;
  medianShare: number;
  medianSim: number;
  topBrand: string;
  topBrandCount: number;
  rank: number; // among the five boroughs by chain share
  bounds: Bounds;
  label_xy: [number, number];
}
export interface KpiRow {
  v2022: number;
  v2026: number;
  change: number;
}
export interface ChangeRow {
  s22: number; // chain share in the 2022 snapshot
  s26: number;
  n22: number; // restaurants in the 2022 snapshot
  n26: number;
}
export interface Data {
  raw: { geo: FeatureCollection<Geometry, RawProps>; kpiRows: Record<string, string>[]; changeRows: Record<string, string>[] }; // kept so another year can be derived
  cuisines: Map<string, Map<string, number>>; // restaurants per cuisine in each neighborhood
  change: Map<string, ChangeRow>; // 2022 vs 2026, from stats/temporal_neighborhoods.csv (empty if that file is missing)
  nbhds: Nbhd[];
  byId: Map<string, Nbhd>;
  ranked: Nbhd[]; // 20+ restaurants, most chain-heavy first
  brands: Brand[]; // every brand, most locations first
  brandByName: Map<string, Brand>;
  sim: Float32Array; // ranked x ranked similarity for the active SimKind (meaningful only where both are simOk)
  latest?: Data; // for a recounted year: the latest snapshot, which fixes the makeup plot's axes
  simKind: SimKind;
  sims: Record<SimKind, { matrix: Float32Array; median: number; range: [number, number]; boroMedian: Record<string, number> }>;
  simCount: number; // neighborhoods with a similarity score
  boros: BoroStat[];
  boroByKey: Map<string, BoroStat>;
  kpi: Map<string, KpiRow>; // `${scope}:${kpi_id}` from stats/kpis.csv
  bounds: Bounds;
  city: {
    restaurants: number;
    chainShare: number;
    shares: Record<Tier, number>;
    chainBrands: number;
    medianShare: number;
    medianChains: number;
    medianSim: number;
    ranges: { share: [number, number]; chains: [number, number]; sim: [number, number] };
  };
}

export const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(.&])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
export const boroLabel = (b: string) => titleCase(b.replace('-', ' '));
export const flat = (s: string) => s.toLowerCase().replace(/['’`.]/g, '');
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const score = (x: number) => String(Math.round(x * 100));
export const num = (x: number) => x.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// "6 pts above", "3 pts below", "level with"
export function ptsVs(value: number, base: number): string {
  const d = Math.round(value * 100) - Math.round(base * 100);
  if (d === 0) return 'level with';
  return `${Math.abs(d)} ${Math.abs(d) === 1 ? 'pt' : 'pts'} ${d > 0 ? 'above' : 'below'}`;
}

// How many neighborhoods gained or lost chain share between the 2022 and 2026 snapshots (whole points)
export function changeSummary(d: Data) {
  let up = 0;
  let down = 0;
  for (const r of d.change.values()) {
    const pts = Math.round((r.s26 - r.s22) * 100);
    if (pts > 0) up++;
    else if (pts < 0) down++;
  }
  return { up, down, total: d.change.size };
}

export const tierShare = (shares: Record<Tier, number>, mode: Mode) =>
  mode === 'mini' ? shares.mini_chain : mode === 'mid' ? shares.chain : mode === 'big' ? shares.big_chain : 1 - shares.independent;

// Similarity between two scored neighborhoods (0 to 1)
export const simBetween = (d: Data, a: Nbhd, b: Nbhd) => (!a.simOk || !b.simOk ? null : d.sim[a.idx * d.ranked.length + b.idx]);

// The same data with the other similarity measure active. Neighborhood objects are copied so every view reads one measure.
const kindCache = new WeakMap<Data, Partial<Record<SimKind, Data>>>();
export function withSimKind(d: Data, kind: SimKind): Data {
  if (d.simKind === kind) return d;
  let cache = kindCache.get(d);
  if (!cache) kindCache.set(d, (cache = {}));
  const hit = cache[kind];
  if (hit) return hit;
  const s = d.sims[kind];
  const nbhds = d.nbhds.map((n) => ({ ...n, simScore: n.simScores[kind] }));
  const byId = new Map(nbhds.map((n) => [n.id, n]));
  const boros = d.boros.map((b) => ({ ...b, medianSim: s.boroMedian[b.key] ?? 0 }));
  const out: Data = {
    ...d,
    nbhds,
    byId,
    ranked: d.ranked.map((n) => byId.get(n.id)!),
    sim: s.matrix,
    simKind: kind,
    boros,
    boroByKey: new Map(boros.map((b) => [b.key, b])),
    city: { ...d.city, medianSim: s.median, ranges: { ...d.city.ranges, sim: s.range } },
  };
  kindCache.set(out, { [d.simKind]: d });
  cache[kind] = out;
  return out;
}

// The number that colors a neighborhood in a mode. `to` is the selected neighborhood while coloring by similarity.
export function modeValue(d: Data, n: Nbhd, mode: Mode, to: Nbhd | null): number | null {
  if (!n.eligible) return null;
  if (mode !== 'sim') return n.n ? tierShare(n.shares, mode) : null;
  if (to && to.simOk) return n.id === to.id ? null : simBetween(d, to, n);
  return n.simScore;
}

// Four class breaks at the 20th, 40th, 60th and 80th percentiles, rounded to whole points and kept strictly increasing
export function makeBreaks(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return [0.2, 0.4, 0.6, 0.8];
  const out: number[] = [];
  for (let i = 1; i < CLASSES; i++) {
    const q = s[Math.min(s.length - 1, Math.floor((i / CLASSES) * s.length))];
    const prev = out.length ? out[out.length - 1] : 0;
    out.push(Math.max(Math.round(q * 100) / 100, Math.round((prev + 0.01) * 100) / 100));
  }
  return out;
}
export const classOf = (v: number, breaks: number[]) => {
  let c = 0;
  while (c < breaks.length && v >= breaks[c]) c++;
  return c;
};

// The map projection depends only on the boundary file, so every year shares it. It lives here rather than on the data
// object, which keeps the data object plain (a projection is a function with dozens of methods).
const projections = new WeakMap<object, GeoProjection>();

function build(geo: FeatureCollection<Geometry, RawProps>, rows: Record<string, string>[], kpiRows: Record<string, string>[], changeRows: Record<string, string>[], fromRows = false, reuse?: Data): Data {
  // The latest snapshot uses the counts the pipeline wrote into the boundary file. Any other year is counted from its rows.
  const tally = new Map<string, Record<Tier, number>>();
  if (fromRows)
    for (const r of rows) {
      const t = r.tier as Tier;
      if (!r.nbhd_id) continue;
      let c = tally.get(r.nbhd_id);
      if (!c) tally.set(r.nbhd_id, (c = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 }));
      if (t in c) c[t]++;
    }
  // Shapes, outlines and label points do not depend on the year, so a recounted year takes them from the data it was derived from
  let projection = projections.get(geo);
  if (!projection) {
    projection = geoMercator().fitExtent(
      [
        [24, 24],
        [MAP_SIZE - 24, MAP_SIZE - 24],
      ],
      geo,
    );
    projections.set(geo, projection);
  }
  const path = geoPath(projection).digits(2);

  const nbhds: Nbhd[] = geo.features.map((f) => {
    const p = f.properties;
    const shape = reuse?.byId.get(p.id);
    const counts = fromRows ? (tally.get(p.id) ?? { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 }) : p.counts;
    const n = fromRows ? counts.independent + counts.mini_chain + counts.chain + counts.big_chain : p.n_restaurants;
    const shares = fromRows ? { independent: n ? counts.independent / n : 0, mini_chain: n ? counts.mini_chain / n : 0, chain: n ? counts.chain / n : 0, big_chain: n ? counts.big_chain / n : 0 } : p.shares;
    return {
      id: p.id,
      name: p.name ?? 'Unnamed area',
      boro: p.boro ?? '',
      n,
      counts,
      shares,
      chainShare: n ? 1 - shares.independent : 0,
      eligible: n >= MIN_RESTAURANTS,
      chainBrands: 0,
      chainCount: 0,
      simOk: false,
      simScore: null,
      simScores: { mix: null, set: null },
      rank: null,
      idx: -1,
      path: shape?.path ?? path(f) ?? '',
      bounds: shape?.bounds ?? (path.bounds(f) as Bounds),
      cx: shape?.cx ?? path.centroid(f)[0],
      cy: shape?.cy ?? path.centroid(f)[1],
    };
  });
  const byId = new Map(nbhds.map((n) => [n.id, n]));

  // Brands, grouped on the `brand` column the pipeline wrote. The pipeline's `tier` column is the authority on what is a chain.
  const brandByName = new Map<string, Brand>();
  const tierCount: Record<Tier, number> = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 };
  const boroTier = new Map<string, Record<Tier, number>>();
  let total = 0;
  const cuisines = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const name = r.brand?.trim();
    const tier = r.tier as Tier;
    const xy = projection([Number(r.lon), Number(r.lat)]);
    if (!name || !(tier in tierCount) || !xy || !r.nbhd_id) continue;
    total++;
    tierCount[tier]++;
    const cu = r.cuisine?.trim() || 'Unknown';
    let cm = cuisines.get(r.nbhd_id);
    if (!cm) cuisines.set(r.nbhd_id, (cm = new Map()));
    cm.set(cu, (cm.get(cu) ?? 0) + 1);
    let bt = boroTier.get(r.boro);
    if (!bt) boroTier.set(r.boro, (bt = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 }));
    bt[tier]++;
    let b = brandByName.get(name);
    if (!b) brandByName.set(name, (b = { name, key: flat(name), tier, total: 0, nbhds: new Map(), boros: {}, places: [] }));
    else if (tier !== 'independent' && b.tier === 'independent') b.tier = tier;
    b.total++;
    b.nbhds.set(r.nbhd_id, (b.nbhds.get(r.nbhd_id) ?? 0) + 1);
    b.boros[r.boro] = (b.boros[r.boro] ?? 0) + 1;
    b.places.push({ name: titleCase(r.name ?? '') || name, cuisine: r.cuisine?.trim() || 'Unknown', nbhd: r.nbhd_id, x: xy[0], y: xy[1], brand: name, tier });
  }
  const brands = [...brandByName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const chains = brands.filter((b) => b.tier !== 'independent');
  for (const b of chains)
    for (const [id, c] of b.nbhds) {
      const n = byId.get(id);
      if (!n) continue;
      n.chainBrands++;
      n.chainCount += c;
    }

  const ranked = nbhds.filter((n) => n.eligible).sort((a, b) => b.chainShare - a.chainShare || a.name.localeCompare(b.name));
  ranked.forEach((n, i) => {
    n.rank = i + 1;
    n.idx = i;
  });

  // Cosine similarity of chain-brand vectors between every pair of ranked neighborhoods, twice:
  // on location counts ('mix') and on present or absent ('set'). Only neighborhoods with enough chain restaurants are scored.
  const E = ranked.length;
  for (const n of ranked) n.simOk = n.chainCount >= MIN_CHAIN_RESTAURANTS;
  const scored = ranked.filter((n) => n.simOk);
  const dots: Record<SimKind, Float64Array> = { mix: new Float64Array(E * E), set: new Float64Array(E * E) };
  for (const b of chains) {
    const entries: [number, number][] = [];
    for (const [id, c] of b.nbhds) {
      const n = byId.get(id);
      if (n && n.simOk) entries.push([n.idx, c]);
    }
    for (let i = 0; i < entries.length; i++)
      for (let j = i; j < entries.length; j++) {
        const a = entries[i][0] * E + entries[j][0];
        const z = entries[j][0] * E + entries[i][0];
        const v = entries[i][1] * entries[j][1];
        dots.mix[a] += v;
        dots.set[a] += 1;
        if (i !== j) {
          dots.mix[z] += v;
          dots.set[z] += 1;
        }
      }
  }
  const sims = {} as Data['sims'];
  for (const kind of SIM_KINDS) {
    const dot = dots[kind];
    const matrix = new Float32Array(E * E);
    for (const a of scored) {
      const i = a.idx;
      let sum = 0;
      for (const b of scored) {
        const j = b.idx;
        const den = Math.sqrt(dot[i * E + i] * dot[j * E + j]);
        const v = den ? dot[i * E + j] / den : 0;
        matrix[i * E + j] = v;
        if (i !== j) sum += v;
      }
      a.simScores[kind] = scored.length > 1 ? sum / (scored.length - 1) : 0;
    }
    const vals = scored.map((n) => n.simScores[kind]!);
    const boroMedian: Record<string, number> = {};
    for (const key of BOROS) boroMedian[key] = median(scored.filter((n) => n.boro === key).map((n) => n.simScores[kind]!));
    sims[kind] = { matrix, median: median(vals), range: vals.length ? [Math.min(...vals), Math.max(...vals)] : [0, 1], boroMedian };
  }
  for (const n of ranked) n.simScore = n.simScores.mix;
  const sim = sims.mix.matrix;

  const union = (list: Nbhd[]): Bounds =>
    list.reduce<Bounds>(
      (acc, n) => [
        [Math.min(acc[0][0], n.bounds[0][0]), Math.min(acc[0][1], n.bounds[0][1])],
        [Math.max(acc[1][0], n.bounds[1][0]), Math.max(acc[1][1], n.bounds[1][1])],
      ],
      [
        [Infinity, Infinity],
        [-Infinity, -Infinity],
      ],
    );

  // A borough label sits at the area-weighted center of its neighborhoods, not the middle of its bounding box,
  // so outlying strips such as the Rockaways do not drag it off the main landmass
  const areaOf = new Map(geo.features.map((f) => [f.properties.id, path.area(f)]));
  const labelPoint = (list: Nbhd[], bounds: Bounds): [number, number] => {
    let a = 0;
    let x = 0;
    let y = 0;
    for (const n of list) {
      const w = areaOf.get(n.id) ?? 0;
      a += w;
      x += n.cx * w;
      y += n.cy * w;
    }
    return a ? [x / a, y / a] : [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
  };

  const boros: BoroStat[] = BOROS.filter((k) => boroTier.has(k)).map((key) => {
    const t = boroTier.get(key)!;
    const restaurants = t.independent + t.mini_chain + t.chain + t.big_chain;
    const mine = ranked.filter((n) => n.boro === key);
    const all = nbhds.filter((n) => n.boro === key);
    const inBoro = chains.filter((b) => b.boros[key]);
    const top = [...inBoro].sort((a, b) => b.boros[key] - a.boros[key])[0];
    const bounds = union(all);
    return {
      key,
      label: boroLabel(key),
      restaurants,
      chainShare: restaurants ? 1 - t.independent / restaurants : 0,
      shares: { independent: t.independent / restaurants, mini_chain: t.mini_chain / restaurants, chain: t.chain / restaurants, big_chain: t.big_chain / restaurants },
      chainBrands: inBoro.length,
      ranked: mine.length,
      medianShare: median(mine.map((n) => n.chainShare)),
      medianSim: sims.mix.boroMedian[key] ?? 0,
      topBrand: top?.name ?? '',
      topBrandCount: top?.boros[key] ?? 0,
      rank: 0,
      bounds,
      label_xy: labelPoint(all, bounds),
    };
  });
  [...boros].sort((a, b) => b.chainShare - a.chainShare).forEach((b, i) => (b.rank = i + 1));

  const kpi = new Map<string, KpiRow>();
  for (const r of kpiRows) {
    const row = { v2022: Number(r.value_2022), v2026: Number(r.value_2026), change: Number(r.change) };
    if (Number.isFinite(row.v2026)) kpi.set(`${r.scope}:${r.kpi_id}`, row);
  }

  const change = new Map<string, ChangeRow>();
  for (const r of changeRows) {
    const row = { s22: Number(r.chain_share_2022), s26: Number(r.chain_share_2026), n22: Number(r.restaurants_2022), n26: Number(r.restaurants_2026) };
    if (byId.has(r.nbhd_id) && Number.isFinite(row.s22) && Number.isFinite(row.s26)) change.set(r.nbhd_id, row);
  }

  const range = (vals: number[]): [number, number] => [Math.min(...vals), Math.max(...vals)];
  const shares = ranked.map((n) => n.chainShare);
  const chainsPer = ranked.map((n) => n.chainBrands);
  return {
    raw: { geo, kpiRows, changeRows },
    cuisines,
    change,
    nbhds,
    byId,
    ranked,
    brands,
    brandByName,
    sim,
    simKind: 'mix',
    sims,
    simCount: scored.length,
    boros,
    boroByKey: new Map(boros.map((b) => [b.key, b])),
    kpi,
    bounds: union(nbhds),
    city: {
      restaurants: total,
      chainShare: total ? 1 - tierCount.independent / total : 0,
      shares: { independent: tierCount.independent / total, mini_chain: tierCount.mini_chain / total, chain: tierCount.chain / total, big_chain: tierCount.big_chain / total },
      chainBrands: chains.length,
      medianShare: median(shares),
      medianChains: median(chainsPer),
      medianSim: sims.mix.median,
      ranges: { share: range(shares), chains: range(chainsPer), sim: sims.mix.range },
    },
  };
}

/* ---------- Makeup plot: principal component analysis of tier and cuisine mix (ported from the Week 13 prototype) ---------- */

const PLOT_CUISINES = 12; // most common cuisines that get their own dimension; the rest are pooled
const SKIP_CUISINES = new Set(['Unknown', 'Other', 'Not Listed/Not Applicable']); // these describe the inspection data, not the neighborhood
const CUISINE_SHORT: Record<string, string> = { 'Bakery Products/Desserts': 'bakeries', 'Juice, Smoothies, Fruit Salads': 'juice bars', 'Coffee/Tea': 'coffee and tea', 'Asian/Asian Fusion': 'Asian fusion' };
const cuisineName = (c: string) => CUISINE_SHORT[c] ?? c;
const DIM_TIER: Record<Tier, string> = { independent: 'independents', mini_chain: 'mini chains', chain: 'mid-size chains', big_chain: 'big chains' };

// Top-k eigenvectors of a small symmetric matrix by power iteration with deflation
function topEigen(C: number[][], k: number) {
  const d = C.length;
  const A = C.map((row) => row.slice());
  const mul = (v: number[]) => A.map((row) => row.reduce((s, a, j) => s + a * v[j], 0));
  const out: { v: number[]; lambda: number }[] = [];
  for (let c = 0; c < k; c++) {
    let v = Array.from({ length: d }, (_, i) => 1 + ((i * 7 + c * 3) % 5) / 5);
    for (let it = 0; it < 300; it++) {
      const w = mul(v);
      const norm = Math.hypot(...w) || 1;
      v = w.map((x) => x / norm);
    }
    const Av = mul(v);
    const lambda = v.reduce((s, x, i) => s + x * Av[i], 0);
    // An eigenvector's sign is arbitrary: point it so its largest loading is positive, so the plot does not flip between loads
    const big = v.reduce((b, x, i) => (Math.abs(x) > Math.abs(v[b]) ? i : b), 0);
    if (v[big] < 0) v = v.map((x) => -x);
    out.push({ v, lambda });
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) A[i][j] -= lambda * v[i] * v[j];
  }
  return out;
}
export interface PlotAxis {
  explained: number; // share of all variation this axis holds
  pos: string[]; // what pulls a neighborhood toward the positive end
  neg: string[];
}
export interface Embedding {
  pts: { id: string; x: number; y: number; dist: number; top: [string, number][] }[];
  axes: [PlotAxis, PlotAxis];
  cuisines: number;
  extent: { x: [number, number]; y: [number, number] }; // plot bounds, fixed by the latest snapshot unless another year goes beyond them
}

const known = (m: Map<string, number>) => [...m].reduce((s, [c, n]) => (SKIP_CUISINES.has(c) ? s : s + n), 0);
// One neighborhood as a list of shares: the four tiers, the chosen cuisines, and "other cuisines"
function shareRow(data: Data, n: Nbhd, top: string[]): number[] {
  const m = data.cuisines.get(n.id)!;
  const k = known(m);
  const shares = top.map((c) => (k ? (m.get(c) ?? 0) / k : 0));
  return [...TIERS.map((t) => n.shares[t.key]), ...shares, k ? 1 - shares.reduce((s, x) => s + x, 0) : 0];
}

// The axes are fitted once, on the latest snapshot, and every other year is placed on those same axes.
// Refitting per year would change the cuisine list, the averages and the axes themselves, so a dot could move
// because the ruler moved, not because the neighborhood changed.
interface MakeupFit {
  top: string[];
  dims: string[];
  mean: number[];
  sd: number[];
  v: [number[], number[]];
  axes: [PlotAxis, PlotAxis];
  ref: { id: string; x: number; y: number }[];
}
const fitCache = new WeakMap<Map<string, Map<string, number>>, MakeupFit | null>(); // keyed on the cuisine table, shared by every copy of the same snapshot
function fitMakeup(ref: Data): MakeupFit | null {
  if (fitCache.has(ref.cuisines)) return fitCache.get(ref.cuisines)!;
  const eligible = ref.ranked.filter((n) => ref.cuisines.has(n.id));
  let fit: MakeupFit | null = null;
  if (eligible.length >= 3) {
    const totals = new Map<string, number>();
    for (const p of eligible) for (const [c, n] of ref.cuisines.get(p.id)!) if (!SKIP_CUISINES.has(c)) totals.set(c, (totals.get(c) ?? 0) + n);
    const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, PLOT_CUISINES).map(([c]) => c);
    const dims = [...TIERS.map((t) => DIM_TIER[t.key]), ...top.map(cuisineName), 'other cuisines'];
    const raw = eligible.map((p) => shareRow(ref, p, top));
    const n = raw.length;
    const d = dims.length;
    const mean = new Array<number>(d).fill(0);
    const sd = new Array<number>(d).fill(0);
    for (const r of raw) r.forEach((x, j) => (mean[j] += x / n));
    for (const r of raw) r.forEach((x, j) => (sd[j] += (x - mean[j]) ** 2 / n));
    const Z = raw.map((r) => r.map((x, j) => (sd[j] > 1e-12 ? (x - mean[j]) / Math.sqrt(sd[j]) : 0)));
    const C = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (const z of Z) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += (z[i] * z[j]) / n;
    const trace = sd.filter((s) => s > 1e-12).length || 1;
    const eig = topEigen(C, 2);
    // Name each axis end after its strongest pull, plus a second if it is clearly part of it
    const ends = (v: number[], sign: 1 | -1) =>
      v
        .map((w, j) => [w * sign, j] as const)
        .filter(([w]) => w > 0)
        .sort((a, b) => b[0] - a[0])
        .filter(([w], i) => i === 0 || w > 0.25)
        .slice(0, 2)
        .map(([, j]) => dims[j]);
    const axes = eig.map(({ v, lambda }) => ({ explained: lambda / trace, pos: ends(v, 1), neg: ends(v, -1) })) as [PlotAxis, PlotAxis];
    const dotp = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    fit = { top, dims, mean, sd, v: [eig[0].v, eig[1].v], axes, ref: eligible.map((p, i) => ({ id: p.id, x: dotp(eig[0].v, Z[i]), y: dotp(eig[1].v, Z[i]) })) };
  }
  fitCache.set(ref.cuisines, fit);
  return fit;
}

// Each ranked neighborhood becomes a list of shares, standardized so tier and cuisine weigh equally, then placed on the two axes.
export function makeupEmbedding(data: Data): Embedding | null {
  const fit = fitMakeup(data.latest ?? data);
  if (!fit) return null;
  const eligible = data.ranked.filter((n) => data.cuisines.has(n.id));
  if (eligible.length < 3) return null;
  const dotp = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const pts = eligible.map((p) => {
    const z = shareRow(data, p, fit.top).map((x, j) => (fit.sd[j] > 1e-12 ? (x - fit.mean[j]) / Math.sqrt(fit.sd[j]) : 0));
    const x = dotp(fit.v[0], z);
    const y = dotp(fit.v[1], z);
    const m = data.cuisines.get(p.id)!;
    const k = known(m) || 1;
    const topHere = [...m]
      .filter(([c]) => !SKIP_CUISINES.has(c))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, cn]): [string, number] => [cuisineName(c), cn / k]);
    return { id: p.id, x, y, dist: Math.hypot(x, y), top: topHere, z };
  });
  // How much of this year's spread the two fixed axes hold (around the latest year's average)
  const total = pts.reduce((s, p) => s + p.z.reduce((a, b) => a + b * b, 0), 0) || 1;
  const held = (axis: 'x' | 'y') => pts.reduce((s, p) => s + p[axis] ** 2, 0) / total;
  const axes = fit.axes.map((a, i) => ({ ...a, explained: held(i === 0 ? 'x' : 'y') })) as [PlotAxis, PlotAxis];
  // Bounds come from the latest snapshot, widened only if this year has a dot beyond them
  const span = (vals: number[]): [number, number] => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.07;
    return [lo - pad, hi + pad];
  };
  const [rx0, rx1] = span(fit.ref.map((p) => p.x));
  const [ry0, ry1] = span(fit.ref.map((p) => p.y));
  const extent = {
    x: [Math.min(rx0, ...pts.map((p) => p.x)), Math.max(rx1, ...pts.map((p) => p.x))] as [number, number],
    y: [Math.min(ry0, ...pts.map((p) => p.y)), Math.max(ry1, ...pts.map((p) => p.y))] as [number, number],
  };
  // Biggest neighborhoods first, so small dots are drawn on top and stay reachable
  const size = new Map(eligible.map((p) => [p.id, p.n]));
  const out = pts.map((p) => ({ id: p.id, x: p.x, y: p.y, dist: p.dist, top: p.top })).sort((a, b) => size.get(b.id)! - size.get(a.id)!);
  return { pts: out, axes, cuisines: fit.top.length, extent };
}

const BASE = `${import.meta.env.BASE_URL}data/`;
async function get(file: string, what: string, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + file, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`The ${what} could not be reached. Check your connection.`);
  }
  if (!res.ok) throw new Error(`The ${what} did not load (HTTP ${res.status}).`);
  return res;
}
async function load(signal: AbortSignal): Promise<Data> {
  const optional = (file: string, what: string) =>
    get(file, what, signal)
      .then((r) => r.text())
      .catch((e: Error) => {
        if (e.name === 'AbortError') throw e;
        return '';
      });
  const [geoRes, csvRes, kpiText, changeText] = await Promise.all([
    get('nbhd.geo.json', 'neighborhood boundaries', signal),
    get('restaurants.csv', 'restaurant list', signal),
    // The 2022 comparisons are optional: the app works without them
    optional('stats/kpis.csv', 'KPI table'),
    optional('stats/temporal_neighborhoods.csv', '2022 comparison'),
  ]);
  let geo: FeatureCollection<Geometry, RawProps>;
  try {
    geo = (await geoRes.json()) as FeatureCollection<Geometry, RawProps>;
  } catch {
    throw new Error('The neighborhood boundaries file is not valid JSON.');
  }
  if (!geo?.features?.length) throw new Error('The neighborhood boundaries file has no neighborhoods in it.');
  const rows = csvParse(await csvRes.text());
  if (!rows.length) throw new Error('The restaurant list is empty.');
  return build(geo, rows, kpiText ? csvParse(kpiText) : [], changeText ? csvParse(changeText) : []);
}

export type LoadState = { status: 'loading' } | { status: 'ready'; data: Data } | { status: 'error'; message: string };
export function useData(): [LoadState, () => void] {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setState({ status: 'error', message: e.message || 'The data did not load.' });
      });
    return () => ctrl.abort();
  }, [attempt]);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);
  return [state, retry];
}

/* ---------- Other years, 2019 to 2026, estimated from restaurants_timeline.csv (method from the Week 13 prototype) ---------- */

// The timeline file pools the March 2022 and September 2026 snapshots. A restaurant counts as open from the year of its
// first inspection on record until its last listing: 2026 if it is in the latest file, otherwise the year it was last seen.
// 2022 and 2026 are real snapshots. The other years are reconstructions: before 2022 only places that survived to 2022 can appear.
export const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
export const LATEST_YEAR = 2026;
export const SNAPSHOT_YEARS = new Set([2022, 2026]);
export const yearKind = (y: number) => (y === LATEST_YEAR ? 'latest' : SNAPSHOT_YEARS.has(y) ? 'snapshot' : 'estimate');

interface TlRow {
  name: string;
  brand: string;
  solo: boolean; // a one-off name: never counted as part of a brand
  cuisine: string;
  lat: string;
  lon: string;
  nbhd: string;
  boro: string;
  first: number;
  end: number;
}
let tlCache: Promise<TlRow[]> | null = null;
function loadTimelineRows(): Promise<TlRow[]> {
  // Loaded only when a view asks for it: the file is 5 MB
  tlCache ??= fetch(`${BASE}restaurants_timeline.csv`)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((text) =>
      csvParse(text)
        .map((r) => ({
          name: r.name ?? '',
          brand: r.brand ?? '',
          solo: r.solo === '1',
          cuisine: r.cuisine ?? '',
          lat: r.lat ?? '',
          lon: r.lon ?? '',
          nbhd: r.nbhd_id ?? '',
          boro: r.boro ?? '',
          first: Number((r.first_seen ?? '').slice(0, 4)),
          end: r.in_latest === '1' ? LATEST_YEAR : Number((r.last_seen ?? '').slice(0, 4)),
        }))
        .filter((r) => r.nbhd && Number.isFinite(r.first) && Number.isFinite(r.end)),
    );
  tlCache.catch(() => {
    tlCache = null; // let a later attempt retry
  });
  return tlCache;
}
// Restaurants open in a year, with each brand's size in that year
function openIn(tl: TlRow[], year: number) {
  const open = tl.filter((r) => r.first <= year && year <= r.end);
  const size = new Map<string, number>();
  for (const r of open) if (!r.solo) size.set(r.brand, (size.get(r.brand) ?? 0) + 1);
  return { open, sizeOf: (r: TlRow) => (r.solo ? 1 : (size.get(r.brand) ?? 1)) };
}
const tierFor = (n: number): Tier => (n >= 50 ? 'big_chain' : n >= 10 ? 'chain' : n >= 3 ? 'mini_chain' : 'independent');

// The whole data set as of one year: same shapes, restaurants and tiers recounted for that year
const yearCache = new WeakMap<Data, Map<number, Data>>();
function dataForYear(base: Data, tl: TlRow[], year: number): Data {
  let cache = yearCache.get(base);
  if (!cache) yearCache.set(base, (cache = new Map()));
  let d = cache.get(year);
  if (!d) {
    const { open, sizeOf } = openIn(tl, year);
    const rows = open.map((r) => ({ name: r.name, brand: r.brand, tier: tierFor(sizeOf(r)), cuisine: r.cuisine, lat: r.lat, lon: r.lon, nbhd_id: r.nbhd, boro: r.boro }));
    d = build(base.raw.geo, rows, base.raw.kpiRows, base.raw.changeRows, true, base);
    d.latest = base.latest ?? base;
    cache.set(year, d);
  }
  return d;
}
// `year` null means the latest snapshot. While another year is being prepared the previous data stays on screen.
export function useYearData(base: Data, year: number | null): { data: Data; status: 'ready' | 'loading' | 'error' } {
  const [got, setGot] = useState<{ base: Data; year: number; data: Data | null } | null>(null);
  useEffect(() => {
    if (year === null) return;
    let alive = true;
    let timer = 0;
    loadTimelineRows().then(
      (tl) => {
        // Recount after the slider has had a chance to repaint, and skip years the visitor has already moved past
        timer = window.setTimeout(() => alive && setGot({ base, year, data: dataForYear(base, tl, year) }), 80);
      },
      () => alive && setGot({ base, year, data: null }),
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [base, year]);
  if (year === null) return { data: base, status: 'ready' };
  const mine = got && got.base === base ? got : null;
  if (mine && mine.year === year) return mine.data ? { data: mine.data, status: 'ready' } : { data: base, status: 'error' };
  return { data: mine?.data ?? base, status: 'loading' };
}

export interface Timeline {
  open: number[]; // restaurants counted as open, per year
  tiers: Record<Tier, number>[]; // the open restaurants split by tier, per year
  gone: number[]; // active in the March 2022 file but not in the 2026 one, per year (0 up to 2022; their closing date is unknown)
  city: number[]; // pooled chain share, per year
  boros: Record<string, number[]>;
  nbhd: Map<string, (number | null)[]>; // null where the neighborhood had under 20 restaurants that year
}
function buildTimeline(tl: TlRow[]): Timeline {
  const out: Timeline = { open: [], tiers: [], gone: [], city: [], boros: {}, nbhd: new Map() };
  YEARS.forEach((year, yi) => {
    const { open, sizeOf } = openIn(tl, year);
    const tiers: Record<Tier, number> = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 };
    for (const r of open) tiers[tierFor(sizeOf(r))]++;
    out.tiers.push(tiers);
    out.gone.push(tl.filter((r) => r.end < year && r.end >= YEARS[0]).length);
    const acc = new Map<string, { n: number; chain: number }>();
    const bump = (key: string, chain: boolean) => {
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { n: 0, chain: 0 }));
      a.n++;
      if (chain) a.chain++;
    };
    for (const r of open) {
      const chain = sizeOf(r) >= 3;
      bump('city', chain);
      bump(`b:${r.boro}`, chain);
      bump(`n:${r.nbhd}`, chain);
    }
    const city = acc.get('city');
    out.open.push(city?.n ?? 0);
    out.city.push(city && city.n ? city.chain / city.n : 0);
    for (const [key, a] of acc) {
      if (key.startsWith('b:')) (out.boros[key.slice(2)] ??= new Array<number>(YEARS.length).fill(0))[yi] = a.n ? a.chain / a.n : 0;
      else if (key.startsWith('n:')) {
        let series = out.nbhd.get(key.slice(2));
        if (!series) out.nbhd.set(key.slice(2), (series = new Array<number | null>(YEARS.length).fill(null)));
        series[yi] = a.n >= MIN_RESTAURANTS ? a.chain / a.n : null;
      }
    }
  });
  return out;
}
let summaryCache: Promise<Timeline> | null = null;
export function useTimeline(): { status: 'loading' | 'ready' | 'error'; timeline: Timeline | null } {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; timeline: Timeline | null }>({ status: 'loading', timeline: null });
  useEffect(() => {
    let alive = true;
    summaryCache ??= loadTimelineRows().then(buildTimeline);
    summaryCache.then(
      (timeline) => alive && setState({ status: 'ready', timeline }),
      () => {
        summaryCache = null;
        if (alive) setState({ status: 'error', timeline: null });
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
