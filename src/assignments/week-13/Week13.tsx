// Same-ification NYC: root component, top bar, and the map explorer.
// Rebuilt from an earlier Week 13 prototype, which this app replaced. See README.md, PLAN.md and NOTES.md in this folder.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './tokens.css';
import './app.css';
import {
  LATEST_YEAR,
  MIN_CHAIN_RESTAURANTS,
  YEARS,
  classOf,
  makeBreaks,
  modeValue,
  useData,
  useYearData,
  withSimKind,
  yearKind,
} from './data';
import type { Bounds, Brand, Data, Mode, Nbhd, SimKind } from './data';
import { ChangePlot, LENSES, MakeupPlot, TierGrid } from './lenses';
import type { Lens } from './lenses';
import { MapView } from './MapView';
import type { Pad } from './MapView';
import { Landing, Methodology } from './pages';
import { Icon, StateLink, useMedia, useUrl } from './ui';
import type { Patch } from './ui';
import {
  KpiSkeleton,
  KpiStrip,
  Legend,
  YearControl,
  ModeSwitch,
  PanelContent,
  PanelSkeleton,
  Search,
  modeMeta,
  panelTitle,
} from './views';
import type { Actions, Ctx } from './views';

const MODES: Mode[] = ['share', 'mini', 'mid', 'big', 'sim'];
type Sheet = 'peek' | 'half' | 'full';
// Playing used to hold each year for 1500ms after it had finished loading. It is now 1.5x faster. Loading a year takes time too, and
// it counts toward the step, so the whole step (loading plus the hold) is the old step divided by 1.5, on any machine.
const PLAY_HOLD_MS = 1500;
const PLAY_SPEEDUP = 1.5;

function Explorer({
  data: base,
  searchRef,
  entering = false,
}: {
  data: Data;
  searchRef: React.RefObject<HTMLInputElement | null>;
  entering?: boolean; // arriving from the home page: the map and panels slide into place
}) {
  const { sp, set } = useUrl();
  // ---- Year: every view reads the same data set, recounted for the chosen year ----
  const yRaw = Number(sp.get('y'));
  const year = YEARS.includes(yRaw) && yRaw !== LATEST_YEAR ? yRaw : null;
  const { data: yearData, status: yearStatus } = useYearData(base, year);
  // 2022 figures for the "since 2022" lines under similarity and ranked neighborhoods. They come from the same year-by-year
  // estimate as the slider, which is a large file, so they are asked for a moment after the page has settled.
  const [wantPrev, setWantPrev] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWantPrev(true), 1200);
    return () => window.clearTimeout(t);
  }, []);
  const prevYear = useYearData(base, wantPrev ? 2022 : null);
  // ---- Similarity measure: location counts (default) or present or absent ----
  const simKind: SimKind = sp.get('sk') === 'set' ? 'set' : 'mix';
  const data = useMemo(() => withSimKind(yearData, simKind), [yearData, simKind]);
  const prevReady = wantPrev && prevYear.status === 'ready' && prevYear.data !== base ? prevYear.data : null;
  const prev = useMemo(() => (prevReady ? withSimKind(prevReady, simKind) : null), [prevReady, simKind]);
  const shownYear = year ?? LATEST_YEAR;
  const [playing, setPlaying] = useState(false);
  const setYear = useCallback(
    (y: number) => set({ y: y === LATEST_YEAR ? null : String(y) }, true),
    [set],
  );
  const shownAt = useRef(0); // when the year on screen last changed
  useEffect(() => {
    shownAt.current = performance.now();
  }, [shownYear]);
  useEffect(() => {
    if (!playing) return;
    if (shownYear === LATEST_YEAR) return setPlaying(false);
    if (yearStatus !== 'ready') return; // wait for the year on screen before stepping on
    const loading = performance.now() - shownAt.current; // how long this year took to load
    const hold = Math.max(0, (PLAY_HOLD_MS + loading) / PLAY_SPEEDUP - loading);
    const t = window.setTimeout(() => setYear(shownYear + 1), hold);
    return () => window.clearTimeout(t);
  }, [playing, shownYear, yearStatus, setYear]);
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (shownYear === LATEST_YEAR) setYear(YEARS[0]);
    setPlaying(true);
  };
  const mobile = useMedia('(max-width: 760px)');
  const [hoverId, setHover] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheet, setSheet] = useState<Sheet>('peek');
  const [preview, setPreview] = useState<number | null>(null);
  const [zoomTo, setZoomTo] = useState<string | null>(null); // neighborhood picked while a brand search is on
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(600);
  useEffect(() => {
    if (!stageRef.current) return;
    const ro = new ResizeObserver(([e]) => setStageH(Math.round(e.contentRect.height)));
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, []);

  // ---- State read from the URL ----
  const sel = data.byId.get(sp.get('n') ?? '') ?? null;
  const cmpRaw = sel ? (data.byId.get(sp.get('c') ?? '') ?? null) : null;
  const cmp = cmpRaw && cmpRaw.id !== sel?.id ? cmpRaw : null;
  const picking = !!sel && !cmp && sp.get('cmp') === '1';
  // A third neighborhood joins only once two are chosen. Its color is the third accent.
  const thirdRaw = sel && cmp ? (data.byId.get(sp.get('d') ?? '') ?? null) : null;
  const third = thirdRaw && thirdRaw.id !== sel?.id && thirdRaw.id !== cmp?.id ? thirdRaw : null;
  const pickingThird = !!sel && !!cmp && !third && sp.get('cmp') === '2';
  const q = sp.get('q') ?? '';
  const brands = useMemo(
    () =>
      q
        .split('|')
        .map((name) => data.brandByName.get(name))
        .filter((b): b is Brand => !!b)
        .slice(0, 3), // up to three restaurants, in the three accents
    [q, data],
  );
  const boro = !sel ? (data.boroByKey.get(sp.get('boro') ?? '') ?? null) : null;
  const m = sp.get('m') as Mode;
  const mode: Mode = MODES.includes(m) ? m : 'share';
  const lensRaw = sp.get('lens');
  const lens: Lens | null =
    lensRaw === 'tiers' || lensRaw === 'makeup' || lensRaw === 'change' ? lensRaw : null;
  const f = sp.get('f') ?? '';
  const filter = useMemo(
    () =>
      new Set(
        f
          .split(',')
          .filter(Boolean)
          .map(Number)
          .filter((x) => x >= 0 && x < 5),
      ),
    [f],
  );

  // ---- What colors the map ----
  // The bands are cut from 2026, whatever year is showing, so a color means the same thing in every year and the map can be
  // compared across them. (Cut from each year's own spread, they would always put a fifth of neighborhoods in each band.)
  const { values, breaks, classes } = useMemo(() => {
    const values = new Map<string, number>();
    for (const n of data.ranked) {
      const v = modeValue(data, n, mode, sel);
      if (v !== null) values.set(n.id, v);
    }
    const ref = data.latest ? withSimKind(data.latest, simKind) : data;
    const refSel = sel ? (ref.byId.get(sel.id) ?? null) : null;
    const refValues: number[] = [];
    for (const n of ref.ranked) {
      const v = modeValue(ref, n, mode, refSel);
      if (v !== null) refValues.push(v);
    }
    const breaks = makeBreaks(refValues);
    const classes = new Map<string, number>();
    for (const [id, v] of values) classes.set(id, classOf(v, breaks));
    return { values, breaks, classes };
  }, [data, mode, sel, simKind]);

  // ---- Actions ----
  const act = useMemo<Actions>(
    () => ({
      select: (id) => {
        setHover(null);
        if (brands.length) {
          // With restaurants on the map a click picks the neighborhood and keeps the restaurants.
          // A click on a neighborhood that is already picked puts it back, as it does without restaurants.
          if (id === sel?.id) {
            setZoomTo(null);
            set(
              cmp
                ? { n: cmp.id, c: third?.id ?? null, d: null, cmp: null, tab: null }
                : { n: null, c: null, d: null, cmp: null, tab: null },
            );
          } else if (id === cmp?.id) {
            setZoomTo(null);
            set({ c: third?.id ?? null, d: null, cmp: null, tab: null });
          } else if (id === third?.id) {
            setZoomTo(null);
            set({ d: null, cmp: null, tab: null });
          } else {
            setZoomTo(id);
            set({ n: id, boro: null });
          }
        } else if (pickingThird) {
          if (id !== sel?.id && id !== cmp?.id) set({ d: id, cmp: null, tab: null });
        } else if (third) {
          // three are on screen: another pick replaces the last one
          if (id !== sel?.id && id !== cmp?.id) set({ d: id, tab: null });
        } else if (picking || cmp) {
          if (id !== sel?.id) set({ c: id, cmp: null, tab: null });
        } else if (id === sel?.id) set({ n: null, c: null, d: null, cmp: null, tab: null });
        else
          set({
            n: id,
            c: null,
            d: null,
            cmp: null,
            boro: null,
            tab: sp.get('tab') === 'similar' ? 'similar' : null,
          });
      },
      // Removing one promotes the ones after it, so A, B and C always fill from the front
      deselectA: () =>
        set(
          cmp
            ? { n: cmp.id, c: third?.id ?? null, d: null, cmp: null, tab: null }
            : { n: null, c: null, d: null, cmp: null, tab: null },
        ),
      deselectB: () => set({ c: third?.id ?? null, d: null, cmp: null, tab: null }),
      deselectC: () => set({ d: null, cmp: null, tab: null }),
      startCompare: () => set({ cmp: '1', c: null, d: null, tab: null }),
      startThird: () => set({ cmp: '2', d: null, tab: null }),
      cancelCompare: () => set({ cmp: null }),
      compareWith: (id) =>
        sel &&
        id !== sel.id &&
        set({ c: id, d: third && third.id !== id ? third.id : null, cmp: null, tab: null }),
      swap: () => sel && cmp && set({ n: cmp.id, c: sel.id }),
      setMode: (next) => set({ m: next === 'share' ? null : next, f: null }),
      setSimKind: (k) => set({ sk: k === 'mix' ? null : k, f: null }, true),
      addBrand: (name) => {
        setZoomTo(null);
        const names = brands.map((b) => b.name).filter((x) => x !== name);
        set({ q: [...names.slice(-2), name].join('|') }); // a fourth replaces the oldest
      },
      removeBrand: (name) => {
        setZoomTo(null);
        set({
          q:
            brands
              .map((b) => b.name)
              .filter((x) => x !== name)
              .join('|') || null,
        });
      },
      clearBrands: () => {
        setZoomTo(null);
        set({ q: null });
      },
      setBoro: (key) => set({ boro: key, n: null, c: null, d: null, cmp: null }),
      setTab: (t) => {
        set({ tab: t === 'overview' || t === 'tiers' ? null : t }, true);
        if (t === 'similar' && sel && sel.simOk) set({ m: 'sim', f: null }, true);
      },
      focusSearch: () => searchRef.current?.focus(),
      setYear: (y) => {
        setPlaying(false);
        setYear(y);
      },
    }),
    [brands, picking, pickingThird, cmp, third, sel, set, sp, searchRef, setYear],
  );

  const ctx: Ctx = {
    data,
    mode,
    simKind,
    sel,
    cmp,
    third,
    picking,
    pickingThird,
    prev: shownYear === LATEST_YEAR ? prev : null,
    brands,
    boro,
    values,
    breaks,
    classes,
    hoverId,
    setHover,
    tab: sp.get('tab'),
    year: shownYear,
    act,
  };
  const meta = modeMeta(mode, sel, simKind);
  const describe = useCallback(
    (n: Nbhd) =>
      values.has(n.id)
        ? `${meta.fmt(values.get(n.id)!)} ${meta.noun}`
        : n.id === sel?.id && meta.simTo
          ? 'The neighborhood being compared'
          : !n.eligible
            ? 'Too few restaurants to rank'
            : meta.isSim && !n.simOk
              ? `Under ${MIN_CHAIN_RESTAURANTS} chain restaurants, too few to compare`
              : 'No value in this mode',
    [values, meta, sel],
  );

  // ---- Where the map looks ----
  // A neighborhood chosen while restaurants are on the map, whether from the map, a list or the search box, is where the map zooms
  const prevSelId = useRef(sel?.id ?? null);
  useEffect(() => {
    const was = prevSelId.current;
    prevSelId.current = sel?.id ?? null;
    if (sel && sel.id !== was && brands.length) setZoomTo(sel.id);
  }, [sel, brands.length]);

  const focus = useMemo<{ key: string; bounds: Bounds }>(() => {
    const union = (list: Bounds[]): Bounds => [
      [Math.min(...list.map((b) => b[0][0])), Math.min(...list.map((b) => b[0][1]))],
      [Math.max(...list.map((b) => b[1][0])), Math.max(...list.map((b) => b[1][1]))],
    ];
    if (brands.length) {
      const z = zoomTo ? data.byId.get(zoomTo) : null;
      if (z) return { key: `qz:${z.id}`, bounds: z.bounds };
      const pts = brands.flatMap((b) => b.places);
      return {
        key: `q:${q}`,
        bounds: pts.length
          ? union(
              pts.map(
                (p) =>
                  [
                    [p.x, p.y],
                    [p.x, p.y],
                  ] as Bounds,
              ),
            )
          : data.bounds,
      };
    }
    if (picking || pickingThird) return { key: 'pick', bounds: data.bounds };
    if (sel && cmp) {
      const all = [sel, cmp, ...(third ? [third] : [])];
      return { key: `c:${all.map((n) => n.id).join(':')}`, bounds: union(all.map((n) => n.bounds)) };
    }
    if (sel) return { key: `n:${sel.id}`, bounds: sel.bounds };
    if (boro) return { key: `b:${boro.key}`, bounds: boro.bounds };
    return { key: 'city', bounds: data.bounds };
  }, [brands, zoomTo, q, picking, pickingThird, sel, cmp, third, boro, data]);

  // The row for the chips is always there (it always holds the year button), so adding or removing a filter never moves or rescales the view
  const pad: Pad = mobile
    ? {
        top: 152,
        left: 12,
        right: 12,
        bottom: sheet === 'peek' ? 192 : Math.round(stageH * 0.52) + 104,
      }
    : { top: 64, left: 304, right: panelOpen ? 424 : 20, bottom: 20 };

  // On a phone, open the sheet when something is selected and get out of the way while picking
  const selKey = `${sel?.id ?? ''}|${cmp?.id ?? ''}|${third?.id ?? ''}|${q}`;
  const firstSel = useRef(true);
  useEffect(() => {
    if (firstSel.current) {
      firstSel.current = false;
      if (selKey !== '|||') setSheet('half');
      return;
    }
    setSheet(selKey === '|||' || picking || pickingThird ? 'peek' : 'half');
  }, [selKey, picking, pickingThird]);

  // Escape steps back one level at a time
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    let done = true;
    if (brands.length) act.clearBrands();
    else if (picking || pickingThird) act.cancelCompare();
    else if (third) act.deselectC();
    else if (cmp) act.deselectB();
    else if (sel) act.deselectA();
    else if (boro) act.setBoro(null);
    else if (filter.size) set({ f: null });
    else if (lens) set({ lens: null });
    else done = false;
    if (done) e.stopPropagation(); // keep the course shell's own Escape shortcut from firing too
  };

  const drag = useRef<number | null>(null);
  const order: Sheet[] = ['peek', 'half', 'full'];
  const stepSheet = (d: number) =>
    setSheet((s) => order[Math.max(0, Math.min(2, order.indexOf(s) + d))]);
  const title = panelTitle(ctx);
  const activeClasses = preview !== null ? new Set([preview]) : filter.size ? filter : null;

  // The chip row. On the map it floats over the top of the stage; in the scrolling views it is the first row of the content and scrolls with it.
  const chips = (
    <div className={`sf-chips${lens ? ' is-inline' : ''}`} aria-label="Current selection">
      {(picking || pickingThird) && sel ? (
        <p className="sf-banner" role="status">
          {pickingThird ? 'Pick a third neighborhood to compare with' : 'Pick a second neighborhood to compare with'}{' '}
          <b>{pickingThird && cmp ? `${sel.name} and ${cmp.name}` : sel.name}</b>
          <button type="button" className="sf-btn" onClick={act.cancelCompare}>
            Cancel
          </button>
        </p>
      ) : (
        <ul>
          {/* Always present and never removable: it states the year every view shows. 2026 is the default. It only states
              the year; the slider above is what changes it, so clicking this does nothing. */}
          <li>
            <button
              type="button"
              className="sf-chipbtn is-year is-fixed"
              aria-label={year === null ? `Showing the ${LATEST_YEAR} snapshot` : `Showing ${year}, ${yearKind(year)}`}
              aria-disabled="true"
            >
              {year === null ? `${LATEST_YEAR} snapshot` : `${year} ${yearKind(year)}`}
            </button>
          </li>
          {/* The scope chip: the whole city until a borough or neighborhood is picked, then that place takes its spot */}
          {!boro && !sel && (
            <li>
              <button
                type="button"
                className="sf-chipbtn is-fixed"
                aria-label="Showing all of New York City"
                aria-disabled="true"
              >
                All of NYC
              </button>
            </li>
          )}
          {boro && (
            <li>
              <button
                type="button"
                className="sf-chipbtn"
                onClick={() => act.setBoro(null)}
                aria-label={`Leave ${boro.label} and show the whole city`}
              >
                {boro.label} <Icon name="x" size={14} />
              </button>
            </li>
          )}
          {sel && (
            <li>
              <button
                type="button"
                className="sf-chipbtn is-a"
                onClick={act.deselectA}
                aria-label={`Deselect ${sel.name}`}
              >
                {cmp && <span className="sf-tag t0">A</span>}
                {sel.name} <Icon name="x" size={14} />
              </button>
            </li>
          )}
          {cmp && (
            <li>
              <button
                type="button"
                className="sf-chipbtn is-b"
                onClick={act.deselectB}
                aria-label={`Deselect ${cmp.name}`}
              >
                <span className="sf-tag t1">B</span>
                {cmp.name} <Icon name="x" size={14} />
              </button>
            </li>
          )}
          {third && (
            <li>
              <button
                type="button"
                className="sf-chipbtn is-c"
                onClick={act.deselectC}
                aria-label={`Deselect ${third.name}`}
              >
                <span className="sf-tag t2">C</span>
                {third.name} <Icon name="x" size={14} />
              </button>
            </li>
          )}
          {brands.map((b, i) => (
            <li key={b.name}>
              <button
                type="button"
                className="sf-chipbtn"
                onClick={() => act.removeBrand(b.name)}
                aria-label={`Remove ${b.name} from the map`}
              >
                <i className={`sf-dotkey s${i}`} aria-hidden="true" />
                {b.name} <Icon name="x" size={14} />
              </button>
            </li>
          ))}
          {filter.size > 0 && (
            <li>
              <button
                type="button"
                className="sf-chipbtn"
                onClick={() => set({ f: null }, true)}
                aria-label="Remove the legend filter"
              >
                {filter.size} of 5 bands <Icon name="x" size={14} />
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );

  return (
    <main className={`sf-explorer${entering ? ' is-entering' : ''}`} onKeyDown={onKeyDown}>
      <KpiStrip
        ctx={ctx}
        yearControl={
          <YearControl
            year={shownYear}
            status={yearStatus}
            playing={playing}
            onYear={act.setYear}
            onPlay={togglePlay}
          />
        }
      />
      <div
        className={`sf-stage${panelOpen ? '' : ' is-wide'}${lens ? ` is-lens lens-${lens}` : ''} sheet-${sheet}`}
        ref={stageRef}
      >
        <div className="sf-controls">
          <div className="sf-views">
            <span className="sf-ctl-label">View</span>
            <div className="sf-seg" role="group" aria-label="View">
              {LENSES.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  aria-pressed={(lens ?? 'map') === l.key}
                  onClick={() => set({ lens: l.key === 'map' ? null : l.key })}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          {lens !== 'tiers' && (
            <ModeSwitch
              mode={mode}
              onChange={act.setMode}
              simKind={simKind}
              onSimKind={act.setSimKind}
            />
          )}
          {lens !== 'tiers' && (
            <Legend
              ctx={ctx}
              filter={filter}
              onFilter={(next) => set({ f: [...next].sort().join(',') || null }, true)}
              onPreview={setPreview}
            />
          )}
        </div>
        {lens ? (
          <section
            className="sf-lens"
            aria-label={LENSES.find((l) => l.key === lens)?.label}
            style={{
              paddingTop: mobile ? 106 : 16,
              paddingRight: pad.right - (mobile ? 0 : 4),
              paddingBottom: mobile ? 72 : 16,
              paddingLeft: pad.left,
            }}
          >
            {chips}
            {lens === 'tiers' && (
              <TierGrid
                ctx={ctx}
                onOpen={(next) => set({ lens: null, m: next === 'share' ? null : next, f: null })}
              />
            )}
            {lens === 'makeup' && <MakeupPlot ctx={ctx} active={activeClasses} />}
            {lens === 'change' && <ChangePlot ctx={ctx} active={activeClasses} />}
          </section>
        ) : (
          <MapView
            data={data}
            classes={classes}
            activeClasses={activeClasses}
            describe={describe}
            selId={sel?.id ?? null}
            cmpId={cmp?.id ?? null}
            thirdId={third?.id ?? null}
            hoverId={hoverId}
            onHover={setHover}
            onSelect={act.select}
            brands={brands}
            focusKey={focus.key}
            focusBounds={focus.bounds}
            pad={pad}
            roomy={!mobile}
            focusBoro={boro?.key ?? null}
            onBoro={(key) => act.setBoro(boro?.key === key ? null : key)}
          />
        )}
        {!lens && chips}
        <aside
          className={`sf-panel${panelOpen ? '' : ' is-closed'}`}
          aria-label={`Details: ${title}`}
        >
          <button
            type="button"
            className="sf-panel-toggle"
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            aria-label={panelOpen ? 'Collapse the details panel' : 'Open the details panel'}
            title={panelOpen ? 'Collapse panel' : 'Open panel'}
          >
            <Icon name="chevron" size={16} />
          </button>
          <button
            type="button"
            className="sf-sheet-handle"
            aria-expanded={sheet !== 'peek'}
            aria-label={
              sheet === 'full' ? `Lower the details for ${title}` : `Raise the details for ${title}`
            }
            onPointerDown={(e) => (drag.current = e.clientY)}
            onPointerUp={(e) => {
              const dy = drag.current === null ? 0 : e.clientY - drag.current;
              drag.current = null;
              if (dy < -30) stepSheet(1);
              else if (dy > 30) stepSheet(-1);
              else setSheet((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSheet((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'));
              }
            }}
          >
            <i aria-hidden="true" />
            <span>{title}</span>
            <span className="sf-sheet-hint">
              {sheet === 'peek' ? 'Show details' : sheet === 'half' ? 'Expand' : 'Show map'}
            </span>
          </button>
          <div className="sf-panel-inner" inert={mobile ? false : !panelOpen}>
            <PanelContent ctx={ctx} />
          </div>
        </aside>
        <p className="sf-sr" role="status" aria-live="polite">
          Showing {title}
        </p>
      </div>
    </main>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="sf-explorer" aria-busy="true">
      <KpiSkeleton />
      <div className="sf-stage">
        <div className="sf-map is-loading">
          <p className="sf-loading-note" role="status">
            Loading the map and 30,000 restaurants
          </p>
        </div>
        <aside className="sf-panel" aria-hidden="true">
          <div className="sf-panel-inner">
            <PanelSkeleton />
          </div>
        </aside>
      </div>
    </div>
  );
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="sf-page">
      <div className="sf-error" role="alert">
        <h1>The data did not load</h1>
        <p>{message}</p>
        <p>
          The app reads its data files from this site. If you are offline they cannot be fetched.
        </p>
        <button type="button" className="sf-btn is-primary is-large" onClick={retry}>
          Try again
        </button>
      </div>
    </main>
  );
}

// The section links, with one underline that slides to whichever page is open. It moves with transform only:
// its position and width are measured from the active link and handed to CSS as two variables.
function SectionNav({ view, href }: { view: string; href: (p: Patch) => string }) {
  const navRef = useRef<HTMLElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const ind = indRef.current;
    if (!nav || !ind) return;
    const place = (jump: boolean) => {
      const a = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!a) {
        ind.dataset.on = '0';
        shown.current = false;
        return;
      }
      // From hidden, or after a resize, the underline appears in place instead of travelling from where it was
      const still = jump || !shown.current;
      if (still) ind.style.transition = 'none';
      // Exact fractions, not the rounded offsetLeft and offsetWidth, so the line matches the tab at any zoom or window size
      const ar = a.getBoundingClientRect();
      const nr = nav.getBoundingClientRect();
      const px = nav.offsetWidth ? nr.width / nav.offsetWidth : 1; // on-screen pixels per layout pixel (not 1 under the CSS zoom)
      ind.style.setProperty('--x', `${(ar.left - nr.left) / px}px`);
      ind.style.setProperty('--w', String(ar.width / px / 100));
      if (still) {
        void ind.offsetWidth;
        ind.style.transition = '';
      }
      ind.dataset.on = '1';
      shown.current = true;
    };
    place(false);
    const ro = new ResizeObserver(() => place(true));
    ro.observe(nav);
    return () => ro.disconnect();
  }, [view]);
  return (
    <nav aria-label="Sections" ref={navRef}>
      <StateLink to={href({ v: 'map' })} aria-current={view === 'map' ? 'page' : undefined}>
        Map
      </StateLink>
      <StateLink to={href({ v: 'method' })} aria-current={view === 'method' ? 'page' : undefined}>
        Methodology
      </StateLink>
      <span className="sf-nav-ind" ref={indRef} data-on="0" aria-hidden="true" />
    </nav>
  );
}

function SameificationApp() {
  const [state, retry] = useData();
  const { sp, set, href } = useUrl();
  const v = sp.get('v');
  const view = v === 'map' || v === 'method' ? v : 'home';
  const searchRef = useRef<HTMLInputElement>(null);
  const data = state.status === 'ready' ? state.data : null;
  // Moving between pages is one scene, not a cut. The page being left stays mounted for the length of the move, then goes.
  // The state is set during render so the first painted frame of the arriving page is already the start of its entrance.
  const [lastView, setLastView] = useState(view);
  const [move, setMove] = useState<{ from: string; to: string } | null>(null);
  if (view !== lastView) {
    setLastView(view);
    setMove({ from: lastView, to: view });
  }
  useEffect(() => {
    if (!move) return;
    const t = window.setTimeout(() => setMove(null), 700);
    return () => window.clearTimeout(t);
  }, [move]);
  const toMap = move?.to === 'map'; // the explorer arrives: map and panels slide into place
  const homeLeaving = move?.from === 'home';
  const methodLeaving = move?.from === 'method';
  const showHome = (view === 'home' && state.status !== 'error') || homeLeaving;
  const showMethod = view === 'method' || methodLeaving;
  useEffect(() => {
    const names: Record<string, string> = {
      home: 'Same-ification NYC',
      map: 'Map · Same-ification NYC',
      method: 'Methodology · Same-ification NYC',
    };
    const before = document.title;
    document.title = names[view];
    return () => {
      document.title = before;
    };
  }, [view]);

  return (
    <div className="sf">
      <a className="sf-skip" href="#sf-main">
        Skip to content
      </a>
      <header className="sf-top">
        <StateLink to={href({})} className="sf-brand" aria-label="Same-ification NYC, home">
          Same-ification <span>NYC</span>
        </StateLink>
        <SectionNav view={view} href={href} />
        {view === 'map' && (
          <div className={`sf-top-tools${toMap ? ' is-entering' : ''}`}>
            <Search
              data={data}
              inputRef={searchRef}
              onNbhd={(id) => {
                // With restaurants on the map, a searched neighborhood is picked the way a click on the map picks it:
                // the restaurants stay and the map zooms to the neighborhood
                if ((sp.get('q') ?? '').split('|').some(Boolean)) {
                  set({ n: id, boro: null });
                  return;
                }
                // While comparing, a searched neighborhood becomes the second one instead of replacing the first
                const first = sp.get('n');
                const comparing = first && (sp.get('cmp') || sp.get('c'));
                if (first && first !== id && comparing) {
                  if (id === sp.get('c') || id === sp.get('d')) set({ cmp: null, q: null, tab: null });
                  else if (sp.get('cmp') === '2' || sp.get('d')) set({ d: id, cmp: null, q: null, tab: null });
                  else set({ c: id, cmp: null, q: null, tab: null });
                } else set({ n: id, c: null, d: null, cmp: null, boro: null, q: null, tab: null });
              }}
              onBrand={(name) => {
                const now = (sp.get('q') ?? '').split('|').filter((x) => x && x !== name);
                set({ q: [...now.slice(-2), name].join('|') });
              }}
            />
          </div>
        )}
      </header>
      <div id="sf-main" className="sf-main">
        {showHome && (
          <div
            className={homeLeaving ? `sf-leaving${move?.to === 'map' ? '' : ' is-quick'}` : 'sf-home'}
            aria-hidden={homeLeaving || undefined}
            inert={homeLeaving}
          >
            <Landing data={data} href={href} />
          </div>
        )}
        {showMethod && (
          <div
            className={methodLeaving ? 'sf-leaving is-quick' : 'sf-home'}
            aria-hidden={methodLeaving || undefined}
            inert={methodLeaving}
          >
            <Methodology data={data} mapHref={href({ v: 'map' })} entering={move?.to === 'method'} />
          </div>
        )}
        {view === 'method' ? null : state.status === 'error' ? (
          <ErrorState message={state.message} retry={retry} />
        ) : view === 'map' ? (
          data ? (
            <Explorer data={data} searchRef={searchRef} entering={toMap} />
          ) : (
            <ExplorerSkeleton />
          )
        ) : null}
      </div>
    </div>
  );
}

export const Week13 = SameificationApp;
