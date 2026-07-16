import { describe, expect, it } from "vitest";
import { materialDrift, recommendCluster } from "@engine/recommend";
import type { Cluster, ModelCard } from "@engine/types";

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

describe("materialDrift — calc-group unknown-safety (P1)", () => {
  it("does not flag calc-group drift when one side's status is unknown (Scanner-sourced)", () => {
    const a: ModelCard = { ...base, hasCalcGroups: true };
    const b: ModelCard = { ...base, hasCalcGroups: undefined };
    expect(materialDrift(a, b).dims).not.toContain("calc groups present on one side only");
  });

  it("still flags calc-group drift when both sides know the status and it genuinely differs", () => {
    const a: ModelCard = { ...base, hasCalcGroups: true };
    const b: ModelCard = { ...base, hasCalcGroups: false };
    expect(materialDrift(a, b).dims).toContain("calc groups present on one side only");
  });
});

describe("recommendCluster — metadataFidelity reflects scan health, not a blind 1 (P1)", () => {
  const keeperMeasures = [
    { name: "Total", dax: "SUM(Sales[Amount])" },
    { name: "Count", dax: "COUNTROWS(Sales)" },
  ];

  it("scores full fidelity (1) when both cards are full TMDL exports", () => {
    const keeper: ModelCard = { ...base, name: "Keeper", measures: keeperMeasures };
    const member: ModelCard = { ...base, name: "Member" };
    const cluster: Cluster = { members: [member, keeper], keep: keeper, pairs: [] };
    const [rec] = recommendCluster(cluster);
    expect(rec.confidence.metadataFidelity).toBe(1);
  });

  it("discounts fidelity when the member's calc-group status is merely unknown (Scanner-derived)", () => {
    const keeper: ModelCard = { ...base, name: "Keeper", measures: keeperMeasures };
    const member: ModelCard = { ...base, name: "Member", hasCalcGroups: undefined };
    const cluster: Cluster = { members: [member, keeper], keep: keeper, pairs: [] };
    const [rec] = recommendCluster(cluster);
    expect(rec.confidence.metadataFidelity).toBeLessThan(1);
  });

  it("discounts fidelity further when the Scanner flagged the schema retrieval as failed", () => {
    const keeper: ModelCard = { ...base, name: "Keeper", measures: keeperMeasures };
    const member: ModelCard = { ...base, name: "Member", hasCalcGroups: undefined, schemaRetrievalError: "timeout" };
    const cluster: Cluster = { members: [member, keeper], keep: keeper, pairs: [] };
    const [rec] = recommendCluster(cluster);
    expect(rec.confidence.metadataFidelity).toBeLessThan(0.85);
  });
});
