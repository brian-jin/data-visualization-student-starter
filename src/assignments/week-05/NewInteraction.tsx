import { useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
import { csvParse } from "d3-dsv";
import { scaleLinear, scaleBand } from "d3-scale";
import { max } from "d3-array";
import { axisBottom, axisLeft } from "d3-axis";
import { useDimensions } from "../week-01/useDimensions";

interface ViolationRow {
  VIOLATION_DESCRIPTION: string;
  [key: string]: string;
}

interface ViolationCount {
  violation: string;
  count: number;
}

interface TooltipState {
  x: number;
  y: number;
  violation: string;
  count: number;
}

const DATA_URL = `${import.meta.env.BASE_URL}data/week2/Restaurant_Grades_20260902.csv`;

const MARGIN = {
  top: 40,
  right: 70,
  bottom: 70,
  left: 300,
};

const BAR_COLOR = "#3A5A40";
const BAR_HOVER_COLOR = "#588157";
const BAR_SELECTED_COLOR = "#344E41";
const TEXT_COLOR = "#3A5A40";
const GRID_COLOR = "#DDE8DA";

const CHARS_PER_LINE = 34;
const MAX_LABEL_LINES = 2;
const LINE_HEIGHT = 13;
const ROW_HEIGHT = 46;
const MIN_CHART_HEIGHT = 560;
const CHART_MAX_HEIGHT = 650;

const RECORD_TABLE_COLUMNS = ["DBA", "BORO", "GRADE", "GRADE_DATE", "CRITICAL_FLAG"];

// how each column should sort. "alpha" and "date" sort generically;
// "ordinal" sorts by position in an explicit rank list below
type ColumnSortType = "alpha" | "date" | "ordinal";

// Best grade to worst
const GRADE_ORDER = ["A", "B", "C", "N", "Z", "P"];

// Least to most severe
const CRITICAL_FLAG_ORDER = ["Not Applicable", "Not Critical", "Critical"];

const COLUMN_SORT_TYPE: Record<string, ColumnSortType> = {
  DBA: "alpha",
  BORO: "alpha",
  GRADE: "ordinal",
  GRADE_DATE: "date",
  CRITICAL_FLAG: "ordinal",
};

const ORDINAL_ORDERS: Record<string, string[]> = {
  GRADE: GRADE_ORDER,
  CRITICAL_FLAG: CRITICAL_FLAG_ORDER,
};

interface TableSortState {
  column: string;
  direction: "asc" | "desc";
}

function compareByColumn(
  a: ViolationRow,
  b: ViolationRow,
  column: string,
): number {
  const av = (a[column] ?? "").trim();
  const bv = (b[column] ?? "").trim();
  const type = COLUMN_SORT_TYPE[column] ?? "alpha";

  if (type === "date") {
    const at = new Date(av).getTime();
    const bt = new Date(bv).getTime();
    const aValid = !Number.isNaN(at);
    const bValid = !Number.isNaN(bt);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1; // unparseable dates sort last
    if (!bValid) return -1;
    return at - bt;
  }

  if (type === "ordinal") {
    const order = ORDINAL_ORDERS[column] ?? [];
    const ai = order.indexOf(av);
    const bi = order.indexOf(bv);
    const aRank = ai === -1 ? order.length : ai;
    const bRank = bi === -1 ? order.length : bi;
    return aRank - bRank;
  }

  return av.localeCompare(bv);
}

export function NewInteraction() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: divRef, dimensions } = useDimensions();

  const [data, setData] = useState<ViolationRow[] | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [isRendered, setIsRendered] = useState(false);

  const [selectedViolation, setSelectedViolation] = useState<string | null>(
    null,
  );

  // How many rows to show in the chart
  const [visibleCount, setVisibleCount] = useState(10);

  // which table column is sorted and in which direction (null = the
  // data's natural order). Resets whenever a new violation is selected.
  const [tableSort, setTableSort] = useState<TableSortState | null>(null);

  // how many rows of the drill-down table to show. Defaults to 200
  const [tableRowLimit, setTableRowLimit] = useState(200);

  useEffect(() => {
    let cancelled = false;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load CSV: ${response.status}`);
        }

        return response.text();
      })
      .then((text) => {
        if (cancelled) return;

        const parsed = csvParse(text);

        setData(
          parsed.map((row) => ({
            ...row,
            VIOLATION_DESCRIPTION: row["VIOLATION_DESCRIPTION"]?.trim() || "",
          })) as ViolationRow[],
        );
      })
      .catch((error) => {
        console.error("Failed to load data", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // count every distinct violation
  const allViolationCounts = useMemo<ViolationCount[]>(() => {
    if (!data) return [];

    const counts = new Map<string, number>();

    data.forEach((row) => {
      const violation = row.VIOLATION_DESCRIPTION;

      if (!violation) return;

      counts.set(violation, (counts.get(violation) || 0) + 1);
    });

    return Array.from(counts.entries())
      .map(([violation, count]) => ({ violation, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const totalViolations = allViolationCounts.length;

  // slice to however many rows the user wants & clamped to what exists
  const violationCounts = useMemo<ViolationCount[]>(() => {
    const n = Math.min(Math.max(visibleCount, 1), totalViolations || 1);
    return allViolationCounts.slice(0, n);
  }, [allViolationCounts, visibleCount, totalViolations]);

  // Raw records behind the currently selected bar
  const selectedRecords = useMemo<ViolationRow[]>(() => {
    if (!data || !selectedViolation) return [];
    return data.filter((row) => row.VIOLATION_DESCRIPTION === selectedViolation);
  }, [data, selectedViolation]);

  // same records, sorted by whichever column header was clicked
  const sortedSelectedRecords = useMemo<ViolationRow[]>(() => {
    if (!tableSort) return selectedRecords;

    const dir = tableSort.direction === "asc" ? 1 : -1;

    return [...selectedRecords].sort(
      (a, b) => compareByColumn(a, b, tableSort.column) * dir,
    );
  }, [selectedRecords, tableSort]);

  // the sorted records to the user's chosen row limit
  const visibleTableRecords = useMemo<ViolationRow[]>(() => {
    const n = Math.min(
      Math.max(tableRowLimit, 1),
      sortedSelectedRecords.length || 1,
    );
    return sortedSelectedRecords.slice(0, n);
  }, [sortedSelectedRecords, tableRowLimit]);

  // click a bar to select it; click the same bar again to clear.
  // Selecting a new violation resets any table sort/row-limit from the last one.
  const selectViolation = (violation: string) => {
    setSelectedViolation((prev) => (prev === violation ? null : violation));
    setTableSort(null);
    setTableRowLimit(200);
  };

  // click a table header to sort by it
  const handleHeaderClick = (column: string) => {
    setTableSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  // Reserve vertical space up front so the chart doesn't jump into place
  // once data loads and isRendered flips.
  const chartHeight = Math.max(
    MIN_CHART_HEIGHT,
    MARGIN.top + MARGIN.bottom + Math.max(violationCounts.length, 10) * ROW_HEIGHT,
  );

  // Draw D3 bar chart
  useEffect(() => {
    const svg = svgRef.current;

    if (!svg || dimensions.width === 0 || violationCounts.length === 0) {
      return;
    }

    const width = dimensions.width;
    const height = chartHeight;

    const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
    const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

    const x = scaleLinear()
      .domain([0, max(violationCounts, (d) => d.count) || 0])
      .nice()
      .range([0, innerWidth]);

    const y = scaleBand<string>()
      .domain(violationCounts.map((d) => d.violation))
      .range([0, innerHeight])
      .padding(0.25);

    const countByViolation = new Map(
      violationCounts.map((d) => [d.violation, d.count]),
    );

    // Break a label into at most MAX_LABEL_LINES lines, on word boundaries.
    // Returns the lines plus whether anything was cut off.
    const wrapViolation = (violation: string) => {
      const words = violation.split(/\s+/);
      const lines: string[] = [];
      let current = "";

      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;

        if (candidate.length <= CHARS_PER_LINE) {
          current = candidate;
          continue;
        }

        if (current) lines.push(current);
        current = word;

        if (lines.length === MAX_LABEL_LINES) break;
      }

      if (current && lines.length < MAX_LABEL_LINES) lines.push(current);

      const rendered = lines.join(" ");
      const truncated = rendered.length < violation.length;

      if (truncated && lines.length > 0) {
        const last = lines[lines.length - 1];
        lines[lines.length - 1] = `${last.slice(0, CHARS_PER_LINE - 1).trim()}…`;
      }

      return { lines, truncated };
    };

    const showTooltip = (event: PointerEvent, violation: string) => {
      const rect = wrapperRef.current?.getBoundingClientRect();

      if (!rect) return;

      setTooltip({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        violation,
        count: countByViolation.get(violation) ?? 0,
      });
    };

    const hideTooltip = () => setTooltip(null);

    const svgSelection = select(svg);

    svgSelection.selectAll("*").remove();

    svgSelection
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", width)
      .attr("height", height)
      .attr("preserveAspectRatio", "xMinYMin meet");

    const chart = svgSelection
      .append("g")
      .attr("transform", `translate(${MARGIN.left}, ${MARGIN.top})`);

    // Gridlines
    const grid = chart
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0, ${innerHeight})`)
      .call(axisBottom(x).ticks(5));

    grid.select(".domain").remove();

    grid
      .selectAll(".tick line")
      .attr("y1", -innerHeight)
      .attr("y2", 0)
      .attr("stroke", GRID_COLOR)
      .attr("stroke-dasharray", "2,2");

    grid.selectAll(".tick text").remove();

    // Bars
    chart
      .selectAll(".bar")
      .data(violationCounts)
      .join("rect")
      .attr("class", "bar")
      .attr("x", 0)
      .attr("y", (d) => y(d.violation) || 0)
      .attr("width", (d) => x(d.count))
      .attr("height", y.bandwidth())
      .attr("fill", (d) =>
        d.violation === selectedViolation ? BAR_SELECTED_COLOR : BAR_COLOR,
      )
      .attr("rx", 3)
      .style("cursor", "pointer")
      .on("pointerenter pointermove", function (event: PointerEvent, d) {
        if (d.violation !== selectedViolation) {
          select(this).attr("fill", BAR_HOVER_COLOR);
        }
        showTooltip(event, d.violation);
      })
      .on("pointerleave", function (_event, d) {
        select(this).attr(
          "fill",
          d.violation === selectedViolation ? BAR_SELECTED_COLOR : BAR_COLOR,
        );
        hideTooltip();
      })
      .on("click", (_event, d) => selectViolation(d.violation))
      // Native tooltip + screen-reader text as a no-JS fallback
      .append("title")
      .text((d) => `${d.violation} — ${d.count} violations`);

    // Value labels
    chart
      .selectAll(".value-label")
      .data(violationCounts)
      .join("text")
      .attr("class", "value-label")
      .attr("x", (d) => x(d.count) + 8)
      .attr("y", (d) => (y(d.violation) || 0) + y.bandwidth() / 2)
      .attr("dominant-baseline", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text((d) => d.count.toLocaleString());

    // Y-axis: wrapped, hoverable category labels
    const yAxis = chart.append("g").call(axisLeft(y).tickSize(0));

    yAxis.select(".domain").remove();

    yAxis
      .selectAll<SVGTextElement, string>(".tick text")
      .attr("font-size", 11)
      .attr("fill", TEXT_COLOR)
      .attr("dominant-baseline", "middle")
      .style("cursor", "pointer")
      .each(function (violation) {
        const textNode = select(this);
        const { lines, truncated } = wrapViolation(violation);

        textNode.text(null);

        const offset = -((lines.length - 1) * LINE_HEIGHT) / 2;

        lines.forEach((line, i) => {
          textNode
            .append("tspan")
            .attr("x", -10)
            .attr("y", 0)
            .attr("dy", offset + i * LINE_HEIGHT)
            .text(line);
        });

        if (truncated) {
          textNode
            .style("cursor", "help")
            .attr("text-decoration", "underline dotted");
        }

        textNode.append("title").text(violation);
      })
      .on("pointerenter pointermove", (event: PointerEvent, violation) =>
        showTooltip(event, violation),
      )
      .on("pointerleave", hideTooltip)
      .on("click", (_event, violation) => selectViolation(violation));

    // X-axis
    const xAxis = chart
      .append("g")
      .attr("transform", `translate(0, ${innerHeight})`)
      .call(axisBottom(x).ticks(5));

    xAxis.selectAll("text").attr("font-size", 11).attr("fill", TEXT_COLOR);

    // X-axis label
    chart
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", innerHeight + 45)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text("Number of Inspection Records of Violation Cited");

    // Y-axis label
    chart
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -innerHeight / 2)
      .attr("y", -MARGIN.left + 20)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text("Violation Cited");

    setIsRendered(true);

    return () => {
      hideTooltip();
    };
  }, [violationCounts, dimensions, chartHeight, selectedViolation]);

  return (
    <div ref={wrapperRef} className="relative w-full px-10 py-10">
      <div
        className={`transition-opacity duration-300 ${
          isRendered ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* chart, and table in one scrollable
            panel, with the header sticky inside it */}
        <div
          ref={divRef}
          className="w-full overflow-y-auto rounded-md border border-neutral-100"
          style={{ maxHeight: CHART_MAX_HEIGHT }}
        >
          <div className="sticky top-0 z-20 bg-white px-4 pb-3 pt-3">
            <h2 className="text-lg font-semibold leading-snug">
              Most-Cited Violations in NYC Restaurant Inspections
            </h2>

            <p className="mb-2 mt-2 max-w-2xl text-sm text-neutral-600 whitespace-nowrap">
              Each bar counts how many inspection records list that
              violation. Hover a bar or label for the full text. Click a
              bar to view a table of the inspection records.
            </p>

            {/* Row-count control */}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-neutral-500">Show:</span>
              <input
                type="range"
                min={1}
                max={Math.max(totalViolations, 1)}
                value={Math.min(visibleCount, Math.max(totalViolations, 1))}
                onChange={(e) => setVisibleCount(Number(e.target.value))}
                className="w-48 accent-[#3A5A40]"
              />
              <span className="w-28 text-neutral-600">
                {Math.min(visibleCount, totalViolations)} of{" "}
                {totalViolations.toLocaleString()}
              </span>
              <div className="flex gap-1">
                {[10, 25, 50].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setVisibleCount(n)}
                    disabled={n > totalViolations}
                    className={`rounded-md border px-2 py-0.5 text-xs disabled:opacity-30 ${
                      visibleCount === n
                        ? "border-[#3A5A40] bg-[#3A5A40] text-white"
                        : "border-neutral-300 text-neutral-600"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setVisibleCount(totalViolations)}
                  className={`rounded-md border px-2 py-0.5 text-xs ${
                    visibleCount >= totalViolations
                      ? "border-[#3A5A40] bg-[#3A5A40] text-white"
                      : "border-neutral-300 text-neutral-600"
                  }`}
                >
                  All
                </button>
              </div>
            </div>
          </div>

          <svg
            ref={svgRef}
            className="block w-full px-4"
            role="img"
            aria-label="Horizontal bar chart of the most frequently cited restaurant inspection violations"
          />

          {/* records table directly under the chart*/}
          {selectedViolation && (
            <div className="mx-4 mb-4 mt-2 rounded-md border border-neutral-200 p-4">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="text-sm font-semibold text-[#3A5A40]">
                  {selectedRecords.length.toLocaleString()} records found:{" "}
                  {selectedViolation}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedViolation(null);
                    setTableSort(null);
                    setTableRowLimit(200);
                  }}
                  className="shrink-0 text-sm text-neutral-500 underline"
                >
                  Clear
                </button>
              </div>

              {/* row-limit control for user-adjustable like the chart's row-count control. */}
              <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                <span className="text-neutral-500">Show:</span>
                <input
                  type="range"
                  min={1}
                  max={Math.max(selectedRecords.length, 1)}
                  value={Math.min(
                    tableRowLimit,
                    Math.max(selectedRecords.length, 1),
                  )}
                  onChange={(e) => setTableRowLimit(Number(e.target.value))}
                  className="w-40 accent-[#3A5A40]"
                />
                <span className="w-32 text-neutral-600">
                  {Math.min(tableRowLimit, selectedRecords.length)} of{" "}
                  {selectedRecords.length.toLocaleString()}
                </span>
                <div className="flex gap-1">
                  {[50, 100, 200, 500].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setTableRowLimit(n)}
                      disabled={n > selectedRecords.length}
                      className={`rounded-md border px-2 py-0.5 text-xs disabled:opacity-30 ${
                        tableRowLimit === n
                          ? "border-[#3A5A40] bg-[#3A5A40] text-white"
                          : "border-neutral-300 text-neutral-600"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setTableRowLimit(selectedRecords.length)}
                    className={`rounded-md border px-2 py-0.5 text-xs ${
                      tableRowLimit >= selectedRecords.length
                        ? "border-[#3A5A40] bg-[#3A5A40] text-white"
                        : "border-neutral-300 text-neutral-600"
                    }`}
                  >
                    All
                  </button>
                </div>
              </div>

              {/* horizontal scroll container so the table can be wider
                  than the card (five columns of text)*/}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      {RECORD_TABLE_COLUMNS.map((col) => {
                        const active = tableSort?.column === col;
                        return (
                          <th
                            key={col}
                            onClick={() => handleHeaderClick(col)}
                            aria-sort={
                              active
                                ? tableSort!.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                            className={`cursor-pointer select-none whitespace-nowrap py-1 pr-4 hover:text-[#3A5A40] ${
                              active ? "text-[#3A5A40]" : ""
                            }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {col}
                              {/* NEW: always-visible sort icon so it reads
                                  as sortable at a glance — faded double
                                  chevron when idle, a solid arrow pointing
                                  the active sort direction when engaged. */}
                              {active ? (
                                <span className="text-[10px] text-[#3A5A40]">
                                  {tableSort!.direction === "asc" ? "▲" : "▼"}
                                </span>
                              ) : (
                                <span className="text-[10px] text-neutral-300">
                                  ⇅
                                </span>
                              )}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTableRecords.map((row, i) => (
                      <tr key={i} className="border-t border-neutral-100">
                        {RECORD_TABLE_COLUMNS.map((col) => (
                          <td key={col} className="whitespace-nowrap py-1 pr-4">
                            {row[col] ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visibleTableRecords.length < selectedRecords.length && (
                <div className="pt-2 text-xs text-neutral-400">
                  Showing {visibleTableRecords.length.toLocaleString()} of{" "}
                  {selectedRecords.length.toLocaleString()}.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {tooltip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-sm rounded-md bg-[#F5F1E8] px-3 py-2 text-xs leading-snug text-[#3A5A40] shadow-lg"
          style={{
            left: tooltip.x + 14,
            top: tooltip.y + 14,
          }}
        >
          <div>{tooltip.violation}</div>
          <div className="mt-1 font-semibold">
            {tooltip.count.toLocaleString()} records
          </div>
        </div>
      )}
    </div>
  );
}