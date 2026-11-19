// Everything around the map: KPI strip, mode switch, legend, search, and the panel views.
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BOROS, LATEST_YEAR, MIN_CHAIN_RESTAURANTS, MIN_RESTAURANTS, TIERS, YEARS, boroLabel, yearKind, flat, num, pct, plural, ptsVs, score, simBetween, tierShare } from './data';
import type { BoroStat, Brand, Data, Mode, Nbhd, Place, SimKind, Tier } from './data';
import { RollNumber, Icon, StateLink, Tabs, useUrl, useWidth } from './ui';
import { RestaurantList } from './restaurants';

export interface Actions {
  select: (id: string) => void;
  deselectA: () => void;
  deselectB: () => void;
  deselectC: () => void;
  startCompare: () => void;
  startThird: () => void;
  cancelCompare: () => void;
  compareWith: (id: string) => void;
  swap: () => void;
  setMode: (m: Mode) => void;
  setSimKind: (k: SimKind) => void;
  addBrand: (name: string) => void;
  removeBrand: (name: string) => void;
  clearBrands: () => void;
  setBoro: (key: string | null) => void;
  setTab: (t: string) => void;
  focusSearch: () => void;
  pinPlace: (p: Place | null) => void; // highlight one restaurant on the map (null clears it)
  listPlaces: (list: Place[]) => void; // the restaurants the Restaurants tab lists, so the map can draw them all
  setYear: (y: number) => void;
}
export interface Ctx {
  data: Data;
  mode: Mode;
  simKind: SimKind;
  sel: Nbhd | null;
  cmp: Nbhd | null;
  third: Nbhd | null; // the third neighborhood when three are being compared
  picking: boolean;
  pickingThird: boolean;
  now: Data | null; // the 2026 data, set while an earlier year is showing, for the "vs 2026" lines
  prev: Data | null; // the data as of 2022, once it has loaded. Only set while the latest year is showing, for the "since 2022" lines
  brands: Brand[];
  boro: BoroStat | null;
  values: Map<string, number>;
  breaks: number[];
  classes: Map<string, number>;
  hoverId: string | null;
  setHover: (id: string | null) => void;
  pin: Place | null; // the restaurant picked in the Restaurants tab
  tab: string | null;
  year: number; // the year every view is showing
  wantYear: number; // the year most recently asked for. It runs ahead of `year` while that year is being recounted
  act: Actions;
}

/* ---------- Mode ---------- */

// Why a neighborhood has no similarity score, or null if it has one
const noSimReason = (n: Nbhd) =>
  n.simOk ? null : !n.eligible ? `Needs ${MIN_RESTAURANTS} or more restaurants` : `Needs ${MIN_CHAIN_RESTAURANTS} or more chain restaurants (has ${n.chainCount})`;

export function modeMeta(mode: Mode, sel: Nbhd | null, simKind: SimKind) {
  const simTo = mode === 'sim' && sel && sel.simOk ? sel : null;
  const isSim = mode === 'sim';
  const set = simKind === 'set';
  const title =
    mode === 'share'
      ? 'Share of restaurants that are chains'
      : mode === 'mini'
        ? 'Share that are mini chains (3 to 9 locations)'
        : mode === 'mid'
          ? 'Share that are mid-size chains (10 to 49)'
          : mode === 'big'
            ? 'Share that are big chains (50 or more)'
            : simTo
              ? set
                ? `Chain overlap with ${simTo.name}`
                : `Chain mix similarity to ${simTo.name}`
              : set
                ? 'Average chain overlap with other neighborhoods'
                : 'Average chain mix similarity to other neighborhoods';
  const noun = mode === 'share' ? 'chains' : mode === 'mini' ? 'mini chains' : mode === 'mid' ? 'mid-size chains' : mode === 'big' ? 'big chains' : simTo ? `similar to ${simTo.name}` : 'average similarity';
  const fmt = (v: number) => (isSim ? score(v) : pct(v));
  const axis = isSim ? 'Similarity score, 0 to 100' : title;
  return { title, noun, fmt, isSim, simTo, axis };
}

export function ModeSwitch({ mode, onChange, simKind, onSimKind }: { mode: Mode; onChange: (m: Mode) => void; simKind: SimKind; onSimKind: (k: SimKind) => void }) {
  const tier = mode === 'mini' || mode === 'mid' || mode === 'big';
  return (
    <div className="sf-modes">
      <span className="sf-ctl-label">Color by</span>
      <div className="sf-seg" role="group" aria-label="Color the map by">
        <button type="button" aria-pressed={mode === 'share'} onClick={() => onChange('share')}>
          Chain share
        </button>
        <button type="button" aria-pressed={tier} onClick={() => onChange(tier ? mode : 'big')}>
          Tier
        </button>
        <button type="button" aria-pressed={mode === 'sim'} onClick={() => onChange('sim')}>
          Similarity
        </button>
      </div>
      {tier && (
        <div className="sf-seg is-sub" role="group" aria-label="Chain tier">
          {(
            [
              ['mini', 'Mini', '3 to 9'],
              ['mid', 'Mid-size', '10 to 49'],
              ['big', 'Big', '50+'],
            ] as const
          ).map(([k, l, r]) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => onChange(k)}>
              {l} <span>{r}</span>
            </button>
          ))}
        </div>
      )}
      {mode === 'sim' && (
        <div className="sf-seg is-sub" role="group" aria-label="Similarity measure">
          {(
            [
              ['mix', 'Mix', 'by count'],
              ['set', 'Overlap', 'yes or no'],
            ] as const
          ).map(([k, l, r]) => (
            <button key={k} type="button" aria-pressed={simKind === k} onClick={() => onSimKind(k)}>
              {l} <span>{r}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Legend: the swatch scale ---------- */

export function Legend({ ctx, filter, onFilter, onPreview }: { ctx: Ctx; filter: Set<number>; onFilter: (next: Set<number>) => void; onPreview: (c: number | null) => void }) {
  const { data, breaks, classes, mode, sel, hoverId } = ctx;
  const meta = modeMeta(mode, sel, ctx.simKind);
  const counts = useMemo(() => {
    const c = [0, 0, 0, 0, 0];
    for (const v of classes.values()) c[v]++;
    return c;
  }, [classes]);
  const max = Math.max(1, ...counts);
  const unranked = data.nbhds.length - data.ranked.length;
  const here = hoverId ? classes.get(hoverId) : undefined;
  const b = breaks.map((x) => Math.round(x * 100));
  const unit = meta.isSim ? '' : '%';
  const short = (i: number) => (i === 0 ? `<${b[0]}${unit}` : i === 4 ? `${b[3]}${unit}+` : `${b[i - 1]}\u2013${b[i]}${unit}`);
  const range = (i: number) => (i === 0 ? `Under ${b[0]}${unit}` : i === 4 ? `${b[3]}${unit} or more` : `${b[i - 1]} to ${b[i]}${unit}`);
  const toggle = (i: number) => {
    const next = new Set(filter);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onFilter(next.size === 5 ? new Set() : next);
  };
  return (
    <section className="sf-legend" aria-label="Map legend">
      <h2 className="sf-legend-title">{meta.title}</h2>
      <ul className="sf-swatches" onPointerLeave={() => onPreview(null)}>
        {counts.map((count, i) => (
          <li key={i}>
            <button
              type="button"
              className={`sf-swatch${here === i ? ' is-here' : ''}`}
              aria-pressed={filter.has(i)}
              aria-label={`${range(i)}: ${plural(count, 'neighborhood')}. ${filter.has(i) ? 'Showing only this band. Press to remove.' : 'Press to show only this band.'}`}
              onClick={() => toggle(i)}
              onPointerEnter={() => onPreview(i)}
              onFocus={() => onPreview(i)}
              onBlur={() => onPreview(null)}
            >
              <i className={`sf-chip c${i}`} />
              <span className="sf-swatch-range">
                <RollNumber value={range(i)} />
              </span>
              <span className="sf-swatch-short" aria-hidden="true">
                <RollNumber value={short(i)} />
              </span>
              <span className="sf-swatch-bar" aria-hidden="true">
                <i style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <span className="sf-swatch-count">
                <RollNumber value={String(count)} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="sf-legend-note">
        <i className="sf-chip is-nodata" />
        Under {MIN_RESTAURANTS} restaurants, not ranked ({unranked})
      </p>
      {meta.isSim && data.ranked.length > data.simCount && (
        <p className="sf-legend-note">
          <i className="sf-chip is-nodata" />
          Under {MIN_CHAIN_RESTAURANTS} chain restaurants, too few to compare ({data.ranked.length - data.simCount})
        </p>
      )}
      <p className="sf-legend-hint">
        {filter.size ? (
          <button type="button" className="sf-textbtn" onClick={() => onFilter(new Set())}>
            Show all bands
          </button>
        ) : (
          'Counts are neighborhoods. Select a band to filter the map.'
        )}
      </p>
    </section>
  );
}

/* ---------- KPI strip ---------- */

interface Cell {
  label: string;
  values: { tag?: string; text: string }[];
  delta?: string; // change since 2022, shown above the note
  note: string;
  short: string; // the comparison in a few words, for the phone layout
  dist?: { min: number; max: number; median: number; marks: number[]; ends: [string, string] };
  // A bar split into parts, for figures that are a whole divided up (brands by size, ranked of all mapped)
  bar?: { parts: { v: number; token: string }[]; ends: [string, string] };
}
// A labelled range line: lowest and highest ranked neighborhood at the ends, a tick at the median, a dot per value shown
function Dist({ d, neutral }: { d: NonNullable<Cell['dist']>; neutral: boolean }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, (v - d.min) / (d.max - d.min || 1))) * 100}%`;
  return (
    <span className={`sf-dist${neutral ? ' is-neutral' : ''}`} aria-hidden="true">
      <span className="sf-dist-end">{d.ends[0]}</span>
      <span className="sf-dist-line">
        <i className="sf-dist-median" style={{ left: x(d.median) }} />
        {d.marks.map((m, i) => (
          <i key={i} className={`sf-dist-mark m${i}`} style={{ left: x(m) }} />
        ))}
      </span>
      <span className="sf-dist-end">{d.ends[1]}</span>
    </span>
  );
}
function SplitBar({ b }: { b: NonNullable<Cell['bar']> }) {
  const total = b.parts.reduce((t, p) => t + p.v, 0) || 1;
  return (
    <span className="sf-dist" aria-hidden="true">
      <span className="sf-dist-end">{b.ends[0]}</span>
      <span className="sf-dist-line sf-kpi-split">
        {b.parts.map((p, i) => (
          <i key={i} style={{ width: `${(p.v / total) * 100}%`, background: p.token }} />
        ))}
      </span>
      <span className="sf-dist-end">{b.ends[1]}</span>
    </span>
  );
}
// Chain brands in a set, split by size: mini, mid-size, big
const brandSplit = (brands: Brand[]) => [TIERS[1], TIERS[2], TIERS[3]].map((t) => ({ v: brands.filter((b) => b.tier === t.key).length, token: t.token }));
const since = (now: number, then: number, unit: 'pts' | 'count') => {
  const d = unit === 'pts' ? Math.round(now * 100) - Math.round(then * 100) : Math.round(now - then);
  if (d === 0) return 'Level with 2022';
  const size = unit === 'pts' ? `${Math.abs(d)} ${Math.abs(d) === 1 ? 'pt' : 'pts'}` : num(Math.abs(d));
  return `${d > 0 ? 'Up' : 'Down'} ${size} since 2022`;
};
// How an earlier year's figure compares with 2026: "3 pts below 2026 (22%)"
const against = (now: number | null | undefined, then: number | null | undefined, unit: 'pts' | 'count', fmt: (v: number) => string) => {
  if (now == null || then == null) return undefined;
  const d = unit === 'pts' ? Math.round(now * 100) - Math.round(then * 100) : Math.round(now - then);
  if (d === 0) return `Level with 2026 (${fmt(then)})`;
  const size = unit === 'pts' ? `${Math.abs(d)} ${Math.abs(d) === 1 ? 'pt' : 'pts'}` : num(Math.abs(d));
  return `${size} ${d > 0 ? 'above' : 'below'} 2026 (${fmt(then)})`;
};
const signed = (d: number) => (d === 0 ? 'level with' : `${d > 0 ? '+' : '\u2212'}${Math.abs(d)} vs`);

function kpiCells(ctx: Ctx): { scope: string; pair?: string[]; sub: string; neutral: boolean; cells: Cell[] } {
  const { data, sel, cmp, boro } = ctx;
  const c = data.city;
  const R = data.ranked.length;
  const latest = ctx.year === LATEST_YEAR;
  const dShare = { min: c.ranges.share[0], max: c.ranges.share[1], median: c.medianShare, ends: [pct(c.ranges.share[0]), pct(c.ranges.share[1])] as [string, string] };
  const dChains = { min: c.ranges.chains[0], max: c.ranges.chains[1], median: c.medianChains, ends: [num(c.ranges.chains[0]), num(c.ranges.chains[1])] as [string, string] };
  const dSim = { min: c.ranges.sim[0], max: c.ranges.sim[1], median: c.medianSim, ends: [score(c.ranges.sim[0]), score(c.ranges.sim[1])] as [string, string] };
  const dRank = { min: R, max: 1, median: (R + 1) / 2, ends: [`#${R}`, '#1'] as [string, string] };
  const sharePts = (v: number) => Math.round(v * 100) - Math.round(c.medianShare * 100);
  const simPts = (v: number) => Math.round(v * 100) - Math.round(c.medianSim * 100);
  const vsChains = (v: number) => {
    const d = v - c.medianChains;
    return d === 0 ? `Level with the city median of ${c.medianChains}` : `${Math.abs(d)} ${d > 0 ? 'more' : 'fewer'} than the city median of ${c.medianChains}`;
  };
  const vsSim = (v: number) => {
    const d = simPts(v);
    return d === 0 ? `Level with the city median of ${score(c.medianSim)}` : `${Math.abs(d)} ${d > 0 ? 'above' : 'below'} the city median of ${score(c.medianSim)}`;
  };
  const rankNote = `Of ${R} ranked neighborhoods. #1 has the most chains.`;
  // 2022 for the "since 2022" lines. It is estimated the same way as the year slider, so it arrives a moment after the page.
  const prev = latest ? ctx.prev : null;
  const L = latest ? null : ctx.now; // the 2026 data, while an earlier year shows
  const simDelta = (now: number | null, was: number | null | undefined) => (now !== null && was != null ? `${since(now, was, 'pts')} (${score(was)})` : undefined);
  const simVs = (now: number | null, then: number | null | undefined) => against(now, then, 'pts', score);

  if (sel && cmp) {
    const picks = [sel, cmp, ...(ctx.third ? [ctx.third] : [])];
    const tags = ['A', 'B', 'C'];
    const vals = (f: (n: Nbhd) => string) => picks.map((n, i) => ({ tag: tags[i], text: f(n) }));
    const dS = Math.round(sel.chainShare * 100) - Math.round(cmp.chainShare * 100);
    const shareNote =
      picks.length > 2 ? `City median ${pct(c.medianShare)}` : dS === 0 ? `Level with each other. City median ${pct(c.medianShare)}` : `A is ${Math.abs(dS)} pts ${dS > 0 ? 'higher' : 'lower'}. City median ${pct(c.medianShare)}`;
    return {
      scope: picks.map((n) => n.name).join(' and '),
      pair: picks.map((n) => n.name),
      sub: picks.length > 2 ? 'Comparing three neighborhoods' : 'Comparing two neighborhoods',
      neutral: false,
      cells: [
        { label: 'Chain Share', values: vals((n) => pct(n.chainShare)), note: shareNote, short: `median ${pct(c.medianShare)}`, dist: { ...dShare, marks: picks.map((n) => n.chainShare) } },
        { label: 'Distinct Chains', values: vals((n) => num(n.chainBrands)), note: `City median ${c.medianChains}`, short: `median ${c.medianChains}`, dist: { ...dChains, marks: picks.map((n) => n.chainBrands) } },
        { label: 'Similarity Score', values: vals((n) => (n.simScore === null ? 'n/a' : score(n.simScore))), note: `City median ${score(c.medianSim)}`, short: `median ${score(c.medianSim)}`, dist: picks.every((n) => n.simScore !== null) ? { ...dSim, marks: picks.map((n) => n.simScore as number) } : undefined },
        { label: 'Chain Share Rank', values: vals((n) => (n.rank ? `#${n.rank}` : 'n/a')), note: rankNote, short: `of ${R}`, dist: picks.every((n) => n.rank) ? { ...dRank, marks: picks.map((n) => n.rank as number) } : undefined },
      ],
    };
  }
  if (sel) {
    const ranked = sel.eligible;
    const was = latest ? data.change.get(sel.id) : undefined;
    return {
      scope: sel.name,
      sub: `${boroLabel(sel.boro)} · ${plural(sel.n, 'restaurant')}`,
      neutral: false,
      cells: [
        { label: 'Chain Share', values: [{ text: sel.n ? pct(sel.chainShare) : 'n/a' }], delta: was ? `${since(sel.chainShare, was.s22, 'pts')} (${pct(was.s22)})` : against(sel.n ? sel.chainShare : null, L?.byId.get(sel.id)?.chainShare, 'pts', pct), note: sel.n ? `${ptsVs(sel.chainShare, c.medianShare)} the city median of ${pct(c.medianShare)}` : 'No restaurants on record here', short: sel.n ? `${signed(sharePts(sel.chainShare))} median` : 'no restaurants', dist: ranked ? { ...dShare, marks: [sel.chainShare] } : undefined },
        { label: 'Distinct Chains', values: [{ text: num(sel.chainBrands) }], note: vsChains(sel.chainBrands), short: `${signed(sel.chainBrands - c.medianChains)} median`, dist: ranked ? { ...dChains, marks: [sel.chainBrands] } : undefined },
        { label: 'Similarity Score', values: [{ text: sel.simScore === null ? 'n/a' : score(sel.simScore) }], delta: latest ? simDelta(sel.simScore, prev?.byId.get(sel.id)?.simScore) : simVs(sel.simScore, L?.byId.get(sel.id)?.simScore), note: sel.simScore === null ? (noSimReason(sel) ?? 'No score') : `${vsSim(sel.simScore)}.`, short: sel.simScore === null ? 'too few to score' : `${signed(simPts(sel.simScore))} median`, dist: sel.simScore !== null ? { ...dSim, marks: [sel.simScore] } : undefined },
        { label: 'Chain Share Rank', values: [{ text: sel.rank ? `#${sel.rank}` : 'Not ranked' }], note: sel.rank ? rankNote : `Fewer than ${MIN_RESTAURANTS} restaurants`, short: sel.rank ? `of ${R}` : 'under 20 restaurants', dist: sel.rank ? { ...dRank, marks: [sel.rank] } : undefined },
      ],
    };
  }
  if (boro) {
    return {
      scope: boro.label,
      sub: `Borough · ${plural(boro.restaurants, 'restaurant')}`,
      neutral: true,
      cells: [
        { label: 'Chain Share', values: [{ text: pct(boro.chainShare) }], note: `${ptsVs(boro.chainShare, c.medianShare)} the city's median neighborhood (${pct(c.medianShare)})`, short: `${signed(sharePts(boro.chainShare))} median`, dist: { ...dShare, marks: [boro.chainShare] } },
        { label: 'Distinct Chains', values: [{ text: num(boro.chainBrands) }], note: `Of ${num(c.chainBrands)} citywide`, short: `of ${num(c.chainBrands)}`, bar: { parts: brandSplit(data.brands.filter((b) => b.tier !== 'independent' && b.boros[boro.key])), ends: ['mini', 'big'] } },
        { label: 'Similarity Score', values: [{ text: score(boro.medianSim) }], delta: latest ? simDelta(boro.medianSim, prev?.boroByKey.get(boro.key)?.medianSim) : simVs(boro.medianSim, L?.boroByKey.get(boro.key)?.medianSim), note: `Median of its ${boro.ranked} ranked neighborhoods. ${vsSim(boro.medianSim)}`, short: `${signed(simPts(boro.medianSim))} median`, dist: { ...dSim, marks: [boro.medianSim] } },
        { label: 'Chain Share Rank', values: [{ text: `#${boro.rank}` }], note: 'Of 5 boroughs. #1 has the most chains.', short: 'of 5 boroughs', dist: { min: 5, max: 1, median: 3, marks: [boro.rank], ends: ['#5', '#1'] } },
      ],
    };
  }
  const k = latest ? data.kpi.get('nyc:chain_penetration') : undefined;
  const kb = latest ? data.kpi.get('nyc:chain_brands') : undefined;
  const ranked: Cell = { label: 'Ranked Neighborhoods', values: [{ text: num(R) }], delta: prev ? `${since(R, prev.ranked.length, 'count')} (${num(prev.ranked.length)})` : against(R, L?.ranked.length, 'count', num), note: `Of ${num(data.nbhds.length)} mapped. The rest have fewer than ${MIN_RESTAURANTS} restaurants.`, short: `of ${num(data.nbhds.length)} mapped`, bar: { parts: [{ v: R, token: 'var(--ink-3)' }, { v: Math.max(0, data.nbhds.length - R), token: 'var(--line)' }], ends: ['0', num(data.nbhds.length)] } };
  return {
    scope: 'New York City',
    sub: `${plural(c.restaurants, 'restaurant')} in ${num(data.nbhds.length)} neighborhoods`,
    neutral: true,
    cells: [
      { label: 'Chain Share', values: [{ text: pct(c.chainShare) }], delta: k ? `${since(k.v2026, k.v2022, 'pts')} (${pct(k.v2022)})` : against(c.chainShare, L?.city.chainShare, 'pts', pct), note: `The median neighborhood is ${pct(c.medianShare)}`, short: `median ${pct(c.medianShare)}`, dist: { ...dShare, marks: [c.chainShare] } },
      { label: 'Distinct Chains', values: [{ text: num(c.chainBrands) }], delta: kb ? `${since(kb.v2026, kb.v2022, 'count')} (${num(kb.v2022)})` : against(c.chainBrands, L?.city.chainBrands, 'count', num), note: 'Brands with 3 or more locations', short: '3+ locations', bar: { parts: brandSplit(data.brands.filter((b) => b.tier !== 'independent')), ends: ['mini', 'big'] } },
      { label: 'Similarity Score', values: [{ text: score(c.medianSim) }], delta: latest ? simDelta(c.medianSim, prev?.city.medianSim) : simVs(c.medianSim, L?.city.medianSim), note: `Median neighborhood. 0 means no chains in common, 100 means ${ctx.simKind === 'set' ? 'the same chains' : 'the same mix'}.`, short: 'median, 0 to 100', dist: { ...dSim, marks: [c.medianSim] } },
      ranked,
    ],
  };
}

// The year control: one slider that moves every view, with play
export function YearControl({ year, status, playing, onYear, onPlay }: { year: number; status: 'ready' | 'loading' | 'error'; playing: boolean; onYear: (y: number) => void; onPlay: () => void }) {
  const id = useId();
  // The slider's own position. While it is being dragged it is a fraction of the way between two years, so the thumb follows the
  // pointer smoothly. The year the rest of the page shows is the nearest whole year, and on release the thumb glides to it.
  const [pos, setPos] = useState<number>(year);
  const posRef = useRef<number>(year);
  const dragging = useRef(false);
  const glide = useRef(0);
  const frame = useRef(0);
  const sent = useRef(year); // the last year this control asked the page for
  const shown = Math.round(pos);

  const place = (v: number) => {
    posRef.current = v;
    setPos(v);
  };
  const stopGlide = () => cancelAnimationFrame(glide.current);
  const glideTo = (target: number, ms = 200) => {
    stopGlide();
    const from = posRef.current;
    if (from === target) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return place(target);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      place(from + (target - from) * (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)); // ease in and out
      if (t < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  // Ask the page for a year, once per change. The slider and the digits answer at once; the page-wide recount follows on the
  // next frame, and only for the last value if several arrive together, so the digits never wait behind it.
  const choose = (y: number) => {
    if (y === sent.current) return;
    sent.current = y;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => onYear(y));
  };
  // The page changed the year by itself (play, a click on a chart): glide there. While dragging, the page is following us instead.
  useEffect(() => {
    sent.current = year;
    if (!dragging.current && Math.round(posRef.current) !== year) glideTo(year, 550); // a longer, steadier glide for play
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(glide.current);
    },
    [],
  );
  const clampYear = (y: number) => Math.max(YEARS[0], Math.min(LATEST_YEAR, y));
  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const y = clampYear(Math.round(posRef.current));
    choose(y);
    // The thumb stays exactly where it was let go. Only the year (the number and the data) is the nearest whole year.
  };

  const kind = yearKind(shown);
  const note = status === 'loading' ? 'loading' : status === 'error' ? 'did not load' : kind;
  return (
    <div className="sf-year">
      <span className="sf-year-label">Year</span>
      <h1 className="sf-yearhead">
        <RollNumber value={String(shown)} />
      </h1>
      <div className="sf-year-row">
        <button type="button" className="sf-iconbtn" onClick={onPlay} aria-label={playing ? 'Pause' : 'Play through the years from 2019'} title={playing ? 'Pause' : 'Play 2019 to 2026'}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <label htmlFor={id} className="sf-sr">
          Year shown in every view
        </label>
        <div className="sf-year-track" style={{ '--p': (pos - YEARS[0]) / (LATEST_YEAR - YEARS[0]) } as CSSProperties}>
          <input
            id={id}
            type="range"
            min={YEARS[0]}
            max={LATEST_YEAR}
            step="any"
            value={pos}
            aria-valuetext={`${shown}, ${kind}`}
            onPointerDown={() => {
              dragging.current = true;
              stopGlide();
              window.addEventListener('pointerup', release, { once: true });
              window.addEventListener('pointercancel', release, { once: true });
            }}
            onChange={(e) => {
              stopGlide();
              const v = Number(e.target.value);
              place(v);
              choose(clampYear(Math.round(v)));
            }}
            onKeyDown={(e) => {
              // Arrow keys and Home and End move one whole year at a time, and the thumb glides there
              const jump: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
              const to = e.key === 'Home' ? YEARS[0] : e.key === 'End' ? LATEST_YEAR : e.key in jump ? clampYear(Math.round(posRef.current) + jump[e.key]) : null;
              if (to === null) return;
              e.preventDefault();
              stopGlide();
              choose(to);
              glideTo(to);
            }}
          />
          {/* One tick under the slider for every year, so the timeline can be read while dragging. The year being shown is marked. */}
          {Array.from({ length: LATEST_YEAR - YEARS[0] + 1 }, (_, i) => YEARS[0] + i).map((y) => (
            <button
              key={y}
              type="button"
              className="sf-year-tick"
              data-on={y === shown ? '1' : undefined}
              style={{ '--t': (y - YEARS[0]) / (LATEST_YEAR - YEARS[0]) } as CSSProperties}
              tabIndex={-1} // the slider itself is the keyboard control
              aria-label={`Go to ${y}`}
              onClick={() => {
                stopGlide();
                choose(y);
                glideTo(y, 350);
              }}
            />
          ))}
        </div>
      </div>
      <output htmlFor={id} className="sf-sr" aria-live="polite">
        {shown}, {note}
      </output>
    </div>
  );
}

export function KpiStrip({ ctx, yearControl }: { ctx: Ctx; yearControl?: ReactNode }) {
  const { scope, neutral, cells } = kpiCells(ctx);
  const uid = useId();
  return (
    <section className="sf-kpis" aria-label={`Key figures for ${scope}`}>
      <div className="sf-kpi-scope">{yearControl}</div>
      <dl className="sf-kpi-row">
        {cells.map((cell, ci) => (
          <div className="sf-kpi" key={cell.label}>
            <dt>
              {/* The explanation sits in a tooltip on the name: hover, or focus it with the keyboard */}
              <span className="sf-kpi-name" tabIndex={0} aria-describedby={`${uid}-${ci}`}>
                {cell.label}
              </span>
              <span className="sf-kpi-tip" role="tooltip" id={`${uid}-${ci}`}>
                {cell.note}
              </span>
            </dt>
            <dd>
              <span className={`sf-kpi-values${cell.values.length > 2 ? ' is-three' : ''}`}>
                {cell.values.map((v, i) => (
                  <span className="sf-kpi-value" key={i}>
                    {v.tag && <span className={`sf-tag t${i}`}>{v.tag}</span>}
                    <RollNumber value={v.text} />
                  </span>
                ))}
              </span>
              {cell.dist && <Dist d={cell.dist} neutral={neutral} />}
              {cell.bar && <SplitBar b={cell.bar} />}
              {cell.delta && <span className={`sf-kpi-delta${ctx.year !== LATEST_YEAR ? ' is-vs' : ''}`}>{cell.delta}</span>}
              <span className="sf-kpi-short">{cell.short}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function KpiSkeleton() {
  return (
    <section className="sf-kpis" aria-hidden="true">
      <div className="sf-kpi-scope">
        <span className="sf-skel" style={{ width: 120, height: 36 }} />
        <span className="sf-skel" style={{ width: 200, height: 24, marginTop: 6 }} />
      </div>
      <div className="sf-kpi-row">
        {[0, 1, 2, 3].map((i) => (
          <div className="sf-kpi" key={i}>
            <span className="sf-skel" style={{ width: 90, height: 12 }} />
            <span className="sf-skel" style={{ width: 70, height: 28 }} />
            <span className="sf-skel" style={{ width: 160, height: 12 }} />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- Search ---------- */

type Hit = { kind: 'n'; n: Nbhd } | { kind: 'b'; b: Brand };
export function Search({ data, onNbhd, onBrand, inputRef }: { data: Data | null; onNbhd: (id: string) => void; onBrand: (name: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const hits = useMemo<Hit[]>(() => {
    const words = flat(q).split(/\s+/).filter(Boolean);
    if (!data || !words.length) return [];
    const ns: Hit[] = [];
    for (const n of data.nbhds) {
      const hay = flat(`${n.name} ${n.boro.replace('-', ' ')}`);
      if (words.every((w) => hay.includes(w))) ns.push({ kind: 'n', n });
      if (ns.length >= 5) break;
    }
    const bs: Hit[] = [];
    for (const b of data.brands) {
      if (words.every((w) => b.key.includes(w))) bs.push({ kind: 'b', b });
      if (bs.length >= 6) break;
    }
    return [...ns, ...bs];
  }, [q, data]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);
  const choose = (h: Hit) => {
    if (h.kind === 'n') onNbhd(h.n.id);
    else onBrand(h.b.name);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      choose(hits[active]);
    } else if (e.key === 'Escape' && (open || q)) {
      e.stopPropagation();
      setOpen(false);
      setQ('');
    }
  };
  const show = open && q.trim().length > 0;
  const firstBrand = hits.findIndex((h) => h.kind === 'b');
  return (
    <div className="sf-search" ref={boxRef}>
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-activedescendant={show && hits[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-label="Search neighborhoods, restaurants, and chains"
        placeholder="Search a neighborhood or restaurant"
        value={q}
        disabled={!data}
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {show && (
        <div className="sf-results" id={listId} role="listbox" aria-label="Search results">
          {hits.length === 0 && (
            <p className="sf-empty" role="status">
              Nothing matches “{q.trim()}”. Try a neighborhood such as Astoria, or a restaurant name such as Dunkin.
            </p>
          )}
          {hits.map((h, i) => (
            <div key={h.kind === 'n' ? h.n.id : `b:${h.b.name}`}>
              {i === 0 && h.kind === 'n' && <p className="sf-results-head">Neighborhoods</p>}
              {i === firstBrand && <p className="sf-results-head">Restaurants and Chains</p>}
              <div id={`${listId}-${i}`} role="option" aria-selected={i === active} className="sf-result" onPointerEnter={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => choose(h)}>
                {h.kind === 'n' ? (
                  <>
                    <span>{h.n.name}</span>
                    <span className="sf-result-meta">{boroLabel(h.n.boro)}</span>
                  </>
                ) : (
                  <>
                    <span>{h.b.name}</span>
                    <span className="sf-result-meta">{plural(h.b.total, 'location')}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Shared panel pieces ---------- */

function TierBar({ shares, label }: { shares: Record<Tier, number>; label: string }) {
  return (
    <div className="sf-tierbar" role="img" aria-label={`${label}: ${TIERS.map((t) => `${t.label} ${pct(shares[t.key])}`).join(', ')}`}>
      {TIERS.map((t) => (
        <i key={t.key} style={{ flexGrow: Math.max(shares[t.key], 0.0001), background: t.token }} />
      ))}
    </div>
  );
}
function TierTable({ cols }: { cols: { head: string; shares: Record<Tier, number> }[] }) {
  return (
    <table className="sf-spec">
      <thead>
        <tr>
          <th scope="col">Chain tier</th>
          {cols.map((c) => (
            <th scope="col" key={c.head} className="is-num">
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {TIERS.map((t) => (
          <tr key={t.key}>
            <th scope="row">
              <i className="sf-chip" style={{ background: t.token }} />
              {t.label.replace(/ chain$/, '')}
              <span className="sf-spec-meta">{t.range}</span>
            </th>
            {cols.map((c) => (
              <td key={c.head} className="is-num">
                {pct(c.shares[t.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BarRow({ label, meta, value, max, display, onClick, link, tag }: { label: string; meta?: string; value: number; max: number; display: string; onClick?: () => void; link?: { onEnter: () => void; onLeave: () => void }; tag?: ReactNode }) {
  const body = (
    <>
      <span className="sf-bar-label">
        {tag}
        <span className="sf-bar-name">{label}</span>
        {meta && <span className="sf-bar-meta">{meta}</span>}
      </span>
      <span className="sf-bar-track" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(1, value / (max || 1))) * 100}%` }} />
      </span>
      <span className="sf-bar-value">{display}</span>
    </>
  );
  return onClick ? (
    <li>
      <button type="button" className="sf-bar is-button" onClick={onClick} onPointerEnter={link?.onEnter} onPointerLeave={link?.onLeave} onFocus={link?.onEnter} onBlur={link?.onLeave}>
        {body}
      </button>
    </li>
  ) : (
    <li className="sf-bar">{body}</li>
  );
}
const linkTo = (ctx: Ctx, id: string) => ({ onEnter: () => ctx.setHover(id), onLeave: () => ctx.setHover(null) });

const tierName = (t: Tier) => TIERS.find((x) => x.key === t)?.label ?? t;

// The full explanations of chain, tiers and similarity live on the Methodology page, so the panels only point to it
function MethodLink() {
  const { href } = useUrl();
  return (
    <p className="sf-footnote sf-methodlink">
      <StateLink to={href({ v: 'method' })}>How chain share and similarity are measured</StateLink>
    </p>
  );
}

/* ---------- Borough strip plot ---------- */

export function StripPlot({ ctx }: { ctx: Ctx }) {
  const { data, values, classes, sel, cmp, hoverId, mode } = ctx;
  const [ref, w] = useWidth<HTMLDivElement>();
  const meta = modeMeta(mode, sel, ctx.simKind);
  const left = 96;
  const right = 14;
  const rowH = 36;
  const top = 26; // room above the rows for the city median's label
  const rows = BOROS.filter((b) => data.boroByKey.has(b));
  // In the city and borough views a row is a button: it shows that borough on the map. Inside a neighborhood the rows only inform.
  const pickable = !ctx.sel && !ctx.cmp;
  const max = useMemo(() => Math.max(0.1, Math.ceil(Math.max(0, ...values.values()) * 10) / 10), [values]);
  const x = (v: number) => left + (v / max) * Math.max(10, w - left - right);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const h = top + rows.length * rowH + 22;
  // Spread dots vertically by a stable hash of the id so overlapping values stay visible
  const jitter = (id: string) => {
    let s = 0;
    for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) % 997;
    return (s / 997 - 0.5) * 18;
  };
  const dots = useMemo(() => data.ranked.filter((n) => values.has(n.id)), [data, values]);
  const medians = useMemo(
    () =>
      rows.map((b) => {
        const vs = dots.filter((n) => n.boro === b).map((n) => values.get(n.id)!).sort((p, q) => p - q);
        return vs.length ? vs[vs.length >> 1] : 0;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dots, values],
  );
  // The median of every ranked neighborhood, for whatever the map is showing
  const cityMedian = useMemo(() => {
    const vs = dots.map((n) => values.get(n.id)!).sort((p, q) => p - q);
    return vs.length ? (vs.length % 2 ? vs[vs.length >> 1] : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2) : null;
  }, [dots, values]);
  const pickBoro = (b: string) => ctx.act.setBoro(ctx.boro?.key === b ? null : b);
  const special = (id: string) => (id === sel?.id ? 'is-a' : id === cmp?.id ? 'is-b' : id === ctx.third?.id ? 'is-c' : id === hoverId ? 'is-hover' : '');
  const hovered = hoverId ? data.byId.get(hoverId) : undefined;
  return (
    <figure className="sf-strip" ref={ref}>
      <figcaption>
        <b>Neighborhoods by borough.</b> {meta.axis}. Each dot is a neighborhood; the tick is the borough median and the dashed line is the city median.{pickable ? ' Select a borough to show it on the map.' : ''}
      </figcaption>
      {w > 0 && (
        <svg width={w} height={h} role="img" aria-label={`Strip plot of ${meta.axis.toLowerCase()} for each ranked neighborhood, one row per borough. The Ranking tab lists the same values.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="sf-strip-grid" x1={x(t)} x2={x(t)} y1={top} y2={top + rows.length * rowH} />
              <text className="sf-strip-tick" x={x(t)} y={h - 6} textAnchor={t === 0 ? 'start' : t === max ? 'end' : 'middle'}>
                {meta.fmt(t)}
              </text>
            </g>
          ))}
          {rows.map((b, r) => (
            <g key={b}>
              {pickable && <rect className={`sf-strip-row${ctx.boro?.key === b ? ' is-on' : ''}`} x={0} y={top + r * rowH} width={w} height={rowH} rx={4} onClick={() => pickBoro(b)} />}
              <text
                className={`sf-strip-label${ctx.boro?.key === b ? ' is-on' : ''}${pickable ? ' is-link' : ''}`}
                x={6}
                y={top + r * rowH + rowH / 2 + 4}
                {...(pickable
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': ctx.boro?.key === b,
                      'aria-label': `${boroLabel(b)}: show on the map`,
                      onClick: () => pickBoro(b),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          pickBoro(b);
                        }
                      },
                    }
                  : {})}
              >
                {boroLabel(b)}
              </text>
              <line className="sf-strip-median" x1={x(medians[r])} x2={x(medians[r])} y1={top + r * rowH + 4} y2={top + (r + 1) * rowH - 4} />
            </g>
          ))}
          {cityMedian !== null && (
            <g className="sf-strip-city">
              <line x1={x(cityMedian)} x2={x(cityMedian)} y1={top - 6} y2={top + rows.length * rowH} />
              <text x={x(cityMedian)} y={top - 11} textAnchor="middle">
                City median {meta.fmt(cityMedian)}
              </text>
            </g>
          )}
          <g onPointerLeave={() => ctx.setHover(null)}>
            {dots.map((n) => {
              const s = special(n.id);
              if (s) return null;
              return <circle key={n.id} className={`sf-strip-dot c${classes.get(n.id) ?? 0}${ctx.boro && n.boro !== ctx.boro.key ? ' is-out' : ''}`} cx={x(values.get(n.id)!)} cy={top + rows.indexOf(n.boro) * rowH + rowH / 2 + jitter(n.id)} r={3.5} onPointerEnter={() => ctx.setHover(n.id)} onClick={() => ctx.act.select(n.id)} />;
            })}
            {dots
              .filter((n) => special(n.id))
              .map((n) => (
                <circle key={n.id} className={`sf-strip-dot ${special(n.id)}`} cx={x(values.get(n.id)!)} cy={top + rows.indexOf(n.boro) * rowH + rowH / 2 + jitter(n.id)} r={6} onPointerEnter={() => ctx.setHover(n.id)} onClick={() => ctx.act.select(n.id)} />
              ))}
          </g>
        </svg>
      )}
      <p className="sf-strip-read" aria-live="polite">
        {hovered && values.has(hovered.id) ? (
          <>
            <b>{hovered.name}</b>, {boroLabel(hovered.boro)}: {meta.fmt(values.get(hovered.id)!)}
          </>
        ) : (
          'Hover or tap a dot to read it.'
        )}
      </p>
    </figure>
  );
}

/* ---------- Ranking ---------- */

type SortKey = 'share' | 'chains' | 'sim' | 'n' | 'name';
function Ranking({ ctx }: { ctx: Ctx }) {
  const { data, sel, hoverId } = ctx;
  const [sort, setSort] = useState<SortKey>('share');
  const [desc, setDesc] = useState(true);
  const boro = ctx.boro?.key ?? '';
  const rows = useMemo(() => {
    const val = (n: Nbhd) => (sort === 'share' ? n.chainShare : sort === 'chains' ? n.chainBrands : sort === 'sim' ? (n.simScore ?? -1) : n.n);
    const list = data.ranked.filter((n) => !boro || n.boro === boro);
    list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : val(a) - val(b) || b.name.localeCompare(a.name)));
    if (desc !== (sort === 'name')) list.reverse();
    return list;
  }, [data, sort, desc, boro]);
  const head = (key: SortKey, label: string, cls = '') => (
    <th scope="col" className={cls} aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => {
          if (sort === key) setDesc((d) => !d);
          else {
            setSort(key);
            setDesc(true);
          }
        }}
      >
        {label}
        <span className={`sf-sort${sort === key ? (desc ? ' is-desc' : ' is-asc') : ''}`} aria-hidden="true" />
      </button>
    </th>
  );
  const max = data.city.ranges.share[1];
  return (
    <div className="sf-ranking">
      <div className="sf-ranking-tools">
        <label>
          <span>Borough</span>
          <select value={boro} onChange={(e) => ctx.act.setBoro(e.target.value || null)}>
            <option value="">All five</option>
            {data.boros.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <div className="sf-seg is-small" role="group" aria-label="Order">
          <button type="button" aria-pressed={sort === 'share' && desc} onClick={() => (setSort('share'), setDesc(true))}>
            Most chains
          </button>
          <button type="button" aria-pressed={sort === 'share' && !desc} onClick={() => (setSort('share'), setDesc(false))}>
            Fewest
          </button>
        </div>
      </div>
      <div className="sf-table-wrap" onPointerLeave={() => ctx.setHover(null)}>
        <table className="sf-table">
          <caption className="sf-sr">Ranked neighborhoods. Select a column heading to sort. Select a neighborhood to open it on the map.</caption>
          <thead>
            <tr>
              <th scope="col" className="is-num">
                #
              </th>
              {head('name', 'Neighborhood')}
              {head('share', 'Chain share', 'is-num')}
              {head('chains', 'Chains', 'is-num')}
              {head('sim', 'Similarity', 'is-num')}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} className={`${n.id === sel?.id ? 'is-selected' : ''}${n.id === hoverId ? ' is-hover' : ''}`} onPointerEnter={() => ctx.setHover(n.id)}>
                <td className="is-num sf-rank">{n.rank}</td>
                <th scope="row">
                  <button type="button" onClick={() => ctx.act.select(n.id)} onFocus={() => ctx.setHover(n.id)} onBlur={() => ctx.setHover(null)}>
                    {n.name}
                    {!boro && <span className="sf-table-meta">{boroLabel(n.boro)}</span>}
                  </button>
                </th>
                <td className="is-num sf-sharecell">
                  <span className="sf-cellbar" aria-hidden="true">
                    <i className={`c${ctx.classes.get(n.id) ?? 0}`} style={{ width: `${(n.chainShare / max) * 100}%` }} />
                  </span>
                  {pct(n.chainShare)}
                </td>
                <td className="is-num">{n.chainBrands}</td>
                <td className="is-num" title={noSimReason(n) ?? undefined}>
                  {n.simScore === null ? '' : score(n.simScore)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sf-footnote">
        {plural(rows.length, 'neighborhood')}. Rank is by chain share.
      </p>
    </div>
  );
}

/* ---------- Panel views ---------- */

function TopChains({ ctx, list, title, empty }: { ctx: Ctx; list: { b: Brand; count: number }[]; title: string; empty: string }) {
  const max = Math.max(1, ...list.map((x) => x.count));
  return (
    <section>
      <h3>{title}</h3>
      {list.length ? (
        <ul className="sf-bars">
          {list.map(({ b, count }) => (
            <BarRow key={b.name} label={b.name} meta={tierName(b.tier)} value={count} max={max} display={num(count)} onClick={() => ctx.act.addBrand(b.name)} />
          ))}
        </ul>
      ) : (
        <p className="sf-empty">{empty}</p>
      )}
      {list.length > 0 && <p className="sf-footnote">Select a chain to see its locations on the map.</p>}
    </section>
  );
}

function CityView({ ctx }: { ctx: Ctx }) {
  const { data, boro } = ctx;
  const tab = ctx.tab === 'rank' || ctx.tab === 'boros' || ctx.tab === 'restaurants' ? ctx.tab : 'overview';
  const c = data.city;
  const scope = boro ? data.ranked.filter((n) => n.boro === boro.key) : data.ranked;
  const most = scope[0];
  const least = scope[scope.length - 1];
  const chains = useMemo(
    () =>
      data.brands
        .filter((b) => b.tier !== 'independent' && (!boro || b.boros[boro.key]))
        .map((b) => ({ b, count: boro ? b.boros[boro.key] : b.total }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    [data, boro],
  );
  return (
    <>
      <header className="sf-panel-head">
        <div>
          <h2>{boro ? boro.label : 'All of New York City'}</h2>
          <p>{boro ? `${boro.ranked} ranked neighborhoods` : `${data.ranked.length} ranked neighborhoods in five boroughs`}</p>
        </div>
        {boro && (
          <button type="button" className="sf-btn" onClick={() => ctx.act.setBoro(null)}>
            <Icon name="x" size={14} /> Whole city
          </button>
        )}
      </header>
      <Tabs
        label="City views"
        value={tab}
        onChange={ctx.act.setTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'restaurants', label: 'Restaurants' },
          { key: 'rank', label: 'Ranking' },
          { key: 'boros', label: 'Boroughs' },
        ]}
      />
      <div className="sf-panel-body" role="tabpanel">
        {tab === 'overview' && (
          <>
            <p className="sf-lede">
              {boro ? (
                <>
                  {pct(boro.chainShare)} of {boro.label}'s {num(boro.restaurants)} restaurants belong to a chain. Its median neighborhood sits at {pct(boro.medianShare)}, against {pct(c.medianShare)} citywide.
                </>
              ) : (
                <>
                  {pct(c.chainShare)} of the city's {num(c.restaurants)} restaurants belong to a chain.
                </>
              )}{' '}
              {most && least && (
                <>
                  The range runs from {pct(least.chainShare)} in{' '}
                  <button type="button" className="sf-inline" onClick={() => ctx.act.select(least.id)} {...spread(linkTo(ctx, least.id))}>
                    {least.name}
                  </button>{' '}
                  to {pct(most.chainShare)} in{' '}
                  <button type="button" className="sf-inline" onClick={() => ctx.act.select(most.id)} {...spread(linkTo(ctx, most.id))}>
                    {most.name}
                  </button>
                  .
                </>
              )}
            </p>
            <section>
              <h3>Restaurants by tier</h3>
              <TierBar shares={boro ? boro.shares : c.shares} label="Restaurants by tier" />
              <TierTable cols={boro ? [{ head: boro.label, shares: boro.shares }, { head: 'City', shares: c.shares }] : [{ head: 'City', shares: c.shares }]} />
            </section>
            <TopChains ctx={ctx} list={chains} title={boro ? `Largest chains in ${boro.label}` : 'Largest chains'} empty="No chains on record." />
            <MethodLink />
          </>
        )}
        {tab === 'restaurants' && <RestaurantList key={boro?.key ?? 'city'} data={data} scope={{ name: boro ? boro.label : 'New York City', boro: boro?.key }} pin={ctx.pin} onPin={ctx.act.pinPlace} onList={ctx.act.listPlaces} />}
        {tab === 'rank' && <Ranking ctx={ctx} />}
        {tab === 'boros' && (
          <>
            <StripPlot ctx={ctx} />
            <section>
              <h3>Borough comparison</h3>
              <div className="sf-table-wrap is-plain">
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th scope="col">Borough</th>
                      <th scope="col" className="is-num">
                        Chain share
                      </th>
                      <th scope="col" className="is-num">
                        Chains
                      </th>
                      <th scope="col">Largest chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.boros]
                      .sort((a, b) => a.rank - b.rank)
                      .map((b) => (
                        <tr key={b.key} className={boro?.key === b.key ? 'is-selected' : ''}>
                          <th scope="row">
                            <button type="button" onClick={() => ctx.act.setBoro(boro?.key === b.key ? null : b.key)} aria-pressed={boro?.key === b.key}>
                              {b.label}
                            </button>
                          </th>
                          <td className="is-num">{pct(b.chainShare)}</td>
                          <td className="is-num">{num(b.chainBrands)}</td>
                          <td>
                            {b.topBrand} <span className="sf-table-meta">{num(b.topBrandCount)}</span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="sf-footnote">Select a borough to zoom to it and scope the figures above.</p>
            </section>
          </>
        )}
      </div>
    </>
  );
}
const spread = (l: { onEnter: () => void; onLeave: () => void }) => ({ onPointerEnter: l.onEnter, onPointerLeave: l.onLeave, onFocus: l.onEnter, onBlur: l.onLeave });

function similarList(data: Data, a: Nbhd): { n: Nbhd; s: number }[] {
  if (!a.simOk) return [];
  return data.ranked
    .filter((n) => n.id !== a.id && n.simOk)
    .map((n) => ({ n, s: simBetween(data, a, n) ?? 0 }))
    .sort((p, q) => q.s - p.s || p.n.name.localeCompare(q.n.name));
}

function SimilarLists({ ctx, a, action }: { ctx: Ctx; a: Nbhd; action: string }) {
  const list = useMemo(() => similarList(ctx.data, a), [ctx.data, a]);
  if (!list.length)
    return (
      <p className="sf-empty">
        {a.eligible
          ? `${a.name} has ${plural(a.chainCount, 'chain restaurant')}. Similarity needs ${MIN_CHAIN_RESTAURANTS} or more, so there is too little to compare.`
          : `${a.name} has fewer than ${MIN_RESTAURANTS} restaurants, so its chains are too few to compare.`}{' '}
        You can still pick any neighborhood on the map.
      </p>
    );
  const set = ctx.simKind === 'set';
  const row = ({ n, s }: { n: Nbhd; s: number }) => <BarRow key={n.id} label={n.name} meta={boroLabel(n.boro)} value={s} max={1} display={score(s)} onClick={() => ctx.act.compareWith(n.id)} link={linkTo(ctx, n.id)} />;
  return (
    <>
      <section>
        <h3>{set ? 'Most overlap in chains' : 'Most similar chain mix'}</h3>
        <ul className="sf-bars">{list.slice(0, 8).map(row)}</ul>
      </section>
      <section>
        <h3>Least similar</h3>
        <ul className="sf-bars">{list.slice(-3).reverse().map(row)}</ul>
        <p className="sf-footnote">{action}</p>
      </section>
    </>
  );
}

function NbhdView({ ctx, n }: { ctx: Ctx; n: Nbhd }) {
  const { data } = ctx;
  const tab = ctx.tab === 'similar' || ctx.tab === 'restaurants' ? ctx.tab : 'overview';
  const chains = useMemo(
    () =>
      data.brands
        .filter((b) => b.tier !== 'independent' && b.nbhds.has(n.id))
        .map((b) => ({ b, count: b.nbhds.get(n.id)! }))
        .sort((a, b) => b.count - a.count || b.b.total - a.b.total)
        .slice(0, 8),
    [data, n],
  );
  return (
    <>
      <header className="sf-panel-head">
        <div>
          <h2>{n.name}</h2>
          <p>
            {boroLabel(n.boro)} · {plural(n.n, 'restaurant')}
          </p>
        </div>
        <div className="sf-head-actions">
          <button type="button" className="sf-btn is-primary" onClick={ctx.act.startCompare}>
            Compare
          </button>
          <button type="button" className="sf-iconbtn" onClick={ctx.act.deselectA} aria-label={`Deselect ${n.name}`} title="Deselect">
            <Icon name="x" />
          </button>
        </div>
      </header>
      <Tabs
        label="Neighborhood views"
        value={tab}
        onChange={ctx.act.setTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'restaurants', label: 'Restaurants' },
          { key: 'similar', label: 'Similar neighborhoods' },
        ]}
      />
      <div className="sf-panel-body" role="tabpanel">
        {tab === 'overview' && (
          <>
            {!n.eligible && (
              <p className="sf-notice">
                {n.name} has {plural(n.n, 'restaurant')} on record. Neighborhoods with fewer than {MIN_RESTAURANTS} are not ranked or colored, because one opening or closing would swing the numbers.
              </p>
            )}
            {n.n > 0 && (
              <section>
                <h3>Restaurants by tier</h3>
                <TierBar shares={n.shares} label={`${n.name} restaurants by tier`} />
                <TierTable cols={[{ head: 'Here', shares: n.shares }, { head: 'City', shares: data.city.shares }]} />
              </section>
            )}
            <TopChains ctx={ctx} list={chains} title="Chains with the most locations here" empty="No chain has a location here." />
            {n.eligible && <StripPlot ctx={ctx} />}
            <MethodLink />
          </>
        )}
        {tab === 'restaurants' && <RestaurantList key={n.id} data={data} scope={{ name: n.name, nbhdId: n.id }} pin={ctx.pin} onPin={ctx.act.pinPlace} onList={ctx.act.listPlaces} />}
        {tab === 'similar' && (
          <>
            {n.simOk && (
              <p className="sf-lede is-small">
                {ctx.mode === 'sim' ? (
                  <>The map is colored by how closely each neighborhood's chains match {n.name}.</>
                ) : (
                  <>
                    <button type="button" className="sf-inline" onClick={() => ctx.act.setMode('sim')}>
                      Color the map by similarity to {n.name}
                    </button>{' '}
                    to see the pattern across the city.
                  </>
                )}
              </p>
            )}
            <SimilarLists ctx={ctx} a={n} action="Select a neighborhood to compare it with this one." />
            <MethodLink />
          </>
        )}
      </div>
    </>
  );
}

function PairHead({ ctx, a, b }: { ctx: Ctx; a: Nbhd; b: Nbhd | null }) {
  const c = ctx.third;
  const row = (tag: string, cls: string, n: Nbhd, remove: () => void) => (
    <li>
      <span className={`sf-tag ${cls}`}>{tag}</span>
      <span className="sf-pair-name">
        <b>{n.name}</b>
        <span>{boroLabel(n.boro)}</span>
      </span>
      <button type="button" className="sf-iconbtn" onClick={remove} aria-label={`Remove ${n.name}`} title="Remove">
        <Icon name="x" size={16} />
      </button>
    </li>
  );
  const empty = (tag: string, cls: string, word: string) => (
    <li className="is-empty">
      <span className={`sf-tag ${cls}`}>{tag}</span>
      <span className="sf-pair-name">
        <b>Pick a {word} neighborhood</b>
        <span>Select one on the map or from the list below</span>
      </span>
      <button type="button" className="sf-btn" onClick={ctx.act.cancelCompare}>
        Cancel
      </button>
    </li>
  );
  return (
    <header className="sf-panel-head is-pair">
      <ul className="sf-pair">
        {row('A', 't0', a, ctx.act.deselectA)}
        {b ? row('B', 't1', b, ctx.act.deselectB) : empty('B', 't1', 'second')}
        {c ? row('C', 't2', c, ctx.act.deselectC) : ctx.pickingThird ? empty('C', 't2', 'third') : null}
      </ul>
      {b && !ctx.pickingThird && (
        <div className="sf-pair-actions">
          {!c && (
            <button type="button" className="sf-btn" onClick={ctx.act.startThird}>
              Add a third
            </button>
          )}
          {!c && (
            <button type="button" className="sf-btn" onClick={ctx.act.swap}>
              <Icon name="swap" size={14} /> Swap A and B
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function PickView({ ctx, a }: { ctx: Ctx; a: Nbhd }) {
  return (
    <>
      <PairHead ctx={ctx} a={a} b={null} />
      <div className="sf-panel-body">
        <SimilarLists ctx={ctx} a={a} action="Or select any neighborhood on the map." />
      </div>
    </>
  );
}

const PICK_TAGS = ['A', 'B', 'C'];
const PICK_KEYS = ['a', 'b', 'c'];
const tierToken = (t: Tier) => TIERS.find((x) => x.key === t)?.token ?? 'var(--ink-3)';

function CompareView({ ctx, a, b }: { ctx: Ctx; a: Nbhd; b: Nbhd }) {
  const { data } = ctx;
  const c = ctx.third;
  const picks = c ? [a, b, c] : [a, b];
  const N = picks.length;
  const idsKey = picks.map((n) => n.id).join('|');
  const tab = ctx.tab === 'shared' ? 'shared' : 'tiers';
  const s = simBetween(data, a, b);
  const rankOf = useMemo(() => {
    if (s === null) return null;
    const list = similarList(data, a);
    return { rank: list.findIndex((x) => x.n.id === b.id) + 1, total: list.length };
  }, [data, a, b, s]);
  const pairScores = c
    ? ([[0, 1], [0, 2], [1, 2]] as const).map(([i, j]) => ({ i, j, s: simBetween(data, picks[i], picks[j]) }))
    : [];

  // Every chain with a location in at least one of the neighborhoods, with its count in each one
  const rows = useMemo(() => {
    const ids = idsKey.split('|');
    const out: { br: Brand; counts: number[]; inN: number }[] = [];
    for (const br of data.brands) {
      if (br.tier === 'independent') continue;
      const counts = ids.map((id) => br.nbhds.get(id) ?? 0);
      const inN = counts.filter(Boolean).length;
      if (inN) out.push({ br, counts, inN });
    }
    return out;
  }, [data, idsKey]);
  const byCombined = (x: { br: Brand; counts: number[] }, y: { br: Brand; counts: number[] }) =>
    y.counts.reduce((p, q) => p + q, 0) - x.counts.reduce((p, q) => p + q, 0) || x.br.name.localeCompare(y.br.name);
  const inAll = rows.filter((r) => r.inN === N).sort(byCombined);
  const inTwo = N === 3 ? rows.filter((r) => r.inN === 2).length : 0;
  const only = picks.map((_, i) => rows.filter((r) => r.inN === 1 && r.counts[i] > 0).sort((x, y) => y.counts[i] - x.counts[i] || x.br.name.localeCompare(y.br.name)));
  const union = rows.length;
  const SHOWN = 10;
  const top = inAll.slice(0, SHOWN);
  const maxShared = Math.max(1, ...top.flatMap((r) => r.counts));
  const ONLY_SHOWN = 5;
  const maxOnly = Math.max(1, ...only.flatMap((list, i) => list.slice(0, ONLY_SHOWN).map((r) => r.counts[i])));
  const both = N === 3 ? 'all three' : 'both';
  const segs =
    N === 3
      ? [
          { cls: 'is-a', n: only[0].length, label: 'Only A' },
          { cls: 'is-b', n: only[1].length, label: 'Only B' },
          { cls: 'is-c', n: only[2].length, label: 'Only C' },
          { cls: 'is-some', n: inTwo, label: 'In two' },
          { cls: 'is-all', n: inAll.length, label: 'In all three' },
        ]
      : [
          { cls: 'is-a', n: only[0].length, label: 'Only A' },
          { cls: 'is-all', n: inAll.length, label: 'Both' },
          { cls: 'is-b', n: only[1].length, label: 'Only B' },
        ];
  const brandButton = (br: Brand) => (
    <button type="button" onClick={() => ctx.act.addBrand(br.name)} title={`${br.name}: show on the map`}>
      {br.name}
    </button>
  );

  return (
    <>
      <PairHead ctx={ctx} a={a} b={b} />
      <Tabs
        label="Comparison views"
        value={tab}
        onChange={ctx.act.setTab}
        tabs={[
          { key: 'tiers', label: 'Tier mix' },
          { key: 'shared', label: `Chains in common (${inAll.length})` },
        ]}
      />
      <div className="sf-panel-body" role="tabpanel">
        {c ? (
          <p className="sf-lede is-small">
            {pairScores.some((p) => p.s === null)
              ? `No similarity score for some of these pairs. ${picks.filter((n) => !n.simOk).map((n) => `${n.name}: ${noSimReason(n)!.toLowerCase()}.`).join(' ')}`
              : <>Their {ctx.simKind === 'set' ? 'chain lists overlap' : 'chain mixes score'}{' '}
                  {pairScores.map((p, k) => (
                    <span key={k}>
                      {k ? ', ' : ''}
                      {PICK_TAGS[p.i]} and {PICK_TAGS[p.j]} <b>{score(p.s as number)}</b>
                    </span>
                  ))}{' '}
                  out of 100.</>}
          </p>
        ) : s !== null && rankOf ? (
          <p className="sf-lede is-small">
            Their {ctx.simKind === 'set' ? 'chain lists overlap' : 'chain mixes score'} <b>{score(s)}</b> out of 100. {b.name} is the {ordinal(rankOf.rank)} closest match to {a.name} of {rankOf.total} neighborhoods.
          </p>
        ) : (
          <p className="sf-notice">
            No similarity score for this pair. {[a, b].filter((n) => !n.simOk).map((n) => `${n.name}: ${noSimReason(n)!.toLowerCase()}.`).join(' ')}
          </p>
        )}
        {tab === 'tiers' && (
          <section>
            <h3>Restaurants by tier</h3>
            <div className="sf-pairbars">
              {picks.map((n, i) => (
                <Fragment key={n.id}>
                  <span className={`sf-tag t${i}`}>{PICK_TAGS[i]}</span>
                  <TierBar shares={n.shares} label={`${n.name} restaurants by tier`} />
                </Fragment>
              ))}
            </div>
            <TierTable cols={[...picks.map((n, i) => ({ head: PICK_TAGS[i], shares: n.shares })), { head: 'City', shares: data.city.shares }]} />
            <table className="sf-spec">
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  {picks.map((n, i) => (
                    <th scope="col" className="is-num" key={n.id}>
                      {PICK_TAGS[i]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Restaurants', (n: Nbhd) => num(n.n)],
                    ['Chain Share', (n: Nbhd) => pct(n.chainShare)],
                    ['Big chain share', (n: Nbhd) => pct(tierShare(n.shares, 'big'))],
                    ['Distinct Chains', (n: Nbhd) => String(n.chainBrands)],
                  ] as const
                ).map(([label, f]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {picks.map((n) => (
                      <td className="is-num" key={n.id}>
                        {f(n)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {tab === 'shared' && (
          <>
            <section className="sf-shared">
              <h3>Chains in common</h3>
              {union === 0 ? (
                <p className="sf-empty">None of these neighborhoods has a chain location.</p>
              ) : (
                <>
                  <p className="sf-lede is-small">
                    <b>{inAll.length}</b> of the {union} chains in these {N === 3 ? 'three' : 'two'} neighborhoods appear in {both} ({pct(inAll.length / union)}).
                  </p>
                  <div className="sf-venn" role="img" aria-label={segs.map((x) => `${x.label}: ${x.n}`).join(', ')}>
                    {segs.filter((x) => x.n > 0).map((x) => (
                      <span key={x.label} className={`sf-venn-seg ${x.cls}`} style={{ flexGrow: x.n }} />
                    ))}
                  </div>
                  <ul className="sf-venn-key">
                    {segs.map((x) => (
                      <li key={x.label}>
                        <i className={`sf-venn-sw ${x.cls}`} />
                        {x.label} <b>{x.n}</b>
                      </li>
                    ))}
                  </ul>
                  {inAll.length ? (
                    <>
                      {N === 2 && (
                        <div className="sf-mirror-head" aria-hidden="true">
                          <span className="sf-tag t0">A</span>
                          <span className="sf-tag t1">B</span>
                        </div>
                      )}
                      <ul className={N === 2 ? 'sf-mirror' : 'sf-groups'}>
                        {top.map(({ br, counts }) => (
                          <li key={br.name}>
                            <span className="sf-mirror-name">
                              <i className="sf-tierdot" style={{ background: tierToken(br.tier) }} aria-hidden="true" />
                              {brandButton(br)}
                              <span className="sf-mirror-total">{counts.reduce((p, q) => p + q, 0)}</span>
                            </span>
                            {N === 2 ? (
                              <span className="sf-mirror-bars">
                                <b className="sf-mirror-n">{counts[0]}</b>
                                <span className="sf-mirror-track is-a">
                                  <i style={{ width: `${(counts[0] / maxShared) * 100}%` }} />
                                </span>
                                <span className="sf-mirror-track is-b">
                                  <i style={{ width: `${(counts[1] / maxShared) * 100}%` }} />
                                </span>
                                <b className="sf-mirror-n">{counts[1]}</b>
                              </span>
                            ) : (
                              <span className="sf-group">
                                {counts.map((n, i) => (
                                  <span className="sf-group-row" key={i}>
                                    <span className={`sf-tag t${i}`}>{PICK_TAGS[i]}</span>
                                    <span className={`sf-group-track is-${PICK_KEYS[i]}`}>
                                      <i style={{ width: `${(n / maxShared) * 100}%` }} />
                                    </span>
                                    <b className="sf-mirror-n">{n}</b>
                                  </span>
                                ))}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <p className="sf-footnote">
                        Locations of each chain in {N === 3 ? 'A, B and C' : 'A and B'}, largest first{inAll.length > SHOWN ? `, showing ${SHOWN} of ${inAll.length}` : ''}. The dot is the chain's tier.
                      </p>
                    </>
                  ) : (
                    <p className="sf-empty">No chain has a location in {both}.</p>
                  )}
                </>
              )}
            </section>
            {union > 0 &&
              picks.map((n, i) => (
                <section className="sf-only" key={n.id}>
                  <h3>
                    <span className={`sf-tag t${i}`}>{PICK_TAGS[i]}</span>
                    Only in {n.name}
                    <span className="sf-only-count">{plural(only[i].length, 'chain')}</span>
                  </h3>
                  {only[i].length ? (
                    <ul className="sf-onlylist">
                      {only[i].slice(0, ONLY_SHOWN).map(({ br, counts }) => (
                        <li key={br.name}>
                          <span className="sf-mirror-name">
                            <i className="sf-tierdot" style={{ background: tierToken(br.tier) }} aria-hidden="true" />
                            {brandButton(br)}
                          </span>
                          <span className={`sf-group-track is-${PICK_KEYS[i]}`}>
                            <i style={{ width: `${(counts[i] / maxOnly) * 100}%` }} />
                          </span>
                          <b className="sf-mirror-n">{counts[i]}</b>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sf-empty">Every chain here also has a location in the {N === 3 ? 'others' : 'other'}.</p>
                  )}
                </section>
              ))}
          </>
        )}
        <MethodLink />
      </div>
    </>
  );
}
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

function BrandView({ ctx }: { ctx: Ctx }) {
  const { data, brands } = ctx;
  // Neighborhoods that have every one of the chosen restaurants
  const overlap = brands.length > 1 ? [...brands[0].nbhds.keys()].filter((id) => brands.every((br) => br.nbhds.has(id))).length : 0;
  const topN = (br: Brand) =>
    [...br.nbhds.entries()]
      .map(([id, count]) => ({ n: data.byId.get(id), count }))
      .filter((x): x is { n: Nbhd; count: number } => !!x.n)
      .sort((p, q) => q.count - p.count || p.n.name.localeCompare(q.n.name))
      .slice(0, 6);
  const maxBoro = Math.max(1, ...brands.flatMap((br) => Object.values(br.boros)));
  return (
    <>
      <header className="sf-panel-head is-pair">
        <ul className="sf-pair">
          {brands.map((br, i) => (
            <li key={br.name}>
              <i className={`sf-dotkey s${i}`} aria-hidden="true" />
              <span className="sf-pair-name">
                <b>{br.name}</b>
                <span>
                  {br.tier === 'independent' ? (br.total > 1 ? 'Not counted as a chain' : 'Independent') : tierName(br.tier)} · {plural(br.total, 'location')}
                </span>
              </span>
              <button type="button" className="sf-iconbtn" onClick={() => ctx.act.removeBrand(br.name)} aria-label={`Remove ${br.name} from the map`} title="Remove">
                <Icon name="x" size={16} />
              </button>
            </li>
          ))}
        </ul>
        <div className="sf-head-actions">
          {brands.length < 3 && (
            <button type="button" className="sf-btn is-primary" onClick={ctx.act.focusSearch}>
              <Icon name="plus" size={14} /> Compare with another
            </button>
          )}
          <button type="button" className="sf-btn" onClick={ctx.act.clearBrands}>
            {ctx.sel ? `Back to ${ctx.sel.name}` : 'Clear search'}
          </button>
        </div>
      </header>
      <div className="sf-panel-body">
        <p className="sf-lede is-small">Each dot is one location. Hover or tap one for its name.</p>
        {brands.length > 1 && (
          <section>
            <h3>Side by side</h3>
            <table className="sf-spec">
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  {brands.map((br, i) => (
                    <th scope="col" className="is-num" key={br.name}>
                      <i className={`sf-dotkey s${i}`} aria-hidden="true" /> {br.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Locations</th>
                  {brands.map((br) => (
                    <td className="is-num" key={br.name}>
                      {num(br.total)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Neighborhoods reached</th>
                  {brands.map((br) => (
                    <td className="is-num" key={br.name}>
                      {br.nbhds.size}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Neighborhoods with {brands.length === 3 ? 'all three' : 'both'}</th>
                  <td className="is-num" colSpan={brands.length}>
                    {overlap}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        )}
        <section>
          <h3>Locations by borough</h3>
          {data.boros.map((bo) => (
            <div className="sf-boro-split" key={bo.key}>
              <span>{bo.label}</span>
              <ul className="sf-bars is-tight">
                {brands.map((br, i) => (
                  <BarRow key={br.name} label="" tag={brands.length > 1 ? <i className={`sf-dotkey s${i}`} role="img" aria-label={br.name} /> : undefined} value={br.boros[bo.key] ?? 0} max={maxBoro} display={num(br.boros[bo.key] ?? 0)} />
                ))}
              </ul>
            </div>
          ))}
        </section>
        {brands.map((br) => {
          const list = topN(br);
          const max = Math.max(1, ...list.map((x) => x.count));
          return (
            <section key={br.name}>
              <h3>Where {br.name} has the most locations</h3>
              <ul className="sf-bars">
                {list.map(({ n, count }) => (
                  <BarRow key={n.id} label={n.name} meta={boroLabel(n.boro)} value={count} max={max} display={num(count)} link={linkTo(ctx, n.id)} onClick={() => ctx.act.select(n.id)} />
                ))}
              </ul>
              <p className="sf-footnote">
                In {plural(br.nbhds.size, 'neighborhood')}. Select one to zoom to it.
              </p>
            </section>
          );
        })}
      </div>
    </>
  );
}

export function PanelContent({ ctx }: { ctx: Ctx }) {
  if (ctx.brands.length) return <BrandView ctx={ctx} />;
  if (ctx.sel && ctx.cmp) return <CompareView ctx={ctx} a={ctx.sel} b={ctx.cmp} />;
  if (ctx.sel && ctx.picking) return <PickView ctx={ctx} a={ctx.sel} />;
  if (ctx.sel) return <NbhdView ctx={ctx} n={ctx.sel} />;
  return <CityView ctx={ctx} />;
}
export function panelTitle(ctx: Ctx): string {
  if (ctx.brands.length) return ctx.brands.map((b) => b.name).join(' and ');
  if (ctx.sel && ctx.cmp) return [ctx.sel, ctx.cmp, ...(ctx.third ? [ctx.third] : [])].map((n) => n.name).join(' and ');
  if (ctx.sel) return ctx.sel.name;
  return ctx.boro ? ctx.boro.label : 'New York City';
}
export function PanelSkeleton() {
  return (
    <div className="sf-panel-body" aria-hidden="true">
      {[180, 260, 220, 300, 240, 200, 280].map((w, i) => (
        <span key={i} className="sf-skel" style={{ width: w, height: i === 0 ? 22 : 14 }} />
      ))}
    </div>
  );
}
