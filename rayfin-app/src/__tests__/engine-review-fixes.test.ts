import { describe, expect, it } from "vitest";
import { materialDrift } from "@engine/recommend";
import { ingestCsv, joinUsage, mergeUsage } from "@engine/usage";
import { findPromotionChains, scoreAll } from "@engine/index";
import type { ModelCard, Usage } from "@engine/types";

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

describe("materialDrift — relationship drift not masked by an empty keeper (P1)", () => {
  it("flags drift when a TMDL keeper genuinely has no relationships but the member does", () => {
    const member: ModelCard = { ...base, name: "M", relationships: ["a\u0000b"], relationshipsKnown: true };
    const keeper: ModelCard = { ...base, name: "K", relationships: [], relationshipsKnown: true };
    expect(materialDrift(member, keeper).dims).toContain("relationship set differs");
  });

  it("does NOT flag relationship drift when the keeper is Scanner-sourced (relationships unknown)", () => {
    const member: ModelCard = { ...base, name: "M", relationships: ["a\u0000b"], relationshipsKnown: true };
    const keeper: ModelCard = { ...base, name: "K", relationships: [], relationshipsKnown: false };
    expect(materialDrift(member, keeper).dims).not.toContain("relationship set differs");
  });
});

describe("mergeUsage — CSV overlay preserves Scanner governance (P1)", () => {
  it("keeps base endorsement/lineage where the overlay is blank, and takes the stronger join", () => {
    const scanner: Usage = {
      datasetName: "Sales",
      workspaceName: "WS",
      endorsement: "Certified",
      downstreamReportCount: 3,
      joinConfidence: "high",
    };
    const csv: Usage = {
      datasetName: "Sales",
      workspaceName: "",
      distinctUsers90d: 0,
      views90d: 0,
      joinConfidence: "low",
    };
    const m = mergeUsage(scanner, csv);
    expect(m.endorsement).toBe("Certified"); // preserved from Scanner
    expect(m.downstreamReportCount).toBe(3); // preserved from Scanner
    expect(m.distinctUsers90d).toBe(0); // added from CSV
    expect(m.joinConfidence).toBe("high"); // stronger of the two identities
  });
});

describe("joinUsage — no double-attach, ambiguity counted (P1)", () => {
  const usageRow = (over: Partial<Usage>): Usage => ({ datasetName: "Sales", workspaceName: "", joinConfidence: "none", ...over });

  it("attaches a single name-only record to just ONE of two same-named cards (no shared object)", () => {
    const cards: ModelCard[] = [
      { ...base, name: "Sales", workspace: "A", datasetId: undefined },
      { ...base, name: "Sales", workspace: "B", datasetId: undefined },
    ];
    joinUsage(cards, [usageRow({})]);
    expect(cards.filter((c) => c.usage)).toHaveLength(1);
  });

  it("counts a duplicate-GUID collision as ambiguous and does not attach", () => {
    const cards: ModelCard[] = [{ ...base, name: "X", datasetId: "g1" }];
    const report = joinUsage(cards, [usageRow({ datasetName: "X", datasetId: "g1" }), usageRow({ datasetName: "X", datasetId: "g1" })]);
    expect(report.ambiguous).toBe(1);
    expect(cards[0].usage).toBeUndefined();
  });
});

describe("findPromotionChains — measureless lifecycle models are not false 'drift' (P1)", () => {
  it("does not flag drift for two identical measureless models across dev/prod", () => {
    const dev: ModelCard = {
      ...base,
      name: "Lakehouse Model",
      workspace: "Sales Dev",
      measures: [],
      tables: ["T"],
      columns: [{ table: "T", name: "C", dataType: "int64", hidden: false }],
    };
    const prod: ModelCard = { ...dev, workspace: "Sales Prod" };
    const chains = findPromotionChains([dev, prod], scoreAll([dev, prod]));
    expect(chains).toHaveLength(1);
    expect(chains[0].drift).toBe(false);
  });
});
