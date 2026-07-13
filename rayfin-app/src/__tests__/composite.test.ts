import { describe, expect, it } from "vitest";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";
import { scorePair } from "@engine/index";
import { runScan, scanCards } from "@engine/scan";
import { scannerToModels, type ScanResultBody } from "@engine/scanner";

// Minimal TMDL for a base model + a composite (DirectQuery-to-dataset) model built on it.
function baseFiles(): InputFile[] {
  const fact = `table Sales\n\tcolumn Amount\n\t\tdataType: double\n\t\tsummarizeBy: sum\n\t\tsourceColumn: Amount\n\n\tpartition Sales = m\n\t\tmode: import\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = #table(type table [Amount = number], {{1250.0}})\n\t\t\tin\n\t\t\t\tSource\n`;
  const meas = `table _Measures\n\tmeasure 'Total Sales' = SUM(Sales[Amount])\n\tmeasure 'Sales YTD' = TOTALYTD([Total Sales], 'Sales'[Amount])\n`;
  return [
    { path: "WS1.Workspace/Sales Core.SemanticModel/definition/tables/Sales.tmdl", text: fact },
    { path: "WS1.Workspace/Sales Core.SemanticModel/definition/tables/_Measures.tmdl", text: meas },
  ];
}

describe("composite / chained model detection", () => {
  it("resolves an inline AnalysisServices.Database(endpoint, dataset) reference", () => {
    const remote = `table Remote\n\tcolumn X\n\t\tdataType: string\n\t\tsourceColumn: X\n\n\tpartition Remote = m\n\t\tmode: directQuery\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = AnalysisServices.Database("pbiazure://api.powerbi.com/v1.0/myorg/WS1", "Sales Core")\n\t\t\tin\n\t\t\t\tSource\n`;
    const files: InputFile[] = [
      ...baseFiles(),
      { path: "WS2.Workspace/Sales Report.SemanticModel/definition/tables/Remote.tmdl", text: remote },
    ];
    const cards = loadModelsFromFiles(files, true);
    const report = cards.find((c) => c.name === "Sales Report")!;
    expect(report.derivedFrom).toEqual(["Sales Core"]);
  });

  it("recovers the dataset name from the M navigation step of AnalysisServices.Databases(endpoint)", () => {
    const expr = `expression DatabaseQuery =\n\t\tlet\n\t\t\tSource = AnalysisServices.Databases("pbiazure://api.powerbi.com/v1.0/myorg/WS1", [TypedConnectorSupport=null]),\n\t\t\tNavWS = Source{[Name="WS1"]}[Data],\n\t\t\tNavDS = NavWS{[Name="Sales Core"]}[Data]\n\t\tin\n\t\t\tNavDS\n`;
    const tbl = `table Sales\n\tcolumn Amount\n\t\tdataType: double\n\t\tsourceColumn: Amount\n\n\tpartition Sales = entity\n\t\tmode: directQuery\n\t\tsource\n\t\t\tentityName: Sales\n\t\t\texpressionSource: DatabaseQuery\n`;
    const files: InputFile[] = [
      ...baseFiles(),
      { path: "WS3.Workspace/Sales Extended.SemanticModel/definition/expressions.tmdl", text: expr },
      { path: "WS3.Workspace/Sales Extended.SemanticModel/definition/tables/Sales.tmdl", text: tbl },
    ];
    const cards = loadModelsFromFiles(files, true);
    const ext = cards.find((c) => c.name === "Sales Extended")!;
    expect(ext.derivedFrom).toEqual(["Sales Core"]);
  });

  it("flags the parent-child pair as composite lineage and keeps it out of organic clusters", () => {
    // A composite model that re-exposes the base schema + measures => strong-duplicate band, but it
    // is intentional lineage (derivedFrom the base), so it must NOT be reported as a consolidation cluster.
    const expr = `expression DatabaseQuery =\n\t\tlet\n\t\t\tSource = AnalysisServices.Databases("pbiazure://api.powerbi.com/v1.0/myorg/WS1", [TypedConnectorSupport=null]),\n\t\t\tNav = Source{[Name="Sales Core"]}[Data]\n\t\tin\n\t\t\tNav\n`;
    const tbl = `table Sales\n\tcolumn Amount\n\t\tdataType: double\n\t\tsourceColumn: Amount\n\n\tpartition Sales = entity\n\t\tmode: directQuery\n\t\tsource\n\t\t\tentityName: Sales\n\t\t\texpressionSource: DatabaseQuery\n`;
    const meas = `table _Measures\n\tmeasure 'Total Sales' = SUM(Sales[Amount])\n\tmeasure 'Sales YTD' = TOTALYTD([Total Sales], 'Sales'[Amount])\n`;
    const files: InputFile[] = [
      ...baseFiles(),
      { path: "WS4.Workspace/Sales Layer.SemanticModel/definition/expressions.tmdl", text: expr },
      { path: "WS4.Workspace/Sales Layer.SemanticModel/definition/tables/Sales.tmdl", text: tbl },
      { path: "WS4.Workspace/Sales Layer.SemanticModel/definition/tables/_Measures.tmdl", text: meas },
    ];
    const scan = runScan(files);
    const layer = scan.cards.find((c) => c.name === "Sales Layer")!;
    const core = scan.cards.find((c) => c.name === "Sales Core")!;

    const pair = scorePair(layer, core);
    expect(pair.composite).toBe(true);
    expect(["strong-duplicate", "exact-clone"]).toContain(pair.band); // would cluster if not suppressed

    // The composite link is surfaced, and neither model is clustered as an organic duplicate.
    expect((scan.compositeLinks ?? []).some((l) => l.from.name === "Sales Layer" && l.to?.name === "Sales Core")).toBe(true);
    const clustered = scan.clusters.some((cl) => cl.members.some((m) => m.name === "Sales Layer" || m.name === "Sales Core"));
    expect(clustered).toBe(false);
  });
});

describe("composite detection on the admin Scanner path", () => {
  // Mirrors the real Admin Scanner (getInfo/scanResult) shape observed for a DirectQuery-to-dataset
  // composite: the composite dataset references an AnalysisServices datasourceInstance whose
  // `database` is the upstream model name and `server` is a pbiazure endpoint. NOTE the Scanner keys
  // the instance by `datasourceId`, but the dataset references it by `datasourceInstanceId`.
  const M = (name: string, expression: string) => ({ name, expression });
  const BASE_MEAS = [
    M("Total Volume (HL)", "SUM(FactSales[VolumeHL])"),
    M("Net Revenue", "SUM(FactSales[NetRevenue])"),
    M("Total Discount", "SUM(FactSales[Discount])"),
    M("Gross Revenue", "SUM(FactSales[NetRevenue]) + SUM(FactSales[Discount])"),
    M("Avg Revenue per HL", "DIVIDE(SUM(FactSales[NetRevenue]), SUM(FactSales[VolumeHL]))"),
  ];
  const tables = (extra: ReturnType<typeof M>[] = []) => [
    { name: "FactSales", columns: [{ name: "VolumeHL", dataType: "Double" }, { name: "NetRevenue", dataType: "Double" }, { name: "Discount", dataType: "Double" }] },
    { name: "DimBrand", columns: [{ name: "BrandKey", dataType: "Int64" }, { name: "Brand", dataType: "String" }] },
    { name: "_Measures", columns: [{ name: "_dummy", dataType: "Int64", isHidden: true }], measures: [...BASE_MEAS, ...extra] },
  ];
  const INSTANCE_ID = "81550314-baa9-4e26-9527-b75828c69020";
  const body = (): ScanResultBody => ({
    workspaces: [
      {
        id: "ws-guid",
        name: "SS_DEMO Composite",
        state: "Active",
        datasets: [
          { id: "base-id", name: "Sales Core", tables: tables() },
          {
            id: "comp-id",
            name: "Sales Executive Cockpit",
            tables: tables([M("Revenue vs Target %", "DIVIDE([Net Revenue], 1000000)")]),
            datasourceUsages: [{ datasourceInstanceId: INSTANCE_ID }],
          },
        ],
      },
    ],
    datasourceInstances: [
      {
        datasourceType: "AnalysisServices",
        connectionDetails: { server: "pbiazure://api.powerbi.com/v1.0/myorg/ws-guid", database: "Sales Core" },
        datasourceId: INSTANCE_ID,
      },
    ],
  });

  it("sets derivedFrom on the composite dataset from its AnalysisServices datasource lineage", () => {
    const cards = scannerToModels(body());
    const comp = cards.find((c) => c.name === "Sales Executive Cockpit")!;
    expect(comp.derivedFrom).toEqual(["Sales Core"]);
    const base = cards.find((c) => c.name === "Sales Core")!;
    expect(base.derivedFrom).toBeUndefined(); // the base import model has no upstream

    // Regression: the datasource instance is keyed by `datasourceId`, so physical source must resolve
    // (the previous `datasourceInstanceId`-keyed map left it silently empty on the admin path).
    expect(comp.sourcePhysical.size).toBeGreaterThan(0);
  });

  it("surfaces the composite link and suppresses the pair from organic clusters", () => {
    const scan = scanCards(scannerToModels(body()));
    const comp = scan.cards.find((c) => c.name === "Sales Executive Cockpit")!;
    const base = scan.cards.find((c) => c.name === "Sales Core")!;

    const pair = scorePair(comp, base);
    expect(pair.composite).toBe(true);
    expect(["strong-duplicate", "exact-clone"]).toContain(pair.band); // would cluster if not suppressed

    expect((scan.compositeLinks ?? []).some((l) => l.from.name === "Sales Executive Cockpit" && l.to?.name === "Sales Core")).toBe(true);
    const clustered = scan.clusters.some((cl) => cl.members.some((m) => m.name === "Sales Executive Cockpit" || m.name === "Sales Core"));
    expect(clustered).toBe(false);
  });
});
