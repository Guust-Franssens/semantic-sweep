import { describe, expect, it } from "vitest";
import { DUPLICATE_BANDS, scorePair } from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";
import { runScan } from "@engine/scan";

// Build a model whose FactUsage table is sourced from a shared warehouse, with `count` measures
// M0..M(count-1). Two such models over the same source share schema + source; the smaller model's
// measures are an exact subset of the larger one's (companion-model / FUAM_Core vs FUAM_Item shape).
function usageModel(workspace: string, name: string, measureCount: number, columnCount = 10): InputFile[] {
  const cols = Array.from({ length: columnCount }, (_, i) => `\tcolumn V${i}\n\t\tdataType: double\n\t\tsourceColumn: V${i}`).join("\n");
  const fact = `table FactUsage\n${cols}\n\n\tpartition FactUsage = m\n\t\tmode: import\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = Sql.Database("fuam.datawarehouse.fabric.microsoft.com", "FUAM_LH"),\n\t\t\t\tData = Source{[Schema="dbo", Item="FactUsage"]}[Data]\n\t\t\tin\n\t\t\t\tData\n`;
  const meas = Array.from({ length: measureCount }, (_, i) => `\tmeasure 'M${i}' = SUM(FactUsage[V${i}])`).join("\n");
  const base = `${workspace}.Workspace/${name}.SemanticModel/definition`;
  const files: InputFile[] = [{ path: `${base}/tables/FactUsage.tmdl`, text: fact }];
  if (measureCount > 0) files.push({ path: `${base}/tables/_Measures.tmdl`, text: `table _M\n${meas}\n` });
  return files;
}

describe("banding — measure-evidence gates (imp-a3 / imp-a4)", () => {
  it("does not label a small companion model (few shared measures) as a strong duplicate", () => {
    // FUAM_Core_SM (10 measures) and FUAM_Item_SM (3 subset measures) share the same lakehouse
    // schema + source. Old logic banded this strong-duplicate via containment alone (measure ~0.3).
    const files = [...usageModel("FUAM", "FUAM_Core_SM", 10), ...usageModel("FUAM", "FUAM_Item_SM", 3)];
    const cards = loadModelsFromFiles(files, true);
    const core = cards.find((c) => c.name === "FUAM_Core_SM")!;
    const item = cards.find((c) => c.name === "FUAM_Item_SM")!;
    const pair = scorePair(core, item);
    expect(pair.facets.measure).toBeLessThan(0.55); // low similarity — schema/source drove the old FP
    expect(DUPLICATE_BANDS.has(pair.band)).toBe(false); // never exact/strong-duplicate
  });

  it("keeps schema-identical, zero-measure models out of duplicate clusters", () => {
    // Two staging/auto models with an identical schema but no measures must never cluster.
    const files = [...usageModel("Stg", "Staging A", 0), ...usageModel("Stg", "Staging B", 0)];
    const scan = runScan(files);
    const a = scan.cards.find((c) => c.name === "Staging A")!;
    const b = scan.cards.find((c) => c.name === "Staging B")!;
    expect(DUPLICATE_BANDS.has(scorePair(a, b).band)).toBe(false);
    const clustered = scan.clusters.some((cl) => cl.members.some((m) => m.name === "Staging A" || m.name === "Staging B"));
    expect(clustered).toBe(false);
  });

  it("still flags a genuine strong duplicate (>= 3 matching measures + shared schema)", () => {
    // Regression guard: the matched-measure floor must not suppress real duplicates.
    const files = [...usageModel("WS", "Real A", 6), ...usageModel("WS", "Real B", 6)];
    const cards = loadModelsFromFiles(files, true);
    const a = cards.find((c) => c.name === "Real A")!;
    const b = cards.find((c) => c.name === "Real B")!;
    const pair = scorePair(a, b);
    expect(pair.measure.matched.length).toBeGreaterThanOrEqual(3);
    expect(DUPLICATE_BANDS.has(pair.band)).toBe(true);
  });
});
