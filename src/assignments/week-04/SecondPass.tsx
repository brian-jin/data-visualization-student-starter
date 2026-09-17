import { useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
import { csvParse } from "d3-dsv";
import { scaleLinear, scaleBand } from "d3-scale";
import { max } from "d3-array";
import { axisBottom, axisLeft } from "d3-axis";
import { useDimensions } from "../week-01/useDimensions";

interface ViolationRow {
  VIOLATION_DESCRIPTION: string;
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
const TEXT_COLOR = "#3A5A40";
const GRID_COLOR = "#DDE8DA";

const CHARS_PER_LINE = 34;
const MAX_LABEL_LINES = 2;
const LINE_HEIGHT = 13;

export function SecondPass() {
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: divRef, dimensions } = useDimensions();

  const [data, setData] = useState<ViolationRow[] | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

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
            VIOLATION_DESCRIPTION: row["VIOLATION_DESCRIPTION"]?.trim() || "",
          })),
        );
      })
      .catch((error) => {
        console.error("Failed to load data", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Count the ten most common violation descriptions
  const violationCounts = useMemo<ViolationCount[]>(() => {
    if (!data) return [];

    const counts = new Map<string, number>();

    data.forEach((row) => {
      const violation = row.VIOLATION_DESCRIPTION;

      if (!violation) return;

      counts.set(violation, (counts.get(violation) || 0) + 1);
    });

    return Array.from(counts.entries())
      .map(([violation, count]) => ({ violation, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [data]);

  // Draw D3 bar chart
  useEffect(() => {
    const svg = svgRef.current;
    const container = divRef.current;

    if (!svg || dimensions.width === 0 || violationCounts.length === 0) {
      return;
    }

    const width = dimensions.width;

    const height = Math.max(
      560,
      MARGIN.top + MARGIN.bottom + violationCounts.length * 46,
    );

    const chartWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
    const chartHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

    const x = scaleLinear()
      .domain([0, max(violationCounts, (d) => d.count) || 0])
      .nice()
      .range([0, chartWidth]);

    const y = scaleBand<string>()
      .domain(violationCounts.map((d) => d.violation))
      .range([0, chartHeight])
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
      if (!container) return;

      const rect = container.getBoundingClientRect();

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
      .attr("height", height);

    const chart = svgSelection
      .append("g")
      .attr("transform", `translate(${MARGIN.left}, ${MARGIN.top})`);

    // Gridlines
    const grid = chart
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0, ${chartHeight})`)
      .call(axisBottom(x).ticks(5));

    grid.select(".domain").remove();

    grid
      .selectAll(".tick line")
      .attr("y1", -chartHeight)
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
      .attr("fill", BAR_COLOR)
      .attr("rx", 3)
      .style("cursor", "pointer")
      .on("pointerenter pointermove", function (event: PointerEvent, d) {
        select(this).attr("fill", BAR_HOVER_COLOR);
        showTooltip(event, d.violation);
      })
      .on("pointerleave", function () {
        select(this).attr("fill", BAR_COLOR);
        hideTooltip();
      })
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
      .style("cursor", "default")
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
          textNode.style("cursor", "help").attr("text-decoration", "underline dotted");
        }

        textNode.append("title").text(violation);
      })
      .on("pointerenter pointermove", (event: PointerEvent, violation) =>
        showTooltip(event, violation),
      )
      .on("pointerleave", hideTooltip);

    // X-axis
    const xAxis = chart
      .append("g")
      .attr("transform", `translate(0, ${chartHeight})`)
      .call(axisBottom(x).ticks(5));

    xAxis.selectAll("text").attr("font-size", 11).attr("fill", TEXT_COLOR);

    // X-axis label
    chart
      .append("text")
      .attr("x", chartWidth / 2)
      .attr("y", chartHeight + 45)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text("Number of Inspection Records of Violation Cited");

    // Y-axis label
    chart
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -chartHeight / 2)
      .attr("y", -MARGIN.left + 20)
      .attr("text-anchor", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text("Violation Cited");

    return () => {
      hideTooltip();
    };
  }, [violationCounts, dimensions, divRef]);

  return (
    <div ref={divRef} className="relative w-full px-10 py-10">
      <h2 className="text-lg font-semibold">
        The Top Ten Most-Cited Violations in NYC Restaurant Inspections
      </h2>

      <p className="mb-6 max-w-prose text-sm text-neutral-600">
        Each bar counts how many inspection records list that violation. Hover over a
        bar or a label to read the full violation text.
      </p>

      <div className="w-full">
        <svg
          ref={svgRef}
          className="block w-full"
          role="img"
          aria-label="Horizontal bar chart of the ten most frequently cited restaurant inspection violations, ordered from most to least common"
        />
      </div>

      {tooltip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-sm rounded-md bg-[#3A5A40] px-3 py-2 text-xs leading-snug text-white shadow-lg"
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