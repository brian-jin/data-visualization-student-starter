import { useEffect, useMemo, useRef, useState } from "react";
import { select } from "d3-selection";
import { csvParse } from "d3-dsv";
import { useDimensions } from "../week-01/useDimensions";
import { geoPath, geoMercator } from "d3-geo";

interface Summary {
    rows: number;
    columns: number;
}

interface RowSummary {
    DBA: string;
    BORO: string;
    BUILDING: string;
    STREET: string;
    ZIPCODE: string;
    CUISINE_DESCRIPTION: string;
    VIOLATION_DESCRIPTION: string;
    CRITICAL_FLAG: string;
    SCORE: number;
    GRADE: string;
    GRADE_DATE: string;
    RECORD_DATE: string;
}

interface BoroughFeature {
    type: "Feature";
    properties: {
        BoroName: string;
    };
    geometry: any;
}

interface BoroughGeoJSON {
    type: "FeatureCollection";
    features: BoroughFeature[];
}

const DATA_URL = `${import.meta.env.BASE_URL}data/week2/Restaurant_Grades_20260902.csv`;
const BOROUGH_URL = `${import.meta.env.BASE_URL}data/week2/borough.geo.json`;
const FONT_SIZE = 28;
const LINE_HEIGHT = FONT_SIZE * 1.2;

export function SummarizeDataset() {
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<SVGSVGElement>(null);
  const { ref: divRef, dimensions } = useDimensions();
  const [data, setData] = useState<RowSummary[] | null>(null);

  // Load & parse dataset
  useEffect(() => {
    let cancelled = false;

    fetch(DATA_URL)
      .then((response) => response.text())
      .then((text) => {
        if (cancelled) return;
        const parsed = csvParse(text);
        setData(
          parsed.map((row) => ({
            DBA: row["DBA"] || "",
            BORO: row["BORO"] || "",
            BUILDING: row["BUILDING"] || "",
            STREET: row["STREET"] || "",
            ZIPCODE: row["ZIPCODE"] || "",
            CUISINE_DESCRIPTION: row["CUISINE_DESCRIPTION"] || "",
            VIOLATION_DESCRIPTION: row["VIOLATION_DESCRIPTION"] || "",
            CRITICAL_FLAG: row["CRITICAL_FLAG"] || "",
            SCORE: Number(row["SCORE"]) || 0,
            GRADE: row["GRADE"] || "",
            GRADE_DATE: row["GRADE_DATE"] || "",
            RECORD_DATE: row["RECORD_DATE"] || "",
          })),
        );
      })
      .catch((error) => {
        console.error('Failed to load data', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Calculate summary
  const summary = useMemo<Summary | null>(() => {
    if (!data) return null;
    // console.log(JSON.stringify(data, null, 2));
    return {
      rows: data.length,
      columns: Object.keys(data[0]).length,
    };
  }, [data]);

  // D3 summary display
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || dimensions.width === 0 || dimensions.height === 0 || !summary) return;

    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;

    select(svg)
      .selectAll('text')
      .data([summary])
      .join('text')
      .attr('x', centerX)
      .attr('y', centerY)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', FONT_SIZE)
      .selectAll('tspan')
      .data((d) => [`Rows: ${d.rows}`, `Columns: ${d.columns}`])
      .join('tspan')
      .attr('x', centerX)
      .attr('dy', (_d, i) => (i === 0 ? 0 : LINE_HEIGHT))
      .text((d) => d);
  }, [dimensions, summary]);

  // NYC borough choropleth
    useEffect(() => {
    const svg = mapRef.current;

    if (
        !svg ||
        dimensions.width === 0 ||
        !data ||
        data.length === 0
    ) {
        return;
    }

    fetch(BOROUGH_URL)
        .then((response) => response.json())
        .then((geojson: BoroughGeoJSON) => {
        const boroughCounts = new Map<string, Set<string>>();

        data.forEach((row) => {
            const borough = row.BORO;
            const restaurant = row.DBA;
            if (!boroughCounts.has(borough)) {
                boroughCounts.set(borough, new Set());
            }
            boroughCounts.get(borough)!.add(restaurant)
        });

        const width = dimensions.width;
        const height = 600;

        const projection = geoMercator().fitExtent(
              [
                [20, 20],
                [width - 20, height - 20],
            ],
            geojson
        );

        const path = geoPath().projection(projection);

        const maxCount = Math.max(
            ...Array.from(boroughCounts.values()).map(
                (restaurants) => restaurants.size
            )
        );

        const colorScale = (borough: string) => {
            const count = boroughCounts.get(borough)?.size || 0;
            const intensity = count / maxCount;

            return `rgb(
            ${Math.round(220 - intensity * 120)},
            ${Math.round(235 - intensity * 100)},
            ${Math.round(220 - intensity * 120)}
            )`;
        };

        select(svg)
            .selectAll("path")
            .data(geojson.features)
            .join("path")
            .attr("d", (d: BoroughFeature) => path(d))
            .attr("fill", (d) => colorScale(d.properties.BoroName))
            .attr("stroke", "#3A5A40")
            .attr("stroke-width", 1);

        select(svg).selectAll("text").remove();
        select(svg)
            .selectAll("text")
            .data(geojson.features)
            .join("text")
            .attr("transform", (d: BoroughFeature) => {
                const centroid = path.centroid(d);
                return `translate(${centroid[0]}, ${centroid[1]})`;
            })
            .attr("text-anchor", "middle")
            .attr("font-size", 12)
            .attr("font-weight", "bold")
            .attr("fill", "#3A5A40")
            .selectAll("tspan")
            .data((d: BoroughFeature) => [
                d.properties.BoroName,
                `${boroughCounts.get(d.properties.BoroName)?.size || 0} restaurants`,
            ])
            .join("tspan")
            .attr("x", 0)
            .attr("dy", (_d, i) => (i === 0 ? -6 : 15))
            .text((d) => d);
        });
    }, [data, dimensions]);

  // HTML display
  return (
  <div ref={divRef} className="relative w-full h-full px-6 py-4">
    {/* Summary */}
    <h2 className="text-lg font-semibold mb-2">
          Row & Column Summary
        </h2>
    <svg
      ref={svgRef}
      className="w-full h-full"
      role="img"
      aria-label="Summary of the NYC Restaurant Grades dataset"
    ></svg>

    {/* Borough Map */}
    {data && data.length > 0 && (
      <div className="w-full mt-8">
        <h2 className="text-lg font-semibold mb-2">
          Restaurants by NYC Borough
        </h2>

        <svg
          ref={mapRef}
          className="w-full h-[600px]"
          role="img"
          aria-label="Choropleth map showing restaurant records by NYC borough"
        />
      </div>
    )}

    {/* Head(10) Table */}
    {data && data.length > 0 && (
        <div className="overflow-x-auto mt-8">
            <h2 className="text-lg font-semibold mb-2">
          Head (10) of Dataset
        </h2>
            <table className="table-auto min-w-max border-collapse border border-[#3A5A40] text-sm">
            <thead>
                <tr>
                {Object.keys(data[0]).map((column) => (
                    <th
                    key={column}
                    className="border border-[#3A5A40] px-2 py-1 bg-[#3A5A40] text-white"
                    >
                    {column}
                    </th>
                ))}
                </tr>
            </thead>

            <tbody>
                {data.slice(0, 10).map((row, rowIndex) => (
                <tr key={rowIndex} className="odd:bg-[#DDE8DA] even:bg-[#F5F7F3]">
                    {Object.values(row).map((value, colIndex) => (
                    <td
                        key={colIndex}
                        className="border border-[#3A5A40] px-2 py-1 "
                    >
                        {String(value)}
                    </td>
                    ))}
                </tr>
                ))}
            </tbody>
            </table>
        </div>
    )}
  </div>
);
}