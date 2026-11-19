// The Restaurants tab: every restaurant on record in a neighborhood, a borough or the whole city, as a table. The Name header sorts it, the cuisine
// filter narrows it, and a click on a row highlights that restaurant among the dots the map draws for the neighborhood.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { num } from './data';
import { Icon } from './ui';
import type { Data, Place, Tier } from './data';

interface Row {
  place: Place;
  tier: Tier;
}
// What the list covers: one neighborhood, one borough, or (with neither) the whole city
export interface Scope {
  name: string;
  nbhdId?: string;
  boro?: string;
}
const PAGE = 200; // rows drawn at a time. A borough has thousands, and the whole city thirty thousand.
// The Chain column: what size of chain the restaurant belongs to, or Independent
const CHAIN: Record<Tier, string> = { independent: 'Independent', mini_chain: 'Mini', chain: 'Mid-size', big_chain: 'Big' };
const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
// Chain sorts by size: independents first, then mini, mid-size and big chains
const TIER_RANK: Record<Tier, number> = { independent: 0, mini_chain: 1, chain: 2, big_chain: 3 };
type SortKey = 'name' | 'cuisine' | 'hood' | 'chain';

export function RestaurantList({ data, scope, pin, onPin, onList }: { data: Data; scope: Scope; pin: Place | null; onPin: (p: Place | null) => void; onList: (list: Place[]) => void }) {
  const cuisineId = useId();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false }); // starts A to Z by name
  const [cuisine, setCuisine] = useState('');
  const [find, setFind] = useState(''); // a search of the names in this list
  const [open, setOpen] = useState(false); // the search box is a magnifier until it is opened
  const findRef = useRef<HTMLInputElement>(null);

  // Every restaurant is a place of some brand, independents included, so the neighborhood's list is the places that fall inside it
  const all = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    for (const b of data.brands) {
      if (scope.nbhdId && !b.nbhds.has(scope.nbhdId)) continue;
      if (scope.boro && !b.boros[scope.boro]) continue;
      for (const p of b.places) {
        if (scope.nbhdId && p.nbhd !== scope.nbhdId) continue;
        if (scope.boro && data.byId.get(p.nbhd)?.boro !== scope.boro) continue;
        rows.push({ place: p, tier: b.tier });
      }
    }
    return rows;
  }, [data, scope.nbhdId, scope.boro]);
  const [limit, setLimit] = useState(PAGE);
  const showHood = !scope.nbhdId; // in a borough or the city, which neighborhood each restaurant is in matters
  const cuisines = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) m.set(r.place.cuisine, (m.get(r.place.cuisine) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || byName.compare(a[0], b[0]));
  }, [all]);
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    let list = cuisine ? all.filter((r) => r.place.cuisine === cuisine) : all.slice();
    if (q) list = list.filter((r) => r.place.name.toLowerCase().includes(q) || (r.place.brand ?? '').toLowerCase().includes(q));
    const hood = (r: Row) => data.byId.get(r.place.nbhd)?.name ?? '';
    const by = (a: Row, b: Row) =>
      sort.key === 'cuisine'
        ? byName.compare(a.place.cuisine, b.place.cuisine)
        : sort.key === 'hood'
          ? byName.compare(hood(a), hood(b))
          : sort.key === 'chain'
            ? TIER_RANK[a.tier] - TIER_RANK[b.tier]
            : byName.compare(a.place.name, b.place.name);
    // Within equal values the list stays in name order, whichever way the column runs
    list.sort((a, b) => (sort.desc ? -1 : 1) * by(a, b) || byName.compare(a.place.name, b.place.name));
    return list;
  }, [all, cuisine, find, sort, data]);
  const sortBy = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));
    setLimit(PAGE);
  };
  // One sortable column header: a button with the arrow, and aria-sort on the cell
  const head = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" onClick={() => sortBy(key)}>
        {label}
        <span className={`sf-sort${sort.key === key ? (sort.desc ? ' is-desc' : ' is-asc') : ''}`} aria-hidden="true" />
      </button>
    </th>
  );

  // The map draws the restaurants the table is showing, so the cuisine filter narrows the dots too
  useEffect(() => {
    onList(shown.map((r) => r.place));
  }, [shown, onList]);
  useEffect(() => () => onList([]), [onList]);

  if (!all.length) return <p className="sf-notice">No restaurants are on record in {scope.name}.</p>;
  return (
    <section>
      <div className="sf-rtools">
        <label htmlFor={cuisineId}>
          <span className="sf-sr">Cuisine</span>
          <select id={cuisineId} value={cuisine} onChange={(e) => {
              setCuisine(e.target.value);
              setLimit(PAGE);
            }}>
            <option value="">All cuisines</option>
            {cuisines.map(([c, k]) => (
              <option key={c} value={c}>
                {c} ({k})
              </option>
            ))}
          </select>
        </label>
        <div className={`sf-rsearch${open ? ' is-open' : ''}`}>
          <input
            ref={findRef}
            type="search"
            value={find}
            placeholder={`Search restaurants in ${scope.name}`}
            aria-label={`Search restaurants in ${scope.name}`}
            tabIndex={open ? 0 : -1}
            onChange={(e) => {
              setFind(e.target.value);
              setLimit(PAGE);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation(); // closes the search only; the page's Escape would also step back out of the neighborhood
                setFind('');
                setOpen(false);
              }
            }}
            onBlur={() => {
              if (!find) setOpen(false);
            }}
          />
          <button
            type="button"
            className="sf-iconbtn"
            aria-label={open ? 'Close the search' : 'Search restaurants'}
            aria-expanded={open}
            onClick={() => {
              if (open && find) {
                setFind('');
                setLimit(PAGE);
                findRef.current?.focus();
              } else if (open) setOpen(false);
              else {
                setOpen(true);
                window.requestAnimationFrame(() => findRef.current?.focus());
              }
            }}
          >
            <Icon name={open && find ? 'x' : 'search'} size={16} />
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="sf-notice">No restaurants match.</p>
      ) : (
        <table className="sf-table sf-rtable">
          <caption className="sf-sr">Restaurants in {scope.name}. Select a row to highlight it on the map.</caption>
          <thead>
            <tr>
              {showHood ? (
                <th scope="col" aria-sort={sort.key === 'name' || sort.key === 'hood' ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                  <button type="button" onClick={() => sortBy('name')}>
                    Name
                    <span className={`sf-sort${sort.key === 'name' ? (sort.desc ? ' is-desc' : ' is-asc') : ''}`} aria-hidden="true" />
                  </button>
                  <button type="button" className="sf-subsort" onClick={() => sortBy('hood')}>
                    Neighborhood
                    <span className={`sf-sort${sort.key === 'hood' ? (sort.desc ? ' is-desc' : ' is-asc') : ''}`} aria-hidden="true" />
                  </button>
                </th>
              ) : (
                head('name', 'Name')
              )}
              {head('cuisine', 'Cuisine')}
              {head('chain', 'Chain')}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r, i) => {
              const on = pin === r.place;
              return (
                <tr key={`${r.place.name}-${i}`} className={on ? 'is-selected' : undefined} onClick={() => onPin(on ? null : r.place)}>
                  <th scope="row">
                    <button type="button" aria-pressed={on} title={on ? 'Highlighted on the map. Select to clear.' : 'Highlight on the map'}>
                      {r.place.name}
                    </button>
                    {showHood && <span className="sf-rhood">{data.byId.get(r.place.nbhd)?.name ?? ''}</span>}
                  </th>
                  <td>{r.place.cuisine.replace(/\//g, '/​')}</td>
                  <td className={r.tier === 'independent' ? 'is-quiet' : undefined}>{CHAIN[r.tier]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shown.length > limit && (
        <p className="sf-rmore">
          <button type="button" className="sf-btn" onClick={() => setLimit(limit + PAGE * 2)}>
            Show {num(Math.min(PAGE * 2, shown.length - limit))} more of {num(shown.length - limit)}
          </button>
        </p>
      )}
    </section>
  );
}
