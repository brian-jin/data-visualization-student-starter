import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import { useSearchParams } from 'react-router';
import {
  brush as d3brush,
  csvParse,
  geoMercator,
  geoPath,
  piecewise,
  interpolateLab,
  quantile,
  scaleSequential,
  select,
  zoom as d3zoom,
  zoomIdentity,
} from 'd3';
import type { BrushBehavior, D3BrushEvent, ZoomBehavior, ZoomTransform } from 'd3';
import './VizHub.css';

type Tier = 'independent' | 'mini_chain' | 'chain' | 'big_chain';

// Properties written onto each feature by scripts/preprocess.py
interface NbhdProps {
  id: string;
  name: string | null;
  boro: string | null;
  n_restaurants: number;
  counts: Record<Tier, number>;
  shares: Record<Tier, number>;
}
type NbhdCollection = FeatureCollection<Geometry, NbhdProps>;

// One restaurant name, grouped in the browser from restaurants.csv (the `brand` column comes from preprocess.py)
interface Brand {
  id: string;
  name: string;
  tier: Tier;
  total: number; // locations on the map
  recent: number; // locations whose first inspection on record is within the past year (rough "new opening" signal)
  nbhds: Record<string, number>; // locations per neighborhood id
  pts: [number, number][]; // [lon, lat] of each location
  info: { name: string; cuisine: string; nbhd: string }[]; // same order as pts, for the hover card
}
// Group restaurants.csv rows by brand. "recent" counts locations whose first inspection on record is within a year of
// the newest one, plus those not inspected yet: a rough stand-in for recent openings.
function groupBrands(rows: readonly Record<string, string | undefined>[]): Brand[] {
  const time = (s?: string) => (s ? Date.parse(s) : NaN);
  let newest = 0;
  for (const r of rows) newest = Math.max(newest, time(r.first_seen) || 0);
  const cutoff = newest - 365 * 24 * 3600 * 1000;
  const byName = new Map<string, Brand>();
  for (const r of rows) {
    const name = r.brand?.trim();
    const lon = Number(r.lon);
    const lat = Number(r.lat);
    const tier = r.tier as Tier;
    if (!name || name.toLowerCase() === 'nan' || !r.nbhd_id) continue;
    if (!TIERS.some((t) => t.key === tier) || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    let b = byName.get(name);
    if (!b) {
      b = { id: name, name, tier, total: 0, recent: 0, nbhds: {}, pts: [], info: [] };
      byName.set(name, b);
    }
    b.total++;
    b.nbhds[r.nbhd_id] = (b.nbhds[r.nbhd_id] ?? 0) + 1;
    b.pts.push([lon, lat]);
    b.info.push({ name: titleCase(r.name ?? '') || 'Unnamed', cuisine: r.cuisine?.trim() || 'Unknown', nbhd: r.nbhd_id });
    if (time(r.first_seen) >= cutoff || r.not_yet_inspected === 'True') b.recent++;
  }
  return [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
// One restaurant location, for the pin layer and its hover card
interface Pin {
  name: string;
  brand: string;
  locs: number; // locations the brand has citywide
  cuisine: string;
  lon: number;
  lat: number;
  nbhd?: string; // only set when the card comes from a selected restaurant's dots
  color?: string; // dot color of the selected restaurant this pin belongs to
}
type Tip = { text: string; x: number; y: number; pins?: Pin[]; more?: number; flipX?: boolean; flipY?: boolean };

function toPins(rows: readonly Record<string, string | undefined>[]): Pin[] {
  const out: Pin[] = [];
  for (const r of rows) {
    const lon = Number(r.lon);
    const lat = Number(r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !r.nbhd_id) continue;
    out.push({
      name: titleCase(r.name ?? '') || 'Unnamed',
      brand: r.brand?.trim() || titleCase(r.name ?? ''),
      locs: Number(r.brand_locations) || 1,
      cuisine: r.cuisine?.trim() || 'Unknown',
      lon,
      lat,
    });
  }
  return out;
}
type Project = (c: [number, number]) => [number, number] | null;
// Sets the --brand color that a restaurant's dots and swatches read from
const brandVar = (color: string) => ({ '--brand': color }) as React.CSSProperties;

// Linked highlighting: spread onto any row that stands for a neighborhood and the map outlines it while you hover or focus the row
interface LinkProps {
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}
type Link = (id: string) => LinkProps;

const DATA_URL = `${import.meta.env.BASE_URL}data/nbhd.geo.json`;
const SIZE = 720;
const MIN_RESTAURANTS = 20; // Used for the side panel and to set the color range
const RANK_N = 5; // How many neighborhoods each ranking list shows
const MAX_RESULTS = 8; // Most search results listed at once
const MAX_BRAND_RESULTS = 6; // Most restaurant results listed at once
const MAX_BRANDS = 3; // Most restaurants shown on the map at once
// One dot color per restaurant: all distinct from the teal ramp, the purple compare outline and each other
const BRAND_COLORS = ['#B5365A', '#2563C9', '#E8890C'];
const PIN_COLOR = '#FFF6DD'; // ivory: light enough to read on the dark end of the ramp
const PIN_RING = '#2B3A46'; // dark ring (the page's ink color) keeps ivory pins visible on the pale end
const HOVER_ZOOM = 4; // pins answer hover once the map is zoomed in at least this far
const HIT_RADIUS = 9; // pixels around the cursor that count as "on" a pin
const MAX_PIN_TIP = 4; // restaurants listed when several pins sit on the same spot
const BRAND_MIN_SPAN = SIZE * 0.08; // A single location still zooms to about this much of the map
const RESTAURANTS_URL = `${import.meta.env.BASE_URL}data/restaurants.csv`;
const MAX_ZOOM = 100;
const PANEL_DEFAULT = 0.25; // The side panel starts at a quarter of the page width
const PANEL_MIN = 0.18; // ...and can be dragged between these fractions of the dashboard's width
const PANEL_MAX = 0.6;
const PANEL_KEY_STEP = 0.02; // Arrow keys on the divider move it by two percentage points (Shift: ten)
const ZOOM_FILL = 0.8; // Clicked neighborhood fills this fraction of the map (1 = edge to edge)
const HIST_BINS = 16; // Bars in the legend histogram
const KEY_STEP = 0.01; // Arrow keys move a legend handle by one percentage point (Shift: five)
const MAX_RANGE_LIST = 10; // Neighborhoods listed in the panel while the legend range is active
const SIM_LEAST = 3; // Least similar neighborhoods listed under the most similar ones
const SHARED_ROWS = 10; // Chains shown in the compare view's "Chains in common" chart

// Color ramp: low chain share -> high chain share. source: https://coolors.co/palette/c9e4ca-87bba2-55828b-3b6064-364958
const RAMP = ['#C9E4CA', '#87BBA2', '#55828B', '#3B6064', '#364958'];

// "Color by" choices. Every choice uses the same teal ramp, so the legend heading and the control say what the shade means.
type Metric = 'all' | Exclude<Tier, 'independent'>;
interface MetricInfo {
  key: Metric;
  label: string; // button text
  unit: string; // follows a percentage: "12% mini chains"
  title: string; // legend heading
  phrase: string; // "ranked by ..."
  most: string;
  fewest: string;
}
const METRICS: MetricInfo[] = [
  { key: 'all', label: 'All chains', unit: 'chains', title: 'Share of restaurants that are chains', phrase: 'chain share', most: 'Most chains', fewest: 'Fewest chains' },
  { key: 'mini_chain', label: 'Mini', unit: 'mini chains', title: 'Share of restaurants that are mini chains (3–9 locations)', phrase: 'mini-chain share', most: 'Most mini chains', fewest: 'Fewest mini chains' },
  { key: 'chain', label: 'Mid-size', unit: 'mid-size chains', title: 'Share of restaurants that are mid-size chains (10–49 locations)', phrase: 'mid-size-chain share', most: 'Most mid-size chains', fewest: 'Fewest mid-size chains' },
  { key: 'big_chain', label: 'Big', unit: 'big chains', title: 'Share of restaurants that are big chains (50+ locations)', phrase: 'big-chain share', most: 'Most big chains', fewest: 'Fewest big chains' },
];

const NO_DATA = 'url(#sm-nodata)'; // Hatched fill (defined in the <svg>) for neighborhoods with too few restaurants to compare

const TIERS: { key: Tier; label: string }[] = [
  { key: 'independent', label: 'Independent' },
  { key: 'mini_chain', label: 'Mini Chain (3–9)' },
  { key: 'chain', label: 'Mid-size Chain (10–49)' },
  { key: 'big_chain', label: 'Big Chain (50+)' },
];
// Tier colors are a separate warm family on purpose: teal always means "share of chains", warm colors always mean "tier".
const TIER_COLORS: Record<Tier, string> = {
  independent: '#B9AD97',
  mini_chain: '#E8B65A',
  chain: '#D9822B',
  big_chain: '#A4471F',
};

const tierLabel = (t: Tier) => TIERS.find((x) => x.key === t)?.label ?? t;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
// Searching ignores apostrophes so "little rubys" finds "Little Ruby's"
const flat = (s: string) => s.toLowerCase().replace(/['\u2019`]/g, '');

const chainShare = (p: NbhdProps) => (p.n_restaurants ? 1 - p.shares.independent : 0);
// Share of a neighborhood's restaurants in one tier (or in all chain tiers together)
const shareOf = (p: NbhdProps, m: Metric) => (p.n_restaurants ? (m === 'all' ? 1 - p.shares.independent : p.shares[m]) : 0);
// Boroughs are lowercase from the data ("queens"), capitalize each word for display
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
const pct = (x: number) => `${Math.round(x * 100)}%`;

// One stacked bar showing how restaurants split across the four tiers
function TierBar({ shares }: { shares: Record<Tier, number> }) {
  return (
    <div
      className="sm-tierbar"
      role="img"
      aria-label={TIERS.map((t) => `${t.label}: ${pct(shares[t.key])}`).join(', ')}
    >
      {TIERS.map((t) => (
        <span key={t.key} style={{ width: `${shares[t.key] * 100}%`, background: TIER_COLORS[t.key] }} />
      ))}
    </div>
  );
}

const nameOf = (p: NbhdProps) => p.name ?? p.id;

type City = { n: number; shares: Record<Tier, number> };

// One column of the breakdown table / one row of the bars
interface Col {
  head: string; // column heading, also the label on the bar
  tag: 'a' | 'b' | 'here' | 'city';
  n: number;
  shares: Record<Tier, number>;
  counts?: Record<Tier, number>; // shown beside each percentage when given
}

const colChain = (c: Col) => (c.n ? 1 - c.shares.independent : 0);

const neighborhoodCol = (p: NbhdProps, tag: Col['tag'], head: string): Col => ({
  head,
  tag,
  n: p.n_restaurants,
  shares: p.shares,
  counts: p.counts,
});
const cityCol = (city: City): Col => ({ head: 'NYC', tag: 'city', n: city.n, shares: city.shares });

// Stacked tier bars, one per column, each ending in its total chain share
function BreakdownBars({ cols }: { cols: Col[] }) {
  return (
    <div className="sm-bars">
      {cols.map((c) => (
        <div key={c.head} className="sm-barrow">
          <span className={`sm-tag sm-tag-${c.tag}`}>{c.head}</span>
          <TierBar shares={c.shares} />
          <b>{pct(colChain(c))}</b>
        </div>
      ))}
      <ul className="sm-tierkey" aria-hidden="true">
        {TIERS.map((t) => (
          <li key={t.key}>
            <i className="sm-swatch" style={{ background: TIER_COLORS[t.key] }} />
            {t.label}
          </li>
        ))}
      </ul>
      <span className="sm-hint">The number at the end of each bar is all chains combined.</span>
    </div>
  );
}

function BreakdownTable({ cols }: { cols: Col[] }) {
  return (
    <table className="sm-table">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Category</span>
          </th>
          {cols.map((c) => (
            <th key={c.head} scope="col">
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">
            <span className="sm-rowlabel">Restaurants</span>
          </th>
          {cols.map((c) => (
            <td key={c.head}>{c.n.toLocaleString()}</td>
          ))}
        </tr>
        <tr className="sm-table-strong">
          <th scope="row">
            <span className="sm-rowlabel">All chains</span>
          </th>
          {cols.map((c) => (
            <td key={c.head}>{pct(colChain(c))}</td>
          ))}
        </tr>
        {TIERS.map((t) => (
          <tr key={t.key}>
            <th scope="row">
              <span className="sm-rowlabel">
                <i className="sm-swatch" style={{ background: TIER_COLORS[t.key] }} />
                {t.label}
              </span>
            </th>
            {cols.map((c) => (
              <td key={c.head}>
                {pct(c.shares[t.key])}
                {c.counts && <span className="sm-count-inline">{c.counts[t.key].toLocaleString()}</span>}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// One selected neighborhood, with the citywide mix alongside for reference
// Two or three views of the same selection, one at a time
function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (k: T) => void;
  label: string;
}) {
  return (
    <div className="sm-tabs" role="group" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" aria-pressed={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// The headline for a selected neighborhood: one big number, with rank and the citywide figure beside it
function NbhdSummary({ p, city, rank, ranked, m }: { p: NbhdProps; city: City; rank?: number; ranked: number; m: MetricInfo }) {
  if (p.n_restaurants < MIN_RESTAURANTS) {
    return (
      <p className="sm-note">
        {nameOf(p)} has only <b className="sm-em">{p.n_restaurants}</b> restaurants, too few to compare reliably.
      </p>
    );
  }
  const cityShare = m.key === 'all' ? 1 - city.shares.independent : city.shares[m.key];
  return (
    <div className="sm-stat">
      <div className="sm-stat-main">
        <b>{pct(shareOf(p, m.key))}</b>
        <span>of its restaurants are {m.unit}</span>
      </div>
      <ul className="sm-stat-side">
        {rank !== undefined && (
          <li>
            Rank <b className="sm-em">#{rank}</b> of {ranked} (1 = highest)
          </li>
        )}
        <li>
          NYC overall: <b className="sm-em">{pct(cityShare)}</b>
        </li>
        <li>{p.n_restaurants.toLocaleString()} restaurants</li>
      </ul>
    </div>
  );
}

const TOP_CHAINS = 8; // Chains listed in a neighborhood's "Chains here" list

// The chains with the most locations in a neighborhood. Clicking a row puts that chain's locations on the map
// (which replaces the neighborhood selection).
function TopChains({
  p,
  brands,
  onPick,
  isPicked,
  full,
}: {
  p: NbhdProps;
  brands: Brand[] | null;
  onPick: (id: string) => void;
  isPicked: (id: string) => boolean;
  full: boolean;
}) {
  const rows = useMemo(() => {
    if (!brands) return null;
    const all: { brand: Brand; n: number }[] = [];
    for (const br of brands) {
      if (br.tier === 'independent') continue;
      const n = br.nbhds[p.id] ?? 0;
      if (n) all.push({ brand: br, n });
    }
    all.sort((x, y) => y.n - x.n || y.brand.total - x.brand.total || x.brand.name.localeCompare(y.brand.name));
    return { total: all.length, list: all.slice(0, TOP_CHAINS) };
  }, [brands, p.id]);

  if (!rows) return <p className="sm-hint sm-prompt">Loading restaurant names…</p>;
  if (!rows.total) return null;
  return (
    <div className="sm-top">
      <h4>Chains here</h4>
      <ul className="sm-top-list" role="list">
        {rows.list.map(({ brand: br, n }) => {
          const blocked = full && !isPicked(br.id);
          return (
            <li key={br.id}>
              <button
                type="button"
                className="sm-top-row"
                disabled={blocked}
                onClick={() => onPick(br.id)}
                title={
                  blocked
                    ? `${MAX_BRANDS} restaurants are already on the map. Remove one to add another.`
                    : `Show all ${plural(br.total, 'location')} of ${br.name} on the map`
                }
              >
                <span className="sm-top-name">
                  <i className="sm-chip" style={{ background: TIER_COLORS[br.tier] }} />
                  <span>{br.name}</span>
                </span>
                <span className="sm-top-n">{plural(n, 'location')}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="sm-hint sm-more">
        {rows.total > rows.list.length ? `Showing ${rows.list.length} of ${rows.total} chains. ` : ''}
        A chain is any name with 3+ locations citywide. Click one to see all its locations on the map.
      </p>
    </div>
  );
}

// Overview tab: the tier mix against the citywide mix, with the counts one click away, then the chains that define the place
function NeighborhoodView({
  p,
  city,
  brands,
  onPickBrand,
  isPicked,
  full,
}: {
  p: NbhdProps;
  city: City;
  brands: Brand[] | null;
  onPickBrand: (id: string) => void;
  isPicked: (id: string) => boolean;
  full: boolean;
}) {
  const cols = [neighborhoodCol(p, 'here', 'Here'), cityCol(city)];
  return (
    <>
      <BreakdownBars cols={cols} />
      <details className="sm-details">
        <summary>Show counts by tier</summary>
        <BreakdownTable cols={cols} />
      </details>
      <TopChains p={p} brands={brands} onPick={onPickBrand} isPicked={isPicked} full={full} />
    </>
  );
}

// Which chain brands do two neighborhoods have in common? "Chain" here means any name with 3+ locations citywide.
// Top: how many chain brands are only in A, in both, only in B. Below: the biggest chains as a mirrored bar chart (A left, B right).
function SharedChains({ a, b, brands }: { a: NbhdProps; b: NbhdProps; brands: Brand[] | null }) {
  const shared = useMemo(() => {
    if (!brands) return null;
    let onlyA = 0;
    let both = 0;
    let onlyB = 0;
    const rows: { brand: Brand; na: number; nb: number }[] = [];
    for (const br of brands) {
      if (br.tier === 'independent') continue;
      const na = br.nbhds[a.id] ?? 0;
      const nb = br.nbhds[b.id] ?? 0;
      if (!na && !nb) continue;
      if (na && nb) both++;
      else if (na) onlyA++;
      else onlyB++;
      rows.push({ brand: br, na, nb });
    }
    // Biggest first by combined locations (the "total" column); ties put chains found in both ahead of the rest, then A to Z
    const inBoth = (r: { na: number; nb: number }) => (r.na && r.nb ? 1 : 0);
    rows.sort(
      (x, y) => y.na + y.nb - (x.na + x.nb) || inBoth(y) - inBoth(x) || x.brand.name.localeCompare(y.brand.name),
    );
    const top = rows.slice(0, SHARED_ROWS);
    // One scale for both sides so bar lengths can be compared across the middle
    const max = Math.max(1, ...top.map((r) => Math.max(r.na, r.nb)));
    return { onlyA, both, onlyB, union: onlyA + both + onlyB, top, max };
  }, [brands, a.id, b.id]);

  if (!shared) return <p className="sm-hint sm-prompt">Loading restaurant names…</p>;
  const { onlyA, both, onlyB, union, top, max } = shared;
  if (!union) {
    return <p className="sm-note">Neither neighborhood has any chain brands (names with 3+ locations citywide).</p>;
  }
  return (
    <div className="sm-shared">
      <h4>Chains in common</h4>
      <p className="sm-note">
        <b className="sm-em">{both}</b> of the {union} chain brands found in these two neighborhoods appear in both (
        <b className="sm-em">{pct(both / union)}</b>).
      </p>
      <details className="sm-details">
        <summary>What counts as a chain brand?</summary>
        <p className="sm-hint">Any restaurant name with 3 or more locations citywide.</p>
      </details>
      <div className="sm-venn" role="img" aria-label={`Only A: ${onlyA}, in both: ${both}, only B: ${onlyB} chain brands`}>
        {onlyA > 0 && <span className="sm-venn-a" style={{ flexGrow: onlyA }} />}
        {both > 0 && <span className="sm-venn-both" style={{ flexGrow: both }} />}
        {onlyB > 0 && <span className="sm-venn-b" style={{ flexGrow: onlyB }} />}
      </div>
      <div className="sm-venn-key">
        <span>
          <i className="sm-swatch sm-venn-a" /> Only A: {onlyA}
        </span>
        <span>
          <i className="sm-swatch sm-venn-both" /> Both: {both}
        </span>
        <span>
          <i className="sm-swatch sm-venn-b" /> Only B: {onlyB}
        </span>
      </div>

      <h4>Biggest chains, A and B combined</h4>
      <ul className="sm-sc" role="list">
        <li className="sm-sc-row sm-sc-legend">
          <span />
          <span className="sm-sc-lg-a">
            <span className="sm-tag sm-tag-a">A</span>
          </span>
          <span className="sm-sc-lg-mid">bold = in both</span>
          <span className="sm-sc-lg-b">
            <span className="sm-tag sm-tag-b">B</span>
          </span>
          <span />
          <span className="sm-sc-total">total</span>
        </li>
        {top.map(({ brand: br, na, nb }) => (
          <li key={br.id} className={`sm-sc-row${na && nb ? ' sm-sc-both' : ''}`}>
            <span className="sm-sc-n">{na || '–'}</span>
            <span className="sm-sc-track sm-sc-track-a" aria-hidden="true">
              <i style={{ width: `${(na / max) * 100}%` }} />
            </span>
            <span
              className="sm-sc-name"
              title={`${br.name}: ${tierLabel(br.tier)}, ${plural(br.total, 'location')} citywide`}
            >
              <i className="sm-chip" style={{ background: TIER_COLORS[br.tier] }} />
              <span>{br.name}</span>
            </span>
            <span className="sm-sc-track sm-sc-track-b" aria-hidden="true">
              <i style={{ width: `${(nb / max) * 100}%` }} />
            </span>
            <span className="sm-sc-n">{nb || '–'}</span>
            <span className="sm-sc-total">{na + nb}</span>
          </li>
        ))}
      </ul>
      {union > top.length && (
        <p className="sm-hint sm-more">
          Showing the {top.length} largest of {union} chain brands, ranked by combined locations. The dot color is the chain's tier.
        </p>
      )}
    </div>
  );
}

// Side-by-side comparison of two neighborhoods, with the citywide mix as a reference
function CompareView({
  a,
  b,
  city,
  brands,
  sim,
  tab,
  onTab,
}: {
  a: NbhdProps;
  b: NbhdProps;
  city: City;
  brands: Brand[] | null;
  sim: { score: number; rank: number; total: number } | null;
  tab: 'mix' | 'shared';
  onTab: (t: 'mix' | 'shared') => void;
}) {
  const small = [a, b].filter((p) => p.n_restaurants < MIN_RESTAURANTS);
  const ap = Math.round(chainShare(a) * 100);
  const bp = Math.round(chainShare(b) * 100);
  const diff = ap - bp;
  const [hi, lo] = diff >= 0 ? [a, b] : [b, a];
  const cols = [neighborhoodCol(a, 'a', 'A'), neighborhoodCol(b, 'b', 'B'), cityCol(city)].map((c) => ({
    ...c,
    counts: undefined,
  }));

  return (
    <div className="sm-compare">
      <ul className="sm-who">
        {[
          { tag: 'a', p: a },
          { tag: 'b', p: b },
        ].map(({ tag, p }) => (
          <li key={tag}>
            <span className={`sm-tag sm-tag-${tag}`}>{tag.toUpperCase()}</span>
            <span>
              {nameOf(p)}
              {p.boro ? `, ${titleCase(p.boro)}` : ''}
            </span>
          </li>
        ))}
      </ul>

      {small.length > 0 ? (
        <p className="sm-note">
          {small.map((p) => `${nameOf(p)} has only ${p.n_restaurants}`).join(' and ')} restaurants, so{' '}
          {small.length > 1 ? 'their shares are' : 'its share is'} too rough to compare reliably.
        </p>
      ) : (
        <p className="sm-note">
          {diff === 0 ? (
            <>
              {nameOf(a)} and {nameOf(b)} have about the same share of chains (<b className="sm-em">{ap}%</b>).
            </>
          ) : (
            <>
              <b className="sm-em">{nameOf(hi)}</b> has <b className="sm-em">{Math.abs(diff)} percentage points</b> more
              chains than <b className="sm-em">{nameOf(lo)}</b> ({Math.max(ap, bp)}% vs. {Math.min(ap, bp)}%).
            </>
          )}
        </p>
      )}

      {sim && small.length === 0 && (
        <p className="sm-note">
          Their chain mixes are <b className="sm-em">{pct(sim.score)}</b> alike
          {sim.rank > 0 && (
            <>
              , which ranks <b className="sm-em">#{sim.rank}</b> of {sim.total} neighborhoods by similarity to {nameOf(a)}
            </>
          )}
          .
        </p>
      )}
      {small.length === 0 && (
        <Tabs
          label="Comparison view"
          value={tab}
          onChange={onTab}
          tabs={[
            { key: 'mix', label: 'Tier mix' },
            { key: 'shared', label: 'Shared chains' },
          ]}
        />
      )}
      {(small.length > 0 || tab === 'mix') && (
        <>
          <BreakdownBars cols={cols} />
          <details className="sm-details">
            <summary>Show table</summary>
            <BreakdownTable cols={cols} />
          </details>
        </>
      )}
      {small.length === 0 && tab === 'shared' && <SharedChains a={a} b={b} brands={brands} />}
    </div>
  );
}

// One restaurant name: how many locations, where they cluster, and how many look new
function BrandView({
  b,
  byId,
  active,
  onChoose,
  onClear,
  link,
  hoverId,
}: {
  b: Brand;
  byId: Map<string, NbhdProps>;
  active: NbhdProps | null;
  onChoose: (id: string) => void;
  onClear: () => void;
  link: Link;
  hoverId: string | null;
}) {
  const spread = Object.keys(b.nbhds).length;
  const top = Object.entries(b.nbhds)
    .map(([id, n]) => ({ p: byId.get(id), n }))
    .filter((x): x is { p: NbhdProps; n: number } => !!x.p)
    .sort((x, y) => y.n - x.n || nameOf(x.p).localeCompare(nameOf(y.p)))
    .slice(0, RANK_N);
  return (
    <>
      <p className="sm-note">
        <b className="sm-em">{b.name}</b> has <b className="sm-em">{plural(b.total, 'location')}</b>
        {spread > 1 && <> across {spread} neighborhoods</>}. It counts as {b.tier === 'independent' ? 'an' : 'a'}{' '}
        <b className="sm-em">{tierLabel(b.tier)}</b> because of how many locations share its name.
        {b.recent > 0 && (
          <>
            {' '}
            <b className="sm-em">{b.recent}</b> of {b.total === 1 ? 'it' : 'them'} first appeared in inspection records
            within the past year, a rough sign of recent openings.
          </>
        )}
      </p>
      {active && (
        <p className="sm-note">
          In {nameOf(active)}: <b className="sm-em">{plural(b.nbhds[active.id] ?? 0, 'location')}</b>.
        </p>
      )}
      {spread > 1 && (
        <>
          <h4>Where it clusters</h4>
          <ul className="sm-rank" role="list">
            {top.map(({ p, n }, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`sm-result${hoverId === p.id ? ' sm-linked' : ''}`}
                  onClick={() => onChoose(p.id)}
                  {...link(p.id)}
                >
                  <span className="sm-rank-n">#{i + 1}</span>
                  <span>
                    {nameOf(p)}
                    {p.boro && <span className="sm-result-boro">{titleCase(p.boro)}</span>}
                  </span>
                  <span className="sm-rank-share">
                    {n}
                    <span className="sm-count-inline">{((n / p.n_restaurants) * 100).toFixed(1)}% of area</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!active && <p className="sm-hint sm-prompt">Click a neighborhood to see how many locations it has.</p>}
      <div className="sm-actions">
        <button type="button" className="sm-btn sm-btn-quiet" onClick={onClear}>
          Remove {b.name}
        </button>
      </div>
    </>
  );
}

// Which neighborhoods have the most (and least) similar mix of chain brands? Click a row to compare the two.
function SimilarView({
  p,
  list,
  byId,
  simOn,
  onToggle,
  onCompare,
  link,
  hoverId,
}: {
  p: NbhdProps;
  list: [string, number][] | null;
  byId: Map<string, NbhdProps>;
  simOn: boolean;
  onToggle: () => void;
  onCompare: (id: string) => void;
  link: Link;
  hoverId: string | null;
}) {
  if (p.n_restaurants < MIN_RESTAURANTS) return null; // the note above already says why
  if (!list) return <p className="sm-hint sm-prompt">Loading restaurant names…</p>;
  if (!list.length) return <p className="sm-note">{nameOf(p)} has no chain restaurants to compare.</p>;
  const row = ([id, score]: [string, number], rank: number) => {
    const q = byId.get(id);
    if (!q) return null;
    return (
      <li key={id}>
        <button
          type="button"
          className={`sm-result${hoverId === id ? ' sm-linked' : ''}`}
          onClick={() => onCompare(id)}
          {...link(id)}
        >
          <span className="sm-rank-n">#{rank}</span>
          <span className="sm-rank-name">
            {nameOf(q)}
            {q.boro && <span className="sm-result-boro">{titleCase(q.boro)}</span>}
          </span>
          <span className="sm-rank-share">{pct(score)}</span>
        </button>
      </li>
    );
  };
  const least = list.slice(-SIM_LEAST);
  return (
    <div className="sm-similar">
      <div className="sm-actions">
        <button type="button" className="sm-btn sm-btn-quiet" aria-pressed={simOn} onClick={onToggle}>
          {simOn ? 'Show chain share again' : `Color the map by similarity to ${nameOf(p)}`}
        </button>
      </div>
      <h4>Most similar chain mix</h4>
      <ul className="sm-rank" role="list">
        {list.slice(0, RANK_N).map((x, i) => row(x, i + 1))}
      </ul>
      <h4>Least similar</h4>
      <ul className="sm-rank" role="list">
        {least.reverse().map((x, i) => row(x, list.length - i))}
      </ul>
      <details className="sm-details">
        <summary>How is similarity calculated?</summary>
        <p className="sm-hint">
          Each neighborhood is scored on how many locations it has of every chain. Similarity is how closely those two
          lists line up (cosine similarity): 100% means an identical chain mix and 0% means no chain in common. Chains
          found almost everywhere raise every score.
        </p>
      </details>
    </div>
  );
}

// ---- Alternate views ----
// The left side of the dashboard shows one view at a time. The side panel, selection, comparison and hover are shared,
// so clicking a neighborhood in any view opens it in the panel, and hovering a panel row outlines it in every view.
type View = 'map' | 'tiers' | 'plot';
const VIEWS: { key: View; label: string; blurb: string }[] = [
  { key: 'map', label: 'Map', blurb: 'One map, colored by the share you pick.' },
  { key: 'tiers', label: 'Tiers side by side', blurb: 'All four chain shares at once. Each map has its own color range.' },
  {
    key: 'plot',
    label: 'Makeup plot',
    blurb: 'Neighborhoods placed by their tier and cuisine mix: dots close together have a similar makeup.',
  },
];

// Teal ramp over a set of values, capped at the 98th percentile so one extreme neighborhood doesn't wash out the rest
function rampScale(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[0] ?? 0;
  const hi = Math.max(quantile(sorted, 0.98) ?? 1, lo + 0.01);
  return { color: scaleSequential(piecewise(interpolateLab, RAMP)).domain([lo, hi]).clamp(true), lo, hi };
}
// CSS gradient sampled from the same scale as the map, so a legend matches the fills exactly
const rampCssOf = (color: (v: number) => string, lo: number, hi: number) =>
  `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) => color(lo + (i / 8) * (hi - lo))).join(', ')})`;

// ---- Tiers side by side: one small map per "color by" choice ----
// Small-multiples structure adapted from VizHub visualization 16ab646f3d4040d2b48e4fba8fc68e61, and the shared
// highlight across panels from 605acb8096f44828bae3a52777894459 (both MIT License).
const TIER_PANEL_TITLE: Record<Metric, string> = {
  all: 'All chains (3+ locations)',
  mini_chain: 'Mini chains (3–9)',
  chain: 'Mid-size chains (10–49)',
  big_chain: 'Big chains (50+)',
};
type RampInfo = { m: MetricInfo; color: (v: number) => string; lo: number; hi: number; css: string };

// The fills only change with the color scale or the plot group, so hovering doesn't redraw every neighborhood
const TierFills = memo(function TierFills({
  features,
  paths,
  ramp,
  group,
}: {
  features: NbhdProps[];
  paths: Map<string, string>;
  ramp: RampInfo;
  group: Set<string> | null;
}) {
  return (
    <g>
      {features.map((p) => (
        <path
          key={p.id}
          data-id={p.id}
          d={paths.get(p.id)}
          className={`sm-nbhd sm-filled${group && !group.has(p.id) ? ' sm-dim' : ''}`}
          style={{ fill: p.n_restaurants < MIN_RESTAURANTS ? NO_DATA : ramp.color(shareOf(p, ramp.m.key)) }}
        />
      ))}
    </g>
  );
});

// Highlight outlines drawn above the fills: hover in slate, selection in teal, comparison in purple
function Outlines({ paths, hoverId, activeId, compareId }: { paths: Map<string, string>; hoverId: string | null; activeId: string | null; compareId: string | null }) {
  return (
    <>
      {hoverId && hoverId !== activeId && hoverId !== compareId && paths.get(hoverId) && (
        <>
          <path d={paths.get(hoverId)} className="sm-hover-halo" />
          <path d={paths.get(hoverId)} className="sm-hover" />
        </>
      )}
      {activeId && (
        <>
          <path d={paths.get(activeId)} className="sm-active-halo" />
          <path d={paths.get(activeId)} className="sm-active" />
        </>
      )}
      {compareId && (
        <>
          <path d={paths.get(compareId)} className="sm-active-halo" />
          <path d={paths.get(compareId)} className="sm-active sm-active-b" />
        </>
      )}
    </>
  );
}

function TierGrid({
  features,
  byId,
  paths,
  ramps,
  hoverId,
  activeId,
  compareId,
  group,
  onHover,
  onPick,
  onOpen,
}: {
  features: NbhdProps[];
  byId: Map<string, NbhdProps>;
  paths: Map<string, string>;
  ramps: RampInfo[];
  hoverId: string | null;
  activeId: string | null;
  compareId: string | null;
  group: Set<string> | null;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
  onOpen: (m: Metric) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number; flipX: boolean; flipY: boolean } | null>(null);
  // Every neighborhood path carries its id, so one handler per map covers all of them
  const idAt = (e: React.SyntheticEvent) => (e.target as Element).getAttribute('data-id');
  const leave = () => {
    setTip(null);
    onHover(null);
  };
  const move = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !wrapRef.current) return;
    const id = idAt(e);
    if (!id) return leave();
    const box = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    setTip({ id, x, y, flipX: x > box.width - 240, flipY: y > box.height - 170 });
    onHover(id);
  };
  const tipP = tip ? byId.get(tip.id) : undefined;
  return (
    <div className="sm-tiergrid" ref={wrapRef}>
      {ramps.map((r) => (
        <figure key={r.m.key} className="sm-tier">
          <figcaption className="sm-tier-head">
            <strong>{TIER_PANEL_TITLE[r.m.key]}</strong>
            <button type="button" className="sm-legend-reset" onClick={() => onOpen(r.m.key)}>
              Open on map
            </button>
          </figcaption>
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label={`Map of neighborhoods shaded by ${r.m.phrase}`}
            onPointerMove={move}
            onPointerLeave={leave}
            onClick={(e) => {
              const id = idAt(e);
              if (id) onPick(id);
            }}
          >
            <TierFills features={features} paths={paths} ramp={r} group={group} />
            <Outlines paths={paths} hoverId={hoverId} activeId={activeId} compareId={compareId} />
          </svg>
          <div className="sm-tier-key" aria-hidden="true">
            <span>{pct(r.lo)} or less</span>
            <i style={{ background: r.css }} />
            <span>{pct(r.hi)} or more</span>
          </div>
        </figure>
      ))}
      {tip && tipP && (
        <div
          className="sm-tip sm-tip-pin"
          role="tooltip"
          style={{
            left: tip.x,
            top: tip.y,
            transform: `translate(${tip.flipX ? 'calc(-100% - 0.75rem)' : '0.75rem'}, ${tip.flipY ? 'calc(-100% - 0.75rem)' : '0.75rem'})`,
          }}
        >
          <div className="sm-tip-row">
            <strong>{nameOf(tipP)}</strong>
            <span>
              {tipP.boro ? `${titleCase(tipP.boro)} · ` : ''}
              {plural(tipP.n_restaurants, 'restaurant')}
            </span>
          </div>
          <div className="sm-tip-row">
            {tipP.n_restaurants < MIN_RESTAURANTS ? (
              <span>Too few restaurants to compare</span>
            ) : (
              ramps.map((r) => (
                <span key={r.m.key} className="sm-tip-line">
                  <i className="sm-chip" style={{ background: r.color(shareOf(tipP, r.m.key)) }} />
                  {r.m.label === 'All chains' ? 'All chains' : `${r.m.label} chains`}
                  <b>{pct(shareOf(tipP, r.m.key))}</b>
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Makeup plot: neighborhoods placed by their tier + cuisine mix (principal component analysis) ----
// Linked brush-plus-map pattern adapted from VizHub visualization c6aa4f17039f4a50a76b4308cee082da
// (MIT License). Credit: Curran Kelleher et al.
const PLOT_CUISINES = 12; // Most common cuisines that get their own dimension; the rest are pooled as "other cuisines"
// "Unknown" and "Other" say more about the inspection data than about a neighborhood, so they are left out
const SKIP_CUISINES = new Set(['Unknown', 'Other', 'Not Listed/Not Applicable']);
const CUISINE_SHORT: Record<string, string> = {
  'Bakery Products/Desserts': 'bakeries',
  'Juice, Smoothies, Fruit Salads': 'juice bars',
  'Coffee/Tea': 'coffee/tea',
  'Asian/Asian Fusion': 'Asian fusion',
};
const cuisineName = (c: string) => CUISINE_SHORT[c] ?? c;
const DIM_TIER: Record<Tier, string> = {
  independent: 'independents',
  mini_chain: 'mini chains',
  chain: 'mid-size chains',
  big_chain: 'big chains',
};
const BORO_COLORS: Record<string, string> = {
  bronx: '#D1495B',
  brooklyn: '#3D6FB6',
  manhattan: '#E08E2B',
  queens: '#4E9A5A',
  'staten island': '#9C7A54',
};
const PLOT_M = { t: 14, r: 14, b: 46, l: 46 }; // plot margins in pixels, room for the axis labels
const PLOT_LABELS = 6; // Neighborhoods furthest from the middle that get a name label

// Restaurants per cuisine in each neighborhood
function countCuisines(rows: readonly Record<string, string | undefined>[]) {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.nbhd_id) continue;
    const c = r.cuisine?.trim() || 'Unknown';
    let m = out.get(r.nbhd_id);
    if (!m) out.set(r.nbhd_id, (m = new Map()));
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return out;
}

// Top-k eigenvectors of a symmetric matrix by power iteration with deflation (k is 2 here, the matrix ~17×17)
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
    // An eigenvector's sign is arbitrary: point it so its largest loading is positive, so the plot doesn't flip between loads
    const big = v.reduce((b, x, i) => (Math.abs(x) > Math.abs(v[b]) ? i : b), 0);
    if (v[big] < 0) v = v.map((x) => -x);
    out.push({ v, lambda });
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) A[i][j] -= lambda * v[i] * v[j];
  }
  return out;
}

interface PlotPoint {
  id: string;
  x: number;
  y: number;
  dist: number; // from the middle of the cloud
  top: [string, number][]; // most common cuisines and their shares, for the hover card
}
interface PlotAxis {
  explained: number; // share of all variation this axis captures
  pos: string[]; // dimensions that pull a neighborhood toward the positive end
  neg: string[];
}
interface Embedding {
  pts: PlotPoint[];
  axes: [PlotAxis, PlotAxis];
  cuisines: number;
}
type Box = [[number, number], [number, number]]; // [[xmin, ymin], [xmax, ymax]] in plot units

// Each neighborhood (with enough restaurants) becomes a list of shares: the four tiers, the most common cuisines, and
// "other cuisines". Each share is standardized so tier and cuisine mix weigh in equally, then the two directions with the
// most variation become the plot's axes.
function makeupEmbedding(nbhds: NbhdProps[], cuisines: Map<string, Map<string, number>>): Embedding | null {
  const eligible = nbhds.filter((p) => p.n_restaurants >= MIN_RESTAURANTS && cuisines.has(p.id));
  if (eligible.length < 3) return null;
  const totals = new Map<string, number>();
  for (const p of eligible) {
    for (const [c, n] of cuisines.get(p.id)!) if (!SKIP_CUISINES.has(c)) totals.set(c, (totals.get(c) ?? 0) + n);
  }
  const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, PLOT_CUISINES).map(([c]) => c);
  const dims = [...TIERS.map((t) => DIM_TIER[t.key]), ...top.map(cuisineName), 'other cuisines'];
  const known = (m: Map<string, number>) => [...m].reduce((s, [c, n]) => (SKIP_CUISINES.has(c) ? s : s + n), 0);
  const raw = eligible.map((p) => {
    const m = cuisines.get(p.id)!;
    const k = known(m);
    const shares = top.map((c) => (k ? (m.get(c) ?? 0) / k : 0));
    return [...TIERS.map((t) => p.shares[t.key]), ...shares, k ? 1 - shares.reduce((s, x) => s + x, 0) : 0];
  });
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
  // Name each axis end after its strongest pulls: always the strongest one, plus a second if it is clearly part of it
  const ends = (v: number[], sign: 1 | -1) =>
    v
      .map((w, j) => [w * sign, j] as const)
      .filter(([w]) => w > 0)
      .sort((a, b) => b[0] - a[0])
      .filter(([w], i) => i === 0 || w > 0.25)
      .slice(0, 2)
      .map(([, j]) => dims[j]);
  const axes = eig.map(({ v, lambda }) => ({ explained: lambda / trace, pos: ends(v, 1), neg: ends(v, -1) })) as [
    PlotAxis,
    PlotAxis,
  ];
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const pts = eligible.map((p, i): PlotPoint => {
    const x = dot(eig[0].v, Z[i]);
    const y = dot(eig[1].v, Z[i]);
    const m = cuisines.get(p.id)!;
    const k = known(m) || 1;
    const topHere = [...m]
      .filter(([c]) => !SKIP_CUISINES.has(c))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, c_n]): [string, number] => [cuisineName(c), c_n / k]);
    return { id: p.id, x, y, dist: Math.hypot(x, y), top: topHere };
  });
  // Biggest dots first, so small ones are drawn on top and stay hoverable
  const size = new Map(eligible.map((p) => [p.id, p.n_restaurants]));
  pts.sort((a, b) => size.get(b.id)! - size.get(a.id)!);
  return { pts, axes, cuisines: top.length };
}

// Pixel size of an element, kept up to date
function useSize<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function MakeupPlot({
  emb,
  byId,
  features,
  paths,
  colorOf,
  colorTitle,
  rampCss,
  lo,
  hi,
  hoverId,
  activeId,
  compareId,
  group,
  box,
  onBox,
  onHover,
  onPick,
}: {
  emb: Embedding;
  byId: Map<string, NbhdProps>;
  features: NbhdProps[];
  paths: Map<string, string>;
  colorOf: (p: NbhdProps) => string;
  colorTitle: string;
  rampCss: string;
  lo: number;
  hi: number;
  hoverId: string | null;
  activeId: string | null;
  compareId: string | null;
  group: Set<string> | null;
  box: Box | null;
  onBox: (b: Box | null) => void;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const [colorBy, setColorBy] = useState<'map' | 'boro'>('map');
  const [wrapRef, { w, h }] = useSize<HTMLDivElement>();
  const brushRef = useRef<SVGGElement | null>(null);
  const brushBehavior = useRef<BrushBehavior<unknown> | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number; flipX: boolean; flipY: boolean } | null>(null);

  // One scale for both axes, so a distance on screen means the same difference in every direction
  const frame = useMemo(() => {
    if (!w || !h) return null;
    const xs = emb.pts.map((p) => p.x);
    const ys = emb.pts.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const iw = Math.max(10, w - PLOT_M.l - PLOT_M.r);
    const ih = Math.max(10, h - PLOT_M.t - PLOT_M.b);
    const pad = 16; // room for the largest dot
    const k = Math.max(1e-6, Math.min((iw - 2 * pad) / (x1 - x0 || 1), (ih - 2 * pad) / (y1 - y0 || 1)));
    const cx = PLOT_M.l + iw / 2 - (k * (x0 + x1)) / 2;
    const cy = PLOT_M.t + ih / 2 + (k * (y0 + y1)) / 2;
    return {
      iw,
      ih,
      sx: (v: number) => cx + k * v,
      sy: (v: number) => cy - k * v, // up is positive
      ix: (px: number) => (px - cx) / k,
      iy: (py: number) => (cy - py) / k,
    };
  }, [emb, w, h]);

  // The brush hands its box back in plot units, so it survives a resize; refs keep the d3 handler current
  const onBoxRef = useRef(onBox);
  const boxRef = useRef(box);
  useEffect(() => {
    onBoxRef.current = onBox;
    boxRef.current = box;
  });
  useEffect(() => {
    const el = brushRef.current;
    if (!el || !frame) return;
    const g = select(el);
    const b = d3brush<unknown>()
      .extent([
        [PLOT_M.l, PLOT_M.t],
        [PLOT_M.l + frame.iw, PLOT_M.t + frame.ih],
      ])
      .on('brush end', (e: D3BrushEvent<unknown>) => {
        if (!e.sourceEvent) return; // moved by code below, not by the user
        const s = e.selection as [[number, number], [number, number]] | null;
        onBoxRef.current(
          s
            ? [
                [frame.ix(s[0][0]), frame.iy(s[1][1])],
                [frame.ix(s[1][0]), frame.iy(s[0][1])],
              ]
            : null,
        );
      });
    g.call(b);
    brushBehavior.current = b;
    const cur = boxRef.current;
    if (cur) {
      g.call(b.move, [
        [frame.sx(cur[0][0]), frame.sy(cur[1][1])],
        [frame.sx(cur[1][0]), frame.sy(cur[0][1])],
      ]);
    }
    return () => {
      g.on('.brush', null);
      g.selectAll('*').remove();
      brushBehavior.current = null;
    };
  }, [frame]);
  // Clearing the group from elsewhere (the side panel, the reset button) clears the box too
  useEffect(() => {
    if (!box && brushRef.current && brushBehavior.current) select(brushRef.current).call(brushBehavior.current.move, null);
  }, [box]);

  const maxN = Math.max(1, ...emb.pts.map((p) => byId.get(p.id)?.n_restaurants ?? 0));
  const rOf = (id: string) => 2.5 + 9.5 * Math.sqrt((byId.get(id)?.n_restaurants ?? 0) / maxN);
  const fillOf = (id: string) => {
    const p = byId.get(id)!;
    return colorBy === 'boro' ? (BORO_COLORS[p.boro ?? ''] ?? '#999') : colorOf(p);
  };
  const ptById = useMemo(() => new Map(emb.pts.map((p) => [p.id, p])), [emb]);

  // Name labels: the selection first, then the neighborhoods furthest from the middle, skipping any that would overlap
  const labels = useMemo(() => {
    if (!frame) return [];
    const want = [activeId, compareId, ...[...emb.pts].sort((a, b) => b.dist - a.dist).slice(0, PLOT_LABELS).map((p) => p.id)];
    const seen = new Set<string>();
    const placed: [number, number, number, number][] = [];
    const out: { id: string; x: number; y: number; anchor: 'start' | 'end'; name: string }[] = [];
    for (const id of want) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const pt = ptById.get(id);
      const p = byId.get(id);
      if (!pt || !p) continue;
      const x = frame.sx(pt.x);
      const y = frame.sy(pt.y);
      const r = rOf(id);
      const name = nameOf(p);
      const width = name.length * 6.4;
      const right = x < PLOT_M.l + frame.iw * 0.7;
      const tx = right ? x + r + 4 : x - r - 4;
      const rect: [number, number, number, number] = [right ? tx : tx - width, y - 11, right ? tx + width : tx, y + 4];
      const hits = placed.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1]);
      if (hits && id !== activeId && id !== compareId) continue;
      placed.push(rect);
      out.push({ id, x: tx, y: y + 4, anchor: right ? 'start' : 'end', name });
    }
    return out;
    // rOf only reads byId and maxN, both covered by emb/byId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, emb, ptById, byId, activeId, compareId]);

  const showTip = (e: React.PointerEvent, id: string) => {
    if (e.pointerType !== 'mouse' || !wrapRef.current) return;
    const b = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    setTip({ id, x, y, flipX: x > b.width - 240, flipY: y > b.height - 150 });
    onHover(id);
  };
  const ring = (id: string | null, cls: string) => {
    const pt = id && frame ? ptById.get(id) : undefined;
    if (!pt || !frame) return null;
    return <circle cx={frame.sx(pt.x)} cy={frame.sy(pt.y)} r={rOf(pt.id) + 2.5} className={cls} />;
  };
  const nEnds = w < 600 ? 1 : 2;
  const end = (a: PlotAxis, side: 'pos' | 'neg') => a[side].slice(0, nEnds).join(', ');
  const [ax, ay] = emb.axes;
  const tipP = tip ? byId.get(tip.id) : undefined;
  const tipPt = tip ? ptById.get(tip.id) : undefined;
  const boros = [...new Set(emb.pts.map((p) => byId.get(p.id)?.boro).filter((b): b is string => !!b))].sort();

  return (
    <div className="sm-plot">
      <div className="sm-plot-main" ref={wrapRef}>
        {frame && (
          <svg
            width={w}
            height={h}
            role="img"
            aria-label="Scatter plot of neighborhoods placed by their mix of restaurant tiers and cuisines"
          >
            <rect x={PLOT_M.l} y={PLOT_M.t} width={frame.iw} height={frame.ih} className="sm-plot-frame" />
            {/* The middle of the cloud: an average neighborhood sits where the dashed lines cross */}
            <line x1={frame.sx(0)} x2={frame.sx(0)} y1={PLOT_M.t} y2={PLOT_M.t + frame.ih} className="sm-plot-zero" />
            <line x1={PLOT_M.l} x2={PLOT_M.l + frame.iw} y1={frame.sy(0)} y2={frame.sy(0)} className="sm-plot-zero" />
            <g className="sm-plot-axis">
              <text x={PLOT_M.l} y={PLOT_M.t + frame.ih + 16}>
                ← more {end(ax, 'neg')}
              </text>
              <text x={PLOT_M.l + frame.iw} y={PLOT_M.t + frame.ih + 16} textAnchor="end">
                more {end(ax, 'pos')} →
              </text>
              <text x={PLOT_M.l + frame.iw / 2} y={PLOT_M.t + frame.ih + 34} textAnchor="middle" className="sm-plot-axis-cap">
                Axis 1 · {pct(ax.explained)} of the variation
              </text>
              <g transform={`translate(${PLOT_M.l - 10}, ${PLOT_M.t + frame.ih}) rotate(-90)`}>
                <text>← more {end(ay, 'neg')}</text>
                <text x={frame.ih} textAnchor="end">
                  more {end(ay, 'pos')} →
                </text>
              </g>
              <g transform={`translate(${PLOT_M.l - 28}, ${PLOT_M.t + frame.ih / 2}) rotate(-90)`}>
                <text textAnchor="middle" className="sm-plot-axis-cap">
                  Axis 2 · {pct(ay.explained)}
                </text>
              </g>
            </g>
            {/* Brush sits under the dots: drag across empty space to pick a group, hover or click a dot to open it */}
            <g ref={brushRef} className="sm-plot-brush" />
            <g>
              {emb.pts.map((pt) => (
                <circle
                  key={pt.id}
                  cx={frame.sx(pt.x)}
                  cy={frame.sy(pt.y)}
                  r={rOf(pt.id)}
                  className={`sm-pt${group && !group.has(pt.id) ? ' sm-pt-dim' : ''}`}
                  style={{ fill: fillOf(pt.id) }}
                  onPointerEnter={(e) => showTip(e, pt.id)}
                  onPointerMove={(e) => showTip(e, pt.id)}
                  onPointerLeave={() => {
                    setTip(null);
                    onHover(null);
                  }}
                  onClick={() => onPick(pt.id)}
                />
              ))}
            </g>
            <g className="sm-plot-rings">
              {hoverId !== activeId && hoverId !== compareId && ring(hoverId, 'sm-ring-hover')}
              {ring(activeId, 'sm-ring-active')}
              {ring(compareId, 'sm-ring-active sm-ring-b')}
            </g>
            <g className="sm-plot-labels">
              {labels.map((l) => (
                <text key={l.id} x={l.x} y={l.y} textAnchor={l.anchor} className={l.id === activeId || l.id === compareId ? 'sm-plot-label-sel' : ''}>
                  {l.name}
                </text>
              ))}
            </g>
          </svg>
        )}
        {tip && tipP && tipPt && (
          <div
            className="sm-tip sm-tip-pin"
            role="tooltip"
            style={{
              left: tip.x,
              top: tip.y,
              transform: `translate(${tip.flipX ? 'calc(-100% - 0.75rem)' : '0.75rem'}, ${tip.flipY ? 'calc(-100% - 0.75rem)' : '0.75rem'})`,
            }}
          >
            <div className="sm-tip-row">
              <strong>{nameOf(tipP)}</strong>
              <span>
                {tipP.boro ? `${titleCase(tipP.boro)} · ` : ''}
                {plural(tipP.n_restaurants, 'restaurant')} · {pct(chainShare(tipP))} chains
              </span>
              <span>Top cuisines: {tipPt.top.map(([c, s]) => `${c} ${pct(s)}`).join(', ')}</span>
            </div>
          </div>
        )}
      </div>

      <aside className="sm-plot-side" aria-label="Plot key">
        <div className="sm-plot-card">
          <span className="sm-colorby-label" id="sm-plotcolor-label">
            Color the dots by
          </span>
          <div className="sm-seg" role="group" aria-labelledby="sm-plotcolor-label">
            <button type="button" aria-pressed={colorBy === 'map'} onClick={() => setColorBy('map')}>
              Map colors
            </button>
            <button type="button" aria-pressed={colorBy === 'boro'} onClick={() => setColorBy('boro')}>
              Borough
            </button>
          </div>
          {colorBy === 'map' ? (
            <>
              <strong className="sm-plot-keytitle">{colorTitle}</strong>
              <div className="sm-ramp" style={{ background: rampCss }} />
              <span className="sm-ramp-labels">
                <span>{pct(lo)} or less</span>
                <span>{pct(hi)} or more</span>
              </span>
            </>
          ) : (
            <ul className="sm-tierkey sm-borokey">
              {boros.map((b) => (
                <li key={b}>
                  <i className="sm-chip" style={{ background: BORO_COLORS[b] ?? '#999' }} />
                  {titleCase(b)}
                </li>
              ))}
            </ul>
          )}
          <span className="sm-hint">Bigger dots have more restaurants.</span>
        </div>

        {/* Locator: the same neighborhoods on a small map, so a cluster on the plot can be read as places */}
        <div className="sm-plot-card sm-plot-card-map">
          <strong className="sm-plot-keytitle">{group ? `${group.size} picked on the plot` : 'Where they are'}</strong>
          <svg className="sm-locator" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Map of the plotted neighborhoods; click one to open it">
            {features.map((p) => {
              const plotted = ptById.has(p.id);
              return (
                <path
                  key={p.id}
                  d={paths.get(p.id)}
                  className={group?.has(p.id) ? 'sm-loc-on' : plotted ? 'sm-loc' : 'sm-loc sm-loc-off'}
                  style={plotted ? { cursor: 'pointer' } : undefined}
                  onPointerEnter={plotted ? () => onHover(p.id) : undefined}
                  onPointerLeave={plotted ? () => onHover(null) : undefined}
                  onClick={plotted ? () => onPick(p.id) : undefined}
                >
                  <title>{nameOf(p)}</title>
                </path>
              );
            })}
            <Outlines paths={paths} hoverId={hoverId} activeId={activeId} compareId={compareId} />
          </svg>
          {group && (
            <button type="button" className="sm-legend-reset" onClick={() => onBox(null)}>
              Clear picked group
            </button>
          )}
        </div>

        <p className="sm-hint">
          Drag across empty space to pick a group. It stays picked on the map and in the side panel. Click a dot to open
          that neighborhood.
        </p>
        <details className="sm-details">
          <summary>How is this plot made?</summary>
          <p className="sm-hint">
            Each of the {emb.pts.length} neighborhoods with at least {MIN_RESTAURANTS} restaurants is described by {4 + emb.cuisines + 1}{' '}
            shares: the four tiers, the {emb.cuisines} most common cuisines, and all other cuisines (unknown cuisines are
            left out). Each share is standardized, then principal component analysis finds the two directions where
            neighborhoods differ most. The axis labels name the shares that pull hardest toward each end. Dots close
            together have a similar makeup, but the axes are blends, not single measurements.
          </p>
        </details>
      </aside>
    </div>
  );
}

export function VizHub() {
  // The assignments sidebar is owned by App, which hides it when the URL has ?hideSidebar. This button sets the same parameter.
  const [searchParams, setSearchParams] = useSearchParams();
  const sidebarHidden = searchParams.has('hideSidebar');
  const toggleSidebar = () => {
    const next = new URLSearchParams(searchParams);
    if (sidebarHidden) next.delete('hideSidebar');
    else next.set('hideSidebar', 'true');
    setSearchParams(next);
  };
  const [data, setData] = useState<NbhdCollection | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Compare mode: `comparing` is on from the moment you press Compare; `compareId` is the second neighborhood once picked
  const [comparing, setComparing] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(true); // the results dropdown closes when you click elsewhere
  // Restaurant names load in the background; `picked` holds up to MAX_BRANDS restaurants shown on the map, each with its own dot color
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [picked, setPicked] = useState<{ id: string; color: string }[]>([]);
  const [pinRows, setPinRows] = useState<Pin[] | null>(null);
  const [showPins, setShowPins] = useState(false); // the pin layer is optional, so it starts off
  const [tip, setTip] = useState<Tip | null>(null);
  // Legend starts open on wide screens and minimized on phones
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia('(max-width: 800px)').matches);
  // Legend brush: the chain-share range being shown (null = no filter), and whether the hatched "too few restaurants" areas are hidden
  const [range, setRange] = useState<[number, number] | null>(null);
  const [hideNoData, setHideNoData] = useState(false);
  // Linked highlighting: the neighborhood under the cursor on the map, or under the cursor / keyboard focus in a list
  const [hoverId, setHoverId] = useState<string | null>(null);
  // What the map is colored by: a tier (or all chains), or, while a neighborhood is selected, similarity to it
  const [metric, setMetric] = useState<Metric>('all');
  const [filterOpen, setFilterOpen] = useState(false); // legend range filter (histogram + handles) is hidden until asked for
  const [simOn, setSimOn] = useState(false);
  // Which view of the selection is showing in the panel
  const [selTab, setSelTab] = useState<'overview' | 'similar'>('overview');
  const [cmpTab, setCmpTab] = useState<'mix' | 'shared'>('mix');
  // Which view fills the left side, the restaurants per cuisine behind the makeup plot, and the box brushed on that plot
  const [view, setView] = useState<View>('map');
  const [cuisines, setCuisines] = useState<Map<string, Map<string, number>> | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  // Width of the right-hand panel as a fraction of the dashboard, set by dragging the divider
  const [panelFrac, setPanelFrac] = useState(PANEL_DEFAULT);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null); // the legend histogram + ramp, used to turn a pointer position into a value
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);
  const gRef = useRef<SVGGElement | null>(null);
  const boundsRef = useRef<SVGGElement | null>(null); // boundary lines drawn above the fills
  const mapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);
  // Screen position and pin index of every pin drawn last frame, so hover only looks at pins you can see
  const shownRef = useRef<{ xs: number[]; ys: number[]; ids: number[] }>({ xs: [], ys: [], ids: [] });

  // Ask for a redraw of the pin layer
  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(DATA_URL, { signal: ctrl.signal })
      .then((r) => r.json() as Promise<NbhdCollection>)
      .then(setData)
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(RESTAURANTS_URL, { signal: ctrl.signal })
      .then((r) => r.text())
      .then((text) => {
        const rows = csvParse(text);
        setBrands(groupBrands(rows));
        setPinRows(toPins(rows));
        setCuisines(countCuisines(rows));
      })
      .catch(() => {
        // Without restaurants.csv the map still works; restaurant search and the chain list just stay empty
      });
    return () => ctrl.abort();
  }, []);

  // Wheel, pinch, drag zoom. Applies the transform to the inner <g>.
  useEffect(() => {
    if (!data || !svgRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const g = select(gRef.current);
    const behavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .translateExtent([
        [0, 0],
        [SIZE, SIZE],
      ])
      .on('start', () => setTip(null))
      .on('zoom', (e) => {
        g.attr('transform', e.transform.toString());
        if (boundsRef.current) select(boundsRef.current).attr('transform', e.transform.toString());
        transformRef.current = e.transform;
        schedule();
      });
    svg.call(behavior);
    zoomRef.current = behavior;
    return () => {
      svg.on('.zoom', null);
    };
  }, [data, schedule]);

  const zoomBy = (k: number) => {
    if (svgRef.current && zoomRef.current) {
      select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, k);
    }
  };
  const resetZoom = () => {
    if (svgRef.current && zoomRef.current) {
      select(svgRef.current).transition().duration(300).call(zoomRef.current.transform, zoomIdentity);
    }
  };

  const { paths, bounds, project } = useMemo(() => {
    if (!data) {
      return {
        paths: new Map<string, string>(),
        bounds: new Map<string, [[number, number], [number, number]]>(),
        project: null as Project | null,
      };
    }
    const projection = geoMercator().fitExtent(
      [
        [6, 6],
        [SIZE - 6, SIZE - 6],
      ],
      data,
    );
    const toPath = geoPath(projection);
    return {
      paths: new Map(data.features.map((f) => [f.properties.id, toPath(f) ?? ''])),
      // Bounding box of each neighborhood in map coordinates, used to zoom to it
      bounds: new Map(data.features.map((f) => [f.properties.id, toPath.bounds(f)])),
      project: ((c: [number, number]) => projection(c)) as Project | null,
    };
  }, [data]);

  // Zoom so the bounding box of one or more neighborhoods fills most of the map (see observablehq.com/@d3/zoom-to-bounding-box)
  const zoomToBox = ([x0, y0, x1, y1]: number[], minSpan = 0) => {
    if (!svgRef.current || !zoomRef.current) return;
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const k = Math.max(
      1,
      Math.min(MAX_ZOOM, ZOOM_FILL / Math.max((x1 - x0) / SIZE, (y1 - y0) / SIZE, minSpan / SIZE)),
    );
    const t = zoomIdentity
      .translate(SIZE / 2, SIZE / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    select(svgRef.current).transition().duration(750).call(zoomRef.current.transform, t);
  };
  // Frame every location of every listed restaurant
  const zoomToBrands = (list: Brand[]) => {
    if (!project) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of list) {
      for (const c of b.pts) {
        const xy = project(c);
        if (!xy) continue;
        x0 = Math.min(x0, xy[0]);
        y0 = Math.min(y0, xy[1]);
        x1 = Math.max(x1, xy[0]);
        y1 = Math.max(y1, xy[1]);
      }
    }
    zoomToBox([x0, y0, x1, y1], BRAND_MIN_SPAN);
  };
  const zoomToNbhds = (ids: string[]) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const box = bounds.get(id);
      if (!box) continue;
      x0 = Math.min(x0, box[0][0]);
      y0 = Math.min(y0, box[0][1]);
      x1 = Math.max(x1, box[1][0]);
      y1 = Math.max(y1, box[1][1]);
    }
    zoomToBox([x0, y0, x1, y1]);
  };

  // Deselect the neighborhood(s) and stop comparing. A restaurant search takes precedence and stays on the map
  // (it has its own "Clear restaurant" button): the view goes back to framing its locations, or to the whole city without one.
  const clearSelection = () => {
    setSimOn(false);
    setSelTab('overview');
    setHoverId(null);
    setActiveId(null);
    setCompareId(null);
    setComparing(false);
    if (layers.length) zoomToBrands(layers.map((l) => l.brand));
    else resetZoom();
  };
  // Start over: also drops the restaurant, and zooms all the way out
  const resetAll = () => {
    setSimOn(false);
    setSelTab('overview');
    setHoverId(null);
    setActiveId(null);
    setCompareId(null);
    setComparing(false);
    setPicked([]);
    setBox(null);
    resetZoom();
  };
  // Escape peels one layer at a time (neighborhood first, then restaurant), through a ref so the key listener below never goes stale
  const escapeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escapeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A click picks a neighborhood. Clicking the selected one again deselects it.
  // In compare mode a click picks the second neighborhood (click it again to unpick it).
  // Clicking the first neighborhood unpicks it too: the second one (if any) takes its place and the map zooms out to wait for a new pick.
  const pick = (id: string) => {
    if (comparing && activeId) {
      if (id === activeId) {
        if (compareId) {
          setActiveId(compareId);
          setCompareId(null);
          resetZoom();
        } else {
          clearSelection();
        }
        return;
      }
      if (id === compareId) {
        setCompareId(null);
        zoomToNbhds([activeId]);
      } else {
        setCompareId(id);
        zoomToNbhds([activeId, id]);
      }
      return;
    }
    if (id === activeId) {
      clearSelection();
      return;
    }
    setActiveId(id);
    setCompareId(null);
    zoomToNbhds([id]);
  };
  // Picking from the search box or a ranking list never deselects: re-picking the current neighborhood just re-zooms
  const choose = (id: string) => {
    if (id === activeId) {
      // Picking from search or a list never deselects: re-zoom, or do nothing while comparing
      if (!comparing) zoomToNbhds([id]);
    } else pick(id);
    setHoverId(null); // the row you clicked may disappear without ever getting a pointerleave
    setQuery('');
  };
  // Picking a restaurant adds it to the map (up to MAX_BRANDS), replaces any neighborhood selection, and zooms to frame every restaurant shown.
  // Picking one that is already on the map just zooms back to it.
  const chooseBrand = (id: string) => {
    const b = brandById.get(id);
    if (!b) return;
    let next = picked;
    if (!picked.some((s) => s.id === id)) {
      if (picked.length >= MAX_BRANDS) return;
      // Take the first dot color no other restaurant is using, so colors stay put when one is removed
      const color = BRAND_COLORS.find((c) => !picked.some((s) => s.color === c)) ?? BRAND_COLORS[0];
      next = [...picked, { id, color }];
      setPicked(next);
    }
    setSimOn(false);
    setSelTab('overview');
    setHoverId(null);
    setActiveId(null);
    setCompareId(null);
    setComparing(false);
    setQuery('');
    zoomToBrands(next.flatMap((s) => brandById.get(s.id) ?? []));
  };
  const removeBrand = (id: string) => {
    const next = picked.filter((s) => s.id !== id);
    setPicked(next);
    if (activeId) return;
    if (next.length) zoomToBrands(next.flatMap((s) => brandById.get(s.id) ?? []));
    else resetZoom();
  };
  const clearBrands = () => {
    setPicked([]);
    if (!activeId) resetZoom();
  };
  escapeRef.current = () => {
    if (activeId || comparing) clearSelection();
    else if (picked.length) clearBrands();
    else if (box) setBox(null);
  };
  // Starting a comparison zooms back out to the full city so the second neighborhood is easy to find and click
  const startCompare = () => {
    setComparing(true);
    setCompareId(null);
    resetZoom();
  };
  const stopCompare = () => {
    setComparing(false);
    setCompareId(null);
    if (activeId) zoomToNbhds([activeId]);
  };
  // From the "most similar" lists: compare the selected neighborhood with this one
  const compareWith = (id: string) => {
    if (!activeId || id === activeId) return;
    setComparing(true);
    setCompareId(id);
    setHoverId(null);
    zoomToNbhds([activeId, id]);
  };
  const swapCompare = () => {
    setActiveId(compareId);
    setCompareId(activeId);
  };

  const byId = useMemo(() => new Map((data?.features ?? []).map((f) => [f.properties.id, f.properties])), [data]);
  const brandById = useMemo(() => new Map((brands ?? []).map((b) => [b.id, b])), [brands]);

  // Similarity: each neighborhood is a vector of how many locations it has of every chain brand (names with 3+ locations).
  // Two neighborhoods' similarity is the cosine of their vectors: 0% = no chain in common, 100% = the same mix.
  const chainNorm = useMemo(() => {
    const sq = new Map<string, number>();
    for (const b of brands ?? []) {
      if (b.tier === 'independent') continue;
      for (const [id, n] of Object.entries(b.nbhds)) sq.set(id, (sq.get(id) ?? 0) + n * n);
    }
    return sq;
  }, [brands]);
  // Scores against the selected neighborhood; `list` holds only neighborhoods with enough restaurants, most similar first
  const sim = useMemo(() => {
    if (!brands || !activeId) return null;
    const dots = new Map<string, number>();
    for (const b of brands) {
      const na = b.tier === 'independent' ? 0 : (b.nbhds[activeId] ?? 0);
      if (!na) continue;
      for (const [id, n] of Object.entries(b.nbhds)) dots.set(id, (dots.get(id) ?? 0) + na * n);
    }
    const normA = Math.sqrt(chainNorm.get(activeId) ?? 0);
    const map = new Map<string, number>();
    const list: [string, number][] = [];
    for (const q of byId.values()) {
      const normB = Math.sqrt(chainNorm.get(q.id) ?? 0);
      if (q.id === activeId || !normA || !normB) continue;
      const score = (dots.get(q.id) ?? 0) / (normA * normB);
      map.set(q.id, score);
      if (q.n_restaurants >= MIN_RESTAURANTS) list.push([q.id, score]);
    }
    list.sort((x, y) => y[1] - x[1] || nameOf(byId.get(x[0])!).localeCompare(nameOf(byId.get(y[0])!)));
    return { map, list };
  }, [brands, activeId, chainNorm, byId]);

  const metricInfo = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  // Similarity only applies to a neighborhood with enough restaurants (the Similar tab is hidden otherwise) and at least one chain
  const activeEnough = (activeId ? (byId.get(activeId)?.n_restaurants ?? 0) : 0) >= MIN_RESTAURANTS;
  const simActive = simOn && activeEnough && !!sim && sim.map.size > 0;
  const unit = simActive ? 'similar' : metricInfo.unit;
  // The number that colors a neighborhood: its share in the chosen tier, or its similarity to the selected neighborhood
  const valueOf = useCallback(
    (p: NbhdProps) => (simActive ? (p.id === activeId ? 1 : (sim?.map.get(p.id) ?? 0)) : shareOf(p, metric)),
    [simActive, sim, activeId, metric],
  );
  // A legend range picked on one color scale means nothing on another, so it resets when the scale changes
  const scaleKey = simActive ? `sim:${activeId}` : metric;
  useEffect(() => {
    setRange(null);
  }, [scaleKey]);

  // Color range comes from the neighborhood-level values (98th percentile cap),
  // so one extreme neighborhood doesn't wash out the rest of the ramp
  const { color, lo, hi } = useMemo(() => {
    const values = (data?.features ?? [])
      .filter((f) => f.properties.n_restaurants >= MIN_RESTAURANTS && !(simActive && f.properties.id === activeId))
      .map((f) => valueOf(f.properties))
      .sort((a, b) => a - b);
    return rampScale(values);
  }, [data, valueOf, simActive, activeId]);
  // The restaurants on the map. Each has its dot color, all of its locations as a single path of zero-length segments
  // (round caps draw them as dots), and the same locations in map coordinates so hover can find the dot under the cursor.
  const layers = useMemo(() => {
    if (!project) return [];
    return picked.flatMap(({ id, color }) => {
      const brand = brandById.get(id);
      if (!brand) return [];
      const x = new Float32Array(brand.pts.length);
      const y = new Float32Array(brand.pts.length);
      let dots = '';
      brand.pts.forEach((c, i) => {
        const xy = project(c);
        x[i] = xy ? xy[0] : NaN;
        y[i] = xy ? xy[1] : NaN;
        if (xy) dots += `M${xy[0].toFixed(2)},${xy[1].toFixed(2)}h0.001`;
      });
      return [{ brand, color, dots, x, y }];
    });
  }, [picked, brandById, project]);
  // Every restaurant projected into map coordinates, in a fixed shuffled order so the same pins are kept at every zoom level
  const pins = useMemo(() => {
    if (!project || !pinRows) return null;
    const n = pinRows.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const xy = project([pinRows[i].lon, pinRows[i].lat]);
      x[i] = xy ? xy[0] : NaN;
      y[i] = xy ? xy[1] : NaN;
    }
    const order = Uint32Array.from({ length: n }, (_, i) => i);
    let seed = 20260929;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return { x, y, order };
  }, [project, pinRows]);

  // Draw the pins on the canvas over the map. Zoomed out: a sparse scatter of small dots. Zoomed in: more and larger pins.
  drawRef.current = () => {
    const canvas = canvasRef.current;
    const box = mapRef.current;
    if (!canvas || !box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    shownRef.current = { xs: [], ys: [], ids: [] };
    if (!pins || !showPins || layers.length) return;

    // Map coordinates to screen pixels (the svg is centered and scaled to fit, like preserveAspectRatio "meet")
    const { k, x: tx, y: ty } = transformRef.current;
    const fit = Math.min(w, h) / SIZE;
    const ox = (w - SIZE * fit) / 2 + tx * fit;
    const oy = (h - SIZE * fit) / 2 + ty * fit;
    const m = k * fit;

    const r = Math.min(4, 1.5 + 0.8 * Math.log2(k)); // pin size grows with zoom
    const t = Math.min(1, Math.log2(k) / Math.log2(MAX_ZOOM));
    // Minimum spacing between drawn pins, in pixels: wide when zoomed out, shrinking as you zoom in, then 0 so every pin shows at the closest zoom
    const gap = Math.max(26 * Math.pow(1 - t, 1.2), 2 * r * 1.15 * (1 - Math.min(1, Math.max(0, (k - 20) / 20))));
    const gcols = Math.ceil(w / gap) + 1;
    const grid = gap > 1.5 ? new Uint8Array(gcols * (Math.ceil(h / gap) + 1)) : null;

    const shown = shownRef.current;
    const pad = r * 2;
    for (let n = 0; n < pins.order.length; n++) {
      const i = pins.order[n];
      const sx = ox + m * pins.x[i];
      const sy = oy + m * pins.y[i];
      if (!(sx >= -pad && sx <= w + pad && sy >= -pad && sy <= h + pad)) continue; // off screen (or not projected)
      if (grid) {
        const cell = Math.floor(Math.min(Math.max(sy, 0), h) / gap) * gcols + Math.floor(Math.min(Math.max(sx, 0), w) / gap);
        if (grid[cell]) continue;
        grid[cell] = 1;
      }
      shown.xs.push(sx);
      shown.ys.push(sy);
      shown.ids.push(i);
    }

    ctx.globalAlpha = Math.min(1, 0.65 + 0.2 * (k - 1)); // faint when zoomed out
    ctx.beginPath();
    for (let j = 0; j < shown.xs.length; j++) {
      ctx.moveTo(shown.xs[j] + r, shown.ys[j]);
      ctx.arc(shown.xs[j], shown.ys[j], r, 0, Math.PI * 2);
    }
    ctx.lineWidth = r > 2.5 ? 1.25 : 0.75;
    ctx.strokeStyle = PIN_RING;
    ctx.stroke();
    ctx.fillStyle = PIN_COLOR;
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  useEffect(() => {
    schedule();
  }, [pins, showPins, layers, schedule]);

  useEffect(() => {
    if (!data || !mapRef.current) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(mapRef.current);
    return () => ro.disconnect();
  }, [data, schedule]);

  // Citywide restaurant counts per tier for the "Category distribution" section
  const citywide = useMemo(() => {
    const totals: Record<Tier, number> = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 };
    for (const f of data?.features ?? []) {
      for (const t of TIERS) totals[t.key] += f.properties.counts[t.key];
    }
    const n = TIERS.reduce((sum, t) => sum + totals[t.key], 0);
    const shares = {} as Record<Tier, number>;
    for (const t of TIERS) shares[t.key] = n ? totals[t.key] / n : 0;
    return { totals, n, shares };
  }, [data]);

  // Neighborhoods with enough restaurants to compare, ranked by chain share (rank 1 = most chains)
  const ranking = useMemo(() => {
    const eligible = (data?.features ?? [])
      .map((f) => f.properties)
      .filter((p) => p.n_restaurants >= MIN_RESTAURANTS)
      .sort((a, b) => shareOf(b, metric) - shareOf(a, metric) || nameOf(a).localeCompare(nameOf(b)));
    return { eligible, rank: new Map(eligible.map((p, i) => [p.id, i + 1])) };
  }, [data, metric]);

  // Does a neighborhood pass the legend brush? Both ends are open: the lowest stop means "anything lower" and the top stop
  // means "hi or more", matching how the color scale is clamped at the 98th percentile.
  const inRange = useCallback(
    (p: NbhdProps) => {
      if (!range) return true;
      const s = valueOf(p);
      return (range[0] <= lo || s >= range[0]) && (range[1] >= hi || s <= range[1]);
    },
    [range, lo, hi, valueOf],
  );

  // Histogram of chain share over the same domain as the color ramp, plus how many neighborhoods the brush keeps
  const brushStats = useMemo(() => {
    const bins = new Array<number>(HIST_BINS).fill(0);
    // While coloring by similarity, the selected neighborhood itself is left out of the histogram
    const pool = ranking.eligible.filter((p) => !(simActive && p.id === activeId));
    for (const p of pool) {
      const i = Math.floor(((valueOf(p) - lo) / (hi - lo)) * HIST_BINS);
      bins[Math.min(HIST_BINS - 1, Math.max(0, i))]++;
    }
    return { bins, max: Math.max(1, ...bins), inside: pool.filter(inRange).length, total: pool.length };
  }, [ranking, lo, hi, inRange, valueOf, simActive, activeId]);

  // ---- Alternate views ----
  const nbhdList = useMemo(() => (data?.features ?? []).map((f) => f.properties), [data]);
  // Tiers side by side: one color range per "color by" choice, over the same neighborhoods the main map uses
  const tierRamps = useMemo(
    (): RampInfo[] =>
      METRICS.map((m) => {
        const s = rampScale(ranking.eligible.map((p) => shareOf(p, m.key)));
        return { m, ...s, css: rampCssOf(s.color, s.lo, s.hi) };
      }),
    [ranking],
  );
  const emb = useMemo(() => (cuisines ? makeupEmbedding(nbhdList, cuisines) : null), [nbhdList, cuisines]);
  // The group brushed on the makeup plot. It dims everything else on every view and gets its own list in the panel.
  const group = useMemo(() => {
    if (!box || !emb) return null;
    const [[x0, y0], [x1, y1]] = box;
    const ids = new Set(emb.pts.filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map((p) => p.id));
    return ids.size ? ids : null;
  }, [box, emb]);
  const showView = (v: View) => {
    setView(v);
    setTip(null);
    setHoverId(null);
  };
  // "Open on map" from a tier panel: show that tier on the big map
  const openTier = (m: Metric) => {
    setMetric(m);
    setSimOn(false);
    setSelTab('overview');
    showView('map');
  };

  if (failed) {
    return (
      <p className="sm-notice" role="alert">
        Could not load <code>public/data/nbhd.geo.json</code>.
      </p>
    );
  }
  if (!data) return <p className="sm-notice">Loading…</p>;

  const active = data.features.find((f) => f.properties.id === activeId)?.properties ?? null;
  const other = data.features.find((f) => f.properties.id === compareId)?.properties ?? null;
  const backLabel =
    layers.length === 1 ? `Back to ${layers[0].brand.name}` : layers.length ? 'Back to restaurants' : 'Back to citywide view';
  const simPair =
    other && sim
      ? { score: sim.map.get(other.id) ?? 0, rank: sim.list.findIndex(([id]) => id === other.id) + 1, total: sim.list.length }
      : null;

  // ---- Legend brush ----
  const span = hi - lo;
  const frac = (v: number) => (v - lo) / span;
  const valueAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return lo;
    const r = el.getBoundingClientRect();
    const f = r.width ? (clientX - r.left) / r.width : 0;
    return lo + Math.min(1, Math.max(0, f)) * span;
  };
  // Move one handle. The handles can meet but never cross, and a range that spans the whole ramp is the same as no filter.
  const moveHandle = (which: 0 | 1, v: number) => {
    const cur = range ?? [lo, hi];
    const next: [number, number] =
      which === 0 ? [Math.min(Math.max(v, lo), cur[1]), cur[1]] : [cur[0], Math.max(Math.min(v, hi), cur[0])];
    setRange(next[0] <= lo && next[1] >= hi ? null : next);
  };
  const onHandleKey = (which: 0 | 1) => (e: React.KeyboardEvent) => {
    const v = (range ?? [lo, hi])[which];
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.round((v + step) * 100) / 100;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.round((v - step) * 100) / 100;
    else if (e.key === 'Home') next = lo;
    else if (e.key === 'End') next = hi;
    else return;
    e.preventDefault();
    moveHandle(which, next);
  };
  // Clicking the histogram or ramp moves whichever handle is closer
  const onTrackDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.sm-handle')) return;
    const v = valueAt(e.clientX);
    const cur = range ?? [lo, hi];
    moveHandle(Math.abs(v - cur[0]) <= Math.abs(v - cur[1]) ? 0 : 1, v);
  };
  // A bar is "inside" when its slice of the ramp overlaps the brush
  const binInside = (i: number) => {
    if (!range) return true;
    const bl = lo + (i / HIST_BINS) * span;
    const bh = lo + ((i + 1) / HIST_BINS) * span;
    return (range[0] <= lo || bh > range[0]) && (range[1] >= hi || bl < range[1]);
  };
  const rangeText = !range
    ? ''
    : range[0] <= lo
      ? `${pct(range[1])} ${unit} or less`
      : range[1] >= hi
        ? `${pct(range[0])} ${unit} or more`
        : `${pct(range[0])} to ${pct(range[1])} ${unit}`;
  // Sampled from the same scale as the map so the legend matches the fills exactly
  const rampCss = rampCssOf(color, lo, hi);
  const legendTitle = simActive && active ? `Chain mix similar to ${nameOf(active)}` : metricInfo.title;
  const groupList = group ? ranking.eligible.filter((p) => group.has(p.id)) : null;
  const inBrush = range ? ranking.eligible.filter(inRange) : null;
  const handle = (which: 0 | 1) => {
    const v = (range ?? [lo, hi])[which];
    return (
      <div
        key={which}
        role="slider"
        tabIndex={0}
        className="sm-handle"
        // When both handles sit on the same spot, keep the one that can still move on top
        style={{ left: `${frac(v) * 100}%`, zIndex: which === 0 && frac(v) > 0.5 ? 3 : 2 }}
        aria-orientation="horizontal"
        aria-label={which === 0 ? 'Lowest chain share shown' : 'Highest chain share shown'}
        aria-valuemin={Math.round(lo * 100)}
        aria-valuemax={Math.round(hi * 100)}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={`${pct(v)} ${unit}${which === 1 && v >= hi ? ' or more' : ''}`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) moveHandle(which, valueAt(e.clientX));
        }}
        onKeyDown={onHandleKey(which)}
      />
    );
  };

  // ---- Linked highlighting ----
  const hoverP = hoverId ? (byId.get(hoverId) ?? null) : null;
  const hoverShare = hoverP && hoverP.n_restaurants >= MIN_RESTAURANTS ? valueOf(hoverP) : null;
  const hoverFrac = hoverShare === null ? null : Math.min(1, Math.max(0, frac(hoverShare)));
  const showFilter = filterOpen || !!range; // an active range always keeps its controls visible
  const hoverBin = hoverFrac === null ? -1 : Math.min(HIST_BINS - 1, Math.floor(hoverFrac * HIST_BINS));
  const link: Link = (id) => ({
    onPointerEnter: (e) => {
      if (e.pointerType === 'mouse') setHoverId(id);
    },
    onPointerLeave: () => setHoverId(null),
    // Keyboard focus only; a mouse click also focuses the row, and that row may be gone a moment later
    onFocus: (e) => {
      if (e.currentTarget.matches(':focus-visible')) setHoverId(id);
    },
    onBlur: () => setHoverId(null),
  });
  const rankRow = (p: NbhdProps) => (
    <li key={p.id}>
      <button
        type="button"
        className={`sm-result${hoverId === p.id ? ' sm-linked' : ''}`}
        onClick={() => choose(p.id)}
        {...link(p.id)}
      >
        <span className="sm-rank-n">#{ranking.rank.get(p.id)}</span>
        <span className="sm-rank-name">
          {nameOf(p)}
          {p.boro && <span className="sm-result-boro">{titleCase(p.boro)}</span>}
        </span>
        <span className="sm-rank-share">
          <i className="sm-chip" style={{ background: color(valueOf(p)) }} />
          {pct(valueOf(p))}
        </span>
      </button>
    </li>
  );

  // Search: every word typed must appear in the neighborhood's name or borough
  const q = query.trim().toLowerCase();
  const matches = q
    ? data.features
        .map((f) => f.properties)
        .filter((p) => {
          const hay = `${nameOf(p)} ${p.boro ?? ''}`.toLowerCase();
          return q.split(/\s+/).every((w) => hay.includes(w));
        })
        .sort((a, b) => {
          const sa = nameOf(a).toLowerCase().startsWith(q) ? 0 : 1;
          const sb = nameOf(b).toLowerCase().startsWith(q) ? 0 : 1;
          return sa - sb || nameOf(a).localeCompare(nameOf(b));
        })
    : [];
  const results = matches.slice(0, MAX_RESULTS);

  // Restaurants: same rule, ignoring apostrophes. Names that start with the text come first, then bigger brands.
  const qb = flat(q);
  const brandMatches =
    qb.length >= 2 && brands
      ? brands
          .filter((b) => {
            const hay = flat(b.name);
            return qb.split(/\s+/).every((w) => hay.includes(w));
          })
          .sort((a, b) => {
            const sa = flat(a.name).startsWith(qb) ? 0 : 1;
            const sb = flat(b.name).startsWith(qb) ? 0 : 1;
            return sa - sb || b.total - a.total || a.name.localeCompare(b.name);
          })
      : [];
  const isPicked = (id: string) => picked.some((s) => s.id === id);
  // Once the map is full only restaurants already on it stay clickable; the rest get a hint to remove one first
  const brandFull = picked.length >= MAX_BRANDS;
  const brandPool = brandFull ? brandMatches.filter((b) => isPicked(b.id)) : brandMatches;
  const brandBlocked = brandFull && brandMatches.length > brandPool.length;
  const brandResults = brandPool.slice(0, MAX_BRAND_RESULTS);
  const brandWhere = (b: Brand) =>
    b.total === 1 ? (byId.get(Object.keys(b.nbhds)[0])?.name ?? '1 location') : plural(b.total, 'location');

  // Tooltip follows the mouse
  // Restaurants under the cursor: only pins that are drawn, and only once zoomed in. Pins stacked on one spot are all listed.
  const pinsAt = (x: number, y: number) => {
    // While restaurants are selected, their own dots answer hover at any zoom level
    if (layers.length && mapRef.current) {
      const w = mapRef.current.clientWidth;
      const h = mapRef.current.clientHeight;
      const { k, x: tx, y: ty } = transformRef.current;
      const fit = Math.min(w, h) / SIZE;
      const ox = (w - SIZE * fit) / 2 + tx * fit;
      const oy = (h - SIZE * fit) / 2 + ty * fit;
      const m = k * fit;
      const near: { l: number; i: number; d: number }[] = [];
      layers.forEach((layer, l) => {
        for (let i = 0; i < layer.brand.pts.length; i++) {
          const dx = ox + m * layer.x[i] - x;
          const dy = oy + m * layer.y[i] - y;
          const d = dx * dx + dy * dy;
          if (d <= HIT_RADIUS * HIT_RADIUS) near.push({ l, i, d });
        }
      });
      if (!near.length) return null;
      near.sort((a, b) => a.d - b.d);
      return {
        list: near.slice(0, MAX_PIN_TIP).map(({ l, i }): Pin => {
          const { brand, color } = layers[l];
          const info = brand.info[i];
          const home = byId.get(info.nbhd);
          return {
            name: info.name,
            brand: brand.name,
            locs: brand.total,
            cuisine: info.cuisine,
            lon: brand.pts[i][0],
            lat: brand.pts[i][1],
            nbhd: home ? nameOf(home) : undefined,
            color,
          };
        }),
        more: Math.max(0, near.length - MAX_PIN_TIP),
      };
    }
    if (!pinRows || !showPins || layers.length || transformRef.current.k < HOVER_ZOOM) return null;
    const { xs, ys, ids } = shownRef.current;
    const near: { id: number; d: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      const dx = xs[i] - x;
      const dy = ys[i] - y;
      const d = dx * dx + dy * dy;
      if (d <= HIT_RADIUS * HIT_RADIUS) near.push({ id: ids[i], d });
    }
    if (!near.length) return null;
    near.sort((a, b) => a.d - b.d);
    return { list: near.slice(0, MAX_PIN_TIP).map((n) => pinRows[n.id]), more: Math.max(0, near.length - MAX_PIN_TIP) };
  };
  const showTip = (e: React.PointerEvent, p: NbhdProps) => {
    if (e.pointerType !== 'mouse' || !mapRef.current) return;
    setHoverId(p.id);
    const box = mapRef.current.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const hit = pinsAt(x, y);
    if (hit) {
      // Flip the card to the other side of the cursor near the right and bottom edges
      setTip({ text: '', x, y, pins: hit.list, more: hit.more, flipX: x > box.width - 280, flipY: y > box.height - 190 });
      return;
    }
    // One restaurant: "Name: 3 locations". Several: "Name: 3 Starbucks · 0 Dunkin'".
    const here =
      layers.length === 1
        ? plural(layers[0].brand.nbhds[p.id] ?? 0, 'location')
        : layers.map((l) => `${l.brand.nbhds[p.id] ?? 0} ${l.brand.name}`).join(' · ');
    const val =
      !layers.length && (simActive || metric !== 'all') && p.n_restaurants >= MIN_RESTAURANTS && p.id !== activeId
        ? `: ${pct(valueOf(p))} ${unit}`
        : '';
    setTip({ text: layers.length ? `${nameOf(p)}: ${here}` : `${nameOf(p)}${val}`, x, y });
  };

  return (
    <div className="sm">
      <header className="sm-header">
        <div className="sm-header-text">
          <h2>Mapping the "Same-ification" of NYC, From Blank Street to 7th Street</h2>
          <p className="sm-lede">
            Are NYC neighborhoods truly becoming more commercially homogeneous, and which neighborhoods are most impacted by changes such as independent shop replacements and gentrification?
          </p>
        </div>
        <button type="button" className="sm-sidebar-toggle" aria-pressed={sidebarHidden} onClick={toggleSidebar}>
          {sidebarHidden ? 'Show assignments' : 'Hide assignments'}
        </button>
      </header>

      <div
        className="sm-stage"
        ref={stageRef}
        style={{ '--panel-w': `clamp(18rem, ${(panelFrac * 100).toFixed(2)}%, ${PANEL_MAX * 100}%)` } as React.CSSProperties}
      >
        {/* Left side: one view at a time, picked from the bar on top. The side panel stays the same for all of them. */}
        <div className="sm-main">
          <div className="sm-viewbar">
            <div className="sm-tabs sm-viewtabs" role="group" aria-label="Choose a view">
              {VIEWS.map((v) => (
                <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => showView(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
            <p className="sm-viewbar-blurb">{VIEWS.find((v) => v.key === view)?.blurb}</p>
            {group && (
              <span className="sm-group-chip" role="status">
                {plural(group.size, 'neighborhood')} picked on the plot
                <button type="button" onClick={() => setBox(null)} aria-label="Clear the group picked on the plot">
                  ×
                </button>
              </span>
            )}
          </div>
          <div className="sm-viewarea">
            {/* Map: stays mounted under the other views, so its zoom and pins keep their state */}
            <div className="sm-map" ref={mapRef} inert={view !== 'map'}>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                role="img"
                onClick={(e) => {
                  // Clicking open water (not a neighborhood) zooms back out
                  if (e.target === e.currentTarget) clearSelection();
                }}
                aria-label="Map of New York City neighborhoods shaded by the share of restaurants that are chains"
              >
                <defs>
                  <pattern id="sm-nodata" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="4" height="4" fill="#E3E0D6" />
                    <line x1="0" y1="0" x2="0" y2="4" stroke="#AEB4B6" strokeWidth="1.4" />
                  </pattern>
                </defs>
                <g ref={gRef}>
                  {data.features.map((f) => {
                    const p = f.properties;
                    // Shade by chain share; neighborhoods with too few restaurants get the hatched fill.
                    // The shading stays on while a restaurant is selected, so its dots can be read against it.
                    const fill = p.n_restaurants < MIN_RESTAURANTS ? NO_DATA : color(valueOf(p));
                    // Outside the legend range (or hidden no-data areas) fade out but stay clickable;
                    // the selected neighborhoods never fade, so a selection can't vanish under the brush
                    // A group picked on the makeup plot dims everything outside it too
                    const dimmed =
                      ((p.n_restaurants < MIN_RESTAURANTS ? hideNoData : !inRange(p)) || (!!group && !group.has(p.id))) &&
                      p.id !== activeId &&
                      p.id !== compareId;
                    return (
                      <path
                        key={p.id}
                        d={paths.get(p.id)}
                        className={`sm-nbhd sm-filled${dimmed ? ' sm-dim' : ''}`}
                        style={{ fill }}
                        onPointerEnter={(e) => showTip(e, p)}
                        onPointerMove={(e) => showTip(e, p)}
                        onPointerLeave={() => {
                          setTip(null);
                          setHoverId(null);
                        }}
                        onClick={() => pick(p.id)}
                      />
                    );
                  })}
                </g>
              </svg>

              {/* Neighborhood outlines sit above the fills so boundaries stay readable */}
              <svg className="sm-bounds sm-bounds-nbhd" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
                <g ref={boundsRef}>
                  {data.features.map((f) => (
                    <path key={f.properties.id} d={paths.get(f.properties.id)} className="sm-edge" />
                  ))}
                  {/* All halos first, then all dots, so one restaurant's halo never covers another's dot */}
                  {layers.map((l) => (
                    <path
                      key={`${l.brand.id}-halo`}
                      d={l.dots}
                      className="sm-dot-halo"
                      style={{ strokeWidth: l.brand.total > 150 ? 6 : 10 }}
                    />
                  ))}
                  {layers.map((l) => (
                    <path
                      key={l.brand.id}
                      d={l.dots}
                      className="sm-dot-path"
                      style={{ ...brandVar(l.color), strokeWidth: l.brand.total > 150 ? 3.5 : 6 }}
                    />
                  ))}
                  {hoverId && hoverId !== activeId && hoverId !== compareId && paths.get(hoverId) && (
                    <>
                      <path d={paths.get(hoverId)} className="sm-hover-halo" />
                      <path d={paths.get(hoverId)} className="sm-hover" />
                    </>
                  )}
                  {activeId && (
                    <>
                      <path d={paths.get(activeId)} className="sm-active-halo" />
                      <path d={paths.get(activeId)} className="sm-active" />
                    </>
                  )}
                  {compareId && (
                    <>
                      <path d={paths.get(compareId)} className="sm-active-halo" />
                      <path d={paths.get(compareId)} className="sm-active sm-active-b" />
                    </>
                  )}
                </g>
              </svg>

              {/* Restaurant pins are drawn here, under the controls and legend */}
              <canvas ref={canvasRef} className="sm-pins" aria-hidden="true" />

              {/* Color-by control lives on the map, outside the legend, so the main question the map answers is always one click away */}
              <div className="sm-topleft">
              <div className="sm-colorby">
                {simActive && active ? (
                  <div className="sm-colorby-sim" role="status">
                    <span>
                      Coloring by <b>similarity to {nameOf(active)}</b>, not chain share
                    </span>
                    <button type="button" className="sm-legend-reset" onClick={() => setSimOn(false)}>
                      Back to chain share
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="sm-colorby-label" id="sm-colorby-label">
                      Color the map by share of restaurants that are
                    </span>
                    <div className="sm-seg" role="group" aria-labelledby="sm-colorby-label">
                      {METRICS.map((m) => (
                        <button key={m.key} type="button" aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* Restaurant-pin toggle: stacked directly under the color-by card */}
              {!layers.length && (
                <div className="sm-controls">
                  <button type="button" className="sm-pin-toggle" aria-pressed={showPins} onClick={() => setShowPins((v) => !v)}>
                    <i
                      className="sm-pin-key"
                      style={{ background: showPins ? PIN_COLOR : 'transparent' }}
                    />
                    Restaurants
                  </button>
                </div>
              )}
              </div>


              {/* Legend sits on the map so it stays visible while the panel scrolls */}
              {legendOpen ? (
                <div className="sm-legend">
                  <div className="sm-legend-bar">
                    <strong>{legendTitle}</strong>
                    <button
                      type="button"
                      className="sm-legend-btn"
                      onClick={() => setLegendOpen(false)}
                      aria-label="Minimize legend"
                      aria-expanded="true"
                    >
                      −
                    </button>
                  </div>

                  <div className="sm-legend-group">
                    {layers.length > 0 && (
                      <>
                        {layers.map((l) => (
                          <span key={l.brand.id} className="sm-key" style={brandVar(l.color)}>
                            <i className="sm-dot" /> One {l.brand.name} location
                          </span>
                        ))}
                        <span className="sm-hint">Hover a dot to see that restaurant.</span>
                      </>
                    )}
                      <>
                        {/* Plain ramp by default. The histogram + handles (a range filter) appear on request, or while a range is set */}
                        {showFilter ? (
                          <div className="sm-brush" ref={trackRef} onPointerDown={onTrackDown}>
                            <div className="sm-hist" aria-hidden="true">
                              {brushStats.bins.map((n, i) => (
                                <span
                                  key={i}
                                  className={`sm-bar${binInside(i) ? '' : ' sm-bar-out'}${hoverBin === i ? ' sm-bar-hover' : ''}`}
                                  style={{
                                    height: `${(n / brushStats.max) * 100}%`,
                                    background: color(lo + ((i + 0.5) / HIST_BINS) * span),
                                  }}
                                />
                              ))}
                            </div>
                            <div className="sm-ramp" style={{ background: rampCss }} />
                            {range && (
                              <>
                                <span className="sm-mask sm-mask-lo" style={{ width: `${frac(range[0]) * 100}%` }} />
                                <span className="sm-mask sm-mask-hi" style={{ width: `${(1 - frac(range[1])) * 100}%` }} />
                              </>
                            )}
                            {hoverFrac !== null && <span className="sm-hover-tick" style={{ left: `${hoverFrac * 100}%` }} />}
                            {handle(0)}
                            {handle(1)}
                          </div>
                        ) : (
                          <div className="sm-brush sm-brush-lite">
                            <div className="sm-ramp" style={{ background: rampCss }} />
                            {hoverFrac !== null && <span className="sm-hover-tick" style={{ left: `${hoverFrac * 100}%` }} />}
                          </div>
                        )}
                        <span className="sm-ramp-labels">
                          <span>
                            {pct(lo)}
                            {simActive ? ' similar' : ''} or less
                          </span>
                          <span>
                            {pct(hi)}
                            {simActive ? ' similar' : ''} or more
                          </span>
                        </span>
                        {showFilter && (
                          <span className="sm-brush-readout" aria-live="polite">
                            {range ? (
                              <>
                                <b>
                                  {brushStats.inside} of {brushStats.total}
                                </b>{' '}
                                neighborhoods: {rangeText}
                              </>
                            ) : (
                              <span className="sm-hint">Drag the handles to keep only a range.</span>
                            )}
                          </span>
                        )}
                        {range ? (
                          <button type="button" className="sm-legend-reset" onClick={() => setRange(null)}>
                            Reset range
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="sm-legend-reset"
                            aria-expanded={filterOpen}
                            onClick={() => setFilterOpen((v) => !v)}
                          >
                            {filterOpen ? 'Hide range filter' : 'Filter by range'}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`sm-key sm-key-btn${hideNoData ? ' sm-key-off' : ''}`}
                          aria-pressed={!hideNoData}
                          title={hideNoData ? 'Show these neighborhoods again' : 'Click to fade these neighborhoods out'}
                          onClick={() => setHideNoData((v) => !v)}
                        >
                          <i className="sm-swatch sm-swatch-nodata" /> Fewer than {MIN_RESTAURANTS} restaurants, too few to compare
                        </button>
                        {showPins && !layers.length && (
                          <>
                            <span className="sm-key">
                              <i className="sm-pin-key" style={{ background: PIN_COLOR }} /> One restaurant
                            </span>
                            <span className="sm-hint">
                              {pinRows
                                ? 'More pins appear as you zoom in. Zoom in close and hover a pin for details.'
                                : 'Loading restaurants…'}
                            </span>
                          </>
                        )}
                      </>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="sm-legend-closed"
                  onClick={() => setLegendOpen(true)}
                  aria-label="Show legend"
                  aria-expanded="false"
                >
                  Legend{range || hideNoData ? ' (filtered)' : ''}
                </button>
              )}

              <div className="sm-zoom" role="group" aria-label="Map zoom">
                <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in">+</button>
                <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">−</button>
                <button type="button" onClick={resetAll} aria-label="Reset zoom and clear selection">⟲</button>
              </div>

              {tip &&
                (tip.pins ? (
                  <div
                    className="sm-tip sm-tip-pin"
                    style={{
                      left: tip.x,
                      top: tip.y,
                      transform: `translate(${tip.flipX ? 'calc(-100% - 0.75rem)' : '0.75rem'}, ${tip.flipY ? 'calc(-100% - 0.75rem)' : '0.75rem'})`,
                    }}
                    role="tooltip"
                  >
                    {tip.pins.map((r, i) => (
                      <div key={i} className="sm-tip-row">
                        <strong>
                          {r.color && <i className="sm-dot sm-dot-tip" style={brandVar(r.color)} />}
                          {r.name}
                        </strong>
                        <span>
                          {r.brand} · {plural(r.locs, 'location')} citywide
                        </span>
                        <span>
                          {r.cuisine}
                          {r.nbhd ? ` · ${r.nbhd}` : ''}
                        </span>
                      </div>
                    ))}
                    {!!tip.more && <div className="sm-tip-more">+{tip.more} more at this spot</div>}
                  </div>
                ) : (
                  <div className="sm-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
                    {tip.text}
                  </div>
                ))}
            </div>

            {view === 'tiers' && (
              <div className="sm-altview">
                <TierGrid
                  features={nbhdList}
                  byId={byId}
                  paths={paths}
                  ramps={tierRamps}
                  hoverId={hoverId}
                  activeId={activeId}
                  compareId={compareId}
                  group={group}
                  onHover={setHoverId}
                  onPick={pick}
                  onOpen={openTier}
                />
              </div>
            )}
            {view === 'plot' && (
              <div className="sm-altview">
                {emb ? (
                  <MakeupPlot
                    emb={emb}
                    byId={byId}
                    features={nbhdList}
                    paths={paths}
                    colorOf={(p) => (p.n_restaurants < MIN_RESTAURANTS ? '#ccc' : color(valueOf(p)))}
                    colorTitle={legendTitle}
                    rampCss={rampCss}
                    lo={lo}
                    hi={hi}
                    hoverId={hoverId}
                    activeId={activeId}
                    compareId={compareId}
                    group={group}
                    box={box}
                    onBox={setBox}
                    onHover={setHoverId}
                    onPick={pick}
                  />
                ) : (
                  <p className="sm-notice">{cuisines ? 'Not enough neighborhoods to plot.' : 'Loading restaurant data…'}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Divider: drag to resize the panel, arrow keys to nudge it, double-click to reset */}
        <div
          className="sm-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
          aria-valuemin={Math.round(PANEL_MIN * 100)}
          aria-valuemax={Math.round(PANEL_MAX * 100)}
          aria-valuenow={Math.round(panelFrac * 100)}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId) || !stageRef.current) return;
            const r = stageRef.current.getBoundingClientRect();
            setPanelFrac(Math.min(PANEL_MAX, Math.max(PANEL_MIN, (r.right - e.clientX) / r.width)));
          }}
          onDoubleClick={() => setPanelFrac(PANEL_DEFAULT)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? PANEL_KEY_STEP * 5 : PANEL_KEY_STEP;
            // The panel is on the right, so moving the divider left makes it wider
            if (e.key === 'ArrowLeft') setPanelFrac((f) => Math.min(PANEL_MAX, f + step));
            else if (e.key === 'ArrowRight') setPanelFrac((f) => Math.max(PANEL_MIN, f - step));
            else if (e.key === 'Home') setPanelFrac(PANEL_DEFAULT);
            else return;
            e.preventDefault();
          }}
        />

        {/* Right panel: scrolls on its own. */}
        <aside className="sm-panel" aria-label="Neighborhood details">
          <div className="sm-search" ref={searchRef}>
            <label htmlFor="sm-search-input" className="sr-only">
              Search neighborhoods or restaurants
            </label>
            <div className="sm-search-box">
            <input
              id="sm-search-input"
              type="search"
              className="sm-search-input"
              placeholder="Search neighborhoods or restaurants"
              autoComplete="off"
              value={query}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (results[0]) choose(results[0].id);
                  else if (brandResults[0]) chooseBrand(brandResults[0].id);
                }
                // Escape clears the search first; it only clears the map selection when the box is empty
                if (e.key === 'Escape' && query) {
                  setQuery('');
                  e.stopPropagation();
                }
              }}
            />
            {q && searchOpen && (
            <div className="sm-dropdown">
            {results.length > 0 && (
              <>
                <h4 className="sm-results-head">Neighborhoods</h4>
                <ul className="sm-results" role="list">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`sm-result${hoverId === p.id ? ' sm-linked' : ''}`}
                        onClick={() => choose(p.id)}
                        {...link(p.id)}
                      >
                        <span>
                          {nameOf(p)}
                          {p.boro && <span className="sm-result-boro">{titleCase(p.boro)}</span>}
                        </span>
                        <span className="sm-result-share">
                          {p.n_restaurants >= MIN_RESTAURANTS ? `${pct(chainShare(p))} chains` : 'few restaurants'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {matches.length > results.length && (
                  <p className="sm-hint sm-more">
                    Showing {results.length} of {matches.length}. Keep typing to narrow it down.
                  </p>
                )}
              </>
            )}
            {brandResults.length > 0 && (
              <>
                <h4 className="sm-results-head">
                  Restaurants and chains{picked.length > 0 && ` (${picked.length} of ${MAX_BRANDS} on map)`}
                </h4>
                <ul className="sm-results" role="list">
                  {brandResults.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="sm-result" onClick={() => chooseBrand(b.id)}>
                        <span className="sm-rowlabel">
                          <i className="sm-chip" style={{ background: TIER_COLORS[b.tier] }} />
                          {b.name}
                        </span>
                        <span className="sm-result-share">{isPicked(b.id) ? 'On map' : brandWhere(b)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {brandPool.length > brandResults.length && (
                  <p className="sm-hint sm-more">
                    Showing {brandResults.length} of {brandPool.length.toLocaleString()}. Keep typing to narrow it down.
                  </p>
                )}
              </>
            )}
            {brandBlocked && (
              <p className="sm-hint sm-more">
                {MAX_BRANDS} restaurants are already on the map. Remove one to add another.
              </p>
            )}
            {results.length === 0 && brandResults.length === 0 && !brandBlocked && (
              <p className="sm-note sm-more">
                No neighborhoods or restaurants match “{query.trim()}”.
                {!brands && ' Restaurant names are still loading.'}
              </p>
            )}
            </div>
            )}
            </div>
          </div>

          {layers.length > 0 && (
            <section aria-label="Restaurants on the map">
              <ul className="sm-picked" role="list">
                {layers.map((l) => (
                  <li key={l.brand.id} className="sm-picked-chip" style={brandVar(l.color)}>
                    <i className="sm-dot" />
                    <span>{l.brand.name}</span>
                    <button type="button" onClick={() => removeBrand(l.brand.id)} aria-label={`Remove ${l.brand.name} from the map`}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <p className="sm-hint">
                {layers.length} of {MAX_BRANDS} restaurants on the map.{' '}
                {layers.length < MAX_BRANDS ? 'Search to add another.' : 'Remove one to add another.'}
              </p>
              {layers.length > 1 && (
                <div className="sm-actions">
                  <button type="button" className="sm-btn sm-btn-quiet" onClick={clearBrands}>
                    Clear all restaurants
                  </button>
                </div>
              )}
            </section>
          )}

          {layers.map((l) => (
            <section key={l.brand.id} aria-live="polite">
              <h3 style={brandVar(l.color)}>
                <i className="sm-dot" /> Restaurant: {l.brand.name}
              </h3>
              <BrandView
                b={l.brand}
                byId={byId}
                active={active}
                onChoose={choose}
                onClear={() => removeBrand(l.brand.id)}
                link={link}
                hoverId={hoverId}
              />
            </section>
          ))}

          {!active && groupList && (
            <section aria-label="Neighborhoods picked on the makeup plot">
              <h3>Picked on the Makeup Plot</h3>
              <p className="sm-note">
                <b className="sm-em">{groupList.length}</b> neighborhoods with a similar tier and cuisine mix, highest{' '}
                {metricInfo.phrase} first. Ranks are citywide.
              </p>
              <ul className="sm-rank" role="list">
                {groupList.slice(0, MAX_RANGE_LIST).map((p) => rankRow(p))}
              </ul>
              {groupList.length > MAX_RANGE_LIST && (
                <p className="sm-hint sm-more">
                  Showing {MAX_RANGE_LIST} of {groupList.length}. Brush a smaller box to see the rest.
                </p>
              )}
              <div className="sm-actions">
                <button type="button" className="sm-btn sm-btn-quiet" onClick={() => setBox(null)}>
                  Clear picked group
                </button>
              </div>
            </section>
          )}

          {!active ? (
            layers.length ? null : (
            <>
            <section>
              <h3>Citywide Breakdown</h3>
              <p className="sm-note">
                All {citywide.n.toLocaleString()} restaurants in NYC, grouped by how many locations in the city share the
                same name.
              </p>
              <TierBar shares={citywide.shares} />
              <ul className="sm-dist">
                {TIERS.map((t) => (
                  <li key={t.key}>
                    <span>
                      <i className="sm-swatch" style={{ background: TIER_COLORS[t.key] }} />
                      {t.label}
                    </span>
                    <b>{citywide.n ? pct(citywide.totals[t.key] / citywide.n) : '–'}</b>
                    <span className="sm-count">{citywide.totals[t.key].toLocaleString()}</span>
                  </li>
                ))}
              </ul>
              <p className="sm-hint sm-prompt">
                Click a neighborhood on the map, search for a neighborhood or restaurant above, or pick from the lists below.
              </p>
            </section>

            <section>
              <h3>Most and Least Chain-Heavy</h3>
              {inBrush ? (
                <>
                  <p className="sm-note">
                    <b className="sm-em">{inBrush.length}</b> of {ranking.eligible.length} neighborhoods fall in the legend
                    range ({rangeText}). Ranks are citywide.
                  </p>
                  <div className="sm-rank-group">
                    <h4>In range, highest first</h4>
                    {inBrush.length > 0 ? (
                      <ul className="sm-rank" role="list">
                        {inBrush.slice(0, MAX_RANGE_LIST).map((p) => rankRow(p))}
                      </ul>
                    ) : (
                      <p className="sm-hint">No neighborhoods in this range.</p>
                    )}
                    {inBrush.length > MAX_RANGE_LIST && (
                      <p className="sm-hint sm-more">
                        Showing {MAX_RANGE_LIST} of {inBrush.length}. Narrow the range to see the rest.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="sm-note">
                    Ranked by {metricInfo.phrase}, among the {ranking.eligible.length} neighborhoods with at
                    least {MIN_RESTAURANTS} restaurants.
                  </p>
                  {[
                    { title: metricInfo.most, list: ranking.eligible.slice(0, RANK_N) },
                    { title: metricInfo.fewest, list: ranking.eligible.slice(-RANK_N).reverse() },
                  ].map(({ title, list }) => (
                    <div key={title} className="sm-rank-group">
                      <h4>{title}</h4>
                      <ul className="sm-rank" role="list">
                        {list.map((p) => rankRow(p))}
                      </ul>
                    </div>
                  ))}
                </>
              )}
            </section>

            </>
            )
          ) : (
            <section className="sm-sel">
              {/* Header stays pinned while the rest of the panel scrolls, so the main actions are always in reach */}
              <div className="sm-sel-head">
                <div className="sm-sel-title" aria-live="polite">
                  <h3>{comparing ? 'Compare Neighborhoods' : nameOf(active)}</h3>
                  {!comparing && active.boro && <span className="sm-sel-boro">{titleCase(active.boro)}</span>}
                </div>
                <div className="sm-actions">
                  {!comparing && (
                    <button type="button" className="sm-btn sm-btn-compare" onClick={startCompare}>
                      <span aria-hidden="true">⇄</span> Compare with another neighborhood
                    </button>
                  )}
                  {comparing && other && (
                    <button type="button" className="sm-btn" onClick={swapCompare}>
                      Swap A and B
                    </button>
                  )}
                  {comparing && (
                    <button type="button" className="sm-btn sm-btn-quiet" onClick={stopCompare}>
                      {other ? 'Done comparing' : 'Cancel'}
                    </button>
                  )}
                  <button type="button" className="sm-btn sm-btn-quiet" onClick={clearSelection}>
                    {backLabel}
                  </button>
                </div>
              </div>

              {comparing && !other && (
                <p className="sm-note">
                  Comparing with <span className="sm-tag sm-tag-a">A</span> <b className="sm-em">{nameOf(active)}</b>.
                  Now click a second neighborhood on the map, or click A again to deselect it.
                </p>
              )}
              {comparing && other && (
                <>
                  <CompareView a={active} b={other} city={citywide} brands={brands} sim={simPair} tab={cmpTab} onTab={setCmpTab} />
                  <p className="sm-hint">Click another neighborhood to replace B, or click A or B to deselect it.</p>
                </>
              )}
              {!comparing && (
                <>
                  <NbhdSummary
                    p={active}
                    city={citywide}
                    rank={ranking.rank.get(active.id)}
                    ranked={ranking.eligible.length}
                    m={metricInfo}
                  />
                  {active.n_restaurants >= MIN_RESTAURANTS && (
                    <Tabs
                      label="Neighborhood view"
                      value={selTab}
                      onChange={(k) => {
                        // The Similar tab is a map mode: opening it colors the map by similarity, leaving it goes back to chain share
                        setSelTab(k);
                        setSimOn(k === 'similar');
                      }}
                      tabs={[
                        { key: 'overview', label: 'Overview' },
                        { key: 'similar', label: 'Similar neighborhoods' },
                      ]}
                    />
                  )}
                  {active.n_restaurants < MIN_RESTAURANTS || selTab === 'overview' ? (
                    <NeighborhoodView
                      p={active}
                      city={citywide}
                      brands={brands}
                      onPickBrand={chooseBrand}
                      isPicked={isPicked}
                      full={picked.length >= MAX_BRANDS}
                    />
                  ) : (
                    <SimilarView
                      p={active}
                      list={sim?.list ?? null}
                      byId={byId}
                      simOn={simActive}
                      onToggle={() => setSimOn((v) => !v)}
                      onCompare={compareWith}
                      link={link}
                      hoverId={hoverId}
                    />
                  )}
                </>
              )}
            </section>
          )}
        </aside>
      </div>

      <footer className="sm-footer">
        Source: NYC DOHMH Restaurant Inspection Results (Sep 2026), via NYC Open Data; Neighborhood boundaries from Zillow (2017), via Chris Whong (CC BY-SA 4.0).
        Restaurants are grouped into categories with normalization techniques and assigned to the closest neighborhood within overlapping boundaries, but variance is recognized. If you spot an error or have suggestions, feedback is welcome!
      </footer>
    </div>
  );
}