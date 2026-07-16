import { describe, expect, it } from "vitest";
import type { ScannerDataset, ScanResultBody } from "@engine/scanner";
import { scannerToModels } from "@engine/scanner";

function bodyWithDataset(overrides: Partial<ScannerDataset> = {}): ScanResultBody {
  const dataset: ScannerDataset = {
    id: "ds1",
    name: "Sales",
    tables: [
      {
        name: "Sales",
        columns: [{ name: "Amount", dataType: "double" }],
        measures: [{ name: "Total", expression: "SUM(Sales[Amount])" }],
      },
    ],
    ...overrides,
  };
  return { workspaces: [{ id: "ws1", name: "Prod", state: "Active", datasets: [dataset] }] };
}

describe("scannerToModels — hasRls / hasCalcGroups fidelity (P1)", () => {
  it("reports hasRls: true when the Scanner payload's dataset has roles", () => {
    const body = bodyWithDataset({ roles: [{ name: "RegionFilter" }] });
    const [card] = scannerToModels(body);
    expect(card.hasRls).toBe(true);
  });

  it("reports hasRls: false (not unknown) when the dataset genuinely has no roles", () => {
    const body = bodyWithDataset();
    const [card] = scannerToModels(body);
    expect(card.hasRls).toBe(false);
  });

  it("always reports hasCalcGroups as undefined (unknown) — the Scanner schema has no such field", () => {
    const body = bodyWithDataset();
    const [card] = scannerToModels(body);
    expect(card.hasCalcGroups).toBeUndefined();
  });

  it("threads schemaMayNotBeUpToDate / schemaRetrievalError onto the card for fidelity scoring", () => {
    const body = bodyWithDataset({ schemaMayNotBeUpToDate: true, schemaRetrievalError: "timeout" });
    const [card] = scannerToModels(body);
    expect(card.schemaMayNotBeUpToDate).toBe(true);
    expect(card.schemaRetrievalError).toBe("timeout");
  });
});
