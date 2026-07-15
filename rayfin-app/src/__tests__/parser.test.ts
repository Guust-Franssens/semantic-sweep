import { describe, expect, it } from "vitest";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

// The TMDL exporter emits a whitespace-only line immediately after `measure X =`, before the body.
// That blank line must NOT terminate the expression block: it previously truncated ~38% of measures
// on real estates (FUAM_Core lost 172/270), silently emptying the strongest similarity facet.
function multilineModel(): InputFile[] {
  const metrics =
    "table Metrics\n" +
    "\tmeasure '# Capacities' =\n" +
    "\t\t\t\n" +
    "\t\t\tCALCULATE(\n" +
    "\t\t\t    COUNT(capacities[CapacityId]),\n" +
    "\t\t\t    capacities[fuam_deleted] = FALSE()\n" +
    "\t\t\t    )\n" +
    "\t\tformatString: #,0\n" +
    "\tmeasure 'Revenue YoY %' =\n" +
    "\t\t\tVAR _cur = [Revenue]\n" +
    "\t\t\tVAR _prior = CALCULATE([Revenue], DATEADD('Date'[Date], -1, YEAR))\n" +
    "\t\t\tRETURN DIVIDE(_cur - _prior, _prior)\n" +
    "\t\tformatString: 0.0%\n" +
    "\tmeasure 'Total Sales' = SUM(Sales[Amount])\n";
  return [{ path: "WS.Workspace/FUAM Core.SemanticModel/definition/tables/Metrics.tmdl", text: metrics }];
}

describe("multi-line DAX parsing (leading blank line)", () => {
  const cards = loadModelsFromFiles(multilineModel(), true);
  const card = cards.find((c) => c.name === "FUAM Core")!;

  it("captures the full CALCULATE body, not an empty string", () => {
    const cap = card.measures.find((m) => m.name === "# Capacities")!;
    expect(cap.dax).toContain("CALCULATE(");
    expect(cap.dax).toContain("capacities[CapacityId]");
    expect(cap.dax).not.toContain("formatString"); // a child property must not leak into the expression
  });

  it("captures a VAR/RETURN body across multiple lines", () => {
    const yoy = card.measures.find((m) => m.name === "Revenue YoY %")!;
    expect(yoy.dax.startsWith("VAR _cur = [Revenue]")).toBe(true);
    expect(yoy.dax).toContain("RETURN DIVIDE(_cur - _prior, _prior)");
    expect(yoy.dax).not.toContain("displayFolder");
  });

  it("leaves single-line measures unchanged", () => {
    const tot = card.measures.find((m) => m.name === "Total Sales")!;
    expect(tot.dax).toBe("SUM(Sales[Amount])");
  });
});
