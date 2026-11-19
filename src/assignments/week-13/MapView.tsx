// The map: a classed choropleth of every neighborhood, drawn with D3 in SVG. Pan, zoom, hover, click, keyboard.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { easeCubicOut, select, transition, zoom as d3zoom, zoomIdentity } from 'd3';
import type { ZoomBehavior } from 'd3';
import { MAP_SIZE, TIERS, boroLabel } from './data';
import type { Bounds, Brand, Data, Nbhd, Place } from './data';
import { Icon, localPoint } from './ui';

export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
interface Props {
  data: Data;
  classes: Map<string, number>; // class 0-4 per neighborhood; missing = too few restaurants
  activeClasses: Set<number> | null; // legend filter: only these classes stay at full strength
  describe: (n: Nbhd) => string; // tooltip line for the current mode
  selId: string | null;
  cmpId: string | null;
  thirdId?: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  brands: Brand[];
  focusKey: string; // changes whenever the view should move
  focusBounds: Bounds;
  pad: Pad; // screen space covered by controls and the panel
  focusBoro?: string | null; // when set, every other borough is drawn faintly
  onBoro?: (key: string) => void;
  interactive?: boolean;
  // The explorer's fit: the whole city fills nearly all of the free height, with a little more air at the sides, and the map keeps
  // the on-screen size it has at 100% browser zoom, so zooming the page out shrinks it with the interface.
  roomy?: boolean;
  places?: Place[]; // every restaurant of a list, drawn as small dots
  thin?: boolean; // a long list (a borough, the city): fewer dots when zoomed out, more as you zoom in
  pin?: Place | null; // one of them picked from the list, highlighted
}
type Tip = { x: number; y: number; nbhd?: Nbhd; place?: Place; brand?: string; list?: Place[]; more?: number };

// Restaurant dots, thinned the way the Week 12 map thins its pins: a fixed scattered order (so the same dots stay at every zoom),
// and a minimum spacing in pixels that is wide when zoomed out and shrinks to nothing as you zoom in.
const HIT = 9; // how close the pointer must be to a dot to read it, in pixels
const HOVER_REL = 4; // on a thinned map, dots answer hover once the map is zoomed in this far (1 is the whole city)
const MAX_TIP = 4; // restaurants listed when several dots sit on the same spot
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// A fixed, scattered order that does not depend on the rest of the list, so narrowing the list keeps the dots that were showing
const scatter = (p: Place) => Math.imul((Math.round(p.x * 100) * 73856093) ^ (Math.round(p.y * 100) * 19349663), 2654435761) >>> 0;
const tierName = (t?: string) => TIERS.find((x) => x.key === t)?.label;

void transition; // keeps d3-transition's selection.transition() in the bundle
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The 386 neighborhood shapes. Re-rendered only when the classes or the filter change, never on hover or zoom.
const Shapes = memo(function Shapes({ nbhds, classes, activeClasses, focusBoro }: { nbhds: Nbhd[]; classes: Map<string, number>; activeClasses: Set<number> | null; focusBoro: string | null }) {
  return (
    <>
      {nbhds.map((n) => {
        const c = classes.get(n.id);
        const dim = activeClasses !== null && (c === undefined || !activeClasses.has(c));
        return <path key={n.id} d={n.path} data-id={n.id} className={`sf-shape ${c === undefined ? 'is-nodata' : `c${c}`}${dim ? ' is-dim' : ''}${focusBoro && n.boro !== focusBoro ? ' is-out' : ''}`} />;
      })}
    </>
  );
});

// Neighborhood names, shown once the map is zoomed in far enough for them to fit
const NbhdLabels = memo(function NbhdLabels({ nbhds }: { nbhds: Nbhd[] }) {
  return (
    <g className="sf-nbhd-labels">
      {nbhds.map((n) => (
        <text key={n.id} x={n.cx} y={n.cy} className="sf-nbhd-label">
          {n.name}
        </text>
      ))}
    </g>
  );
});

const Dots = memo(function Dots({ brands }: { brands: Brand[] }) {
  return (
    <>
      {brands.map((b, slot) => (
        <g key={b.name} className={`sf-dots s${slot}`}>
          <path className="sf-dot-case" d={b.places.map((p) => `M${p.x.toFixed(2)},${p.y.toFixed(2)}h0.01`).join('')} />
          {b.places.map((p, i) => (
            <path key={i} className="sf-dot" data-dot={`${slot}:${i}`} d={`M${p.x.toFixed(2)},${p.y.toFixed(2)}h0.01`} />
          ))}
        </g>
      ))}
    </>
  );
});

export function MapView({ data, classes, activeClasses, describe, selId, cmpId, thirdId = null, hoverId, onHover, onSelect, brands, focusKey, focusBounds, pad, focusBoro = null, onBoro, interactive = true, roomy = false, places, thin = false, pin = null }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const padRef = useRef(pad);
  padRef.current = pad;
  const roomyRef = useRef(roomy);
  roomyRef.current = roomy;
  const boundsRef = useRef(focusBounds);
  boundsRef.current = focusBounds;
  const fitted = useRef(false);
  // "Reset view" shows the whole city without touching what is selected. While it is in force, a change of window size or panel
  // keeps fitting the whole city; choosing something else to look at takes over again.
  const viewAll = useRef(false);
  const cityRef = useRef(data.bounds);
  cityRef.current = data.bounds;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const tf = useRef({ x: 0, y: 0, k: 1 }); // where the map is now, for placing restaurant dots
  const placeCase = useRef<SVGPathElement>(null);
  const placeDot = useRef<SVGPathElement>(null);
  const shown = useRef<{ xs: number[]; ys: number[]; at: number[] }>({ xs: [], ys: [], at: [] }); // the dots on screen, in pixels
  const ordered = useMemo(() => (places ? [...places].sort((a, b) => scatter(a) - scatter(b)) : []), [places]);
  const drawPlaces = useRef<() => void>(() => {});
  const frame = useRef(0);
  const schedulePlaces = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      drawPlaces.current();
    });
  }, []);
  const relZoom = () => {
    const w = wrapRef.current;
    const base = w ? Math.min(w.clientWidth, w.clientHeight) / MAP_SIZE : 0;
    return base ? Math.max(1, tf.current.k / base) : 1;
  };
  drawPlaces.current = () => {
    const dot = placeDot.current;
    const cs = placeCase.current;
    const wrap = wrapRef.current;
    if (!dot || !cs || !wrap) return;
    const out = shown.current;
    out.xs = [];
    out.ys = [];
    out.at = [];
    if (!ordered.length) {
      dot.setAttribute('d', '');
      cs.setAttribute('d', '');
      return;
    }
    const { x: tx, y: ty, k } = tf.current;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const rel = relZoom();
    const r = Math.min(4, 1.8 + 0.75 * Math.log2(rel)); // dots grow with zoom
    const t = clamp01(Math.log2(rel) / Math.log2(Math.max(2, 90 / (Math.min(w, h) / MAP_SIZE || 1))));
    const gap = thin ? Math.max(26 * Math.pow(1 - t, 1.2), 2 * r * 1.15 * (1 - clamp01((rel - 20) / 20))) : 0;
    const gcols = Math.ceil(w / (gap || 1)) + 1;
    const grid = gap > 1.5 ? new Uint8Array(gcols * (Math.ceil(h / gap) + 1)) : null;
    const pad = r * 2;
    let d = '';
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const sx = tx + k * p.x;
      const sy = ty + k * p.y;
      if (!(sx >= -pad && sx <= w + pad && sy >= -pad && sy <= h + pad)) continue;
      if (grid) {
        const cell = Math.floor(Math.min(Math.max(sy, 0), h) / gap) * gcols + Math.floor(Math.min(Math.max(sx, 0), w) / gap);
        if (grid[cell]) continue;
        grid[cell] = 1;
      }
      out.xs.push(sx);
      out.ys.push(sy);
      out.at.push(i);
      d += `M${p.x.toFixed(1)},${p.y.toFixed(1)}h0.01`;
    }
    dot.setAttribute('d', d);
    cs.setAttribute('d', d);
    dot.style.strokeWidth = `${2 * r}px`;
    cs.style.strokeWidth = `${2 * r + 3}px`;
  };
  useEffect(() => {
    schedulePlaces();
  }, [ordered, thin, size, schedulePlaces]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0; // a cancelled frame must not keep the next one from being scheduled
    },
    [],
  );
  // The dots near a point, nearest first. On a thinned map they answer only once the map is zoomed in some way.
  const nearPlaces = (x: number, y: number) => {
    if (!ordered.length || (thin && relZoom() < HOVER_REL)) return [];
    const { xs, ys, at } = shown.current;
    const found: { i: number; d: number }[] = [];
    for (let j = 0; j < xs.length; j++) {
      const dx = xs[j] - x;
      const dy = ys[j] - y;
      const d = dx * dx + dy * dy;
      if (d <= HIT * HIT) found.push({ i: at[j], d });
    }
    return found.sort((a, b) => a.d - b.d).map((f) => f.i);
  };
  const placeTip = (x: number, y: number): Tip | null => {
    const near = nearPlaces(x, y);
    if (!near.length) return null;
    return { x, y, list: near.slice(0, MAX_TIP).map((i) => ordered[i]), more: Math.max(0, near.length - MAX_TIP) };
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit a box (in map units) into the part of the screen the controls and panel leave free
  const fit = useCallback((b: Bounds, animate: boolean) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    const wrap = wrapRef.current;
    if (!svg || !z || !wrap) return;
    const p = padRef.current;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const freeW = Math.max(120, w - p.left - p.right);
    const freeH = Math.max(120, h - p.top - p.bottom);
    const roomyFit = roomyRef.current;
    // Zooming the browser out gives more room in CSS pixels but not on screen. window.outerWidth does not change with browser zoom
    // while innerWidth does, so their ratio is the zoom (it is 1 or more at 100%, and in an undocked or unmaximized window).
    // Using only that share of the room keeps the map the same size in CSS pixels, so on screen it shrinks with everything else.
    const browserZoom = roomyFit && window.innerWidth ? Math.min(1, Math.max(0.25, window.outerWidth / window.innerWidth)) : 1;
    const aw = freeW * browserZoom; // the room the map is sized to
    const ah = freeH * browserZoom;
    const minSpan = MAP_SIZE * 0.05; // a single point or tiny neighborhood still gets some context
    const dx = Math.max(b[1][0] - b[0][0], minSpan);
    const dy = Math.max(b[1][1] - b[0][1], minSpan);
    // The whole city is allowed nearly all of the height, and a little less of the width (the controls and the panel sit beside it)
    const wholeCity = roomyFit && b === cityRef.current;
    const k = Math.min((aw * (wholeCity ? 0.92 : 0.88)) / dx, (ah * (wholeCity ? 0.97 : 0.88)) / dy);
    const t = zoomIdentity.translate(p.left + freeW / 2 - (k * (b[0][0] + b[1][0])) / 2, p.top + freeH / 2 - (k * (b[0][1] + b[1][1])) / 2).scale(k); // centered in all the free room
    const s = select(svg);
    if (animate && !reducedMotion()) s.transition().duration(650).ease(easeCubicOut).call(z.transform, t);
    else s.call(z.transform, t);
  }, []);

  const schedulePlacesRef = useRef(schedulePlaces);
  schedulePlacesRef.current = schedulePlaces;
  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g) return;
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 90])
      .translateExtent([
        [-MAP_SIZE * 0.5, -MAP_SIZE * 0.5],
        [MAP_SIZE * 1.5, MAP_SIZE * 1.5],
      ])
      .on('zoom', (e) => {
        g.setAttribute('transform', e.transform.toString());
        tf.current = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
        schedulePlacesRef.current();
        svg.style.setProperty('--k', String(e.transform.k));
        svg.classList.toggle('is-close', e.transform.k > 2.4);
        svg.classList.toggle('is-near', e.transform.k > 6.5);
        // keep the no-data hatch the same size on screen at every zoom
        svg.querySelector('#sf-hatch')?.setAttribute('patternTransform', `rotate(45) scale(${1 / e.transform.k})`);
      });
    zoomRef.current = z;
    if (interactive) select(svg).call(z).on('dblclick.zoom', null);
    return () => {
      select(svg).on('.zoom', null);
    };
  }, [interactive]);

  // Move the view when the focus changes (animated) or the frame changes (immediate)
  const padKey = `${pad.top},${pad.right},${pad.bottom},${pad.left}`;
  const lastFocus = useRef('');
  useEffect(() => {
    if (!size) return;
    const first = !fitted.current;
    const focusChanged = lastFocus.current !== focusKey;
    if (focusChanged) viewAll.current = false;
    fit(viewAll.current ? cityRef.current : boundsRef.current, !first && focusChanged);
    fitted.current = true;
    lastFocus.current = focusKey;
  }, [size, focusKey, padKey, fit]);

  const resetView = () => {
    viewAll.current = true;
    fit(cityRef.current, true);
  };
  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const s = select(svg);
    if (reducedMotion()) s.call(z.scaleBy, factor);
    else s.transition().duration(220).ease(easeCubicOut).call(z.scaleBy, factor);
  };
  const panBy = (dx: number, dy: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (svg && z) select(svg).call(z.translateBy, dx, dy);
  };

  // Keyboard: the crosshair in the middle of the free area stands in for the pointer
  // x and y are in the map's own pixels (they place the crosshair); screenX and screenY are on-screen pixels (they find what is under it)
  const centre = () => {
    const wrap = wrapRef.current!;
    const r = wrap.getBoundingClientRect();
    const p = padRef.current;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const x = p.left + (w - p.left - p.right) / 2;
    const y = p.top + (h - p.top - p.bottom) / 2;
    return { x, y, screenX: r.left + x * (w ? r.width / w : 1), screenY: r.top + y * (h ? r.height / h : 1) };
  };
  const underCentre = () => {
    const c = centre();
    const el = document.elementFromPoint(c.screenX, c.screenY);
    const id = el instanceof SVGElement ? el.dataset.id : undefined;
    return id ? (data.byId.get(id) ?? null) : null;
  };
  const probe = () => {
    const n = underCentre();
    const c = centre();
    onHover(n?.id ?? null);
    setTip(n ? { x: c.x, y: c.y, nbhd: n } : null);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 160 : 60;
    let handled = true;
    if (e.key === 'ArrowLeft') panBy(step / zk(), 0);
    else if (e.key === 'ArrowRight') panBy(-step / zk(), 0);
    else if (e.key === 'ArrowUp') panBy(0, step / zk());
    else if (e.key === 'ArrowDown') panBy(0, -step / zk());
    else if (e.key === '+' || e.key === '=') zoomBy(1.6);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.6);
    else if (e.key === '0') resetView();
    else if (e.key === 'Enter' || e.key === ' ') {
      const n = underCentre();
      if (n) onSelect(n.id);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      setKeyboard(true);
      window.setTimeout(probe, e.key.startsWith('Arrow') ? 0 : 260);
    }
  };
  const zk = () => Number(svgRef.current?.style.getPropertyValue('--k')) || 1;

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const wrap = wrapRef.current!;
    return localPoint(e, wrap, wrap.clientWidth, wrap.clientHeight);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const t = e.target as SVGElement;
    const { x, y } = local(e);
    setKeyboard(false);
    const dot = t.dataset?.dot;
    if (dot) {
      const [slot, i] = dot.split(':').map(Number);
      const b = brands[slot];
      const place = b?.places[i];
      if (place) {
        setTip({ x, y, place, brand: b.name });
        onHover(place.nbhd);
        return;
      }
    }
    const near = placeTip(x, y);
    if (near && near.list) {
      setTip(near);
      onHover(near.list[0].nbhd);
      return;
    }
    const id = t.dataset?.id;
    const n = id ? data.byId.get(id) : undefined;
    if (n) {
      setTip({ x, y, nbhd: n });
      if (n.id !== hoverId) onHover(n.id);
    } else {
      setTip(null);
      if (hoverId) onHover(null);
    }
  };
  const onLeave = () => {
    setTip(null);
    onHover(null);
  };
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as SVGElement;
    const dot = t.dataset?.dot;
    if (dot) {
      const [slot, i] = dot.split(':').map(Number);
      const place = brands[slot]?.places[i];
      if (place) {
        const { x, y } = local(e);
        setTip({ x, y, place, brand: brands[slot].name }); // touch: tap a dot to read it
        return;
      }
    }
    const touched = (e.nativeEvent as PointerEvent).pointerType === 'touch' ? placeTip(local(e).x, local(e).y) : null;
    if (touched) {
      setTip(touched);
      return;
    }
    const boro = t.dataset?.boro;
    if (boro && onBoro) return onBoro(boro);
    const id = t.dataset?.id;
    if (!id) return;
    // Touch has no hover, so a tap shows the same card a pointer would get, then selects
    const n = data.byId.get(id);
    if (n && (e.nativeEvent as PointerEvent).pointerType === 'touch') {
      const { x, y } = local(e);
      setTip({ x, y, nbhd: n });
      window.setTimeout(() => setTip(null), 2400);
    }
    onSelect(id);
  };

  const sel = selId ? data.byId.get(selId) : undefined;
  const cmp = cmpId ? data.byId.get(cmpId) : undefined;
  const third = thirdId ? data.byId.get(thirdId) : undefined;
  const hover = hoverId && hoverId !== selId && hoverId !== cmpId && hoverId !== thirdId ? data.byId.get(hoverId) : undefined;
  const flipX = tip && size ? tip.x > size.w - pad.right - 240 : false;
  const flipY = tip ? tip.y < pad.top + 90 : false;
  const label = useMemo(
    () => `Map of New York City neighborhoods. Arrow keys pan, plus and minus zoom, 0 resets the view, Enter selects the neighborhood under the crosshair.`,
    [],
  );

  return (
    <div
      ref={wrapRef}
      className={`sf-map${keyboard ? ' is-keyboard' : ''}`}
      tabIndex={interactive ? 0 : -1}
      role={interactive ? 'application' : 'img'}
      aria-label={interactive ? label : 'Choropleth map of chain share by New York City neighborhood'}
      onKeyDown={interactive ? onKeyDown : undefined}
      onBlur={() => setKeyboard(false)}
    >
      <svg ref={svgRef} className="sf-map-svg" width={size?.w ?? 0} height={size?.h ?? 0} aria-hidden="true">
        <defs>
          <pattern id="sf-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" className="sf-hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="6" className="sf-hatch-line" />
          </pattern>
        </defs>
        <g ref={gRef}>
          <g
            onPointerMove={interactive ? onPointerMove : undefined}
            onPointerLeave={interactive ? onLeave : undefined}
            onClick={interactive ? onClick : undefined}
            className={interactive ? 'sf-shapes' : 'sf-shapes is-static'}
          >
            <Shapes nbhds={data.nbhds} classes={classes} activeClasses={activeClasses} focusBoro={focusBoro} />
            {hover && <path className="sf-outline is-hover" d={hover.path} />}
            {cmp && (
              <>
                <path className="sf-outline is-case" d={cmp.path} />
                <path className="sf-outline is-b" d={cmp.path} />
              </>
            )}
            {third && (
              <>
                <path className="sf-outline is-case" d={third.path} />
                <path className="sf-outline is-c" d={third.path} />
              </>
            )}
            {sel && (
              <>
                <path className="sf-outline is-case" d={sel.path} />
                <path className="sf-outline is-a" d={sel.path} />
              </>
            )}
            <g className="sf-boro-labels">
              {data.boros.map((b) => (
                <text key={b.key} x={b.label_xy[0]} y={b.label_xy[1]} data-boro={interactive ? b.key : undefined} className={`sf-boro-label${focusBoro === b.key ? ' is-on' : focusBoro ? ' is-out' : ''}`}>
                  {boroLabel(b.key)}
                </text>
              ))}
            </g>
            {interactive && <NbhdLabels nbhds={data.ranked} />}
            <Dots brands={brands} />
            <g className="sf-places" aria-hidden="true">
              <path ref={placeCase} className="sf-places-case" d="" />
              <path ref={placeDot} className="sf-places-dot" d="" />
            </g>
            {pin && (
              <g className="sf-pin" aria-hidden="true">
                <path className="sf-pin-halo" d={`M${pin.x.toFixed(2)},${pin.y.toFixed(2)}h0.01`} />
                <path className="sf-pin-case" d={`M${pin.x.toFixed(2)},${pin.y.toFixed(2)}h0.01`} />
                <path className="sf-pin-dot" d={`M${pin.x.toFixed(2)},${pin.y.toFixed(2)}h0.01`} />
              </g>
            )}
          </g>
        </g>
      </svg>
      {interactive && keyboard && <div className="sf-crosshair" style={{ left: centre().x, top: centre().y }} aria-hidden="true" />}
      {tip && (
        <div className={`sf-tip${flipX ? ' flip-x' : ''}${flipY ? ' flip-y' : ''}`} style={{ left: tip.x, top: tip.y }}>
          {tip.list ? (
            <>
              {tip.list.map((p, i) => (
                <div key={i} className="sf-tip-row">
                  <b>{p.name}</b>
                  <span>
                    {p.cuisine} · {data.byId.get(p.nbhd)?.name ?? ''}
                  </span>
                  <span className="sf-tip-meta">
                    {p.tier && p.tier !== 'independent' ? `${tierName(p.tier)}${p.brand && !p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? `, ${p.brand}` : ''}` : 'Independent'}
                  </span>
                </div>
              ))}
              {tip.more ? <span className="sf-tip-meta">and {tip.more} more here. Zoom in to tell them apart.</span> : null}
            </>
          ) : tip.place ? (
            <>
              <b>{tip.place.name}</b>
              <span>
                {tip.place.cuisine} · {data.byId.get(tip.place.nbhd)?.name ?? ''}
              </span>
              {tip.brand && !tip.place.name.toLowerCase().startsWith(tip.brand.toLowerCase()) && <span className="sf-tip-meta">{tip.brand}</span>}
            </>
          ) : tip.nbhd ? (
            <>
              <b>{tip.nbhd.name}</b>
              <span>{describe(tip.nbhd)}</span>
              <span className="sf-tip-meta">
                {boroLabel(tip.nbhd.boro)} · {tip.nbhd.n.toLocaleString('en-US')} restaurants
              </span>
            </>
          ) : null}
        </div>
      )}
      {interactive && (
        <div className="sf-zoom" style={{ right: pad.right, bottom: pad.bottom }}>
          <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">
            <Icon name="plus" />
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">
            <Icon name="minus" />
          </button>
          <button type="button" onClick={resetView} aria-label="Reset view to the full map" title="Reset view">
            <Icon name="reset" />
          </button>
        </div>
      )}
    </div>
  );
}
