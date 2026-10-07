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
import { hexbin } from 'd3-hexbin';
import './SecondVersion.css';

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
const PINS_URL = `${import.meta.env.BASE_URL}data/restaurants.csv`;
const SIZE = 720;
const MIN_RESTAURANTS = 20; // Used for the side panel and to set the color range
const MAX_ZOOM = 100;
const ZOOM_FILL = 0.8; // Clicked neighborhood fills this fraction of the map (1 = edge to edge)

// Hexagon ramp: low chain share -> high chain share. source: https://coolors.co/palette/c9e4ca-87bba2-55828b-3b6064-364958
const RAMP = ['#C9E4CA', '#87BBA2', '#55828B', '#3B6064', '#364958'];

// Hexbin settings
// The hex grid is anchored to the map (not the screen), so dragging never reshuffles the bins.
// Bins only get finer at fixed zoom steps, and stop getting finer at HEX_ZOOM_CAP.
const BASE_R = 10; // Bin cell radius in map units at zoom 1
const HEX_MIN = 0.3; // Smallest hexagon, as a fraction of its cell, so single restaurants stay visible
const LEVELS_PER_DOUBLING = 2; // Grid refines in steps of sqrt(2) each time you zoom in
const HEX_ZOOM_CAP = 6; // Past this zoom the grid freezes and hexagons simply scale with the map
const NO_DATA = '#E3E0D6'; // Neighborhood view: neighborhoods with too few restaurants to compare
const MAX_LEVEL = Math.floor(Math.log2(HEX_ZOOM_CAP) * LEVELS_PER_DOUBLING);

// One hexagon bin in map coordinates
interface Bin {
  x: number;
  y: number;
  n: number; // restaurants in the bin
  share: number; // fraction of them that are chains
}

const TIERS: { key: Tier; label: string }[] = [
  { key: 'independent', label: 'Independent' },
  { key: 'mini_chain', label: 'Mini Chain (2–9)' },
  { key: 'chain', label: 'Chain (10–29)' },
  { key: 'big_chain', label: 'Big Chain (30+)' },
];
const TIER_KEYS = new Set<string>(TIERS.map((t) => t.key));

// Restaurant locations, projected into map coordinates
interface Pins {
  x: Float32Array; // map coordinates
  y: Float32Array;
  chain: Uint8Array; // 1 if the restaurant is any kind of chain
  ids: number[]; // 0..n-1, what gets handed to the hexbin generator
}

// Fraction of the cell a hexagon fills, scaled by area (sqrt) so size reads as count
const hexFrac = (count: number, max: number) => Math.max(HEX_MIN, Math.sqrt(count / max));

const chainShare = (p: NbhdProps) => (p.n_restaurants ? 1 - p.shares.independent : 0);
// Boroughs are lowercase from the data ("queens"), capitalize each word for display
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function SecondVersion() {
  const [data, setData] = useState<NbhdCollection | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [rows, setRows] = useState<{ lon: number; lat: number; tier: Tier }[] | null>(null);
  // Which view is showing: restaurant hexagons, or neighborhoods shaded by chain share
  const [view, setView] = useState<'hex' | 'nbhd'>('hex');
  const showHex = view === 'hex';
  // Legend starts open on wide screens and minimized on phones
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia('(max-width: 800px)').matches);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRef = useRef<SVGGElement | null>(null);
  const boundsRef = useRef<SVGGElement | null>(null); // boundary lines drawn above the hexagons
  const mapRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);
  // Bins per zoom level, built once per level and reused while panning
  const binCache = useRef<{ pins: Pins | null; levels: Map<number, { bins: Bin[]; max: number }> }>({
    pins: null,
    levels: new Map(),
  });

  // Ask for a redraw of the hexagon layer
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
          if (Number.isFinite(lon) && Number.isFinite(lat) && TIER_KEYS.has(tier)) out.push({ lon, lat, tier });
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

  const { projection, paths, bounds } = useMemo(() => {
    if (!data) {
      return {
        projection: null,
        paths: new Map<string, string>(),
        bounds: new Map<string, [[number, number], [number, number]]>(),
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
      projection,
      paths: new Map(data.features.map((f) => [f.properties.id, toPath(f) ?? ''])),
      // Bounding box of each neighborhood in map coordinates, used to zoom to it
      bounds: new Map(data.features.map((f) => [f.properties.id, toPath.bounds(f)])),
    };
  }, [data]);

  // Zoom so a neighborhood's bounding box fills most of the map (see observablehq.com/@d3/zoom-to-bounding-box)
  const zoomToNbhd = (id: string) => {
    const b = bounds.get(id);
    if (!b || !svgRef.current || !zoomRef.current) return;
    const [[x0, y0], [x1, y1]] = b;
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const k = Math.min(MAX_ZOOM, ZOOM_FILL / Math.max((x1 - x0) / SIZE, (y1 - y0) / SIZE));
    const t = zoomIdentity
      .translate(SIZE / 2, SIZE / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    select(svgRef.current).transition().duration(750).call(zoomRef.current.transform, t);
  };

  const pins = useMemo<Pins | null>(() => {
    if (!projection || !rows) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    const cs: number[] = [];
    for (const r of rows) {
      const p = projection([r.lon, r.lat]);
      if (!p) continue;
      xs.push(p[0]);
      ys.push(p[1]);
      cs.push(r.tier === 'independent' ? 0 : 1);
    }
    const n = xs.length;
    return {
      x: Float32Array.from(xs),
      y: Float32Array.from(ys),
      chain: Uint8Array.from(cs),
      ids: Array.from({ length: n }, (_, i) => i),
    };
  }, [projection, rows]);

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

  // Bin every restaurant in map space for one zoom level. Cached, so panning costs nothing.
  const binsForLevel = (level: number) => {
    if (!pins) return { bins: [] as Bin[], max: 1 };
    const cache = binCache.current;
    if (cache.pins !== pins) {
      cache.pins = pins;
      cache.levels.clear();
    }
    const hit = cache.levels.get(level);
    if (hit) return hit;

    const r = BASE_R / 2 ** (level / LEVELS_PER_DOUBLING);
    const raw = hexbin<number>()
      .x((i) => pins.x[i])
      .y((i) => pins.y[i])
      .radius(r)(pins.ids);
    let max = 1;
    const bins: Bin[] = raw.map((b) => {
      let chains = 0;
      for (const i of b) chains += pins.chain[i];
      if (b.length > max) max = b.length;
      return { x: b.x, y: b.y, n: b.length, share: chains / b.length };
    });
    const out = { bins, max };
    cache.levels.set(level, out);
    return out;
  };

  // Draw the hexagons on the canvas that sits over the map.
  // The hex grid lives in map coordinates, so panning just slides the same hexagons around.
  // The grid gets finer in steps as you zoom in, and freezes at HEX_ZOOM_CAP.
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
    if (!pins || !showHex) return;

    // Map coordinates to screen pixels
    const { k, x: tx, y: ty } = transformRef.current;
    const fit = Math.min(w, h) / SIZE;
    const ox = (w - SIZE * fit) / 2 + tx * fit;
    const oy = (h - SIZE * fit) / 2 + ty * fit;
    const m = k * fit;

    const level = Math.min(MAX_LEVEL, Math.max(0, Math.floor(Math.log2(k) * LEVELS_PER_DOUBLING + 1e-9)));
    const cellR = BASE_R / 2 ** (level / LEVELS_PER_DOUBLING); // cell radius in map units
    const { bins, max } = binsForLevel(level);

    const cellPx = cellR * m; // cell radius on screen
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = 'rgba(54,73,88,0.5)';
    ctx.lineWidth = 0.6;
    for (const b of bins) {
      const cx = ox + m * b.x;
      const cy = oy + m * b.y;
      if (cx < -cellPx || cx > w + cellPx || cy < -cellPx || cy > h + cellPx) continue;
      const r = cellPx * hexFrac(b.n, max);

      ctx.beginPath();
      for (let c = 0; c < 6; c++) {
        const a = (c * Math.PI) / 3;
        const px = cx + Math.sin(a) * r;
        const py = cy - Math.cos(a) * r;
        if (c === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color(b.share);
      ctx.fill();
      if (r > 3) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  useEffect(() => {
    schedule();
  }, [pins, showHex, color, schedule]);

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
        <h2>Mapping the "Same-ification" of NYC, From Blank Street to 7th Street</h2>
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
            onClick={(e) => {
              // Clicking open water (not a neighborhood) zooms back out
              if (e.target === e.currentTarget) resetZoom();
            }}
            aria-label="Map of New York City neighborhoods with hexagons showing restaurant counts and chain share"
          >
            <g ref={gRef}>
              {data.features.map((f) => {
                const p = f.properties;
                // Neighborhood view: shade by chain share; too-small neighborhoods stay neutral gray
                const fill = showHex ? undefined : p.n_restaurants >= MIN_RESTAURANTS ? color(chainShare(p)) : NO_DATA;
                return (
                  <path
                    key={p.id}
                    d={paths.get(p.id)}
                    className={showHex ? 'sm-nbhd' : 'sm-nbhd sm-filled'}
                    style={fill ? { fill } : undefined}
                    onPointerEnter={(e) => showTip(e, p)}
                    onPointerMove={(e) => showTip(e, p)}
                    onPointerLeave={() => setTip(null)}
                    onClick={() => {
                      setActiveId(p.id);
                      zoomToNbhd(p.id);
                    }}
                  />
                );
              })}
            </g>
          </svg>

          {/* Restaurant hexagons are drawn here */}
          <canvas ref={canvasRef} className="sm-pins" aria-hidden="true" />

          {/* Neighborhood outlines sit above the hexagons so boundaries stay readable */}
          <svg className={showHex ? 'sm-bounds' : 'sm-bounds sm-bounds-nbhd'} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
            <g ref={boundsRef}>
              {data.features.map((f) => (
                <path key={f.properties.id} d={paths.get(f.properties.id)} className="sm-edge" />
              ))}
              {activeId && (
                <>
                  <path d={paths.get(activeId)} className="sm-active-halo" />
                  <path d={paths.get(activeId)} className="sm-active" />
                </>
              )}
            </g>
          </svg>

          {/* Legend sits on the map so it stays visible while the panel scrolls */}
          {legendOpen ? (
            <div className="sm-legend">
              <div className="sm-legend-bar">
                <strong>Restaurants by Area</strong>
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
                <strong>Share of restaurants that are chains</strong>
                <span className="sm-ramp" style={{ background: `linear-gradient(to right, ${RAMP.join(', ')})` }} />
                <span className="sm-ramp-labels">
                  <span>{pct(lo)} or less</span>
                  <span>{pct(hi)} or more</span>
                </span>
                <span className="sm-hint">
                  {showHex ? 'Larger hexagons = more restaurants' : `Gray = fewer than ${MIN_RESTAURANTS} restaurants`}
                </span>
              </div>

              <div className="sm-seg" role="group" aria-label="Map view">
                <button type="button" aria-pressed={showHex} onClick={() => setView('hex')}>
                  Hexagons
                </button>
                <button type="button" aria-pressed={!showHex} onClick={() => setView('nbhd')}>
                  Neighborhoods
                </button>
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