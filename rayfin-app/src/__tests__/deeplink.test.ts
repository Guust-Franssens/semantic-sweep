import { describe, expect, it } from "vitest";
import { fabricModelUrl } from "@engine/types";
import type { ModelCard } from "@engine/types";

const base: ModelCard = {
  name: "Sales",
  workspace: "Prod",
  tables: [],
  columns: [],
  measures: [],
  relationships: [],
  sourceLogical: new Set(),
  sourcePhysical: new Set(),
  hasRls: false,
  hasCalcGroups: false,
  systemGenerated: false,
};

describe("fabricModelUrl (imp-b2 deep link)", () => {
  it("returns null when identity is absent (drag-drop TMDL zip)", () => {
    expect(fabricModelUrl(base)).toBeNull();
    expect(fabricModelUrl({ ...base, workspaceId: "w1" })).toBeNull(); // needs BOTH ids
    expect(fabricModelUrl({ ...base, datasetId: "d1" })).toBeNull();
  });

  it("builds a portal deep link when a live scan populated both ids", () => {
    const url = fabricModelUrl({ ...base, workspaceId: "w1", datasetId: "d1" });
    expect(url).toBe("https://app.powerbi.com/groups/w1/datasets/d1/details");
  });
});
