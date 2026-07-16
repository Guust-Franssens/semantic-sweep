// Measured precision/recall over sample_models/, not just per-pair smoke assertions (mirrors
// tests/test_precision_recall.py). precision.test.ts and the engine/*.test.ts calibration-style
// tests pin individual pairs to expected bands one at a time; this file instead computes an
// explicit confusion matrix across ALL 15 pairs in the 6-model sample estate against a
// hand-labeled ground truth, so a change that keeps every individual pair assertion green but
// quietly trades recall for precision (or vice versa) across the whole estate is still caught.
//
// Ground truth (mirrors the intent in scripts/make_sample_models.py and test_calibration.py): the
// three "Commercial Sales" / "(rounded)" / "(truncated)" variants are deliberate near-duplicates of
// each other (3 positive pairs); every other pair -- including the partial-overlap "Sales Margin"
// and the fully-renamed "Revenue Report", both of which must still surface for human review -- is a
// true negative for the DUPLICATE_BANDS label specifically.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DUPLICATE_BANDS, scoreAll } from "@engine/index";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

const SAMPLE = join(__dirname, "..", "..", "..", "sample_models");

const DUPLICATE_FAMILY = new Set(["Commercial Sales", "Commercial Sales (rounded)", "Commercial Sales (truncated)"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

function loadSampleModels() {
  const inputs: InputFile[] = walk(SAMPLE)
    .filter((p) => p.endsWith(".tmdl") || p.endsWith(".platform") || p.endsWith(".pbism"))
    .map((p) => ({ path: relative(SAMPLE, p).split(sep).join("/"), text: readFileSync(p, "utf-8") }));
  return loadModelsFromFiles(inputs);
}

describe("remove-em-dashes-and-precision-recall — measured confusion matrix", () => {
  it("has perfect precision and recall over the 15 pairs in the sample estate", () => {
    const cards = loadSampleModels();
    expect(cards.length).toBe(6); // precondition: the fixture set hasn't silently grown/shrunk

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const pair of scoreAll(cards)) {
      const isDuplicatePair = DUPLICATE_FAMILY.has(pair.a.name) && DUPLICATE_FAMILY.has(pair.b.name);
      const flagged = DUPLICATE_BANDS.has(pair.band);
      if (isDuplicatePair && flagged) tp++;
      else if (isDuplicatePair && !flagged) fn++;
      else if (!isDuplicatePair && flagged) fp++;
      else tn++;
    }

    expect(tp + fp + fn + tn).toBe(15); // 6 choose 2
    expect([tp, fp, fn, tn]).toEqual([3, 0, 0, 12]);

    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    expect(precision).toBe(1);
    expect(recall).toBe(1);
    expect(f1).toBe(1);
  });
});
