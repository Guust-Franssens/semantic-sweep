import { describe, expect, it } from "vitest";
import { BAND_EXACT, BAND_REVIEW, DUPLICATE_BANDS, scorePair } from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

// A single-table model with 3 identical ref-backed measures over Sql.Database(server, "SalesDB").
// Varying only `server` between two calls produces a pair whose measures/schema are byte-identical
// but whose physical source (endpoint) genuinely disagrees — e.g. an EU vs a US regional shard of
// the same template.
function shardModel(workspace: string, name: string, server: string): InputFile[] {
  const table = [
    "table Sales",
    "\tcolumn Amount",
    "\t\tdataType: double",
    "\t\tsourceColumn: Amount",
    "",
    "\tmeasure Total = SUM(Sales[Amount])",
    "\tmeasure Count = COUNTROWS(Sales)",
    "\tmeasure Avg = AVERAGE(Sales[Amount])",
    "",
    "\tpartition Sales = m",
    "\t\tmode: import",
    "\t\tsource =",
    "\t\t\tlet",
    `\t\t\t\tSource = Sql.Database("${server}", "SalesDB"),`,
    '\t\t\t\tData = Source{[Schema="dbo", Item="Sales"]}[Data]',
    "\t\t\tin",
    "\t\t\t\tData",
    "",
  ].join("\n");
  const base = `${workspace}.Workspace/${name}.SemanticModel/definition`;
  return [{ path: `${base}/tables/Sales.tmdl`, text: table }];
}

describe("physical-source-banding (P1) — mismatch downgrades the band, not just a warning", () => {
  it("downgrades an otherwise-identical pair to needs-review when physical source disagrees", () => {
    const files = [...shardModel("Prod", "SalesEU", "eu-sql.contoso.com"), ...shardModel("Prod", "SalesUS", "us-sql.contoso.com")];
    const cards = loadModelsFromFiles(files, true);
    const a = cards.find((c) => c.name === "SalesEU")!;
    const b = cards.find((c) => c.name === "SalesUS")!;
    const pair = scorePair(a, b);
    expect(pair.facets.measure).toBeGreaterThanOrEqual(0.95); // measures are byte-identical
    expect(pair.facets.schema).toBeGreaterThanOrEqual(0.95); // same single table + column
    expect(pair.facets.source_physical).toBeLessThan(1); // disjoint endpoints
    expect(DUPLICATE_BANDS.has(pair.band)).toBe(false); // never exact/strong once physical disagrees
    expect(pair.band).toBe(BAND_REVIEW); // falls through to needs-review, not silently unrelated
    expect(pair.warnings).toContain("different physical source / endpoint");
  });

  it("still classifies as exact-clone when the physical source matches (control case)", () => {
    const files = [...shardModel("Prod", "SalesA", "eu-sql.contoso.com"), ...shardModel("Prod", "SalesB", "eu-sql.contoso.com")];
    const cards = loadModelsFromFiles(files, true);
    const a = cards.find((c) => c.name === "SalesA")!;
    const b = cards.find((c) => c.name === "SalesB")!;
    const pair = scorePair(a, b);
    expect(pair.band).toBe(BAND_EXACT);
    expect(pair.warnings).not.toContain("different physical source / endpoint");
  });
});
