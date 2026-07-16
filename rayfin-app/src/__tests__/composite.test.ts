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

  it("detects composite lineage from a parameterized AnalysisServices.Database(serverURL, ...) call", () => {
    // Real-world idiom (seen in Microsoft's own FUAM toolkit exports): the endpoint is a bare M query
    // parameter, not a literal string, and the dataset arg is an empty placeholder — the previous
    // literal-quotes-only regex silently failed to match this at all, so the file contributed nothing
    // to composite detection (a genuine false negative).
    const remote = `table Remote\n\tcolumn X\n\t\tdataType: string\n\t\tsourceColumn: X\n\n\tpartition Remote = m\n\t\tmode: directQuery\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = AnalysisServices.Database(serverURL, "", [Query=[Cube="Model"], Implementation="2.0"])\n\t\t\tin\n\t\t\t\tSource\n`;
    const files: InputFile[] = [
      ...baseFiles(),
      { path: "WS2.Workspace/Sales Report.SemanticModel/definition/tables/Remote.tmdl", text: remote },
    ];
    const cards = loadModelsFromFiles(files, true);
    const report = cards.find((c) => c.name === "Sales Report")!;
    // No literal dataset name and no `{[Name="…"]}[Data]` nav step here, so the name can't be
    // recovered — the regression check is that it's flagged as composite AT ALL.
    expect(report.derivedFrom).toEqual(["a Power BI dataset"]);
  });

  it("recovers the dataset name via nav step even when the AnalysisServices endpoint is parameterized", () => {
    const expr = `expression DatabaseQuery =\n\t\tlet\n\t\t\tSource = AnalysisServices.Databases(serverURL, [TypedConnectorSupport=null]),\n\t\t\tNav = Source{[Name="Sales Core"]}[Data]\n\t\tin\n\t\t\tNav\n`;
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

  it("does not suppress duplicate evidence via an ambiguous derivedFrom name shared by two unrelated models", () => {
    // Two UNRELATED models coincidentally both named "Sales Core" in different workspaces (e.g. the
    // same starter template cloned around the tenant). A composite model's derivedFrom references
    // "Sales Core" by name alone — that must not resolve to (and suppress evidence against) either one
    // when the full scan can see the name is ambiguous.
    const coreA = baseFiles(); // "Sales Core" in WS1.Workspace (from the shared helper)
    const coreBFact = `table Inventory\n\tcolumn Stock\n\t\tdataType: int64\n\t\tsummarizeBy: sum\n\t\tsourceColumn: Stock\n\n\tpartition Inventory = m\n\t\tmode: import\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = #table(type table [Stock = number], {{40}})\n\t\t\tin\n\t\t\t\tSource\n`;
    const coreBMeas = `table _Measures\n\tmeasure 'Stock Level' = SUM(Inventory[Stock])\n`;
    const coreB: InputFile[] = [
      { path: "WSB.Workspace/Sales Core.SemanticModel/definition/tables/Inventory.tmdl", text: coreBFact },
      { path: "WSB.Workspace/Sales Core.SemanticModel/definition/tables/_Measures.tmdl", text: coreBMeas },
    ];
    const remote = `table Remote\n\tcolumn X\n\t\tdataType: string\n\t\tsourceColumn: X\n\n\tpartition Remote = m\n\t\tmode: directQuery\n\t\tsource =\n\t\t\tlet\n\t\t\t\tSource = AnalysisServices.Database("pbiazure://api.powerbi.com/v1.0/myorg/WS1", "Sales Core")\n\t\t\tin\n\t\t\t\tSource\n`;
    const files: InputFile[] = [
      ...coreA,
      ...coreB,
      { path: "WSC.Workspace/Sales Report.SemanticModel/definition/tables/Remote.tmdl", text: remote },
    ];

    const scan = runScan(files);
    const report = scan.cards.find((c) => c.name === "Sales Report")!;
    // Parsing itself has no cross-model visibility, so the raw name is still recorded.
    expect(report.derivedFrom).toEqual(["Sales Core"]);

    const coreCardA = scan.cards.find((c) => c.name === "Sales Core" && c.workspace === "WS1.Workspace")!;
    const coreCardB = scan.cards.find((c) => c.name === "Sales Core" && c.workspace === "WSB.Workspace")!;
    const pairWith = (other: typeof coreCardA) =>
      scan.pairs.find((p) => (p.a === report && p.b === other) || (p.b === report && p.a === other))!;

    // scoreAll (used by runScan) has full-scan visibility: an ambiguous name match must not suppress.
    expect(pairWith(coreCardA).composite).toBe(false);
    expect(pairWith(coreCardB).composite).toBe(false);

    // A direct 2-arg scorePair call (no `cards` context, e.g. an ad-hoc caller) keeps trusting the
    // name match — this documents the intentional, backward-compatible default.
    expect(scorePair(report, coreCardA).composite).toBe(true);

    // The composite-link list surfaces the name but must not wrongly resolve `to` to either same-named model.
    const link = (scan.compositeLinks ?? []).find((l) => l.from.name === "Sales Report");
    expect(link?.toName).toBe("Sales Core");
    expect(link?.to).toBeUndefined();
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
