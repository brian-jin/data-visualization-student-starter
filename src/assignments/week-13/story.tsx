// The Story page: the idea behind the project and what the numbers show, told in six steps.
// The text scrolls on the left; the picture on the right stays put and changes to match the step in view.
// A step becomes the current one when it crosses the middle of the page (an IntersectionObserver on the page's own scroll box).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { csvParse } from 'd3';
import { BOROS, MIN_RESTAURANTS, TIERS, YEARS, SNAPSHOT_YEARS, boroLabel, changeSummary, classOf, makeBreaks, num, score, useTimeline, useYearData } from './data';
import type { Data, Tier, Timeline } from './data';
import { MapView } from './MapView';
import { StateLink } from './ui';
import type { Patch } from './ui';

const NO_PAD = { top: 24, right: 24, bottom: 24, left: 24 };
const noop = () => {};
const pts = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const BRANDS_URL = `${import.meta.env.BASE_URL}data/stats/temporal_brand_change.csv`;

interface BrandRow {
  key: string;
  label: string;
  was: number;
  now: number;
  tier: string; // the size of chain it is in 2026: mini, mid or big
}
let brandCache: Promise<BrandRow[]> | null = null;
function loadBrandChange(): Promise<BrandRow[]> {
  brandCache ??= fetch(BRANDS_URL)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((t) => csvParse(t).map((r) => ({ key: r.brand_key ?? '', label: r.label ?? '', was: Number(r.locations_2022), now: Number(r.locations_2026), tier: r.tier_2026 ?? '' })))
    .catch((e) => {
      brandCache = null;
      throw e;
    });
  return brandCache;
}
function useBrandChange(): BrandRow[] | null {
  const [rows, setRows] = useState<BrandRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadBrandChange().then(
      (r) => alive && setRows(r),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

/* ---------- The pictures ---------- */

const VW = 560;
const VH = 440;

function ChainMap({ data }: { data: Data }) {
  const map = useMemo(() => {
    const breaks = makeBreaks(data.ranked.map((n) => n.chainShare));
    return { breaks, classes: new Map(data.ranked.map((n) => [n.id, classOf(n.chainShare, breaks)])) };
  }, [data]);
  const b = map.breaks.map((x) => Math.round(x * 100));
  return (
    <figure className="sf-vis-map" aria-label="Map of New York City neighborhoods shaded by the share of restaurants that are chains">
      <MapView data={data} classes={map.classes} activeClasses={null} describe={() => ''} selId={null} cmpId={null} hoverId={null} onHover={noop} onSelect={noop} brands={[]} focusKey="story" focusBounds={data.bounds} pad={NO_PAD} interactive={false} />
      <figcaption className="sf-landing-key">
        <p>Share of restaurants that are chains</p>
        <ol>
          {[`Under ${b[0]}%`, `${b[0]} to ${b[1]}%`, `${b[1]} to ${b[2]}%`, `${b[2]} to ${b[3]}%`, `${b[3]}% or more`].map((label, i) => (
            <li key={label}>
              <i className={`sf-chip c${i}`} />
              {label}
            </li>
          ))}
          <li>
            <i className="sf-chip is-nodata" />
            Under {MIN_RESTAURANTS} restaurants
          </li>
        </ol>
      </figcaption>
    </figure>
  );
}

// Chain share of all restaurants, by year, split by chain size. Only the two snapshot years are measured; the others are estimates.
function ShareByYear({ data, timeline, on }: { data: Data; timeline: Timeline | null; on: boolean }) {
  const L = 44;
  const R = 16;
  const T = 44;
  const B = 56;
  const plotW = VW - L - R;
  const plotH = VH - T - B;
  const top = 0.25;
  const y = (v: number) => T + plotH - (v / top) * plotH;
  const slot = plotW / YEARS.length;
  const barW = slot * 0.62;
  const kpi = data.kpi.get('nyc:chain_penetration');
  const rows = YEARS.map((year, i) => {
    const t = timeline?.tiers[i];
    const open = timeline?.open[i] ?? 0;
    if (!t || !open) return null;
    const mini = t.mini_chain / open;
    const mid = t.chain / open;
    const big = t.big_chain / open;
    return { year, mini, mid, big, total: mini + mid + big };
  });
  const first = rows[YEARS.indexOf(2022)];
  const last = rows[YEARS.length - 1];
  const shown = (r: NonNullable<(typeof rows)[number]>) => (r.year === 2022 && kpi ? kpi.v2022 : r.year === YEARS[YEARS.length - 1] && kpi ? kpi.v2026 : r.total);
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Stacked columns of the share of restaurants that are chains each year from 2019 to 2026. ${kpi ? `It was ${pts(kpi.v2022)} in 2022 and ${pts(kpi.v2026)} in 2026.` : ''}`}>
      {[0, 0.1, 0.2].map((v) => (
        <g key={v}>
          <line x1={L} x2={VW - R} y1={y(v)} y2={y(v)} className="sf-vis-grid" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" className="sf-vis-tick">
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        if (!r) return null;
        const x = L + slot * i + (slot - barW) / 2;
        const real = SNAPSHOT_YEARS.has(r.year);
        const parts = [
          { k: 'big', v: r.big, fill: TIERS[3].token },
          { k: 'mid', v: r.mid, fill: TIERS[2].token },
          { k: 'mini', v: r.mini, fill: TIERS[1].token },
        ];
        let acc = 0;
        return (
          <g key={r.year} className="sf-vis-col" style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'} opacity={real ? 1 : 0.5}>
            {parts.map((p) => {
              const y0 = y(acc);
              acc += p.v;
              return <rect key={p.k} x={x} y={y(acc)} width={barW} height={Math.max(0, y0 - y(acc))} fill={p.fill} />;
            })}
            <text x={x + barW / 2} y={VH - B + 20} textAnchor="middle" className={`sf-vis-tick${real ? ' is-strong' : ''}`}>
              {r.year}
            </text>
            {real && (
              <text x={x + barW / 2} y={y(r.total) - 8} textAnchor="middle" className="sf-vis-value">
                {pts(shown(r))}
              </text>
            )}
          </g>
        );
      })}
      {first && last && (
        <text x={VW - R} y={VH - 10} textAnchor="end" className="sf-vis-note">
          Lighter columns are estimated from inspection dates
        </text>
      )}
      <g transform={`translate(${L}, 12)`} className="sf-vis-legend">
        {[
          { t: TIERS[1], text: 'Mini chain (3 to 9)', x: 0 },
          { t: TIERS[2], text: 'Mid-size (10 to 49)', x: 150 },
          { t: TIERS[3], text: 'Big (50 or more)', x: 300 },
        ].map((l) => (
          <g key={l.t.key} transform={`translate(${l.x}, 0)`}>
            <rect width="12" height="12" rx="2" fill={l.t.token} />
            <text x="18" y="10.5">
              {l.text}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function BrandGrowth({ rows, on }: { rows: BrandRow[] | null; on: boolean }) {
  const top = useMemo(() => (rows ? [...rows].sort((a, b) => b.now - b.was - (a.now - a.was)).slice(0, 8) : []), [rows]);
  const L = 190;
  const R = 70;
  const rowH = 42;
  const T = 84;
  const max = Math.max(1, ...top.map((r) => r.now - r.was));
  const W = (v: number) => (v / max) * (VW - L - R);
  const isBig = (r: BrandRow) => r.tier === 'big';
  const smaller = top.filter((r) => !isBig(r)).length;
  const tierWord = (r: BrandRow) => (r.tier === 'big' ? 'big chain' : r.tier === 'mid' ? 'mid-size' : r.tier === 'mini' ? 'mini chain' : '');
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Chains that added the most locations between 2022 and 2026. ${smaller} of the ${top.length} are mini or mid-size chains: ${top.map((r) => `${r.label}, ${tierWord(r)}, from ${r.was} to ${r.now}`).join('; ')}.`}>
      <text x={0} y={22} className="sf-vis-title">
        Locations added, 2022 to 2026
      </text>
      <g className="sf-vis-legend" transform="translate(0, 40)">
        <rect width="12" height="12" rx="2" className="sf-vis-bar" />
        <text x="18" y="10.5">
          Mini and mid-size chains
        </text>
        <g transform="translate(190, 0)">
          <rect width="12" height="12" rx="2" className="sf-vis-bar is-big" />
          <text x="18" y="10.5">
            Big chains (50 or more)
          </text>
        </g>
      </g>
      {top.map((r, i) => {
        const y = T + i * rowH;
        const add = r.now - r.was;
        const big = isBig(r);
        return (
          <g key={r.key} className={`sf-vis-row${big ? ' is-muted' : ''}`} style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'}>
            <text x={L - 12} y={y + 17} textAnchor="end" className="sf-vis-label">
              {r.label}
            </text>
            <rect x={L} y={y} width={W(add)} height={26} rx="2" className={`sf-vis-bar${big ? ' is-big' : ''}`} />
            <text x={L + W(add) + 8} y={y + 12} className="sf-vis-value">
              +{add}
            </text>
            <text x={L + W(add) + 8} y={y + 25} className="sf-vis-sub">
              {r.was} to {r.now}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Chain share by borough, 2022 and 2026: a dot for each year and the gain between them
function BoroughShare({ data, on }: { data: Data; on: boolean }) {
  const rows = BOROS.map((key) => {
    const k = data.kpi.get(`${key}:chain_penetration`);
    return k ? { key, label: boroLabel(key), was: k.v2022, now: k.v2026 } : null;
  })
    .filter((r): r is { key: string; label: string; was: number; now: number } => r !== null)
    .sort((a, b) => b.now - b.was - (a.now - a.was));
  const L = 118;
  const R = 74;
  const T = 76;
  const rowH = 64;
  const lo = Math.floor(Math.min(...rows.map((r) => r.was), 0.15) * 20) / 20;
  const hi = Math.ceil(Math.max(...rows.map((r) => r.now), 0.3) * 20) / 20;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (VW - L - R);
  const ticks: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += 0.05) ticks.push(Math.round(t * 100) / 100);
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Share of restaurants that are chains in each borough, 2022 and 2026. ${rows.map((r) => `${r.label}, ${pts(r.was)} to ${pts(r.now)}`).join('; ')}.`}>
      <text x={0} y={22} className="sf-vis-title">
        Chain share by borough
      </text>
      <g className="sf-vis-legend" transform="translate(0, 38)">
        <circle cx="6" cy="6" r="5" className="sf-vis-dot" />
        <text x="18" y="10.5">
          2022
        </text>
        <circle cx="76" cy="6" r="5" className="sf-vis-dot is-real" />
        <text x="88" y="10.5">
          2026
        </text>
      </g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={T - 8} y2={T + rows.length * rowH - 20} className="sf-vis-grid" />
          <text x={x(t)} y={T + rows.length * rowH - 2} textAnchor="middle" className="sf-vis-tick">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = T + i * rowH + 12;
        return (
          <g key={r.key} className="sf-vis-row" style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'}>
            <text x={L - 14} y={y + 5} textAnchor="end" className="sf-vis-label">
              {r.label}
            </text>
            <line x1={x(r.was)} x2={x(r.now)} y1={y} y2={y} className="sf-vis-span" />
            <circle cx={x(r.was)} cy={y} r="8" className="sf-vis-dot" />
            <circle cx={x(r.now)} cy={y} r="8" className="sf-vis-dot is-real" />
            <text x={x(Math.max(r.was, r.now)) + 16} y={y + 5} className="sf-vis-value">
              +{((r.now - r.was) * 100).toFixed(1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// How many neighborhoods in each borough rose and fell between 2022 and 2026
function boroughSplit(data: Data) {
  const out = new Map<string, { up: number; down: number }>();
  for (const key of BOROS) out.set(key, { up: 0, down: 0 });
  for (const [id, r] of data.change) {
    const boro = data.byId.get(id)?.boro;
    const c = boro ? out.get(boro) : undefined;
    if (!c) continue;
    const d = Math.round((r.s26 - r.s22) * 100);
    if (d > 0) c.up++;
    else if (d < 0) c.down++;
  }
  return BOROS.map((key) => ({ key, label: boroLabel(key), ...out.get(key)! }));
}

function BoroughSplit({ data, on }: { data: Data; on: boolean }) {
  const rows = useMemo(() => boroughSplit(data).sort((a, b) => b.up + b.down - (a.up + a.down)), [data]);
  const L = 118;
  const R = 20;
  const T = 84;
  const rowH = 56;
  const half = Math.max(1, ...rows.flatMap((r) => [r.up, r.down]));
  const plotW = VW - L - R;
  const mid = L + plotW / 2;
  const w = (v: number) => (v / half) * (plotW / 2 - 36);
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Neighborhoods where chain share rose or fell between 2022 and 2026, by borough. ${rows.map((r) => `${r.label}, ${r.up} rose and ${r.down} fell`).join('; ')}.`}>
      <text x={0} y={22} className="sf-vis-title">
        Neighborhoods where chain share fell or rose
      </text>
      <g className="sf-vis-legend" transform="translate(0, 38)">
        <rect width="12" height="12" rx="2" className="sf-vis-bar is-down" />
        <text x="18" y="10.5">
          Fell
        </text>
        <rect x="70" width="12" height="12" rx="2" className="sf-vis-bar" />
        <text x="88" y="10.5">
          Rose
        </text>
      </g>
      <line x1={mid} x2={mid} y1={T - 12} y2={T + rows.length * rowH - 12} className="sf-vis-axis" />
      {rows.map((r, i) => {
        const y = T + i * rowH;
        return (
          <g key={r.key} className="sf-vis-row" style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'}>
            <text x={L - 14} y={y + 17} textAnchor="end" className="sf-vis-label">
              {r.label}
            </text>
            <rect x={mid - w(r.down)} y={y} width={w(r.down)} height={26} rx="2" className="sf-vis-bar is-down" />
            <text x={mid - w(r.down) - 8} y={y + 18} textAnchor="end" className="sf-vis-value">
              {r.down}
            </text>
            <rect x={mid} y={y} width={w(r.up)} height={26} rx="2" className="sf-vis-bar" />
            <text x={mid + w(r.up) + 8} y={y + 18} className="sf-vis-value">
              {r.up}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// One neighborhood's two snapshots, from the same file as the "since 2022" figures: how many restaurants, and the share in each tier
function snapOf(data: Data, id: string) {
  const r = data.raw.changeRows.find((x) => x.nbhd_id === id);
  if (!r) return null;
  const mk = (y: string) => {
    const n = Number(r[`restaurants_${y}`]);
    const chain = Number(r[`chain_share_${y}`]);
    const mini = Number(r[`mini_share_${y}`]);
    const mid = Number(r[`mid_share_${y}`]);
    const big = Number(r[`big_share_${y}`]);
    const shares: Record<Tier, number> = { independent: 1 - chain, mini_chain: mini, chain: mid, big_chain: big };
    const counts = Object.fromEntries((Object.keys(shares) as Tier[]).map((k) => [k, Math.round(shares[k] * n)])) as Record<Tier, number>;
    return { n, chain, shares, counts };
  };
  return { y22: mk('2022'), y26: mk('2026') };
}

// Two neighborhoods that began at nearly the same chain share, as stacked bars of what their restaurants were in 2022 and in 2026
const CLOSE = [
  { name: 'Williamsburg', boro: 'brooklyn' },
  { name: 'SoHo', boro: 'manhattan' },
];
function CloseUps({ data, on }: { data: Data; on: boolean }) {
  const L = 40;
  const T = 112;
  const B = 84;
  const plotH = VH - T - B;
  const top = 0.25; // one scale for both neighborhoods, so the columns can be compared by eye
  const y = (v: number) => T + plotH - (v / top) * plotH;
  const gap = 28;
  const panelW = (VW - L - gap) / 2;
  const colW = 70;
  const blocks = CLOSE.map((c) => {
    const n = data.nbhds.find((x) => x.name === c.name && x.boro === c.boro);
    const snap = n ? snapOf(data, n.id) : null;
    return n && snap ? { n, snap } : null;
  });
  const stack = [TIERS[3], TIERS[2], TIERS[1]]; // big at the bottom, as in the year-by-year chart
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Share of restaurants that are chains in Williamsburg and SoHo, 2022 and 2026, on one scale. ${blocks.map((b) => (b ? `${b.n.name}: ${pts(b.snap.y22.chain)} in 2022 and ${pts(b.snap.y26.chain)} in 2026` : '')).join('. ')}.`}>
      <g className="sf-vis-legend" transform="translate(0, 4)">
        {[
          { t: TIERS[3], text: 'Big', x: 0 },
          { t: TIERS[2], text: 'Mid-size', x: 72 },
          { t: TIERS[1], text: 'Mini', x: 166 },
        ].map((l) => (
          <g key={l.t.key} transform={`translate(${l.x}, 0)`}>
            <rect width="12" height="12" rx="2" fill={l.t.token} />
            <text x="18" y="10.5">
              {l.text}
            </text>
          </g>
        ))}
        <text x={VW} y="10.5" textAnchor="end" className="sf-vis-note">
          Chains as a share of all restaurants
        </text>
      </g>
      {[0, 0.1, 0.2].map((v) => (
        <g key={v}>
          <line x1={L} x2={VW} y1={y(v)} y2={y(v)} className="sf-vis-grid" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" className="sf-vis-tick">
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}
      {blocks.map((b, bi) => {
        if (!b) return null;
        const x0 = L + bi * (panelW + gap);
        const cx = [x0 + panelW * 0.27, x0 + panelW * 0.73];
        // From the rounded figures printed above the columns, so the change always matches what a reader subtracts
        const change = (Math.round(b.snap.y26.chain * 1000) - Math.round(b.snap.y22.chain * 1000)) / 10;
        return (
          <g key={b.n.id}>
            <text x={x0 + panelW / 2} y={52} textAnchor="middle" className="sf-vis-title">
              {b.n.name}
            </text>
            <text x={x0 + panelW / 2} y={74} textAnchor="middle" className={`sf-vis-delta${change < 0 ? ' is-down' : ''}`}>
              {change > 0 ? '+' : change < 0 ? '\u2212' : ''}
              {Math.abs(change).toFixed(1)} points
            </text>
            {[
              { label: '2022', v: b.snap.y22 },
              { label: '2026', v: b.snap.y26 },
            ].map((col, ci) => {
              let acc = 0;
              const x = cx[ci] - colW / 2;
              return (
                <g key={col.label} className="sf-vis-col" style={{ ['--i' as string]: bi * 2 + ci }} data-on={on ? '1' : '0'}>
                  {stack.map((t) => {
                    const v = col.v.shares[t.key];
                    const y0 = y(acc);
                    acc += v;
                    return <rect key={t.key} x={x} y={y(acc)} width={colW} height={Math.max(0, y0 - y(acc))} fill={t.token} />;
                  })}
                  <text x={cx[ci]} y={y(col.v.chain) - 8} textAnchor="middle" className="sf-vis-value">
                    {pts(col.v.chain)}
                  </text>
                  <text x={cx[ci]} y={VH - B + 22} textAnchor="middle" className="sf-vis-tick is-strong">
                    {col.label}
                  </text>
                  <text x={cx[ci]} y={VH - B + 40} textAnchor="middle" className="sf-vis-sub">
                    {num(col.v.n)} restaurants
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function SimilarityHistogram({ data, was, on }: { data: Data; was: number | null; on: boolean }) {
  const vals = useMemo(() => data.ranked.filter((n) => n.simOk && n.simScore !== null).map((n) => (n.simScore as number) * 100), [data]);
  const binW = 5;
  const topScore = Math.max(50, Math.ceil(Math.max(0, ...vals) / binW) * binW);
  const bins = useMemo(() => {
    const out = new Array(topScore / binW).fill(0) as number[];
    for (const v of vals) out[Math.min(out.length - 1, Math.floor(v / binW))]++;
    return out;
  }, [vals, topScore]);
  const L = 44;
  const R = 16;
  const T = 70;
  const B = 64;
  const plotW = VW - L - R;
  const plotH = VH - T - B;
  const maxCount = Math.max(1, ...bins);
  const sx = (v: number) => L + (v / topScore) * plotW;
  const h = (c: number) => (c / maxCount) * plotH;
  const median = data.city.medianSim * 100;
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`Histogram of similarity scores for ${vals.length} neighborhoods in 2026. The median is ${score(data.city.medianSim)} out of 100.`}>
      <text x={0} y={22} className="sf-vis-title">
        Neighborhoods by similarity score, 2026
      </text>
      <line x1={L} x2={VW - R} y1={T + plotH} y2={T + plotH} className="sf-vis-axis" />
      {bins.map((c, i) => (
        <rect key={i} x={sx(i * binW) + 1} y={T + plotH - h(c)} width={sx(binW) - sx(0) - 2} height={h(c)} className="sf-vis-bar sf-vis-bin" style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'}>
          <title>{`${i * binW} to ${i * binW + binW}: ${num(c)} neighborhoods`}</title>
        </rect>
      ))}
      {Array.from({ length: topScore / 10 + 1 }, (_, i) => i * 10).map((v) => (
        <text key={v} x={sx(v)} y={T + plotH + 20} textAnchor="middle" className="sf-vis-tick">
          {v}
        </text>
      ))}
      <text x={L + plotW / 2} y={VH - 10} textAnchor="middle" className="sf-vis-note">
        Similarity score, 0 to 100
      </text>
      <g className="sf-vis-median" data-on={on ? '1' : '0'}>
        <line x1={sx(median)} x2={sx(median)} y1={T - 38} y2={T + plotH} />
        <text x={sx(median) + 8} y={T - 22} className="sf-vis-value">
          Median {score(data.city.medianSim)}
        </text>
        {was !== null && (
          <text x={sx(median) + 8} y={T - 6} className="sf-vis-sub">
            {score(was)} in 2022
          </text>
        )}
      </g>
    </svg>
  );
}

function SourceTimeline({ on }: { on: boolean }) {
  const L = 40;
  const R = 40;
  const y = 190;
  const slot = (VW - L - R) / (YEARS.length - 1);
  return (
    <svg className="sf-vis-svg" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Timeline from 2019 to 2026. 2022 and 2026 are measured from inspection files. The years between are estimated.">
      <text x={0} y={22} className="sf-vis-title">
        Where the numbers come from
      </text>
      <line x1={L} x2={VW - R} y1={y} y2={y} className="sf-vis-axis" />
      {YEARS.map((year, i) => {
        const real = SNAPSHOT_YEARS.has(year);
        const x = L + i * slot;
        return (
          <g key={year} className="sf-vis-row" style={{ ['--i' as string]: i }} data-on={on ? '1' : '0'}>
            <circle cx={x} cy={y} r={real ? 11 : 7} className={real ? 'sf-vis-dot is-real' : 'sf-vis-dot'} />
            <text x={x} y={y + 38} textAnchor="middle" className={`sf-vis-tick${real ? ' is-strong' : ''}`}>
              {year}
            </text>
          </g>
        );
      })}
      <g transform={`translate(${L}, 290)`}>
        <circle cx="8" cy="0" r="8" className="sf-vis-dot is-real" />
        <text x="26" y="4" className="sf-vis-label is-left">
          Measured: a full inspection file (March 2022 and 2026)
        </text>
        <circle cx="8" cy="34" r="6" className="sf-vis-dot" />
        <text x="26" y="38" className="sf-vis-label is-left">
          Estimated: restaurants counted as open from their inspection dates
        </text>
      </g>
    </svg>
  );
}

/* ---------- The steps ---------- */

interface Step {
  id: string;
  title: string;
  body: ReactNode;
}

export function Story({ data, href, entering = false }: { data: Data | null; href: (p: Patch) => string; entering?: boolean }) {
  const { timeline } = useTimeline();
  const brands = useBrandChange();
  const y22 = useYearData(data as Data, data ? 2022 : null);
  const was = data && y22.status === 'ready' && y22.data !== data ? y22.data.city.medianSim : null;
  const [active, setActive] = useState(0);
  const pageRef = useRef<HTMLElement>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const [stageH, setStageH] = useState(0);

  const steps = useMemo<Step[]>(() => {
    if (!data) return [];
    const kpi = (id: string) => data.kpi.get(`nyc:${id}`);
    const pen = kpi('chain_penetration');
    const mini = kpi('mini_share');
    const mid = kpi('mid_share');
    const big = kpi('big_share');
    const bc = kpi('chain_brands');
    const topShare = kpi('top_brand_share');
    const top10 = kpi('top10_share');
    const ch = changeSummary(data);
    const biggest = data.brands[0]?.name;
    const pick = (key: string) => brands?.find((r) => r.key === key);
    const blank = pick('BLANK STREET');
    const seventh = pick('7TH STREET BURGER');
    // Boroughs by how much their chain share rose
    const bor = BOROS.map((key) => ({ key, label: boroLabel(key), k: data.kpi.get(`${key}:chain_penetration`) }))
      .filter((r): r is { key: string; label: string; k: NonNullable<typeof r.k> } => !!r.k)
      .map((r) => ({ ...r, was: r.k.v2022, now: r.k.v2026, gain: (r.k.v2026 - r.k.v2022) * 100 }));
    const byGain = [...bor].sort((a, b) => b.gain - a.gain);
    const byShare = [...bor].sort((a, b) => b.now - a.now);
    const allRose = bor.length > 0 && bor.every((r) => r.gain > 0);
    const split = boroughSplit(data).filter((r) => r.up + r.down > 0);
    const bySplit = [...split].sort((a, b) => b.up / (b.up + b.down) - a.up / (a.up + a.down));
    const both = split.length > 0 && split.every((r) => r.up > 0 && r.down > 0);
    // The chains that added the most locations, and how many of them are mid-size
    const topAdds = brands ? [...brands].sort((a, b) => b.now - b.was - (a.now - a.was)).slice(0, 8) : [];
    const midAdds = topAdds.filter((r) => r.tier === 'mid').length;
    const bestMid = topAdds.find((r) => r.tier !== 'big');
    const bestBig = topAdds.find((r) => r.tier === 'big');
    const word = (n: number) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][n] ?? String(n);
    // Williamsburg and SoHo, from the 2022 and 2026 files
    const close = CLOSE.map((c) => {
      const n = data.nbhds.find((x) => x.name === c.name && x.boro === c.boro);
      const snap = n ? snapOf(data, n.id) : null;
      return n && snap ? { n, ...snap } : null;
    });
    const [wb, so] = close;
    const smallChains = (c: Record<Tier, number>) => c.mini_chain + c.chain;
    // Names read differently at the start of a sentence, after "the", and after "in" or "on"
    const lead = (l: string) => (l === 'Bronx' ? 'The Bronx' : l);
    const mid2 = (l: string) => (l === 'Bronx' ? 'the Bronx' : l);
    const at = (l: string) => (l === 'Bronx' ? 'In the Bronx' : l === 'Staten Island' ? 'On Staten Island' : `In ${l}`);
    return [
      {
        id: 'question',
        title: 'Have the same restaurants been popping up around NYC?',
        body: (
          <>
            <p>Inspired by Infatuation NYC, “same-ification” is the phenomenon that neighborhoods are losing what sets them apart as the same businesses open everywhere. To break down the trends, this project maps every restaurant in the city's health inspection records to one of {num(data.nbhds.length)} neighborhoods.</p>
            <p>
               A restaurant with three or more locations in the five boroughs counts as a chain. The map shades each neighborhood by the share of its restaurants that are chains. Chains are further grouped by tier: mini chains have 3 to 9 locations, mid-size chains have 10 to 49, and big chains have 50 or more, allowing us to differentiate between well-established chains, think Dunkin or McDonald's, against smaller chains, such as Sweetgreen or Blank Street.
            </p>
          </>
        ),
      },
      {
        id: 'share',
        title: 'The chain share is increasing',
        body: (
          <>
            <p>
              According to official 2026 city inspection data, New York City boats over {num(data.city.restaurants)} restaurants. {pen ? pts(pen.v2026) : 'a share'} of these restaurants are chains. In March 2022, it was {pen ? pts(pen.v2022) : 'lower'}
              {pen ? `, so the share went up ${(pen.change * 100).toFixed(1)} points` : ''}.
            </p>
            {mini && mid && big && (
              <p>
                Smaller chains account for the increase. Mini chains (restaurants with 3 to 9 locations) went from {pts(mini.v2022)} to {pts(mini.v2026)} of all restaurants, and mid-size chains (10 to 49 locations) went from {pts(mid.v2022)} to {pts(mid.v2026)}. Big chains (50 or more locations) actually decreased from {pts(big.v2022)} to {pts(big.v2026)}.
              </p>
            )}
          </>
        ),
      },
      {
        id: 'boroughs',
        title: allRose ? 'Every borough went up, by different amounts' : 'The boroughs moved by different amounts',
        body: (
          <>
            <p>
              {allRose ? 'Chain share rose in all five boroughs between 2022 and 2026.' : 'Chain share changed in different ways across the boroughs between 2022 and 2026.'}
              {byGain.length > 2 ? ` ${lead(byGain[0].label)} and ${mid2(byGain[1].label)} gained the most, by ${byGain[0].gain.toFixed(1)} and ${byGain[1].gain.toFixed(1)} points, respectively. ${lead(byGain[byGain.length - 1].label)} gained the least, ${byGain[byGain.length - 1].gain.toFixed(1)} points.` : ''}
              {byShare.length > 1 ? ` ${lead(byShare[0].label)} is the most chain-heavy borough at ${pts(byShare[0].now)}, and ${mid2(byShare[byShare.length - 1].label)} the least chain-heavy at ${pts(byShare[byShare.length - 1].now)}.` : ''}
            </p>
          </>
        ),
      },
      {
        id: 'inside',
        title: 'Neighborhoods inside a borough do not move together',
        body: (
          <>
            <p>
              Despite the total borough count, between 2022 and 2026, chain share rose in {ch.up} of {ch.total} neighborhoods and fell in {ch.down}. The rest did not change.
            </p>
            {bySplit.length > 1 && (
              <p>
                {both ? 'Every borough has some of each. ' : ''}
                {at(bySplit[0].label)}, {bySplit[0].up} rose and {bySplit[0].down} fell. {at(bySplit[bySplit.length - 1].label)}, {bySplit[bySplit.length - 1].up} rose and {bySplit[bySplit.length - 1].down} fell.
              </p>
            )}
          </>
        ),
      },
      {
        id: 'brands',
        title: 'Growth is spread across chains',
        body: (
          <>
            <p>
              {biggest && topShare ? `${biggest} is still the largest chain, but its share of chain locations fell from ${pts(topShare.v2022)} to ${pts(topShare.v2026)}. ` : ''}
              {top10 ? `The ten biggest chains went from ${pts(top10.v2022)} to ${pts(top10.v2026)}. ` : ''}
              {bc ? `Over the years, the number of chain brands rose from ${num(bc.v2022)} to ${num(bc.v2026)}.` : ''}
            </p>
            {blank && seventh && (
              <p>
                This graph shows the chains with the most locations added. Drawing attention to smaller chains that have recently gained prominence, such as {blank.label}, which grew from {blank.was} to {blank.now} locations and also {seventh.label}, from {seventh.was} to {seventh.now}.
              </p>
            )}
            {midAdds > 0 && bestMid && bestBig && (
              <p>
                {word(midAdds)} of the {word(topAdds.length).toLowerCase()} chains that added the most locations are mid-size chains. Their gains are as much as the biggest chain's: {bestMid.label} added {bestMid.now - bestMid.was} locations and {bestBig.label} added {bestBig.now - bestBig.was}.
              </p>
            )}
          </>
        ),
      },
      {
        id: 'closeup',
        title: 'Let\'s zoom into influential neighborhoods',
        body: (
          <>
            {wb && so && (
              <>
                <p>
                  In 2022, {pts(wb.y22.chain)} of Williamsburg's restaurants were chains, and {pts(so.y22.chain)} of SoHo's. By 2026, Williamsburg was at {pts(wb.y26.chain)} and SoHo at {pts(so.y26.chain)}. Williamsburg added {wb.y26.n - wb.y22.n} restaurants and SoHo added {so.y26.n - so.y22.n}.
                </p>
                <p>
                  In Williamsburg, mini and mid-size chain restaurants went from {smallChains(wb.y22.counts)} to {smallChains(wb.y26.counts)}, while big chains went from {wb.y22.counts.big_chain} to {wb.y26.counts.big_chain}. SoHo's mini and mid-size chains went from {smallChains(so.y22.counts)} to {smallChains(so.y26.counts)}, and its independents from {so.y22.counts.independent} to {so.y26.counts.independent}.
                </p>
              </>
            )}
          </>
        ),
      },
      {
        id: 'alike',
        title: 'Similarity between neighborhoods',
        body: (
          <>
            <p>Chain share counts chains. It does not say whether two neighborhoods have the same ones. So each neighborhood also gets a similarity score from 0 to 100: the average of how closely its chain mix matches each other neighborhood's. A score of 100 means the neighborhoods are identical in their chain mix.</p>
            <p>
              The median score is {score(data.city.medianSim)} in 2026
              {was === null ? '.' : data.city.medianSim < was ? `. In 2022 it was ${score(was)}, so by this measure neighborhoods are slightly less alike than before, even though chain share went up.` : `, up from ${score(was)} in 2022.`} No neighborhood scores above {Math.round(Math.max(0, ...data.ranked.map((n) => (n.simScore ?? 0) * 100)))}.
            </p>
          </>
        ),
      },
      {
        id: 'conclusion',
        title: 'So, are neighborhoods truly losing their unique identities?',
        body: (
          <>
            <p>
               Although more of the city's restaurants are chains, the growth is spread across many smaller brands and is uneven from one neighborhood to the next, rather than one chain taking over. Do note the rise of chains such as Blank Street and 7th Street Burger, which are not the biggest chains but are growing quickly. Perhaps, not enough time has passed yet for the story to fully unfold.
              {was !== null ? ` Despite this, neighborhoods remain distinct from each other: the median similarity score is ${score(data.city.medianSim)}, ${data.city.medianSim < was ? `down from ${score(was)} in 2022` : `compared with ${score(was)} in 2022`}.` : ''} Chains are growing, but restaurants alone will not settle whether a neighborhood has lost its individuality.
            </p>
          </>
        ),
      },
      {
        id: 'limits',
        title: 'Limits of the data',
        body: (
          <>
            <p>The data comes from the city's restaurant inspection records. There are two snapshots, one from March 2022 and one from 2026. The years between are estimated from inspection dates. A restaurant that closed between the two files drops, and the year it closed is not known.</p>
            <p>A chain is a count of locations city-wide, not internationally. </p>
            <p className="sf-story-actions">
              <StateLink to={href({ v: 'map' })} className="sf-btn is-primary is-large">
                Explore the Map
              </StateLink>
              <StateLink to={href({ v: 'method' })} className="sf-btn is-large">
                Methodology
              </StateLink>
            </p>
          </>
        ),
      },
    ];
  }, [data, brands, was, href]);

  // The step crossing the middle of the page is the current one
  useEffect(() => {
    const root = pageRef.current;
    if (!root || !steps.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
      },
      { root, rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    stepRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  // The picture is as tall as the page's visible area, so it can stay in place while the text moves
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const ro = new ResizeObserver(([e]) => setStageH(Math.round(e.contentRect.height)));
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const go = (i: number) => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    stepRefs.current[i]?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <main ref={pageRef} className={`sf-page sf-story${entering ? ' is-entering' : ''}`} style={stageH ? ({ ['--stage-h' as string]: `${stageH}px` } as React.CSSProperties) : undefined}>
      <div className="sf-story-grid">
        <div className="sf-story-text">
          <header className="sf-story-intro">
            <p className="sf-landing-sub">Mapping the Same-ification of NYC, From Blank Street to 7th Street</p>
            <h1>Findings</h1>
          </header>
          {steps.length === 0 ? (
            <p className="sf-story-wait" aria-hidden="true">
              <span className="sf-skel" style={{ width: '100%', height: 18 }} />
              <span className="sf-skel" style={{ width: '80%', height: 18 }} />
            </p>
          ) : (
            steps.map((s, i) => (
              <section key={s.id} ref={(el) => {
                  stepRefs.current[i] = el;
                }} data-step={i} className={`sf-step${active === i ? ' is-active' : ''}`} aria-labelledby={`sf-step-${s.id}`}>
                <h2 id={`sf-step-${s.id}`}>{s.title}</h2>
                {s.body}
              </section>
            ))
          )}
        </div>
        <div className="sf-story-stage">
          {data && (
            <>
              {steps.map((st, i) => {
                const on = active === i;
                const pic =
                  st.id === 'question' ? (
                    <ChainMap data={data} />
                  ) : st.id === 'share' ? (
                    <ShareByYear data={data} timeline={timeline} on={on} />
                  ) : st.id === 'boroughs' ? (
                    <BoroughShare data={data} on={on} />
                  ) : st.id === 'inside' ? (
                    <BoroughSplit data={data} on={on} />
                  ) : st.id === 'brands' ? (
                    <BrandGrowth rows={brands} on={on} />
                  ) : st.id === 'closeup' ? (
                    <CloseUps data={data} on={on} />
                  ) : st.id === 'alike' ? (
                    <SimilarityHistogram data={data} was={was} on={on} />
                  ) : st.id === 'conclusion' ? (
                    <ChainMap data={data} />
                  ) : (
                    <SourceTimeline on={on} />
                  );
                return (
                  <div key={st.id} className="sf-vis" data-on={on ? '1' : '0'} aria-hidden={!on}>
                    {pic}
                  </div>
                );
              })}
            </>
          )}
          {steps.length > 0 && (
            <ol className="sf-story-dots" aria-label="Steps">
              {steps.map((s, i) => (
                <li key={s.id}>
                  <button type="button" aria-current={active === i ? 'step' : undefined} aria-label={`Step ${i + 1}: ${s.title}`} onClick={() => go(i)} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </main>
  );
}
