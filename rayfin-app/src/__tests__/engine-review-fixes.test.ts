import { describe, expect, it } from "vitest";
import { materialDrift } from "@engine/recommend";
import { ingestCsv } from "@engine/usage";
import type { ModelCard } from "@engine/types";

// Regression tests for the multi-model engine review (2026-07-17):
//  - blank usage CSV cells must be "unknown" (undefined), never 0
//  - materialDrift must not flag drift when a measure's DAX is withheld on either side

const base: ModelCard = {
  name: "Sales",
  workspace: "Prod",
  tables: ["Sales"],
  columns: [],
  measures: [{ name: "Total", dax: "SUM(Sales[Amount])" }],
  relationships: [],
  sourceLogical: new Set(),
  sourcePhysical: new Set(),
  hasRls: false,
  hasCalcGroups: false,
  systemGenerated: false,
};

describe("usage ingest — blank numeric cells are unknown, not zero (P0)", () => {
  it("parses a blank users/views/reports cell as undefined (not 0)", () => {
    const csv = ["datasetName,distinctUsers90d,views90d,downstreamReportCount", "Sales,,,"].join("\n");
    const { records } = ingestCsv(csv);
    expect(records).toHaveLength(1);
    expect(records[0].distinctUsers90d).toBeUndefined();
    expect(records[0].views90d).toBeUndefined();
    expect(records[0].downstreamReportCount).toBeUndefined();
  });

  it("still parses a genuine 0 as 0 (an explicit zero is real evidence)", () => {
    const csv = ["datasetName,distinctUsers90d,views90d", "Sales,0,0"].join("\n");
    const { records } = ingestCsv(csv);
    expect(records[0].distinctUsers90d).toBe(0);
    expect(records[0].views90d).toBe(0);
  });

  it("still strips thousands separators from a real number", () => {
    const csv = ["datasetName,views90d", "Sales,\"1,234\""].join("\n");
    const { records } = ingestCsv(csv);
    expect(records[0].views90d).toBe(1234);
  });
});

describe("materialDrift — withheld DAX is not a conflict (P0)", () => {
  it("does not flag measure-logic drift when the keeper's DAX is withheld (Scanner-sourced)", () => {
    // member = full TMDL (real DAX); keeper = admin Scanner (expressions withheld -> "")
    const member: ModelCard = { ...base, name: "Member", measures: [{ name: "Total", dax: "SUM(Sales[Amount])" }] };
    const keeper: ModelCard = { ...base, name: "Keeper", measures: [{ name: "Total", dax: "" }] };
    const dims = materialDrift(member, keeper).dims;
    expect(dims.some((d) => d.startsWith("measure logic differs"))).toBe(false);
  });

  it("does not flag drift when the member's DAX is withheld either", () => {
    const member: ModelCard = { ...base, name: "Member", measures: [{ name: "Total", dax: "" }] };
    const keeper: ModelCard = { ...base, name: "Keeper", measures: [{ name: "Total", dax: "SUM(Sales[Amount])" }] };
    expect(materialDrift(member, keeper).dims.some((d) => d.startsWith("measure logic differs"))).toBe(false);
  });

  it("still flags drift when BOTH sides have real, genuinely different DAX", () => {
    const member: ModelCard = { ...base, name: "Member", measures: [{ name: "Total", dax: "SUM(Sales[Amount])" }] };
    const keeper: ModelCard = { ...base, name: "Keeper", measures: [{ name: "Total", dax: "SUM(Sales[Net])" }] };
    expect(materialDrift(member, keeper).dims.some((d) => d.startsWith("measure logic differs"))).toBe(true);
  });
});
