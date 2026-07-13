import { describe, expect, it } from "vitest";
import { recsToCsv } from "../csv";
import { modelId, type ModelCard, type Recommendation } from "@engine/types";

// Minimal ModelCard — only the fields recsToCsv reads matter; the rest are stubbed.
function card(name: string, workspace: string, configuredBy?: string): ModelCard {
  return {
    name,
    workspace,
    usage: configuredBy ? { configuredBy, joinConfidence: "high" } : undefined,
  } as unknown as ModelCard;
}

function rec(over: Partial<Recommendation> & { member: ModelCard }): Recommendation {
  return {
    keeper: null,
    action: "retirement-candidate",
    reasonCodes: [],
    blockers: [],
    driftDims: [],
    driftCoverage: [],
    confidence: { overall: 0.9, usageLineage: 0.9, identityJoin: 0.9, metadataFidelity: 0.9 },
    savingsRefreshMinPerYear: 0,
    priority: 1,
    ...over,
  } as unknown as Recommendation;
}

describe("recsToCsv", () => {
  it("emits a header row + one row per recommendation with a BOM", () => {
    const m = card("Sales", "WS-A");
    const csv = recsToCsv([rec({ member: m, savingsRefreshMinPerYear: 120 })], {});
    const lines = csv.split("\r\n");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"Action"');
    expect(lines[0]).toContain('"Status"');
    expect(lines[1]).toContain('"Sales"');
    expect(lines[1]).toContain('"120"');
  });

  it("defaults Status to Proposed and reflects the per-model status map", () => {
    const a = card("A", "WS");
    const b = card("B", "WS");
    const csv = recsToCsv([rec({ member: a }), rec({ member: b })], { [modelId(b)]: "Approved" });
    const rows = csv.replace("\uFEFF", "").split("\r\n").slice(1);
    expect(rows[0].endsWith('"Proposed"')).toBe(true);
    expect(rows[1].endsWith('"Approved"')).toBe(true);
  });

  it("escapes embedded quotes, commas and newlines so cells survive Excel", () => {
    const m = card("Model, Inc.", "WS");
    const csv = recsToCsv(
      [rec({ member: m, reasonCodes: ['has "quotes"', "line1\nline2"] })],
      {},
    );
    const dataRow = csv.replace("\uFEFF", "").split("\r\n")[1];
    // comma inside the name stays inside its quoted cell
    expect(dataRow).toContain('"Model, Inc."');
    // embedded double-quotes are doubled
    expect(dataRow).toContain('has ""quotes""');
    // a newline inside a cell does not add a CSV record separator
    expect(dataRow).toContain("line1\nline2");
  });

  it("blanks out savings for actions that do not show savings", () => {
    const m = card("X", "WS");
    const csv = recsToCsv([rec({ member: m, action: "semantic-conflict", savingsRefreshMinPerYear: 999 })], {});
    const dataRow = csv.replace("\uFEFF", "").split("\r\n")[1];
    expect(dataRow).not.toContain("999");
  });
});
