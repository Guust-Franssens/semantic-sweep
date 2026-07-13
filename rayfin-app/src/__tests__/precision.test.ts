import { describe, expect, it } from "vitest";
import {
  BAND_EXACT,
  BAND_SUBSET,
  CLUSTER_BANDS,
  DUPLICATE_BANDS,
  organicClusters,
  scoreAll,
  scorePair,
} from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";
import { extractFeatures, matchModelMeasures } from "@engine/measures";
import type { Measure } from "@engine/types";

// Build a model from an explicit {table: columns} map + (name, dax) measures, so the schema/source
// overlap and the measure topology can be controlled precisely (multi-table date-hub scenarios).
function buildModel(
  workspace: string,
  name: string,
  tables: Record<string, string[]>,
  measures: Array<[string, string]>,
): InputFile[] {
  const base = `${workspace}.Workspace/${name}.SemanticModel/definition`;
  const files: InputFile[] = [];
  for (const [t, cols] of Object.entries(tables)) {
    const colDefs = cols.map((c) => `\tcolumn ${c}\n\t\tdataType: string\n\t\tsourceColumn: ${c}`).join("\n");
    const tbl =
      `table ${t}\n${colDefs}\n\n\tpartition ${t} = m\n\t\tmode: import\n\t\tsource =\n` +
      `\t\t\tlet\n\t\t\t\tSource = Sql.Database("wh.contoso.com", "GoldLH"),\n` +
      `\t\t\t\tData = Source{[Schema="dbo", Item="${t}"]}[Data]\n\t\t\tin\n\t\t\t\tData\n`;
    files.push({ path: `${base}/tables/${t}.tmdl`, text: tbl });
  }
  if (measures.length) {
    const meas = measures.map(([n, d]) => `\tmeasure '${n}' = ${d}`).join("\n");
    files.push({ path: `${base}/tables/_Measures.tmdl`, text: `table _M\n${meas}\n` });
  }
  return files;
}

const shapeMeasures = (agg: string, table: string, cols: string[]): Array<[string, string]> =>
  cols.map((c) => [`${table} ${c}`, `${agg}(${table}[${c}])`]);

describe("precision — acc1 empty/withheld DAX", () => {
  it("does not read two shape-identical models as clones when expressions are withheld", () => {
    const measures = shapeMeasures("SUM", "FactUsage", ["V0", "V1", "V2", "V3"]);
    const files = [
      ...buildModel("WS", "Model A", { FactUsage: ["V0", "V1", "V2", "V3"] }, measures),
      ...buildModel("WS", "Model B", { FactUsage: ["V0", "V1", "V2", "V3"] }, measures),
    ];
    const cards = loadModelsFromFiles(files, true);
    const a = cards.find((c) => c.name === "Model A")!;
    const b = cards.find((c) => c.name === "Model B")!;
    // Sanity: with DAX present the two identical models ARE an exact clone.
    expect(scorePair(a, b).band).toBe(BAND_EXACT);

    // Simulate an admin / locked-down scan that withholds every measure expression.
    for (const c of cards) for (const m of c.measures) m.dax = "";
    const pair = scorePair(a, b);
    expect(pair.facets.measure).toBe(0); // no measure evidence at all
    expect(DUPLICATE_BANDS.has(pair.band)).toBe(false); // schema/source alone is never a clone
  });
});

describe("precision — acc3 string-literal refs", () => {
  it("does not leak a bracketed token inside a format string as a column ref", () => {
    const f = extractFeatures('FORMAT(Sales[Amount], "[Red]#,0;[Green](#,0)")');
    expect(f.refs.has("amount")).toBe(true); // the real column ref survives
    expect(f.refs.has("red")).toBe(false); // format-string tokens are NOT refs
    expect(f.refs.has("green")).toBe(false);
  });
});

describe("precision — acc5 ref-backed strong evidence", () => {
  it("counts a shape-only skeleton match as review evidence, not strong-duplicate evidence", () => {
    // SUM(Sales[a_i]) vs SUM(HR[b_i]): identical skeleton, DISJOINT refs. They match structurally
    // (surface for review) but must contribute ZERO ref-backed evidence — a pure shape collision.
    const a: Measure[] = Array.from({ length: 4 }, (_, i) => ({ name: `MA${i}`, dax: `SUM(Sales[a${i}])` }));
    const b: Measure[] = Array.from({ length: 4 }, (_, i) => ({ name: `MB${i}`, dax: `SUM(HR[b${i}])` }));
    const m = matchModelMeasures(a, b);
    expect(m.matched.length).toBeGreaterThanOrEqual(3); // structurally matched
    expect(m.strongMatched).toBe(0); // but none are ref-backed
  });

  it("counts a shared referenced column as ref-backed strong evidence", () => {
    // Renamed-clone shape: same column name, different table -> refs intersect -> ref-backed.
    const a: Measure[] = Array.from({ length: 4 }, (_, i) => ({ name: `MA${i}`, dax: `SUM(Sales[amt${i}])` }));
    const b: Measure[] = Array.from({ length: 4 }, (_, i) => ({ name: `MB${i}`, dax: `SUM(Revenue[amt${i}])` }));
    const m = matchModelMeasures(a, b);
    expect(m.strongMatched).toBeGreaterThanOrEqual(3);
  });
});

describe("precision — acc4 directional subset (no hub bridging)", () => {
  it("does not let a shared date model bridge two unrelated fact models into one cluster", () => {
    const dateCols = ["Year", "Quarter", "Month", "Day", "Date"];
    const dateMeasures: Array<[string, string]> = [
      ["Row Count", "COUNTROWS(DimDate)"],
      ["Year Count", "DISTINCTCOUNT(DimDate[Year])"],
      ["Latest Date", "MAX(DimDate[Date])"],
      ["Earliest Date", "MIN(DimDate[Date])"],
    ];
    const salesCols = ["s0", "s1", "s2", "s3", "s4", "s5"];
    const hrCols = ["h0", "h1", "h2", "h3", "h4", "h5"];
    const files = [
      ...buildModel("Finance", "Date Tools", { DimDate: dateCols }, dateMeasures),
      ...buildModel(
        "Sales",
        "Sales Model",
        { DimDate: dateCols, FactSales: salesCols },
        [...dateMeasures, ...shapeMeasures("SUM", "FactSales", salesCols)],
      ),
      ...buildModel(
        "People",
        "HR Model",
        { DimDate: dateCols, FactHR: hrCols },
        [...dateMeasures, ...shapeMeasures("AVERAGE", "FactHR", hrCols)],
      ),
    ];
    const cards = loadModelsFromFiles(files, true);
    const d = cards.find((c) => c.name === "Date Tools")!;
    const s = cards.find((c) => c.name === "Sales Model")!;
    const h = cards.find((c) => c.name === "HR Model")!;

    // Precondition: the date hub is a SUBSET of each fact model, but the fact models are NOT a
    // co-equal duplicate/subset of each other (Sales uses SUM, HR uses AVERAGE -> no shape match).
    expect(scorePair(d, s).band).toBe(BAND_SUBSET);
    expect(scorePair(d, h).band).toBe(BAND_SUBSET);
    expect(CLUSTER_BANDS.has(scorePair(s, h).band)).toBe(false);

    const clusters = organicClusters(cards, scoreAll(cards));
    // No cluster may contain BOTH fact models (the old undirected subset edges bridged them).
    for (const cl of clusters) {
      const names = new Set(cl.members.map((m) => m.name));
      expect(names.has("Sales Model") && names.has("HR Model")).toBe(false);
    }
    // The date hub attaches to exactly ONE container.
    const dCluster = clusters.find((cl) => cl.members.some((m) => m.name === "Date Tools"));
    expect(dCluster).toBeDefined();
    expect(dCluster!.members.length).toBe(2);
  });
});
