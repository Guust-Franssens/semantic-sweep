// Slice 1a validation: run the usage x similarity fusion over the built-in usage demo estate and
// assert the recommendation taxonomy fires correctly. Usage: npx tsx scripts/validate_usage.ts
import { REC_LABELS } from "../../engine/recommend";
import { modelId } from "../../engine/types";
import { usageDemoScan } from "../src/usageDemo";

const scan = usageDemoScan();

console.log(`models=${scan.cards.length} clusters=${scan.clusters.length} chains=${scan.chains.length}`);
console.log("join:", JSON.stringify(scan.joinReport));

for (const cl of scan.clusters) {
  console.log(`\ncluster keeper=${modelId(cl.usageKeeper ?? cl.keep)} basis="${cl.keeperBasis ?? ""}"`);
  for (const r of cl.recommendations ?? []) {
    console.log(
      `  [${REC_LABELS[r.action]}] ${modelId(r.member)}  conf=${r.confidence.overall} save=${r.savingsRefreshMinPerYear}min/yr`,
    );
    console.log(`      why: ${r.reasonCodes.join(" | ")}`);
    if (r.blockers.length) console.log(`      blockers: ${r.blockers.join(" | ")}`);
  }
}

// ---- assertions (the six taxonomy branches) ----
const recs = scan.recommendations ?? [];
const byMember = new Map(recs.map((r) => [modelId(r.member), r]));
let fail = 0;
const expect = (label: string, cond: boolean): void => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fail++;
};

expect("6 models, 1 cluster", scan.cards.length === 6 && scan.clusters.length === 1);
expect("keeper = certified, most-used Sales Performance", scan.clusters[0]?.usageKeeper?.name === "Sales Performance");
expect("join: 6 matched at medium (workspace+name)", scan.joinReport?.matched === 6 && scan.joinReport?.byTier.medium === 6);
expect("Sales Performance (copy) -> retirement-candidate", byMember.get("Sales West/Sales Performance (copy)")?.action === "retirement-candidate");
expect("retirement-candidate carries refresh savings", (byMember.get("Sales West/Sales Performance (copy)")?.savingsRefreshMinPerYear ?? 0) > 0);
expect("Depletions Dashboard -> merge (has audience)", byMember.get("Sales West/Depletions Dashboard")?.action === "merge");
expect("Regional Sales -> governance-conflict (certified)", byMember.get("Sales East/Regional Sales")?.action === "governance-conflict");
expect("Sales Performance QBR -> insufficient-evidence (quarterly protect)", byMember.get("Exec Reporting/Sales Performance QBR")?.action === "insufficient-evidence");
expect("Sales Perf v2 -> semantic-conflict (drift trumps usage)", byMember.get("Sales West/Sales Perf v2")?.action === "semantic-conflict");

console.log(fail === 0 ? "\nUSAGE FUSION OK" : `\nUSAGE FUSION: ${fail} assertion(s) failed`);
process.exit(fail === 0 ? 0 : 1);
