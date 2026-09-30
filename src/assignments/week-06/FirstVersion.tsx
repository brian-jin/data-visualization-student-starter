import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import {
  csvParse,
  geoMercator,
  geoPath,
  interpolateRgb,
  quantile,
  scaleSequential,
  select,
  zoom as d3zoom,
  zoomIdentity,
} from 'd3';
import type { ZoomBehavior, ZoomTransform } from 'd3';
import './FirstVersion.css';

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

const DATA_URL = `${import.meta.env.BASE_URL}data/nbhd.geo.json`;
const SIZE = 720;
const MIN_RESTAURANTS = 20; // Neighborhoods with restaurants fewer than this are hatched
const MAX_ZOOM = 100;
const LOW = '#DDE8DA';
const HIGH = '#344E41';

const TIERS: { key: Tier; label: string }[] = [
  { key: 'independent', label: 'Independent' },
  { key: 'mini_chain', label: 'Mini Chain (2–9)' },
  { key: 'chain', label: 'Chain (10–29)' },
  { key: 'big_chain', label: 'Big Chain (30+)' },
];

const PINS_URL = `${import.meta.env.BASE_URL}data/restaurants.csv`;
const PIN_COLORS = ['#F2C14E', '#E58A3C', '#C8503A', '#7D2E4D'];
const TIER_INDEX: Record<Tier, number> = { independent: 0, mini_chain: 1, chain: 2, big_chain: 3 };

// Restaurant locations, projected into map coordinates
interface Pins {
  x: Float32Array;
  y: Float32Array;
  tier: Uint8Array;
  order: Uint32Array;
}

// Add one circle to the current canvas path
function addCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// The same circle as a small SVG, for the legend
// A hollow gray ring means that type is currently filtered out
function PinIcon({ color, off = false }: { color: string; off?: boolean }) {
  return (
    <svg className="sm-key-icon" viewBox="0 0 14 14" aria-hidden="true">
      {off ? (
        <circle cx="7" cy="7" r="4.1" fill="none" stroke="#a9b5a6" strokeWidth="1.2" />
      ) : (
        <circle cx="7" cy="7" r="4.6" fill={color} />
      )}
    </svg>
  );
}

const chainShare = (p: NbhdProps) => (p.n_restaurants ? 1 - p.shares.independent : 0);
// Boroughs are lowercase from the data ("queens"), capitalize each word for display
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function FirstVersion() {
  const [data, setData] = useState<NbhdCollection | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [rows, setRows] = useState<{ lon: number; lat: number; tier: Tier }[] | null>(null);
  const [showPins, setShowPins] = useState(true);
  // Which restaurant types are shown, in the same order as tiers
  const [tierOn, setTierOn] = useState<boolean[]>([true, true, true, true]);
  const toggleTier = (i: number) => setTierOn((prev) => prev.map((on, j) => (j === i ? !on : on)));
  // Legend starts open on wide screens and minimized on phones
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia('(max-width: 800px)').matches);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRef = useRef<SVGGElement | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);

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

  // Restaurant locations
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(PINS_URL, { signal: ctrl.signal })
      .then((r) => r.text())
      .then((text) => {
        const out: { lon: number; lat: number; tier: Tier }[] = [];
        for (const r of csvParse(text)) {
          const lon = Number(r.lon);
          const lat = Number(r.lat);
          const tier = r.tier as Tier;
          if (Number.isFinite(lon) && Number.isFinite(lat) && tier in TIER_INDEX) out.push({ lon, lat, tier });
        }
        setRows(out);
      })
      .catch(() => {});
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

  const { projection, paths } = useMemo(() => {
    if (!data) return { projection: null, paths: new Map<string, string>() };
    const projection = geoMercator().fitExtent(
      [
        [6, 6],
        [SIZE - 6, SIZE - 6],
      ],
      data,
    );
    const toPath = geoPath(projection);
    return { projection, paths: new Map(data.features.map((f) => [f.properties.id, toPath(f) ?? ''])) };
  }, [data]);

  const pins = useMemo<Pins | null>(() => {
    if (!projection || !rows) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    const ts: number[] = [];
    for (const r of rows) {
      const p = projection([r.lon, r.lat]);
      if (!p) continue;
      xs.push(p[0]);
      ys.push(p[1]);
      ts.push(TIER_INDEX[r.tier]);
    }
    const n = xs.length;
    // Fixed pseudo-random order, so the same pins are kept at every zoom level
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
    return { x: Float32Array.from(xs), y: Float32Array.from(ys), tier: Uint8Array.from(ts), order };
  }, [projection, rows]);

  // Draw the pins on the canvas that sits over the map.
  // Zoomed out: sparse scatter of small dots. Zoomed in: more pins
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
    if (!pins || !showPins) return;

    // Map coordinates to screen pixels
    const { k, x: tx, y: ty } = transformRef.current;
    const fit = Math.min(w, h) / SIZE;
    const ox = (w - SIZE * fit) / 2 + tx * fit;
    const oy = (h - SIZE * fit) / 2 + ty * fit;
    const m = k * fit;

    const r = Math.min(4, 1.5 + 0.8 * Math.log2(k)); // icon size grows with zoom
    const t = Math.min(1, Math.log2(k) / Math.log2(MAX_ZOOM));
    // Minimum spacing between drawn pins, in pixels: wide when zoomed out, shrinking as you zoom in, and finally 0 so every single pin shows at the closest zoom.
    const gap = Math.max(26 * Math.pow(1 - t, 1.2), 2 * r * 1.15 * (1 - Math.min(1, Math.max(0, (k - 20) / 20))));
    const gcols = Math.ceil(w / gap) + 1;
    const grid = gap > 1.5 ? new Uint8Array(gcols * (Math.ceil(h / gap) + 1)) : null;

    const buckets: number[][] = [[], [], [], []];
    const pad = r * 2;
    for (let n = 0; n < pins.order.length; n++) {
      const i = pins.order[n];
      const sx = ox + m * pins.x[i];
      const sy = oy + m * pins.y[i];
      if (sx < -pad || sx > w + pad || sy < -pad || sy > h + pad) continue;
      // Filtered-out types are skipped before the spacing check
      if (!tierOn[pins.tier[i]]) continue;
      if (grid) {
        const cell = Math.floor(Math.min(Math.max(sy, 0), h) / gap) * gcols + Math.floor(Math.min(Math.max(sx, 0), w) / gap);
        if (grid[cell]) continue;
        grid[cell] = 1;
      }
      buckets[pins.tier[i]].push(sx, sy);
    }

    ctx.globalAlpha = Math.min(1, 0.6 + 0.2 * (k - 1)); // faint when zoomed out
    for (let ti = 0; ti < 4; ti++) {
      const pts = buckets[ti];
      if (!pts.length) continue;
      ctx.beginPath();
      for (let j = 0; j < pts.length; j += 2) addCircle(ctx, pts[j], pts[j + 1], r);
      ctx.lineWidth = r > 2.5 ? 1.25 : 0.75;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
      ctx.fillStyle = PIN_COLORS[ti];
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  useEffect(() => {
    schedule();
  }, [pins, showPins, tierOn, schedule]);

  useEffect(() => {
    if (!data || !mapRef.current) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(mapRef.current);
    return () => ro.disconnect();
  }, [data, schedule]);

  const { color, lo, hi } = useMemo(() => {
    const values = (data?.features ?? [])
      .filter((f) => f.properties.n_restaurants >= MIN_RESTAURANTS)
      .map((f) => chainShare(f.properties))
      .sort((a, b) => a - b);
    const lo = values[0] ?? 0;
    // Cap at the 98th percentile
    const hi = Math.max(quantile(values, 0.98) ?? 1, lo + 0.01);
    const scale = scaleSequential(interpolateRgb(LOW, HIGH)).domain([lo, hi]).clamp(true);
    return { color: scale, lo, hi };
  }, [data]);

  // Citywide restaurant counts per tier for the "Category distribution" section
  const citywide = useMemo(() => {
    const totals: Record<Tier, number> = { independent: 0, mini_chain: 0, chain: 0, big_chain: 0 };
    for (const f of data?.features ?? []) {
      for (const t of TIERS) totals[t.key] += f.properties.counts[t.key];
    }
    const n = TIERS.reduce((sum, t) => sum + totals[t.key], 0);
    return { totals, n };
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

  // Tooltip follows the mouse
  const showTip = (e: React.PointerEvent, p: NbhdProps) => {
    if (e.pointerType !== 'mouse' || !mapRef.current) return;
    const box = mapRef.current.getBoundingClientRect();
    setTip({ text: p.name ?? p.id, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  return (
    <div className="sm">
      <header className="sm-header">
        <h2>Mapping the "Same-ification" of NYC, From Blank to 7th Street</h2>
        <p className="sm-lede">
          Are NYC neighborhoods truly becoming more commercially homogeneous over time, and which neighborhoods are most impacted by changes such as independent shop replacements and gentrification?
        </p>
      </header>

      <div className="sm-stage">
        {/* Map: fills the left side */}
        <div className="sm-map" ref={mapRef}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label="Map of New York City neighborhoods shaded by chain restaurant share"
          >
            <defs>
              <pattern id="sm-thin" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="#eef3ec" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#b5c3b2" strokeWidth="2" />
              </pattern>
            </defs>
            <g ref={gRef}>
              {data.features.map((f) => {
                const p = f.properties;
                return (
                  <path
                    key={p.id}
                    d={paths.get(p.id)}
                    className="sm-nbhd"
                    fill={p.n_restaurants >= MIN_RESTAURANTS ? color(chainShare(p)) : 'url(#sm-thin)'}
                    onPointerEnter={(e) => showTip(e, p)}
                    onPointerMove={(e) => showTip(e, p)}
                    onPointerLeave={() => setTip(null)}
                    onClick={() => setActiveId(p.id)}
                  />
                );
              })}
              {activeId && <path d={paths.get(activeId)} className="sm-active" />}
            </g>
          </svg>

          {/* Restaurant pins are drawn here */}
          <canvas ref={canvasRef} className="sm-pins" aria-hidden="true" />

          {/* Legend sits on the map so it stays visible while the panel scrolls */}
          {legendOpen ? (
            <div className="sm-legend">
              <div className="sm-legend-bar">
                <strong>Chain Distribution of Restaurants</strong>
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
              <span className="sm-ramp" style={{ background: `linear-gradient(to right, ${LOW}, ${HIGH})` }} />
              <span className="sm-ramp-labels">
                <span>{pct(lo)}</span>
                <span>{pct(hi)} or more</span>
              </span>
              <span className="sm-thin-note">
                <i /> Fewer than {MIN_RESTAURANTS} restaurants
              </span>

              <strong className="sm-legend-head">Restaurant Pins</strong>
              <ul className="sm-keys">
                {TIERS.map((tier, i) => (
                  <li key={tier.key}>
                    {/* Each key is a filter: click to show or hide that type */}
                    <button
                      type="button"
                      className={`sm-key${tierOn[i] && showPins ? '' : ' sm-key-off'}`}
                      aria-pressed={tierOn[i]}
                      disabled={!showPins}
                      onClick={() => toggleTier(i)}
                    >
                      <PinIcon color={PIN_COLORS[i]} off={!tierOn[i] || !showPins} /> {tier.label}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="sm-toggle">
                <input type="checkbox" checked={showPins} onChange={(e) => setShowPins(e.target.checked)} /> Show Restaurants
              </label>
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
            <button type="button" onClick={resetZoom} aria-label="Reset zoom">⟲</button>
          </div>

          {tip && (
            <div className="sm-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
              {tip.text}
            </div>
          )}
        </div>

        {/* Right panel: scrolls on its own. */}
        <aside className="sm-panel" aria-label="Neighborhood details">
          <section aria-live="polite">
            <h3>
              Selected Neighborhood
              {active && `: ${active.name ?? active.id}${active.boro ? `, ${titleCase(active.boro)}` : ''}`}
            </h3>
            <div className="sm-readout">
              {!active && <span>Tap a neighborhood on the map to see details.</span>}
              {active && (
                <>
                  {active.n_restaurants < MIN_RESTAURANTS ? (
                    <p className="sm-note">
                      {active.name ?? active.id} has only <b className="sm-em">{active.n_restaurants}</b> restaurants,
                      too few to compare.
                    </p>
                  ) : (
                    <>
                      <p className="sm-note">
                        {active.name ?? active.id} is comprised of{' '}
                        <b className="sm-em">{active.n_restaurants.toLocaleString()}</b> restaurants. Of these
                        restaurants, <b className="sm-em">{pct(chainShare(active))}</b> are chains.
                      </p>
                      <ul className="sm-dist">
                        {TIERS.map((t) => (
                          <li key={t.key}>
                            <span>{t.label}</span>
                            <b>{pct(active.shares[t.key])}</b>
                            <span className="sm-count">{active.counts[t.key].toLocaleString()}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </section>

          <section>
            <h3>Category Distribution</h3>
            <p className="sm-note">
              All {citywide.n.toLocaleString()} restaurants in NYC classified by ownership size. A chart will replace this.
            </p>
            <ul className="sm-dist">
              {TIERS.map((t) => (
                <li key={t.key}>
                  <span>{t.label}</span>
                  <b>{citywide.n ? pct(citywide.totals[t.key] / citywide.n) : '–'}</b>
                  <span className="sm-count">{citywide.totals[t.key].toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </section>

        </aside>
      </div>

      <footer className="sm-footer">
        Source: NYC DOHMH Restaurant Inspection Results (Sep 2026), via NYC Open Data; Neighborhood boundaries from Zillow (2017), via Chris Whong (CC BY-SA 4.0).
        Restaurants are grouped into categories with normalization techniques and assigned to the closest neighborhood within overlapping boundaries, but variance is recognized. If you spot an error or have suggestions, feedback is welcome!
      </footer>
    </div>
  );
}