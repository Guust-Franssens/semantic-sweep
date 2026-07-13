// Parity check: run the TS engine on ../models and diff against the Python out/results.json.
// Usage: npx tsx scripts/validate.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { runScan, toResults } from "../../engine/scan";
import type { InputFile } from "../../engine/parser";

const REPO = join(process.cwd(), "..");
const MODELS = join(REPO, "models");

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

const inputs: InputFile[] = walk(MODELS)
  .filter((p) => p.endsWith(".tmdl") || p.endsWith(".platform") || p.endsWith(".pbism"))
  .map((p) => ({ path: relative(MODELS, p).split(sep).join("/"), text: readFileSync(p, "utf-8") }));

const ts = toResults(runScan(inputs)) as any;
const py = JSON.parse(readFileSync(join(REPO, "out", "results.json"), "utf-8"));

let problems = 0;
const check = (label: string, a: unknown, b: unknown): void => {
  const eq = JSON.stringify(a) === JSON.stringify(b);
  if (!eq) {
    problems++;
    console.log(`MISMATCH ${label}:\n  TS: ${JSON.stringify(a)}\n  PY: ${JSON.stringify(b)}`);
  }
};

for (const k of ["models", "pairs", "organic_clusters", "promotion_chains", "system_generated"]) {
  check(`summary.${k}`, ts.summary[k], py.summary[k]);
}

const keyOf = (p: any): string => [p.a, p.b].sort().join(" ~ ");
const pyPairs = new Map(py.pairs.map((p: any) => [keyOf(p), p]));
const tsPairs = new Map(ts.pairs.map((p: any) => [keyOf(p), p]));
check("pairs.count(headline>=0.1)", ts.pairs.length, py.pairs.length);
let pairDiffs = 0;
for (const [k, pp] of pyPairs) {
  const tp: any = tsPairs.get(k);
  if (!tp) { console.log(`  PY pair missing in TS: ${k}`); pairDiffs++; continue; }
  if (tp.band !== (pp as any).band || Math.abs(tp.measure - (pp as any).measure) > 0.0011 ||
      Math.abs(tp.headline - (pp as any).headline) > 0.0011) {
    console.log(`  pair diff ${k}: TS[${tp.band},m=${tp.measure},h=${tp.headline}] PY[${(pp as any).band},m=${(pp as any).measure},h=${(pp as any).headline}]`);
    pairDiffs++;
  }
}
if (pairDiffs) { problems++; console.log(`  ${pairDiffs} pair diffs`); }

const clusterStr = (r: any): string =>
  JSON.stringify(r.organic_clusters.map((c: any) => [c.keep, [...c.members].sort()]).sort());
check("clusters", clusterStr(ts), clusterStr(py));

const chainStr = (r: any): string =>
  JSON.stringify(r.promotion_chains.map((c: any) => [c.item, c.environments, c.drift]).sort());
check("chains", chainStr(ts), chainStr(py));

console.log(`\nTS models=${ts.summary.models} pairs=${ts.summary.pairs} clusters=${ts.summary.organic_clusters} chains=${ts.summary.promotion_chains}`);
console.log(problems === 0 ? "PARITY OK" : `PARITY: ${problems} problem group(s)`);
process.exit(problems === 0 ? 0 : 1);
