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

const DATA_URL = `${import.meta.env.BASE_URL}data/week2/Restaurant_Grades_20260902.csv`;

const MARGIN = {
  top: 50,
  right: 60,
  bottom: 50,
  left: 280,
};

const BAR_COLOR = "#3A5A40";
const TEXT_COLOR = "#3A5A40";
const GRID_COLOR = "#DDE8DA";

export function FirstVisual() {
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: divRef, dimensions } = useDimensions();

  const [data, setData] = useState<ViolationRow[] | null>(null);

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
            VIOLATION_DESCRIPTION:
              row["VIOLATION_DESCRIPTION"]?.trim() || "",
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

      counts.set(
        violation,
        (counts.get(violation) || 0) + 1,
      );
    });

    return Array.from(counts.entries())
      .map(([violation, count]) => ({
        violation,
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [data]);

  // Truncate labels after a fixed number of characters
  const shortenViolation = (
    violation: string,
    maxLength = 45,
  ): string => {
    if (violation.length <= maxLength) {
      return violation;
    }

    return `${violation.slice(0, maxLength).trim()}...`;
  };

  // Draw D3 bar chart
  useEffect(() => {
    const svg = svgRef.current;

    if (
      !svg ||
      dimensions.width === 0 ||
      violationCounts.length === 0
    ) {
      return;
    }

    const width = dimensions.width;

    const height = Math.max(
      700,
      MARGIN.top +
        MARGIN.bottom +
        violationCounts.length * 55,
    );

    const chartWidth = Math.max(
      width - MARGIN.left - MARGIN.right,
    );

    const chartHeight = Math.max(
      height - MARGIN.top - MARGIN.bottom,
    );

    const x = scaleLinear()
      .domain([
        0,
        max(violationCounts, (d) => d.count) || 0,
      ])
      .nice()
      .range([0, chartWidth]);

    const y = scaleBand<string>()
      .domain(violationCounts.map((d) => d.violation))
      .range([0, chartHeight])
      .padding(0.25);

    const svgSelection = select(svg);

    svgSelection.selectAll("*").remove();

    svgSelection
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", width)
      .attr("height", height);

    const chart = svgSelection
      .append("g")
      .attr(
        "transform",
        `translate(${MARGIN.left}, ${MARGIN.top})`,
      );

    // Gridlines
    const grid = chart
      .append("g")
      .attr("class", "grid")
      .attr(
        "transform",
        `translate(0, ${chartHeight})`,
      )
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
      .attr("rx", 3);

    // Value labels
    chart
      .selectAll(".value-label")
      .data(violationCounts)
      .join("text")
      .attr("class", "value-label")
      .attr("x", (d) => x(d.count) + 6)
      .attr(
        "y",
        (d) =>
          (y(d.violation) || 0) +
          y.bandwidth() / 2,
      )
      .attr("dominant-baseline", "middle")
      .attr("font-size", 12)
      .attr("fill", TEXT_COLOR)
      .text((d) => d.count);

    // Y-axis
    const yAxis = chart
      .append("g")
      .call(axisLeft(y));

    yAxis
      .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", TEXT_COLOR)
      .text((d) => shortenViolation(String(d)));

    // X-axis
    const xAxis = chart
      .append("g")
      .attr(
        "transform",
        `translate(0, ${chartHeight})`,
      )
      .call(axisBottom(x).ticks(5));

    xAxis
      .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", TEXT_COLOR);
  }, [violationCounts, dimensions]);

    return (
    <div
        ref={divRef}
        className="relative w-full px-10 py-10"
    >
        <h2 className="text-lg font-semibold mb-2">
        Most Common Restaurant Violations
        </h2>

        <div className="w-full">
        <svg
            ref={svgRef}
            className="block w-full h-[800px]"
            role="img"
            aria-label="Horizontal bar chart showing the ten most common restaurant violations"
        />
        </div>
    </div>
    );
}