import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import {
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
import type { ZoomBehavior, ZoomTransform } from 'd3';
import './IterateProject.css';

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
      b = { id: name, name, tier, total: 0, recent: 0, nbhds: {}, pts: [] };
      byName.set(name, b);
    }
    b.total++;
    b.nbhds[r.nbhd_id] = (b.nbhds[r.nbhd_id] ?? 0) + 1;
    b.pts.push([lon, lat]);
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

const DATA_URL = `${import.meta.env.BASE_URL}data/nbhd.geo.json`;
const SIZE = 720;
const MIN_RESTAURANTS = 20; // Used for the side panel and to set the color range
const RANK_N = 5; // How many neighborhoods each ranking list shows
const MAX_RESULTS = 8; // Most search results listed at once
const MAX_BRAND_RESULTS = 6; // Most restaurant results listed at once
const PIN_COLOR = '#FFF6DD'; // ivory: light enough to read on the dark end of the ramp
const PIN_RING = '#2B3A46'; // dark ring (the page's ink color) keeps ivory pins visible on the pale end
const HOVER_ZOOM = 4; // pins answer hover once the map is zoomed in at least this far
const HIT_RADIUS = 9; // pixels around the cursor that count as "on" a pin
const MAX_PIN_TIP = 4; // restaurants listed when several pins sit on the same spot
const BRAND_MIN_SPAN = SIZE * 0.08; // A single location still zooms to about this much of the map
const RESTAURANTS_URL = `${import.meta.env.BASE_URL}data/restaurants.csv`;
const MAX_ZOOM = 100;
const ZOOM_FILL = 0.8; // Clicked neighborhood fills this fraction of the map (1 = edge to edge)

// Color ramp: low chain share -> high chain share. source: https://coolors.co/palette/c9e4ca-87bba2-55828b-3b6064-364958
const RAMP = ['#C9E4CA', '#87BBA2', '#55828B', '#3B6064', '#364958'];

const NO_DATA = 'url(#sm-nodata)'; // Hatched fill (defined in the <svg>) for neighborhoods with too few restaurants to compare

const TIERS: { key: Tier; label: string }[] = [
  { key: 'independent', label: 'Independent' },
  { key: 'mini_chain', label: 'Mini Chain (2–9)' },
  { key: 'chain', label: 'Chain (10–29)' },
  { key: 'big_chain', label: 'Big Chain (30+)' },
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
      <span className="sm-hint">Bars show each category's share of restaurants; the number is the total chain share.</span>
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
function NeighborhoodView({ p, city, rank, ranked }: { p: NbhdProps; city: City; rank?: number; ranked: number }) {
  const cols = [neighborhoodCol(p, 'here', 'Here'), cityCol(city)];
  return (
    <>
      {p.n_restaurants < MIN_RESTAURANTS ? (
        <p className="sm-note">
          {nameOf(p)} has only <b className="sm-em">{p.n_restaurants}</b> restaurants, too few to compare reliably.
        </p>
      ) : (
        <p className="sm-note">
          {nameOf(p)} has <b className="sm-em">{p.n_restaurants.toLocaleString()}</b> restaurants.{' '}
          <b className="sm-em">{pct(chainShare(p))}</b> of them are chains, compared with{' '}
          <b className="sm-em">{pct(colChain(cols[1]))}</b> citywide.
          {rank !== undefined && (
            <>
              {' '}
              It ranks <b className="sm-em">#{rank}</b> of {ranked} neighborhoods by chain share (#1 has the most chains).
            </>
          )}
        </p>
      )}
      <BreakdownBars cols={cols} />
      <BreakdownTable cols={cols} />
    </>
  );
}

// Side-by-side comparison of two neighborhoods, with the citywide mix as a reference
function CompareView({ a, b, city }: { a: NbhdProps; b: NbhdProps; city: City }) {
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

      <BreakdownBars cols={cols} />
      <BreakdownTable cols={cols} />
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
}: {
  b: Brand;
  byId: Map<string, NbhdProps>;
  active: NbhdProps | null;
  onChoose: (id: string) => void;
  onClear: () => void;
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
                <button type="button" className="sm-result" onClick={() => onChoose(p.id)}>
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
          Clear restaurant
        </button>
      </div>
    </>
  );
}

export function IterateProject() {
  const [data, setData] = useState<NbhdCollection | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Compare mode: `comparing` is on from the moment you press Compare; `compareId` is the second neighborhood once picked
  const [comparing, setComparing] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(true); // the results dropdown closes when you click elsewhere
  // Restaurant names load in the background; `brandId` is the restaurant currently shown on the map
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [pinRows, setPinRows] = useState<Pin[] | null>(null);
  const [showPins, setShowPins] = useState(false); // the pin layer is optional, so it starts off
  const [tip, setTip] = useState<Tip | null>(null);
  // Legend starts open on wide screens and minimized on phones
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia('(max-width: 800px)').matches);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
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
  const zoomToBrand = (b: Brand) => {
    if (!project) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of b.pts) {
      const xy = project(c);
      if (!xy) continue;
      x0 = Math.min(x0, xy[0]);
      y0 = Math.min(y0, xy[1]);
      x1 = Math.max(x1, xy[0]);
      y1 = Math.max(y1, xy[1]);
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

  // Back to the full-city view: nothing selected, not comparing, zoomed all the way out
  const clearSelection = () => {
    setActiveId(null);
    setCompareId(null);
    setComparing(false);
    setBrandId(null);
    resetZoom();
  };
  // Escape does the same, through a ref so the key listener below never goes stale
  const clearRef = useRef(clearSelection);
  clearRef.current = clearSelection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A click picks a neighborhood. Clicking the selected one again deselects it.
  // In compare mode a click picks the second neighborhood (click it again to unpick it).
  const pick = (id: string) => {
    if (comparing && activeId) {
      if (id === activeId) return;
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
    if (!comparing && id === activeId) zoomToNbhds([id]);
    else pick(id);
    setQuery('');
  };
  // Picking a restaurant replaces any neighborhood selection and zooms to all of its locations
  const chooseBrand = (id: string) => {
    setBrandId(id);
    setActiveId(null);
    setCompareId(null);
    setComparing(false);
    setQuery('');
    const b = brands?.find((x) => x.id === id);
    if (b) zoomToBrand(b);
  };
  const clearBrand = () => {
    setBrandId(null);
    if (!activeId) resetZoom();
  };
  const startCompare = () => {
    setComparing(true);
    setCompareId(null);
  };
  const stopCompare = () => {
    setComparing(false);
    setCompareId(null);
    if (activeId) zoomToNbhds([activeId]);
  };
  const swapCompare = () => {
    setActiveId(compareId);
    setCompareId(activeId);
  };

  // Color range comes from the neighborhood-level chain shares (98th percentile cap),
  // so one extreme neighborhood doesn't wash out the rest of the ramp
  const { color, lo, hi } = useMemo(() => {
    const values = (data?.features ?? [])
      .filter((f) => f.properties.n_restaurants >= MIN_RESTAURANTS)
      .map((f) => chainShare(f.properties))
      .sort((a, b) => a - b);
    const lo = values[0] ?? 0;
    const hi = Math.max(quantile(values, 0.98) ?? 1, lo + 0.01);
    const scale = scaleSequential(piecewise(interpolateLab, RAMP)).domain([lo, hi]).clamp(true);
    return { color: scale, lo, hi };
  }, [data]);

  const byId = useMemo(() => new Map((data?.features ?? []).map((f) => [f.properties.id, f.properties])), [data]);
  const brand = useMemo(() => brands?.find((b) => b.id === brandId) ?? null, [brands, brandId]);
  // All of one restaurant's locations as a single path of zero-length segments; round caps draw them as dots
  const dots = useMemo(() => {
    if (!brand || !project) return '';
    return brand.pts
      .map((c) => {
        const xy = project(c);
        return xy ? `M${xy[0].toFixed(2)},${xy[1].toFixed(2)}h0.001` : '';
      })
      .join('');
  }, [brand, project]);
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
    if (!pins || !showPins || brand) return;

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
  }, [pins, showPins, brand, schedule]);

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
      .sort((a, b) => chainShare(b) - chainShare(a) || nameOf(a).localeCompare(nameOf(b)));
    return { eligible, rank: new Map(eligible.map((p, i) => [p.id, i + 1])) };
  }, [data]);

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
  const brandResults = brandMatches.slice(0, MAX_BRAND_RESULTS);
  const brandWhere = (b: Brand) =>
    b.total === 1 ? (byId.get(Object.keys(b.nbhds)[0])?.name ?? '1 location') : plural(b.total, 'location');

  // Tooltip follows the mouse
  // Restaurants under the cursor: only pins that are drawn, and only once zoomed in. Pins stacked on one spot are all listed.
  const pinsAt = (x: number, y: number) => {
    if (!pinRows || !showPins || brand || transformRef.current.k < HOVER_ZOOM) return null;
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
    const box = mapRef.current.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const hit = pinsAt(x, y);
    if (hit) {
      // Flip the card to the other side of the cursor near the right and bottom edges
      setTip({ text: '', x, y, pins: hit.list, more: hit.more, flipX: x > box.width - 280, flipY: y > box.height - 190 });
      return;
    }
    setTip({ text: brand ? `${nameOf(p)}: ${plural(brand.nbhds[p.id] ?? 0, 'location')}` : nameOf(p), x, y });
  };

  return (
    <div className="sm">
      <header className="sm-header">
        <h2>Where Do Chains Cluster in NYC? From Blank Street to 7th Street</h2>
        <p className="sm-lede">
          A snapshot of NYC restaurants today: in each neighborhood, what share belong to a chain? This map shows where chains cluster now, not how neighborhoods have changed over time.
        </p>
      </header>

      <div className="sm-stage">
        {/* Map: fills the left side */}
        <div className="sm-map" ref={mapRef}>
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
                // Shade by chain share; neighborhoods with too few restaurants get the hatched fill
                // While a restaurant is on the map the fills go neutral so its dots stand out
                const fill = brand
                  ? 'var(--nbhd)'
                  : p.n_restaurants < MIN_RESTAURANTS
                    ? NO_DATA
                    : color(chainShare(p));
                return (
                  <path
                    key={p.id}
                    d={paths.get(p.id)}
                    className="sm-nbhd sm-filled"
                    style={{ fill }}
                    onPointerEnter={(e) => showTip(e, p)}
                    onPointerMove={(e) => showTip(e, p)}
                    onPointerLeave={() => setTip(null)}
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
              {brand && (
                <>
                  <path d={dots} className="sm-dot-halo" style={{ strokeWidth: brand.total > 150 ? 6 : 10 }} />
                  <path d={dots} className="sm-dot-path" style={{ strokeWidth: brand.total > 150 ? 3.5 : 6 }} />
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

          {!brand && (
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

          {/* Legend sits on the map so it stays visible while the panel scrolls */}
          {legendOpen ? (
            <div className="sm-legend">
              <div className="sm-legend-bar">
                <strong>{brand ? 'Restaurant locations' : 'Chain share by area'}</strong>
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
                {brand ? (
                  <>
                    <span className="sm-key">
                      <i className="sm-dot" /> One {brand.name} location
                    </span>
                    <span className="sm-hint">Neighborhoods are shown in a single neutral color.</span>
                  </>
                ) : (
                  <>
                    <strong>Share of restaurants that are chains</strong>
                    <span className="sm-ramp" style={{ background: `linear-gradient(to right, ${RAMP.join(', ')})` }} />
                    <span className="sm-ramp-labels">
                      <span>{pct(lo)} or less</span>
                      <span>{pct(hi)} or more</span>
                    </span>
                    <span className="sm-hint">Each neighborhood is shaded by its overall share of chains.</span>
                    <span className="sm-key">
                      <i className="sm-swatch sm-swatch-nodata" /> Fewer than {MIN_RESTAURANTS} restaurants, too few to compare
                    </span>
                    {showPins && (
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
                )}
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
              Legend
            </button>
          )}

          <div className="sm-zoom" role="group" aria-label="Map zoom">
            <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">−</button>
            <button type="button" onClick={clearSelection} aria-label="Reset zoom and clear selection">⟲</button>
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
                    <strong>{r.name}</strong>
                    <span>
                      {r.brand} · {plural(r.locs, 'location')} citywide
                    </span>
                    <span>{r.cuisine}</span>
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
                      <button type="button" className="sm-result" onClick={() => choose(p.id)}>
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
                <h4 className="sm-results-head">Restaurants and chains</h4>
                <ul className="sm-results" role="list">
                  {brandResults.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="sm-result" onClick={() => chooseBrand(b.id)}>
                        <span className="sm-rowlabel">
                          <i className="sm-chip" style={{ background: TIER_COLORS[b.tier] }} />
                          {b.name}
                        </span>
                        <span className="sm-result-share">{brandWhere(b)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {brandMatches.length > brandResults.length && (
                  <p className="sm-hint sm-more">
                    Showing {brandResults.length} of {brandMatches.length.toLocaleString()}. Keep typing to narrow it down.
                  </p>
                )}
              </>
            )}
            {results.length === 0 && brandResults.length === 0 && (
              <p className="sm-note sm-more">
                No neighborhoods or restaurants match “{query.trim()}”.
                {!brands && ' Restaurant names are still loading.'}
              </p>
            )}
            </div>
            )}
            </div>
          </div>

          {brand && (
            <section aria-live="polite">
              <h3>Restaurant: {brand.name}</h3>
              <BrandView b={brand} byId={byId} active={active} onChoose={choose} onClear={clearBrand} />
            </section>
          )}

          {!active ? (
            brand ? null : (
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
              <p className="sm-note">
                Ranked by share of restaurants that are chains, among the {ranking.eligible.length} neighborhoods with at
                least {MIN_RESTAURANTS} restaurants.
              </p>
              {[
                { title: 'Most chains', list: ranking.eligible.slice(0, RANK_N) },
                { title: 'Fewest chains', list: ranking.eligible.slice(-RANK_N).reverse() },
              ].map(({ title, list }) => (
                <div key={title} className="sm-rank-group">
                  <h4>{title}</h4>
                  <ul className="sm-rank" role="list">
                    {list.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="sm-result" onClick={() => choose(p.id)}>
                          <span className="sm-rank-n">#{ranking.rank.get(p.id)}</span>
                          <span className="sm-rank-name">
                            {nameOf(p)}
                            {p.boro && <span className="sm-result-boro">{titleCase(p.boro)}</span>}
                          </span>
                          <span className="sm-rank-share">
                            <i className="sm-chip" style={{ background: color(chainShare(p)) }} />
                            {pct(chainShare(p))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>

            </>
            )
          ) : (
            <section aria-live="polite">
              <h3>
                {comparing ? 'Compare Neighborhoods' : 'Selected Neighborhood'}
                {!comparing && `: ${nameOf(active)}${active.boro ? `, ${titleCase(active.boro)}` : ''}`}
              </h3>

              {comparing && !other && (
                <p className="sm-note">
                  Comparing with <span className="sm-tag sm-tag-a">A</span> <b className="sm-em">{nameOf(active)}</b>.
                  Now click a second neighborhood on the map.
                </p>
              )}
              {comparing && other && <CompareView a={active} b={other} city={citywide} />}
              {!comparing && (
                <NeighborhoodView p={active} city={citywide} rank={ranking.rank.get(active.id)} ranked={ranking.eligible.length} />
              )}

              <div className="sm-actions">
                {!comparing && (
                  <button type="button" className="sm-btn" onClick={startCompare}>
                    Compare with another neighborhood
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
                  Back to citywide view
                </button>
                {comparing && other && <p className="sm-hint">Click another neighborhood to replace B.</p>}
              </div>
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