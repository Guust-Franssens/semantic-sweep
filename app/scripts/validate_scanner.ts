// Slice 1b validation: parse a synthetic Admin Scanner payload into models and run the pipeline.
// Usage: npx tsx scripts/validate_scanner.ts
import { recommendScan, scanCards } from "../../engine/scan";
import { scannerToModels, type ScanResultBody } from "../../engine/scanner";
import { REC_LABELS } from "../../engine/recommend";
import { modelId } from "../../engine/types";

// Two near-duplicate sales models across two workspaces (one certified) + a certified original,
// plus datasource instances and report lineage. No relationships/consumption (as a real scan).
const BODY: ScanResultBody = {
  datasourceInstances: [
    { datasourceInstanceId: "ds1", datasourceType: "Sql", connectionDetails: { server: "wh.contoso.com", database: "gold" } },
  ],
  workspaces: [
    {
      id: "w1",
      name: "Sales Analytics",
      state: "Active",
      reports: [{ id: "r1", datasetId: "m1" }, { id: "r2", datasetId: "m1" }],
      datasets: [
        {
          id: "m1",
          name: "Sales Performance",
          configuredBy: "maria@contoso.com",
          endorsementDetails: { endorsement: "Certified" },
          createdDate: "2024-02-11",
          datasourceUsages: [{ datasourceInstanceId: "ds1" }],
          tables: [
            {
              name: "Sales",
              columns: [{ name: "Amount", dataType: "Decimal" }, { name: "VolumeHL", dataType: "Double" }],
              measures: [
                { name: "Net Revenue", expression: "SUM ( Sales[Amount] ) - SUM ( Sales[Discount] )" },
                { name: "Total Volume", expression: "SUM ( Sales[VolumeHL] )" },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "w2",
      name: "Sales West",
      state: "Active",
      reports: [],
      datasets: [
        {
          id: "m2",
          name: "Sales Performance (copy)",
          configuredBy: "sam@contoso.com",
          datasourceUsages: [{ datasourceInstanceId: "ds1" }],
          tables: [
            {
              name: "Sales",
              columns: [{ name: "Amount", dataType: "Decimal" }, { name: "VolumeHL", dataType: "Double" }],
              measures: [
                { name: "Net Revenue", expression: "SUM ( Sales[Amount] ) - SUM ( Sales[Discount] )" },
                { name: "Total Volume", expression: "SUM ( Sales[VolumeHL] )" },
              ],
            },
          ],
        },
        {
          id: "m3",
          name: "Sales Performance (certified dup)",
          configuredBy: "priya@contoso.com",
          endorsementDetails: { endorsement: "Certified" },
          datasourceUsages: [{ datasourceInstanceId: "ds1" }],
          tables: [
            {
              name: "Sales",
              columns: [{ name: "Amount", dataType: "Decimal" }, { name: "VolumeHL", dataType: "Double" }],
              measures: [
                { name: "Net Revenue", expression: "SUM ( Sales[Amount] ) - SUM ( Sales[Discount] )" },
                { name: "Total Volume", expression: "SUM ( Sales[VolumeHL] )" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const cards = scannerToModels(BODY);
const scan = recommendScan(scanCards(cards));

console.log(`cards=${cards.length} clusters=${scan.clusters.length}`);
for (const c of cards) {
  console.log(`  ${modelId(c)} tables=${c.tables.length} measures=${c.measures.length} src=${[...c.sourcePhysical].join("|")} endorse=${c.usage?.endorsement ?? "-"} reports=${c.usage?.downstreamReportCount}`);
}
for (const r of scan.recommendations ?? []) {
  console.log(`  [${REC_LABELS[r.action]}] ${modelId(r.member)} — ${r.reasonCodes.join(" | ")}`);
}

let fail = 0;
const expect = (label: string, cond: boolean): void => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fail++;
};
const byMember = new Map((scan.recommendations ?? []).map((r) => [modelId(r.member), r]));

expect("3 cards parsed", cards.length === 3);
expect("columns carry dataType", cards[0].columns.every((c) => c.dataType));
expect("measures carry DAX", cards[0].measures.every((m) => m.dax.length > 0));
expect("physical source mapped from datasource instance", [...cards[0].sourcePhysical][0] === "wh.contoso.com\u0000gold");
expect("keeper report lineage counted (2)", cards.find((c) => c.name === "Sales Performance")?.usage?.downstreamReportCount === 2);
expect("one duplicate cluster formed", scan.clusters.length === 1);
expect("plain copy -> insufficient-evidence (no consumption data)", byMember.get("Sales West/Sales Performance (copy)")?.action === "insufficient-evidence");
expect("certified dup -> governance-conflict", byMember.get("Sales West/Sales Performance (certified dup)")?.action === "governance-conflict");

console.log(fail === 0 ? "\nSCANNER OK" : `\nSCANNER: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
