import { describe, expect, it } from "vitest";
import { DUPLICATE_BANDS, organicClusters, scorePair, scoreAll } from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

// Same model name promoted across two lifecycle environments (feat -> prod) over the same warehouse
// with identical measures: a high-similarity duplicate that is expected lifecycle promotion, not an
// organic consolidation target.
function envModel(workspace: string, name: string, measureCount = 6): InputFile[] {
  const cols = Array.from({ length: 8 }, (_, i) => `\tcolumn V${i}\n\t\tdataType: double\n\t\tsourceColumn: V${i}`).join("\n");
  const fact = `table FactSales\n${cols}\n\n\tpartition FactSales = m\n\t\tmode: import\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = Sql.Database("dw.datawarehouse.fabric.microsoft.com", "SalesLH"),\n\t\t\t\tData = Source{[Schema="dbo", Item="FactSales"]}[Data]\n\t\t\tin\n\t\t\t\tData\n`;
  const meas = Array.from({ length: measureCount }, (_, i) => `\tmeasure 'M${i}' = SUM(FactSales[V${i}])`).join("\n");
  const base = `${workspace}/${name}.SemanticModel/definition`;
  return [
    { path: `${base}/tables/FactSales.tmdl`, text: fact },
    { path: `${base}/tables/_Measures.tmdl`, text: `table _M\n${meas}\n` },
  ];
}

describe("lifecycle clustering toggle (imp-a2)", () => {
  const files = [...envModel("CICD-prod", "SalesSense"), ...envModel("CICD-feat", "SalesSense")];
  const cards = loadModelsFromFiles(files, true);
  const pairs = scoreAll(cards);

  it("flags the cross-environment pair as a lifecycle duplicate", () => {
    const prod = cards.find((c) => c.workspace === "CICD-prod")!;
    const feat = cards.find((c) => c.workspace === "CICD-feat")!;
    const pair = scorePair(prod, feat);
    expect(pair.lifecycle).toBe(true);
    expect(DUPLICATE_BANDS.has(pair.band)).toBe(true); // would cluster if it were not lifecycle
  });

  it("excludes lifecycle copies from clusters by default", () => {
    expect(organicClusters(cards, pairs).length).toBe(0);
  });

  it("re-clusters lifecycle copies when includeLifecycle is set (prod is the keeper)", () => {
    const clusters = organicClusters(cards, pairs, true);
    expect(clusters.length).toBe(1);
    expect(clusters[0].members.length).toBe(2);
    expect(clusters[0].keep.workspace).toBe("CICD-prod");
  });
});
