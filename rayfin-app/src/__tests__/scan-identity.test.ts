// modelId() collision guard (mirrors semantic_sweep tests/test_model_id_dedup.py).
//
// modelId() has no identity to fall back on beyond "workspace/name" (a TMDL-zip upload carries no
// true unique id). Two cards sharing both fields -- most plausibly two Scanner-API workspaces that
// happen to report the same display name (e.g. one deleted and recreated), each containing a
// dataset with the same name -- must not collapse into a single slot in anything keyed by
// modelId(): pairs, clusters, chains, and the UI's labels map, which is what previously produced a
// duplicated-looking label like "Sales, Sales" instead of two distinguishable rows.
import { describe, expect, it } from "vitest";
import { modelId } from "@engine/types";
import { scanCards } from "@engine/scan";
import { scannerToModels, type ScanResultBody } from "@engine/scanner";

const tables = (measureName: string, dax: string) => [
  { name: "FactSales", columns: [{ name: "Amount", dataType: "Double" }] },
  { name: "_Measures", columns: [{ name: "_dummy", dataType: "Int64", isHidden: true }], measures: [{ name: measureName, expression: dax }] },
];

// Two different workspace IDs that happen to report the SAME display name, each holding a dataset
// also named the same as the other -- the collision this guards against.
const collidingBody = (): ScanResultBody => ({
  workspaces: [
    { id: "ws-guid-1", name: "Finance", state: "Active", datasets: [{ id: "ds-1", name: "Sales", tables: tables("RevenueA", "SUM(FactSales[Amount])") }] },
    { id: "ws-guid-2", name: "Finance", state: "Active", datasets: [{ id: "ds-2", name: "Sales", tables: tables("RevenueB", "SUM(FactSales[Amount]) * 2") }] },
  ],
});

describe("modelId collision guard", () => {
  it("disambiguates two distinct cards that would otherwise share a modelId", () => {
    const scan = scanCards(scannerToModels(collidingBody()));
    expect(scan.cards).toHaveLength(2);

    const ids = scan.cards.map(modelId);
    expect(new Set(ids).size).toBe(2); // no collision survives the scan

    // Names stay intact; only the 2nd collider's workspace carries the disambiguator.
    expect(scan.cards.every((c) => c.name === "Sales")).toBe(true);
    expect(scan.cards[0].workspace).toBe("Finance");
    expect(scan.cards[1].workspace).toBe("Finance (2)");
  });

  it("scores the deduped pair as two distinct models instead of merging them", () => {
    const scan = scanCards(scannerToModels(collidingBody()));
    expect(scan.pairs).toHaveLength(1); // both cards survived and were compared, not merged into one
  });

  it("leaves non-colliding cards' modelId untouched", () => {
    const body: ScanResultBody = {
      workspaces: [
        { id: "ws-guid-1", name: "Finance", state: "Active", datasets: [{ id: "ds-1", name: "Sales", tables: tables("RevenueA", "SUM(FactSales[Amount])") }] },
        { id: "ws-guid-2", name: "Ops", state: "Active", datasets: [{ id: "ds-2", name: "Logistics", tables: tables("CostB", "SUM(FactSales[Amount])") }] },
      ],
    };
    const scan = scanCards(scannerToModels(body));
    expect(scan.cards.map((c) => c.workspace)).toEqual(["Finance", "Ops"]);
  });
});
