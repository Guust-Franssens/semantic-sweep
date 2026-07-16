import { describe, expect, it } from "vitest";
import { modeChipLabel } from "../scanModeLabels";

describe("modeChipLabel (P2 a11y — saved-scan chips must not show raw internal tokens)", () => {
  it("maps every known SaveScanMeta mode token to a human phrase", () => {
    expect(modeChipLabel("admin")).toBe("Admin scan");
    expect(modeChipLabel("tenant")).toBe("Per-user scan");
    expect(modeChipLabel("zip")).toBe("Imported");
    expect(modeChipLabel("usage")).toBe("Usage fused");
    expect(modeChipLabel("scan")).toBe("Scan");
  });

  it("falls back to the raw value for an unrecognized token instead of throwing", () => {
    expect(modeChipLabel("future-mode")).toBe("future-mode");
  });
});
