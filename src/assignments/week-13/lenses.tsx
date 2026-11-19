// Three views that sit beside the map and share its hover, selection, legend filter and URL:
// the tier grid (2x2 small multiples), the makeup plot (PCA of tier and cuisine mix), and change since 2022.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { easeCubicOut, select, zoom as d3zoom, zoomIdentity } from 'd3';
import type { D3ZoomEvent, ZoomBehavior, ZoomTransform } from 'd3';
import { BOROS, LATEST_YEAR, SNAPSHOT_YEARS, TIERS, YEARS, boroLabel, classOf, makeBreaks, makeupEmbedding, modeValue, num, pct, useTimeline, yearKind } from './data';
import type { Data, Mode, Nbhd, Timeline } from './data';
import type { Ctx } from './views';
import { Icon, localPoint } from './ui';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export type Lens = 'tiers' | 'makeup' | 'change';
export const LENSES: { key: Lens | 'map'; label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'tiers', label: 'By tier' },
  { key: 'makeup', label: 'Mix' },
  { key: 'change', label: 'Change' },
];

function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}
const idAt = (e: React.SyntheticEvent) => (e.target as Element).getAttribute('data-id');
const special = (ctx: Ctx, id: string) => (id === ctx.sel?.id ? ' is-a' : id === ctx.cmp?.id ? ' is-b' : id === ctx.third?.id ? ' is-c' : id === ctx.hoverId ? ' is-hover' : '');

/* ---------- Tier grid ---------- */

const GRID: { mode: Mode; title: string }[] = [
  { mode: 'share', title: 'All chains' },
  { mode: 'mini', title: 'Mini chains, 3 to 9 locations' },
  { mode: 'mid', title: 'Mid-size chains, 10 to 49' },
  { mode: 'big', title: 'Big chains, 50 or more' },
];
const GridShapes = memo(function GridShapes({ nbhds, classes, focusBoro }: { nbhds: Nbhd[]; classes: Map<string, number>; focusBoro: string | null }) {
  return (
    <>
      {nbhds.map((n) => {
        const c = classes.get(n.id);
        return <path key={n.id} d={n.path} data-id={n.id} className={`sf-shape ${c === undefined ? 'is-flat' : `c${c}`}${focusBoro && n.boro !== focusBoro ? ' is-out' : ''}`} />;
      })}
    </>
  );
});

export function TierGrid({ ctx, onOpen }: { ctx: Ctx; onOpen: (m: Mode) => void }) {
  const { data, sel, cmp, hoverId } = ctx;
  const third = ctx.third;
  const maps = useMemo(
    () =>
      GRID.map((g) => {
        const vals = new Map<string, number>();
        for (const n of data.ranked) {
          const v = modeValue(data, n, g.mode, null);
          if (v !== null) vals.set(n.id, v);
        }
        const breaks = makeBreaks([...vals.values()]);
        return { ...g, vals, breaks, classes: new Map([...vals].map(([id, v]) => [id, classOf(v, breaks)])) };
      }),
    [data],
  );
  const b = data.bounds;
  const viewBox = `${b[0][0] - 10} ${b[0][1] - 10} ${b[1][0] - b[0][0] + 20} ${b[1][1] - b[0][1] + 20}`;
  const hover = hoverId ? data.byId.get(hoverId) : undefined;
  const shown = hover ?? sel ?? undefined;
  // A name beside the pointer, on whichever of the four maps it is over. The maps carry no labels of their own.
  const [tip, setTip] = useState<{ mode: Mode; x: number; y: number; name: string; w: number } | null>(null);

  // One zoom for all four maps: a pan or zoom on any of them is copied to the others
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomers = useRef<{ svg: SVGSVGElement; z: ZoomBehavior<SVGSVGElement, unknown> }[]>([]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const svgs = [...grid.querySelectorAll<SVGSVGElement>('svg')];
    const x0 = b[0][0] - 10;
    const y0 = b[0][1] - 10;
    const x1 = b[1][0] + 10;
    const y1 = b[1][1] + 10;
    let syncing = false;
    const all = svgs.map((svg) => {
      const g = svg.querySelector<SVGGElement>('.sf-zg');
      const z = d3zoom<SVGSVGElement, unknown>()
        .scaleExtent([1, 40])
        .extent([[x0, y0], [x1, y1]])
        .translateExtent([[x0, y0], [x1, y1]])
        .on('zoom', (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
          g?.setAttribute('transform', e.transform.toString());
          if (syncing) return;
          syncing = true;
          for (const o of all) if (o.svg !== svg) select(o.svg).call(o.z.transform, e.transform);
          syncing = false;
        });
      select(svg).call(z).on('dblclick.zoom', null);
      return { svg, z };
    });
    zoomers.current = all;
    return () => {
      for (const o of all) select(o.svg).on('.zoom', null);
      zoomers.current = [];
    };
  }, [viewBox, b]);
  const zoomBy = (factor: number) => {
    const first = zoomers.current[0];
    if (!first) return;
    const s = select(first.svg);
    if (reducedMotion()) s.call(first.z.scaleBy, factor);
    else s.transition().duration(220).ease(easeCubicOut).call(first.z.scaleBy, factor);
  };
  const resetZoom = () => {
    const first = zoomers.current[0];
    if (!first) return;
    const s = select(first.svg);
    if (reducedMotion()) s.call(first.z.transform, zoomIdentity);
    else s.transition().duration(400).ease(easeCubicOut).call(first.z.transform, zoomIdentity);
  };
  return (
    <>
      <header className="sf-lens-head sf-tiergrid-head">
        <h2>Four tiers side by side{ctx.year !== 2026 ? `, ${ctx.year}` : ''}</h2>
        <div className="sf-gridtools">
          <div className="sf-zoom is-inline" role="group" aria-label="Zoom all four maps">
            <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">
              <Icon name="plus" />
            </button>
            <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">
              <Icon name="minus" />
            </button>
            <button type="button" onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom">
              <Icon name="reset" />
            </button>
          </div>
        </div>
      </header>
      <div className="sf-tiergrid" ref={gridRef}>
        {maps.map((m) => {
          const br = m.breaks.map((x) => Math.round(x * 100));
          return (
            <figure key={m.mode}>
              <figcaption>
                <b>{m.title}</b>
                <button type="button" className="sf-textbtn" onClick={() => onOpen(m.mode)}>
                  Open on map
                </button>
              </figcaption>
              <svg
                viewBox={viewBox}
                role="img"
                aria-label={`Map of neighborhoods shaded by share of restaurants that are ${m.title.toLowerCase()}`}
                onPointerMove={(e) => {
                  const id = idAt(e);
                  if (id !== hoverId) ctx.setHover(id);
                  const fig = e.currentTarget.parentElement;
                  const name = id ? data.byId.get(id)?.name : undefined;
                  if (fig && name && e.pointerType !== 'touch') {
                    const at = localPoint(e, fig, fig.clientWidth, fig.clientHeight);
                    setTip({ mode: m.mode, x: at.x, y: at.y, name, w: fig.clientWidth });
                  } else setTip(null);
                }}
                onPointerLeave={() => {
                  ctx.setHover(null);
                  setTip(null);
                }}
                onClick={(e) => {
                  const id = idAt(e);
                  if (id) ctx.act.select(id);
                }}
              >
                <g className="sf-zg">
                  <GridShapes nbhds={data.nbhds} classes={m.classes} focusBoro={ctx.boro?.key ?? null} />
                  {hover && hover.id !== sel?.id && hover.id !== cmp?.id && hover.id !== third?.id && <path className="sf-outline is-hover" d={hover.path} />}
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
                </g>
              </svg>
              {tip && tip.mode === m.mode && (
                <div className={`sf-tip${tip.x > tip.w - 170 ? ' flip-x' : ''}`} style={{ left: tip.x, top: tip.y }}>
                  <b>{tip.name}</b>
                </div>
              )}
              <ol className="sf-minikey" aria-label={`Bands for ${m.title}`}>
                {[`<${br[0]}%`, `${br[0]}–${br[1]}`, `${br[1]}–${br[2]}`, `${br[2]}–${br[3]}`, `${br[3]}%+`].map((label, i) => (
                  <li key={i} className={shown && m.classes.get(shown.id) === i ? 'is-here' : ''}>
                    <i className={`sf-chip c${i}`} />
                    {label}
                  </li>
                ))}
              </ol>
            </figure>
          );
        })}
      </div>
      <p className="sf-lens-read" aria-live="polite">
        {shown ? (
          shown.eligible ? (
            <>
              <b>{shown.name}</b>, {boroLabel(shown.boro)}: {maps.map((m) => `${m.title.split(',')[0].toLowerCase()} ${pct(m.vals.get(shown.id) ?? 0)}`).join(' · ')}
            </>
          ) : (
            <>
              <b>{shown.name}</b> has too few restaurants to rank.
            </>
          )
        ) : (
          'Hover or tap a neighborhood to read all four shares.'
        )}
      </p>
    </>
  );
}

/* ---------- Makeup plot (PCA) ---------- */

export function MakeupPlot({ ctx, active }: { ctx: Ctx; active: Set<number> | null }) {
  const { data, classes, sel, cmp, hoverId } = ctx;
  const emb = useMemo(() => makeupEmbedding(data), [data]);
  const [ref, box] = useBox<HTMLDivElement>();
  // Zoom and pan: the transform moves the dot positions, while dot sizes, outlines and labels stay the same size on screen
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [t, setT] = useState<ZoomTransform>(zoomIdentity);
  const ready = box.w > 0 && box.h > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !ready) return;
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 14])
      .extent([[0, 0], [box.w, box.h]])
      .translateExtent([[0, 0], [box.w, box.h]])
      .on('zoom', (e: D3ZoomEvent<SVGSVGElement, unknown>) => setT(e.transform));
    zoomRef.current = z;
    select(svg).call(z).on('dblclick.zoom', null);
    return () => {
      select(svg).on('.zoom', null);
    };
  }, [ready, box.w, box.h]);
  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const s = select(svg);
    if (reducedMotion()) s.call(z.scaleBy, factor);
    else s.transition().duration(220).ease(easeCubicOut).call(z.scaleBy, factor);
  };
  const resetZoom = () => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    const s = select(svg);
    if (reducedMotion()) s.call(z.transform, zoomIdentity);
    else s.transition().duration(400).ease(easeCubicOut).call(z.transform, zoomIdentity);
  };
  if (!emb)
    return (
      <p className="sf-empty">The makeup plot needs at least three ranked neighborhoods with cuisine data, and this data set does not have them.</p>
    );
  const M = { t: 26, r: 18, b: 26, l: 18 };
  const [x0, x1] = emb.extent.x;
  const [y0, y1] = emb.extent.y;
  const X = (v: number) => t.applyX(M.l + ((v - x0) / (x1 - x0)) * Math.max(10, box.w - M.l - M.r));
  const Y = (v: number) => t.applyY(box.h - M.b - ((v - y0) / (y1 - y0)) * Math.max(10, box.h - M.t - M.b));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const radius = (n: Nbhd) => Math.max(3.5, Math.min(13, Math.sqrt(n.n) / 2.2));
  // Name the selected, compared and hovered dots first, then the outliers, skipping any label that would sit on another
  const byIdPt = new Map(emb.pts.map((p) => [p.id, p]));
  const inBoro = (id: string) => !ctx.boro || data.byId.get(id)?.boro === ctx.boro.key;
  const wanted = [sel?.id, cmp?.id, ctx.third?.id, hoverId, ...[...emb.pts].filter((p) => inBoro(p.id)).sort((p, q) => q.dist - p.dist).slice(0, 8).map((p) => p.id)].filter((id): id is string => !!id && byIdPt.has(id));
  const placed: { id: string; x: number; y: number; w: number; right: boolean }[] = [];
  for (const id of wanted) {
    if (placed.some((l) => l.id === id)) continue;
    const p = byIdPt.get(id)!;
    const n = data.byId.get(id)!;
    if (X(p.x) < 0 || X(p.x) > box.w || Y(p.y) < 0 || Y(p.y) > box.h) continue; // zoomed out of view
    const w = n.name.length * 6.6 + 8;
    const right = X(p.x) > box.w - w - 24;
    const x = X(p.x) + (right ? -1 : 1) * (radius(n) + 5);
    const y = Y(p.y) + 4;
    const x0 = right ? x - w : x;
    if (placed.some((l) => Math.abs(l.y - y) < 14 && x0 < (l.right ? l.x : l.x + l.w) && x0 + w > (l.right ? l.x - l.w : l.x))) continue;
    placed.push({ id, x, y, w, right });
  }
  const hovered = hoverId ? emb.pts.find((p) => p.id === hoverId) : undefined;
  const hn = hovered ? data.byId.get(hovered.id) : undefined;
  const more = (list: string[]) => (list.length ? `More ${list.join(', ')}` : '');
  // Selected and hovered dots are drawn last so they sit on top
  const order = [...emb.pts].sort((p, q) => Number(!!special(ctx, p.id)) - Number(!!special(ctx, q.id)));
  return (
    <>
      <header className="sf-lens-head">
        <h2>Neighborhoods by what their restaurants are{ctx.year !== 2026 ? `, ${ctx.year}` : ''}</h2>
        <p>
          Each dot is a neighborhood, placed by its mix of the four tiers and its {emb.cuisines} most common cuisines. Dots close together have a similar makeup. Dot size is restaurants; color follows the map.
        </p>
      </header>
      <div className="sf-plot is-zoomable" ref={ref}>
        {ready && (
          <svg
            ref={svgRef}
            width={box.w}
            height={box.h}
            role="img"
            aria-label="Scatter plot of ranked neighborhoods by tier and cuisine mix. The Ranking tab in the panel lists the same neighborhoods."
            onPointerMove={(e) => {
              const id = idAt(e);
              if (id !== hoverId) ctx.setHover(id);
            }}
            onPointerLeave={() => ctx.setHover(null)}
            onClick={(e) => {
              const id = idAt(e);
              if (id) ctx.act.select(id);
            }}
          >
            <line className="sf-plot-zero" x1={M.l} x2={box.w - M.r} y1={Y(0)} y2={Y(0)} />
            <line className="sf-plot-zero" x1={X(0)} x2={X(0)} y1={M.t} y2={box.h - M.b} />
            {order.map((p) => {
              const n = data.byId.get(p.id)!;
              const c = classes.get(p.id);
              const dim = !inBoro(p.id) || (active !== null && (c === undefined || !active.has(c)));
              return <circle key={p.id} data-id={p.id} className={`sf-plot-dot${c === undefined ? '' : ` c${c}`}${dim ? ' is-dim' : ''}${special(ctx, p.id)}`} cx={X(p.x)} cy={Y(p.y)} r={radius(n)} />;
            })}
            {placed.map((l) => (
              <text key={l.id} className="sf-plot-label" x={l.x} y={l.y} textAnchor={l.right ? 'end' : 'start'}>
                {data.byId.get(l.id)!.name}
              </text>
            ))}
            <text className="sf-plot-end has-halo" x={box.w - 8} y={clamp(Y(0) - 7, 34, box.h - 56)} textAnchor="end">
              {more(emb.axes[0].pos)}
            </text>
            <text className="sf-plot-end has-halo" x={8} y={clamp(Y(0) - 7, 34, box.h - 56)}>
              {more(emb.axes[0].neg)}
            </text>
            <text className="sf-plot-end has-halo" x={clamp(X(0) + 8, 8, box.w - 200)} y={16}>
              {more(emb.axes[1].pos)}
            </text>
            <text className="sf-plot-end has-halo" x={clamp(X(0) + 8, 8, box.w - 200)} y={box.h - 8}>
              {more(emb.axes[1].neg)}
            </text>
          </svg>
        )}
        {ready && (
          <div className="sf-zoom is-corner" role="group" aria-label="Zoom the plot">
            <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">
              <Icon name="plus" />
            </button>
            <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">
              <Icon name="minus" />
            </button>
            <button type="button" onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom">
              <Icon name="reset" />
            </button>
          </div>
        )}
      </div>
      <p className="sf-lens-read" aria-live="polite">
        {hovered && hn ? (
          <>
            <b>{hn.name}</b>, {boroLabel(hn.boro)}: {num(hn.n)} restaurants, {pct(hn.chainShare)} chains. Most common: {hovered.top.map(([c, s]) => `${c} ${pct(s)}`).join(', ')}.
          </>
        ) : (
          <>
            The axes are blends of many measurements and hold {pct(emb.axes[0].explained + emb.axes[1].explained)} of the variation, so treat distance as a rough guide.
          </>
        )}
      </p>
    </>
  );
}

/* ---------- Change since 2022 ---------- */

function changeRows(data: Data) {
  return [...data.change.entries()]
    .map(([id, c]) => ({ n: data.byId.get(id), ...c, d: c.s26 - c.s22 }))
    .filter((r): r is { n: Nbhd; s22: number; s26: number; n22: number; n26: number; d: number } => !!r.n)
    .sort((a, b) => b.d - a.d || a.n.name.localeCompare(b.n.name));
}

export function ChangePlot({ ctx, active }: { ctx: Ctx; active: Set<number> | null }) {
  const { data, classes, hoverId } = ctx;
  const rows = useMemo(() => changeRows(data), [data]);
  const [ref, box] = useBox<HTMLDivElement>();
  if (!rows.length)
    return (
      <p className="sf-empty">The 2022 comparison file (stats/temporal_neighborhoods.csv) did not load, so there is nothing to compare against. The rest of the app works without it.</p>
    );
  const M = { t: 30, r: 12, b: 28, l: 42 };
  const max = Math.ceil(Math.max(...rows.map((r) => Math.max(r.s22, r.s26))) * 5) / 5;
  const step = Math.max(1, box.w - M.l - M.r) / rows.length;
  const X = (i: number) => M.l + (i + 0.5) * step;
  const Y = (v: number) => box.h - M.b - (v / max) * Math.max(10, box.h - M.t - M.b);
  const up = rows.filter((r) => Math.round(r.d * 100) > 0).length;
  const down = rows.filter((r) => Math.round(r.d * 100) < 0).length;
  const sorted = rows.map((r) => r.d).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const firstFlat = rows.findIndex((r) => Math.round(r.d * 100) <= 0);
  const firstDown = rows.findIndex((r) => Math.round(r.d * 100) < 0);
  const hov = hoverId ? rows.find((r) => r.n.id === hoverId) : undefined;
  const pick = hov ?? rows.find((r) => r.n.id === ctx.sel?.id);
  const pts = (d: number) => `${d > 0 ? 'up' : 'down'} ${Math.abs(Math.round(d * 100))} ${Math.abs(Math.round(d * 100)) === 1 ? 'pt' : 'pts'}`;
  const r = Math.max(2, Math.min(4.5, step * 0.42));
  return (
    <>
      <header className="sf-lens-head">
        <h2>
          Chain share rose in {up} of {rows.length} neighborhoods since 2022
        </h2>
        <p>
          It fell in {down}. The median neighborhood moved {pts(med)}.
        </p>
      </header>
      <YearLines ctx={ctx} />
      <YearTotals ctx={ctx} />
      <h3 className="sf-lens-sub">Each neighborhood, 2022 to 2026</h3>
      <p className="sf-lens-cap">Each line runs from a neighborhood's 2022 chain share (open end) to its 2026 share (dot), sorted from the biggest rise to the biggest fall.</p>
      <div className="sf-plot" ref={ref}>
        {box.w > 0 && box.h > 0 && (
          <svg
            width={box.w}
            height={box.h}
            role="img"
            aria-label={`Chart of chain share in 2022 and 2026 for ${rows.length} neighborhoods, sorted by change. It rose in ${up} and fell in ${down}.`}
            onPointerMove={(e) => {
              const i = Math.floor((localPoint(e, e.currentTarget, box.w, box.h).x - M.l) / step);
              const id = rows[i]?.n.id ?? null;
              if (id !== hoverId) ctx.setHover(id);
            }}
            onPointerLeave={() => ctx.setHover(null)}
            onClick={(e) => {
              const i = Math.floor((localPoint(e, e.currentTarget, box.w, box.h).x - M.l) / step);
              if (rows[i]) ctx.act.select(rows[i].n.id);
            }}
          >
            {Array.from({ length: Math.round(max / 0.2) + 1 }, (_, i) => (i * 0.2) / max).map((t) => (
              <g key={t}>
                <line className="sf-strip-grid" x1={M.l} x2={box.w - M.r} y1={Y(t * max)} y2={Y(t * max)} />
                <text className="sf-strip-tick" x={M.l - 8} y={Y(t * max) + 4} textAnchor="end">
                  {pct(t * max)}
                </text>
              </g>
            ))}
            {firstDown > 0 && <line className="sf-plot-zero" x1={X(firstDown) - step / 2} x2={X(firstDown) - step / 2} y1={M.t - 6} y2={box.h - M.b} />}
            <text className="sf-plot-end" x={M.l} y={14}>
              Rose ({up})
            </text>
            {firstFlat >= 0 && firstDown > firstFlat && box.w > 620 && (
              <text className="sf-plot-end" x={(X(firstFlat) + X(firstDown - 1)) / 2} y={14} textAnchor="middle">
                Flat ({firstDown - firstFlat})
              </text>
            )}
            <text className="sf-plot-end" x={box.w - M.r} y={14} textAnchor="end">
              Fell ({down})
            </text>
            {rows.map((row, i) => {
              const c = classes.get(row.n.id);
              const dim = (ctx.boro && row.n.boro !== ctx.boro.key) || (active !== null && (c === undefined || !active.has(c)));
              const s = special(ctx, row.n.id);
              return (
                <g key={row.n.id} className={`sf-change${dim ? ' is-dim' : ''}${s}`}>
                  <line x1={X(i)} x2={X(i)} y1={Y(row.s22)} y2={Y(row.s26)} />
                  <circle className="sf-change-from" cx={X(i)} cy={Y(row.s22)} r={Math.max(1.2, r * 0.55)} />
                  <circle className={`sf-change-to${c === undefined ? '' : ` c${c}`}`} cx={X(i)} cy={Y(row.s26)} r={s ? r + 2.5 : r} />
                </g>
              );
            })}
            <text className="sf-strip-tick" x={M.l} y={box.h - 8}>
              Biggest rise
            </text>
            <text className="sf-strip-tick" x={box.w - M.r} y={box.h - 8} textAnchor="end">
              Biggest fall
            </text>
          </svg>
        )}
      </div>
      <p className="sf-lens-read" aria-live="polite">
        {pick ? (
          <>
            <b>{pick.n.name}</b>, {boroLabel(pick.n.boro)}: {pct(pick.s22)} of {num(pick.n22)} restaurants in 2022, {pct(pick.s26)} of {num(pick.n26)} in 2026 ({pts(pick.d)}).
          </>
        ) : (
          <>Hover or tap a line to read it. A neighborhood needs 20 or more restaurants in both years.</>
        )}
      </p>
    </>
  );
}

/* ---------- Total restaurants, year by year ---------- */

function YearTotals({ ctx }: { ctx: Ctx }) {
  const { status, timeline } = useTimeline();
  const [ref, box] = useBox<HTMLDivElement>();
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  if (status === 'error') return null; // YearLines already explains the missing file
  const M = { t: 12, r: 12, b: 30, l: 42 };
  const open = timeline?.open ?? [];
  const gone = timeline?.gone ?? [];
  const whole = open.map((v, i) => v + gone[i]);
  const max = whole.length ? Math.ceil(Math.max(...whole) / 10000) * 10000 : 40000;
  const w = Math.max(10, box.w - M.l - M.r);
  const slot = w / YEARS.length;
  const bw = Math.min(56, slot * 0.62);
  const X = (i: number) => M.l + (i + 0.5) * slot;
  const H = Math.max(10, box.h - M.t - M.b);
  const Y = (v: number) => box.h - M.b - (v / max) * H;
  const i22 = YEARS.indexOf(2022);
  const iNow = YEARS.indexOf(LATEST_YEAR);
  const diff = open.length ? open[iNow] - open[i22] : 0;
  const k = (v: number) => `${Math.round(v / 1000)}k`;
  const slotAt = (e: React.MouseEvent<SVGSVGElement>) => Math.floor((localPoint(e, e.currentTarget, box.w, box.h).x - M.l) / slot);
  const ticks = [0, 0.5, 1].map((t) => t * max);
  // Bottom to top: independents, then each chain tier, then the restaurants that are no longer listed
  const order = TIERS.map((t) => t.key);
  const t = tip && timeline ? { year: YEARS[tip.i], open: open[tip.i], gone: gone[tip.i], tiers: timeline.tiers[tip.i] } : null;
  return (
    <>
      <h3 className="sf-lens-sub">Restaurants counted, 2019 to 2026</h3>
      <p className="sf-lens-cap">
        {timeline ? (
          <>
            {diff === 0 ? 'No net change' : `${diff > 0 ? 'Up' : 'Down'} ${num(Math.abs(diff))}`} between the 2022 and 2026 snapshots, from {num(open[i22])} to {num(open[iNow])}. Faded bars are estimates, and the early ones are a floor.
          </>
        ) : (
          'Open restaurants in each year, from the pooled timeline file.'
        )}
      </p>
      <div className="sf-plot is-short" ref={ref}>
        {status === 'loading' && <span className="sf-skel" style={{ position: 'absolute', inset: 12, margin: 0 }} aria-label="Loading the restaurant totals" />}
        {status === 'ready' && box.w > 0 && box.h > 0 && (
          <svg
            width={box.w}
            height={box.h}
            role="img"
            aria-label={`Stacked bar chart of restaurants by tier from 2019 to 2026: ${open.map((v, i) => `${YEARS[i]} ${num(v)}${gone[i] ? `, plus ${num(gone[i])} active in 2022 and not listed in 2026` : ''}`).join('; ')}.`}
            onPointerMove={(e) => {
              const i = slotAt(e);
              const at = localPoint(e, e.currentTarget, box.w, box.h);
              setTip(i >= 0 && i < YEARS.length ? { i, x: at.x, y: at.y } : null);
            }}
            onPointerLeave={() => setTip(null)}
            onClick={(e) => {
              const i = slotAt(e);
              if (i >= 0 && i < YEARS.length) ctx.act.setYear(YEARS[i]);
            }}
          >
            <defs>
              <pattern id="sf-gone-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" className="sf-gone-bg" />
                <line x1="0" y1="0" x2="0" y2="6" className="sf-gone-line" />
              </pattern>
            </defs>
            {ticks.map((v) => (
              <g key={v}>
                <line className="sf-strip-grid" x1={M.l} x2={box.w - M.r} y1={Y(v)} y2={Y(v)} />
                <text className="sf-strip-tick" x={M.l - 8} y={Y(v) + 4} textAnchor="end">
                  {v === 0 ? '0' : k(v)}
                </text>
              </g>
            ))}
            {open.map((_, i) => {
              const y = YEARS[i];
              const est = !SNAPSHOT_YEARS.has(y);
              let base = 0;
              const parts = [...order.map((key) => ({ cls: `t-${key}`, v: timeline!.tiers[i][key] })), { cls: 'is-gone', v: gone[i] }];
              return (
                <g key={y} className={`sf-bar${est ? ' is-est' : ''}${y === ctx.year ? ' is-now' : ''}${tip?.i === i ? ' is-hover' : ''}`}>
                  {parts.map((p) => {
                    const top = Y(base + p.v);
                    const h = Y(base) - top;
                    base += p.v;
                    return h > 0 ? <rect key={p.cls} className={p.cls} x={X(i) - bw / 2} y={top} width={bw} height={h} /> : null;
                  })}
                  <rect className="sf-bar-frame" x={X(i) - bw / 2} y={Y(whole[i])} width={bw} height={Y(0) - Y(whole[i])} />
                  <text className={`sf-strip-tick${!est ? ' is-snap' : ''}${y === ctx.year ? ' is-now' : ''}`} x={X(i)} y={box.h - 10} textAnchor="middle">
                    {slot < 44 ? `'${String(y).slice(2)}` : y}
                  </text>
                </g>
              );
            })}
            {/* One outline for the year asked for. It slides from bar to bar and changes height with them, instead of switching bars.
                It moves with transform only, so it keeps gliding while the page recounts the new year. It follows the year asked for,
                not the year shown, so it sets off at once. */}
            {YEARS.includes(ctx.wantYear) &&
              (() => {
                const i = YEARS.indexOf(ctx.wantYear);
                const tall = Y(0) - Y(Math.max(...whole));
                const h = Y(0) - Y(whole[i]);
                return <rect className="sf-bar-select" style={{ width: bw, height: tall, transform: `translate(${X(i) - bw / 2}px, ${Y(0) - tall}px) scaleY(${tall ? h / tall : 1})` }} />;
              })()}
          </svg>
        )}
        {t && tip && (
          <div className={`sf-tip is-chart${tip.x > box.w - 320 ? ' flip-x' : ''}`} style={{ left: tip.x, top: 8 }}>
            <b>
              {t.year} <span className="sf-tip-meta">{yearKind(t.year)}</span>
            </b>
            <span>{num(t.open)} open</span>
            <ul className="sf-tip-rows">
              {gone[tip.i] > 0 && (
                <li>
                  <i className="sf-chip is-gone" />
                  Active in 2022, not listed in 2026<b>{num(t.gone)}</b>
                </li>
              )}
              {[...TIERS].reverse().map((tr) => (
                <li key={tr.key}>
                  <i className="sf-chip" style={{ background: tr.token }} />
                  {tr.label}
                  <b>{num(t.tiers[tr.key])}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- Year by year, 2019 to 2026 (estimated) ---------- */

interface Series {
  key: string;
  label: string;
  cls: string;
  values: (number | null)[];
}
function seriesFor(ctx: Ctx, tl: Timeline): Series[] {
  const out: Series[] = BOROS.filter((b) => tl.boros[b]).map((b) => ({ key: b, label: boroLabel(b), cls: `is-boro${ctx.boro ? (ctx.boro.key === b ? ' is-on' : ' is-out') : ''}`, values: tl.boros[b] }));
  out.push({ key: 'city', label: 'City', cls: 'is-city', values: tl.city });
  if (ctx.cmp && tl.nbhd.has(ctx.cmp.id)) out.push({ key: ctx.cmp.id, label: ctx.cmp.name, cls: 'is-b', values: tl.nbhd.get(ctx.cmp.id)! });
  if (ctx.third && tl.nbhd.has(ctx.third.id)) out.push({ key: ctx.third.id, label: ctx.third.name, cls: 'is-c', values: tl.nbhd.get(ctx.third.id)! });
  if (ctx.sel && tl.nbhd.has(ctx.sel.id)) out.push({ key: ctx.sel.id, label: ctx.sel.name, cls: 'is-a', values: tl.nbhd.get(ctx.sel.id)! });
  return out;
}

function YearLines({ ctx }: { ctx: Ctx }) {
  const { status, timeline } = useTimeline();
  const [ref, box] = useBox<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const series = useMemo(() => (timeline ? seriesFor(ctx, timeline) : []), [ctx, timeline]);
  const narrow = box.w < 520;
  const M = { t: 12, r: narrow ? 104 : 150, b: 34, l: 42 };
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = all.length ? Math.ceil(Math.max(...all) * 20) / 20 : 0.4;
  const min = all.length ? Math.floor(Math.min(...all) * 20) / 20 : 0;
  const X = (i: number) => M.l + (i / (YEARS.length - 1)) * Math.max(10, box.w - M.l - M.r);
  const Y = (v: number) => box.h - M.b - ((v - min) / (max - min || 1)) * Math.max(10, box.h - M.t - M.b);
  const pathOf = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) pen = false;
      else {
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      }
    });
    return d;
  };
  // Labels sit at the right end of each line and are pushed apart so they never overlap
  const ends = series
    .map((s) => ({ s, v: s.values[YEARS.length - 1] }))
    .filter((e): e is { s: Series; v: number } => e.v !== null)
    .map((e) => ({ ...e, y: Y(e.v) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const ticks = [0, 0.5, 1].map((t) => min + t * (max - min));
  const year = at === null ? null : YEARS[at];
  // Nearest year to the pointer
  const yearAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = localPoint(e, e.currentTarget, box.w, box.h).x;
    return Math.max(0, Math.min(YEARS.length - 1, Math.round(((x - M.l) / Math.max(10, box.w - M.l - M.r)) * (YEARS.length - 1))));
  };
  return (
    <>
      <h3 className="sf-lens-sub">Year by year, 2019 to 2026</h3>
      <p className="sf-lens-cap">
        Chain share for the city, each borough{ctx.sel ? `, and ${ctx.sel.name}` : ''}. Filled points are the two real snapshots. Hollow points are estimates from inspection dates. Select a year to see every view as of that year.
      </p>
      <div className="sf-plot is-short" ref={ref}>
        {status === 'loading' && <span className="sf-skel" style={{ position: 'absolute', inset: 12, margin: 0 }} aria-label="Loading the year by year file" />}
        {status === 'error' && <p className="sf-empty">The timeline file (restaurants_timeline.csv) did not load, so the year by year estimate is not shown. The 2022 to 2026 comparison below does not depend on it.</p>}
        {status === 'ready' && box.w > 0 && box.h > 0 && (
          <svg
            width={box.w}
            height={box.h}
            role="img"
            aria-label={`Line chart of chain share from 2019 to 2026. City: ${timeline!.city.map((v, i) => `${YEARS[i]} ${pct(v)}`).join(', ')}.`}
            onPointerMove={(e) => {
              const i = yearAt(e);
              if (i !== at) setAt(i);
            }}
            onPointerLeave={() => setAt(null)}
            onClick={(e) => ctx.act.setYear(YEARS[yearAt(e)])}
          >
            {/* Fixed at the first year and moved with transform, so a change of year slides it instead of jumping */}
            <rect
              className="sf-yl-now"
              x={X(0) - 14}
              y={M.t - 6}
              width={28}
              height={box.h - M.t - 4}
              rx={4}
              style={{ transform: `translateX(${X(YEARS.indexOf(ctx.year)) - X(0)}px)` }}
            />
            {ticks.map((t) => (
              <g key={t}>
                <line className="sf-strip-grid" x1={M.l} x2={box.w - M.r} y1={Y(t)} y2={Y(t)} />
                <text className="sf-strip-tick" x={M.l - 8} y={Y(t) + 4} textAnchor="end">
                  {pct(t)}
                </text>
              </g>
            ))}
            {YEARS.map((y, i) => (
              <text key={y} className={`sf-strip-tick${SNAPSHOT_YEARS.has(y) ? ' is-snap' : ''}${y === ctx.year ? ' is-now' : ''}`} x={X(i)} y={box.h - 14} textAnchor="middle">
                {narrow ? `'${String(y).slice(2)}` : y}
              </text>
            ))}
            {at !== null && <line className="sf-plot-zero" x1={X(at)} x2={X(at)} y1={M.t} y2={box.h - M.b} />}
            {series.map((s) => (
              <g key={s.key} className={`sf-yl ${s.cls}`}>
                <path d={pathOf(s.values)} />
                {s.values.map((v, i) => (v === null ? null : <circle key={i} className={SNAPSHOT_YEARS.has(YEARS[i]) ? 'is-snap' : ''} cx={X(i)} cy={Y(v)} r={s.cls.includes('is-boro') ? 2.5 : 3.5} />))}
              </g>
            ))}
            {ends.map((e) => (
              <text key={e.s.key} className={`sf-yl-label ${e.s.cls}`} x={box.w - M.r + 10} y={e.y + 4}>
                {e.s.label} {pct(e.v)}
              </text>
            ))}
          </svg>
        )}
      </div>
      <p className="sf-lens-read is-one" aria-live="polite">
        {year !== null && timeline ? (
          <>
            <b>{year}</b>
            {SNAPSHOT_YEARS.has(year) ? ' (snapshot)' : ' (estimate)'}: {series
              .filter((s) => !s.cls.includes('is-out') && s.values[at!] !== null)
              .reverse()
              .map((s) => `${s.label} ${pct(s.values[at!]!)}`)
              .join(' · ')}
            . {num(timeline.open[at!])} restaurants counted.
          </>
        ) : (
          <>A restaurant counts as open from its first inspection on record to its last listing. Years before 2022 only include places still open in 2022, so read them as a floor, not a count. The 2022 and 2026 points can sit a point away from the figures above.</>
        )}
      </p>
    </>
  );
}
