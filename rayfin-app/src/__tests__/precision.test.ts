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
import { extractFeatures, matchModelMeasures, normalizeDax } from "@engine/measures";
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

describe("dax-tokenizer-hardening — escape-aware strings and comments", () => {
  it("does not leak a bracketed token inside a string with an escaped quote as a column ref", () => {
    // DAX embeds a literal quote in a string by doubling it (`""`). The old non-escape-aware
    // `"[^"]*"` stopped at the FIRST embedded quote, leaving the remainder of the string (including
    // a bracketed token) unneutralized and leaking it as a bogus column ref.
    const f = extractFeatures('FORMAT(Sales[Amount], "Say ""[Bracket]"" here")');
    expect(f.refs.has("amount")).toBe(true);
    expect(f.refs.has("bracket")).toBe(false);
  });

  it("does not treat a line-comment marker inside a string literal as a real comment", () => {
    // normalizeDax used to strip comments before any string protection, so a "//" occurring INSIDE
    // a string literal (e.g. "100 // percent") was misread as a real comment start and truncated
    // everything after it, silently deleting real DAX code later in the expression.
    const norm = normalizeDax('VAR _x = "100 // percent" RETURN SUM(Sales[Amount])');
    expect(norm).toContain("return sum(sales[amount])");
  });

  it("does not treat a block-comment marker inside a string literal as a real comment", () => {
    const norm = normalizeDax('VAR _x = "50% /* not a comment */ done" RETURN SUM(Sales[Amount])');
    expect(norm).toContain("return sum(sales[amount])");
    expect(norm).toContain("not a comment"); // string content preserved, not stripped as a comment
  });
});

describe("remove-em-dashes-and-precision-recall — greedy matcher no longer under-counts", () => {
  it("finds the mutually-compatible optimal assignment instead of the single best-scoring pair", () => {
    // The old greedy matcher sorted ALL candidate pairs by score descending and assigned
    // first-come-first-served. That under-counts matches whenever a contested measure's single
    // best candidate blocks a DIFFERENT, mutually-compatible assignment that would have matched
    // everyone. Here A0's top choice (B0, 1.0) beats A1's ONLY viable candidate (B0, 0.8824) and
    // A1~B1 falls below threshold (0.3529, no candidate at all) -- so a score-descending greedy
    // pass grabs A0-B0 first, then drops both A1~B0 (B0 taken) and A0~B1 (A0 taken), leaving A1
    // completely unmatched even though A0-B1 (0.9) + A1-B0 (0.8824) matches BOTH measures on each
    // side. The matcher must find that second, better assignment.
    const a: Measure[] = [
      { name: "A0", dax: "SUM(Sales[Amount])" },
      { name: "A1", dax: "SUM(Sales[Amount]) * 1" },
    ];
    const b: Measure[] = [
      { name: "B0", dax: "SUM(Sales[Amount])" },
      { name: "B1", dax: "SUM(Revenue[Units])" },
    ];
    const m = matchModelMeasures(a, b);
    expect(m.matched.length).toBe(2); // both sides fully matched, not just the single best pair
    const pairs = new Set(m.matched.map(({ a: x, b: y }) => `${x}~${y}`));
    expect(pairs).toEqual(new Set(["A0~B1", "A1~B0"])); // the mutually-compatible optimal assignment
  });
});

describe("precision — acc6 generic bare refs are not ref-backed across tables", () => {
  it("captures a table-qualified ref only when a qualifier is present in the source DAX", () => {
    const qualified = extractFeatures("SUM(Sales[Amount])");
    expect(qualified.qualifiedRefs.has("sales.amount")).toBe(true);
    const bare = extractFeatures("SUM([Amount])");
    expect(bare.qualifiedRefs.size).toBe(0);
    expect(bare.refs.has("amount")).toBe(true); // still a bare ref, just not table-qualified
  });

  it("does not treat a shared generic column name on unrelated tables as ref-backed", () => {
    // Sales[Amount]/[Date]/[Id]/[Name] vs Budget[Amount]/[Date]/[Id]/[Name]: same GENERIC names,
    // unrelated tables (the P0 false positive: "Sales[Amount] ~ Budget[Amount]"). Still matches
    // structurally (surfaces for review) but must not manufacture strong-duplicate evidence.
    const cols = ["Amount", "Date", "Id", "Name"];
    const a: Measure[] = cols.map((c, i) => ({ name: `MA${i}`, dax: `SUM(Sales[${c}])` }));
    const b: Measure[] = cols.map((c, i) => ({ name: `MB${i}`, dax: `SUM(Budget[${c}])` }));
    const m = matchModelMeasures(a, b);
    expect(m.matched.length).toBeGreaterThanOrEqual(3);
    expect(m.strongMatched).toBe(0);
  });
});

describe("remove-em-dashes-and-precision-recall — generic multi-word name downweight", () => {
  it("gives a partly generic name a partial, not zero, downweight versus a fully generic or fully specific name", () => {
    // measureWeight() used to strip ALL non-alphanumeric chars (including spaces) before the
    // GENERIC_NAMES check, so "Total Sales" collapsed to "totalsales" and matched nothing -> never
    // downweighted, identical to a fully specific name like "Revenue". Word-boundary tokenization
    // now judges each word independently, so a partly generic name sits strictly BETWEEN a fully
    // generic name and a fully specific one.
    //
    // Each case matches one measure with identical DAX on both sides (so DAX complexity is constant
    // across cases) plus an unmatched, non-generic filler on side A only, so the matched measure's
    // weight is exposed through the similarity normalization instead of always resolving to 1.0.
    const filler: Measure = { name: "Extra Metric", dax: "DISTINCTCOUNT(Customer[Id])" };
    const similarity = (name: string): number => {
      const a: Measure[] = [{ name, dax: "SUM(Sales[Amount])" }, filler];
      const b: Measure[] = [{ name, dax: "SUM(Sales[Amount])" }];
      return matchModelMeasures(a, b).similarity;
    };

    const simGeneric = similarity("Total"); // fully generic word -> full 0.4 floor (unchanged)
    const simPartial = similarity("Total Sales"); // one generic + one specific word
    const simSpecific = similarity("Revenue"); // no generic words -> no downweight

    expect(simGeneric).toBeLessThan(simPartial);
    expect(simPartial).toBeLessThan(simSpecific);
    // Before the fix simPartial === simSpecific exactly (both treated as fully non-generic).
    expect(simSpecific - simPartial).toBeGreaterThan(0.02);
  });
});

describe("fix-parity-harness — Unicode-aware table qualifiers", () => {
  // JS's `\w` is ASCII-only regardless of regex flags, unlike Python's `\w` (Unicode-aware by
  // default) -- engine/measures.ts previously used `\w+` for the bare table-qualifier alternative in
  // its bracket-reference regexes, so a non-ASCII table name split the qualifier mid-identifier and
  // diverged from the Python engine's parse of the exact same DAX. Fixed via `[\p{L}\p{N}_]` + `u`.
  it("captures a full non-ASCII bare table qualifier, not a truncated fragment", () => {
    const accented = extractFeatures("SUM(Clientèle[Montant])");
    expect(accented.qualifiedRefs.has("clientèle.montant")).toBe(true);
  });

  it("treats a shared non-ASCII column name across two non-ASCII tables as ref-backed strong evidence", () => {
    const a: Measure[] = [{ name: "M", dax: "SUM(Übersicht[Größe])" }];
    const b: Measure[] = [{ name: "M", dax: "SUM(Zusammenfassung[Größe])" }];
    const m = matchModelMeasures(a, b);
    expect(m.strongMatched).toBe(1);
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
