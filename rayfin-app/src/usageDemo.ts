// Built-in "usage demo" estate: a controlled set of near-duplicate models that exercises every
// branch of the recommendation taxonomy once usage is fused in. Models are constructed as ModelCards
// directly (the TMDL parser is validated separately) so the fixture is deterministic; usage is
// ingested from the messy sample CSV to exercise the column mapper + join end-to-end.

import { findPromotionChains, organicClusters, scoreAll } from "@engine/index";
import { enrichScanWithUsage, type ScanResult } from "@engine/scan";
import { ingestCsv } from "@engine/usage";
import type { Column, Measure, ModelCard } from "@engine/types";
import { SAMPLE_USAGE_NOW, sampleUsageCsv } from "./sampleUsage";

const TABLES = ["Sales", "DimBrand", "DimDate", "DimMarket"];

const COLS: Column[] = [
  { table: "Sales", name: "VolumeHL", dataType: "double", hidden: false },
  { table: "Sales", name: "Amount", dataType: "decimal", hidden: false },
  { table: "Sales", name: "Discount", dataType: "decimal", hidden: false },
  { table: "DimBrand", name: "Brand", dataType: "string", hidden: false },
  { table: "DimDate", name: "Date", dataType: "dateTime", hidden: false },
  { table: "DimMarket", name: "Market", dataType: "string", hidden: false },
];

const REL = ["Sales\u0000DimBrand", "Sales\u0000DimDate", "Sales\u0000DimMarket"];

const BASE_MEASURES: Measure[] = [
  { name: "Total Volume (HL)", dax: "SUM ( Sales[VolumeHL] )" },
  { name: "Gross Revenue", dax: "SUM ( Sales[Amount] )" },
  { name: "Net Revenue", dax: "SUM ( Sales[Amount] ) - SUM ( Sales[Discount] )" },
  { name: "Avg Price / HL", dax: "DIVIDE ( [Net Revenue], [Total Volume (HL)] )" },
  {
    name: "YoY Growth %",
    dax: "DIVIDE ( [Net Revenue] - CALCULATE ( [Net Revenue], SAMEPERIODLASTYEAR ( DimDate[Date] ) ), CALCULATE ( [Net Revenue], SAMEPERIODLASTYEAR ( DimDate[Date] ) ) )",
  },
];

// Same measure NAMES, but Net Revenue silently drops the discount → will not tie out.
const DRIFT_MEASURES: Measure[] = BASE_MEASURES.map((m) =>
  m.name === "Net Revenue" ? { name: m.name, dax: "SUM ( Sales[Amount] )" } : { ...m },
);

function makeCard(name: string, workspace: string, measures: Measure[] = BASE_MEASURES): ModelCard {
  return {
    name,
    workspace,
    tables: [...TABLES],
    columns: COLS.map((c) => ({ ...c })),
    measures: measures.map((m) => ({ ...m })),
    relationships: [...REL],
    sourceLogical: new Set<string>(),
    sourcePhysical: new Set<string>(["wh.contoso.com\u0000gold"]),
    hasRls: false,
    hasCalcGroups: false,
    systemGenerated: false,
  };
}

function demoCards(): ModelCard[] {
  return [
    makeCard("Sales Performance", "Sales Analytics"), // -> usage keeper (certified, most-used)
    makeCard("Sales Performance (copy)", "Sales West"), // -> retirement candidate (unused, dormant >1yr)
    makeCard("Depletions Dashboard", "Sales West"), // -> merge (has an audience)
    makeCard("Regional Sales", "Sales East"), // -> governance conflict (certified duplicate)
    makeCard("Sales Performance QBR", "Exec Reporting"), // -> insufficient evidence (quarterly; protected)
    makeCard("Sales Perf v2", "Sales West", DRIFT_MEASURES), // -> semantic conflict (Net Revenue drift)
  ];
}

export const USAGE_DEMO_NOW = SAMPLE_USAGE_NOW;

export function usageDemoScan(): ScanResult {
  const cards = demoCards();
  const pairs = scoreAll(cards);
  const clusters = organicClusters(cards, pairs);
  const chains = findPromotionChains(cards, pairs);
  const base: ScanResult = { cards, pairs, clusters, chains, emptyModels: [] };
  const { records } = ingestCsv(sampleUsageCsv);
  return enrichScanWithUsage(base, records, { now: Date.parse(USAGE_DEMO_NOW) });
}
