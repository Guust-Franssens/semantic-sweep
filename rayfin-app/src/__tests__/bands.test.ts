import { describe, expect, it } from "vitest";
import { BAND_META, bandRgbTable, hexToRgb } from "../bands";

describe("hexToRgb (P2 a11y — per-band heatmap coloring)", () => {
  it("parses a 6-digit hex color into an r,g,b triple", () => {
    expect(hexToRgb("#c50f1f")).toBe("197,15,31"); // --cp-danger (light)
    expect(hexToRgb("#bc4b09")).toBe("188,75,9"); // --cp-warning (light)
  });

  it("parses a 3-digit shorthand hex color", () => {
    expect(hexToRgb("#0f6")).toBe("0,255,102");
  });

  it("parses without a leading #", () => {
    expect(hexToRgb("6366f1")).toBe("99,102,241");
  });

  it("falls back to a neutral gray for an empty or unresolved value", () => {
    expect(hexToRgb("")).toBe("107,114,128");
    expect(hexToRgb("var(--cp-danger)")).toBe("107,114,128");
    expect(hexToRgb("not-a-color")).toBe("107,114,128");
  });
});

describe("bandRgbTable (P2 a11y)", () => {
  it("returns one valid r,g,b entry per band declared in BAND_META", () => {
    const table = bandRgbTable(document.documentElement);
    for (const band of Object.keys(BAND_META)) {
      expect(table[band]).toMatch(/^\d{1,3},\d{1,3},\d{1,3}$/);
    }
  });
});
