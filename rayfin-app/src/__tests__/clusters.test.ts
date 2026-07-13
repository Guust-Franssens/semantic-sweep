import { describe, expect, it } from "vitest";
import { CLUSTER_BANDS, organicClusters, scoreAll, scorePair } from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

interface Meas {
  name: string;
  agg: string;
  col: string;
}

// Build a model over a shared warehouse FactUsage table with explicit measures + columns, so we can
// craft exact subset overlaps and genuinely-dissimilar measures (different aggregator + column) to
// control the pairwise topology precisely.
function model(workspace: string, name: string, measures: Meas[], cols: string[]): InputFile[] {
  const colDefs = cols.map((c) => `\tcolumn ${c}\n\t\tdataType: double\n\t\tsourceColumn: ${c}`).join("\n");
  const fact =
    `table FactUsage\n${colDefs}\n\n\tpartition FactUsage = m\n\t\tmode: import\n\t\tsource =\n` +
    `\t\t\tlet\n\t\t\t\tSource = Sql.Database("wh.contoso.com", "GoldLH"),\n` +
    `\t\t\t\tData = Source{[Schema="dbo", Item="FactUsage"]}[Data]\n\t\t\tin\n\t\t\t\tData\n`;
  const meas = measures.map((x) => `\tmeasure '${x.name}' = ${x.agg}(FactUsage[${x.col}])`).join("\n");
  const base = `${workspace}/${name}.SemanticModel/definition`;
  const files: InputFile[] = [{ path: `${base}/tables/FactUsage.tmdl`, text: fact }];
  if (measures.length) files.push({ path: `${base}/tables/_Measures.tmdl`, text: `table _M\n${meas}\n` });
  return files;
}

// n exact SUM-over-Va* measures / AVERAGE-over-Vc* measures — disjoint AND dissimilar across the two
// families (different aggregator, different columns), so a SUM model never partially matches an AVG one.
const sumA = (n: number): Meas[] =>
  Array.from({ length: n }, (_, i) => ({ name: `SalesA${i}`, agg: "SUM", col: `Va${i}` }));
const avgC = (n: number): Meas[] =>
  Array.from({ length: n }, (_, i) => ({ name: `CostC${i}`, agg: "AVERAGE", col: `Vc${i}` }));
const va = (n: number): string[] => Array.from({ length: n }, (_, i) => `Va${i}`);
const vc = (n: number): string[] => Array.from({ length: n }, (_, i) => `Vc${i}`);

describe("clustering — subset + transitive coverage (imp-a5 / imp-a6)", () => {
  it("clusters a trimmed subset copy as a consolidation candidate (imp-a5)", () => {
    // Core has 8 measures; Trim's 4 measures are an exact subset over the same schema/source.
    const files = [
      ...model("Ops", "Core Model", sumA(8), va(8)),
      ...model("Ops", "Trim Copy", sumA(4), va(8)),
    ];
    const cards = loadModelsFromFiles(files, true);
    const core = cards.find((c) => c.name === "Core Model")!;
    const trim = cards.find((c) => c.name === "Trim Copy")!;
    const pair = scorePair(core, trim);
    expect(pair.band).toBe("subset"); // trimmed copy, not a co-equal duplicate

    const clusters = organicClusters(cards, scoreAll(cards));
    const cluster = clusters.find((cl) => cl.members.some((m) => m.name === "Trim Copy"));
    expect(cluster).toBeDefined();
    // Subset now surfaces in the actionable worklist (previously excluded from clusters entirely).
    expect(cluster!.members.map((m) => m.name).sort()).toEqual(["Core Model", "Trim Copy"]);
    expect(cluster!.keep.name).toBe("Core Model"); // superset is the keep nominee
  });

  it("retains a transitively-connected member instead of silently dropping it (imp-a6)", () => {
    // Topology: A≈B and B≈C are cluster edges (B is the hub holding both measure sets), but A's
    // measures (SUM over Va*) and C's (AVERAGE over Vc*) are disjoint AND dissimilar, so A≉C. The
    // keep nominee is A (prod workspace → higher rank than the dev hub B), making A a LEAF. Old
    // code dropped C (no direct edge to keep A); the fix keeps the whole connected component.
    const A = model("Alpha prod", "Alpha Sales", sumA(4), va(4));
    const B = model("Beta dev", "Beta Sales", [...sumA(4), ...avgC(4)], [...va(4), ...vc(4)]);
    const C = model("Gamma dev", "Gamma Sales", avgC(4), vc(4));
    const cards = loadModelsFromFiles([...A, ...B, ...C], true);
    const a = cards.find((c) => c.name === "Alpha Sales")!;
    const b = cards.find((c) => c.name === "Beta Sales")!;
    const c = cards.find((c) => c.name === "Gamma Sales")!;

    // Precondition: the intended topology actually holds.
    expect(CLUSTER_BANDS.has(scorePair(a, b).band)).toBe(true);
    expect(CLUSTER_BANDS.has(scorePair(b, c).band)).toBe(true);
    expect(CLUSTER_BANDS.has(scorePair(a, c).band)).toBe(false); // A≉C — no direct edge

    const clusters = organicClusters(cards, scoreAll(cards));
    const cluster = clusters.find((cl) => cl.members.some((m) => m.name === "Alpha Sales"));
    expect(cluster).toBeDefined();
    expect(cluster!.keep.name).toBe("Alpha Sales"); // prod outranks the dev hub
    // C is only transitively connected (via B) — it must NOT vanish.
    expect(cluster!.members.map((m) => m.name).sort()).toEqual(["Alpha Sales", "Beta Sales", "Gamma Sales"]);
  });
});
