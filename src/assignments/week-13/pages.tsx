// Landing and Methodology pages.
import { useMemo } from 'react';
import { MIN_CHAIN_RESTAURANTS, MIN_RESTAURANTS, changeSummary, classOf, makeBreaks, num, pct, plural, score } from './data';
import type { Data } from './data';
import { MapView } from './MapView';
import { Icon, StateLink } from './ui';
import type { Patch } from './ui';

const NO_PAD = { top: 24, right: 24, bottom: 24, left: 24 };
const noop = () => {};

export function Landing({ data, href }: { data: Data | null; href: (p: Patch) => string }) {
  const map = useMemo(() => {
    if (!data) return null;
    const breaks = makeBreaks(data.ranked.map((n) => n.chainShare));
    return { breaks, classes: new Map(data.ranked.map((n) => [n.id, classOf(n.chainShare, breaks)])) };
  }, [data]);
  // Three real entry points, each a shareable link into the map
  const starts = useMemo(() => {
    if (!data) return [];
    const most = data.ranked[0];
    const E = data.ranked.length;
    let best = { i: 0, j: 1, s: -1 };
    // Two neighborhoods with one chain each can match perfectly by accident, so only places with 10 or more chains qualify
    const ok = (k: number) => data.ranked[k].chainBrands >= 10;
    for (let i = 0; i < E; i++) for (let j = i + 1; j < E; j++) if (ok(i) && ok(j) && data.sim[i * E + j] > best.s) best = { i, j, s: data.sim[i * E + j] };
    const a = data.ranked[best.i];
    const b = data.ranked[best.j];
    const chain = data.brands.find((x) => x.tier !== 'independent');
    const ch = changeSummary(data);
    return [
      ...(ch.total ? [{ to: href({ v: 'map', lens: 'change' }), title: 'What changed since 2022', text: `Chain share rose in ${ch.up} of ${ch.total} neighborhoods and fell in ${ch.down}.` }] : []),
      { to: href({ v: 'map', n: most.id }), title: most.name, text: `The most chain-heavy neighborhood: ${pct(most.chainShare)} of its ${num(most.n)} restaurants are chains.` },
      ...(a && b && best.s >= 0 ? [{ to: href({ v: 'map', n: a.id, c: b.id, tab: 'shared' }), title: `${a.name} and ${b.name}`, text: `The closest pair among neighborhoods with 10 or more chains. Their chain mixes score ${score(best.s)} out of 100.` }] : []),
      ...(chain ? [{ to: href({ v: 'map', q: chain.name }), title: chain.name, text: `The largest chain: ${plural(chain.total, 'location')} in ${num(chain.nbhds.size)} neighborhoods.` }] : []),
    ];
  }, [data, href]);
  const c = data?.city;
  const b = map?.breaks.map((x) => Math.round(x * 100));
  return (
    <main className="sf-page sf-landing">
      <div className="sf-landing-text">
        <p className="sf-landing-sub">Mapping the Same-ification of NYC, From Blank Street to 7th Street</p>
        <h1>Are neighborhoods in NYC truly losing their unique identities?</h1>
        {c && data ? (
          <p className="sf-landing-lede">
            This map counts chain restaurants in {num(data.nbhds.length)} neighborhoods. Of {num(c.restaurants)} restaurants, {pct(c.chainShare)} belong to one of {num(c.chainBrands)} chains. In the median neighborhood the figure is {pct(c.medianShare)}. In {data.ranked[0].name} it is {pct(data.ranked[0].chainShare)}.{changeSummary(data).total ? ` Since 2022 the share has risen in ${changeSummary(data).up} of ${changeSummary(data).total} neighborhoods.` : ''}
          </p>
        ) : (
          <p className="sf-landing-lede" aria-hidden="true">
            <span className="sf-skel" style={{ width: '100%', height: 18 }} />
            <span className="sf-skel" style={{ width: '92%', height: 18 }} />
            <span className="sf-skel" style={{ width: '60%', height: 18 }} />
          </p>
        )}
        <p className="sf-landing-actions">
          <StateLink to={href({ v: 'map' })} className="sf-btn is-primary is-large">
            Open the map
          </StateLink>
          <StateLink to={href({ v: 'method' })} className="sf-btn is-large">
            How it is measured
          </StateLink>
        </p>
        {starts.length > 0 && (
          <section className="sf-starts" aria-labelledby="sf-starts-h">
            <h2 id="sf-starts-h">Places to start</h2>
            <ul>
              {starts.map((s) => (
                <li key={s.title}>
                  <StateLink to={s.to}>
                    <b>{s.title}</b>
                    <span>{s.text}</span>
                    <Icon name="arrow" size={16} />
                  </StateLink>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="sf-landing-map">
        {data && map && b ? (
          <>
            <MapView data={data} classes={map.classes} activeClasses={null} describe={() => ''} selId={null} cmpId={null} hoverId={null} onHover={noop} onSelect={noop} brands={[]} focusKey="city" focusBounds={data.bounds} pad={NO_PAD} interactive={false} />
            <div className="sf-landing-key">
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
            </div>
          </>
        ) : (
          <div className="sf-map is-loading" />
        )}
      </div>
    </main>
  );
}

const DOHMH = 'https://data.cityofnewyork.us/Health/DOHMH-New-York-City-Restaurant-Inspection-Results/43nn-pn8j/about_data';
const KAGGLE = 'https://www.kaggle.com/datasets/minisam/new-york-city-restaurant-inspection20172021/data';
const ZILLOW ='https://github.com/chriswhong/nyc-neighborhood-boundaries';

export function Methodology({ data, mapHref, entering = false }: { data: Data | null; mapHref: string; entering?: boolean }) {
  const c = data?.city;
  return (
    <main className={`sf-page sf-method${entering ? ' is-entering' : ''}`}>
      <article>
        <h1>Methodology</h1>
        <p className="sf-method-lede">
          “Same-ification” is the worry that neighborhoods lose what sets them apart as the same businesses open everywhere. This project measures one part of it: how much of each neighborhood's restaurant scene belongs to chains, and how alike those chains are from one neighborhood to the next.
        </p>

        <h2 id="chain">What counts as a chain</h2>
        <p>
          A chain is a restaurant brand with three or more locations inside the five boroughs. Locations outside New York City are not counted, so a national brand with two stores here is treated as independent. Two shops that happen to share a name are also not a chain; a hand-reviewed list keeps common names such as “Happy Garden” apart.
        </p>
        <table className="sf-spec is-wide">
          <caption className="sf-sr">Chain tiers by number of citywide locations</caption>
          <thead>
            <tr>
              <th scope="col">Chain tier</th>
              <th scope="col">Citywide locations</th>
              <th scope="col" className="is-num">
                Share of restaurants
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Independent', '1 or 2', 'independent', 'var(--tier-independent)'],
                ['Mini', '3 to 9', 'mini_chain', 'var(--tier-mini)'],
                ['Mid-size', '10 to 49', 'chain', 'var(--tier-mid)'],
                ['Big', '50 or more', 'big_chain', 'var(--tier-big)'],
              ] as const
            ).map(([label, range, key, token]) => (
              <tr key={key}>
                <th scope="row">
                  <i className="sf-chip" style={{ background: token }} />
                  {label}
                </th>
                <td>{range}</td>
                <td className="is-num">{c ? pct(c.shares[key]) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 id="share">Chain share</h2>
        <p>
          Chain share is the number of chain restaurants in a neighborhood divided by all of its restaurants. The tier modes on the map use the same division for one tier at a time.
          {c && data ? ` Across the city the pooled figure is ${pct(c.chainShare)}. The median neighborhood is ${pct(c.medianShare)}.` : ''}
        </p>

        <h2 id="similarity">Similarity score</h2>
        <p>
          For every neighborhood the app builds a list of its chains. Two neighborhoods are compared with cosine similarity, which measures how closely two such lists point the same way, whatever their size. The result is scaled to run from 0 to 100, where 0 means the two have no chain in common. The map offers two versions of the list:
        </p>
        <ul className="sf-sources">
          <li>
            <b>Chain mix</b> (the default) counts locations. 100 means the same chains in the same proportions, so a chain with five locations in a neighborhood weighs much more than a chain with one.
            {data ? ` The median neighborhood scores ${score(data.sims.mix.median)}.` : ''}
          </li>
          <li>
            <b>Chain overlap</b> records each chain as present or absent. 100 means exactly the same chains. The score is the number of chains two neighborhoods share, divided by the square root of each one's chain count.
            {data ? ` The median neighborhood scores ${score(data.sims.set.median)}.` : ''}
          </li>
        </ul>
        <p>
          A neighborhood's own similarity score is the average of its scores against every other scored neighborhood. A high score means its chains are the ones found everywhere. Independent restaurants are left out of the calculation, so the score describes chains only.
        </p>
        <p>
          Only neighborhoods with {MIN_CHAIN_RESTAURANTS} or more chain restaurants are scored. Cosine similarity ignores size, so a neighborhood with a single Dunkin would count as entirely Dunkin and match every neighborhood that has one.
          {data ? ` ${num(data.ranked.length - data.simCount)} ranked neighborhoods fall under this floor. They keep their chain share and rank but have no similarity score, and they are left out of everyone else's average.` : ''}
        </p>

        <h2 id="rank">Ranking and the {MIN_RESTAURANTS}-restaurant floor</h2>
        <p>
          {data ? `The boundary file has ${num(data.nbhds.length)} neighborhoods. ${num(data.ranked.length)} of them have ${MIN_RESTAURANTS} or more restaurants and are ranked. ` : ''}
          Neighborhoods under the floor are drawn with a hatch and left out of rankings, medians, and similarity, because a single opening or closing would move their numbers by several points. Rank 1 is the highest chain share.
        </p>
        <p>The map sorts ranked neighborhoods into five bands with about the same number in each. The legend prints the range and count for every band, so the colors never have to be read alone.</p>

        <h2 id="views">The other views</h2>
        <p>
          The tier grid draws the map four times, once for all chains and once per tier, each with its own five bands. The makeup plot places every ranked neighborhood by its share of each tier and of the 12 most common cuisines, using principal component analysis to flatten those shares to two axes. Its axes are blends, so distance on the plot is a rough guide to how alike two neighborhoods are.
        </p>
        <p>The Change view draws one line per neighborhood from its 2022 chain share to its 2026 share. Each year is tiered on its own counts, and a neighborhood appears only if it had {MIN_RESTAURANTS} or more restaurants in both.</p>
        <p>
          Its year by year chart runs from 2019 to 2026 and is an estimate. Only 2022 and 2026 are real snapshots. For the other years a restaurant counts as open from its first inspection on record to its last listing, and a brand counts as a chain if it had three or more open locations that year. Places that closed before March 2022 are missing from the early years, and places that closed between the snapshots have no known closing date, so the estimated years can sit away from the truth. Since they do not have closing dates, the open count dips in 2023. As a result, earlier years should be treated as a rough guide to the trend.
        </p>

        <p>The year slider beside the place name applies the same estimate to the whole tool. Move it and the map, the tier grid, the makeup plot, the ranking, and the figures are all recounted for that year.</p>

        <h2 id="sources">Data sources</h2>
        <ul className="sf-sources">
          <li>
            <a href={DOHMH} target="_blank" rel="noreferrer">
              DOHMH New York City Restaurant Inspection Results
            </a>
            , NYC Open Data. One row per violation, reduced to one row per restaurant. The current figures use the file dated September 29, 2026. The 2022 figures use an earlier copy of the same file dated March 23, 2022 found on{' '}
            <a href={KAGGLE} target="_blank" rel="noreferrer">
              Kaggle
            </a>
            .
          </li>
          <li>
            <a href={ZILLOW} target="_blank" rel="noreferrer">
              Zillow neighborhood boundaries (2017)
            </a>
            , republished by Chris Whong under CC BY-SA 4.0. Each restaurant is assigned to the boundary that contains its coordinates.
          </li>
        </ul>

        <h2 id="limits">Limits</h2>
        <ul className="sf-sources">
          <li>The inspection file is updated daily andlists restaurants that are active on the day it is pulled. It is a snapshot, not a history. The Change view compares two snapshots, March 2022 and September 2026. The years around them are estimates. There is no direct way to download past snapshots. </li>
          <li>Restaurants are expected to be inspected at least once a year. Only active restaurants are included in the data. The snapshots hold up to three years of historical data. </li>
          <li>Brand names are matched after cleaning (case, punctuation, store numbers, legal suffixes) and a manual alias list. Some variants will have been missed and some unrelated shops merged.</li>
          <li>Restaurants are only one kind of business that can be measured. Other types of businesses may have different patterns and behaviors. </li>
          <li>Zillow's boundaries are informal. They differ from the city's official Neighborhood Tabulation Areas. However, the official NTAs merge several neighborhoods and do not include many of the smaller neighborhoods that are commonly used in everyday conversation.</li>
        </ul>

        <p className="sf-method-end">
          <StateLink to={mapHref} className="sf-btn is-primary is-large">
            Open the map <Icon name="arrow" size={16} />
          </StateLink>
        </p>
      </article>
    </main>
  );
}
