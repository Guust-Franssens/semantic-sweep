// Web Worker entry: runs the pure similarity engine off the main thread.
//
// The O(n^2) pairwise scoring (scanCards) blocks the UI for tens of seconds once an estate reaches
// hundreds of models, freezing the progress bar and every interaction. Fetch + auth (MSAL) stay on
// the main thread; only the CPU-bound scoring/parsing runs here. The engine is pure TS (no DOM), so
// it executes identically in a worker — results are structurally cloned back (Sets clone natively;
// the shared card references inside pairs/clusters are preserved within a single postMessage).

import type { InputFile } from "@engine/parser";
import { enrichScanWithUsage, recommendScan, runScan, scanCards, type ScanResult } from "@engine/scan";
import { scannerToModels, type ScanResultBody } from "@engine/scanner";
import type { Usage } from "@engine/types";

export type ScanWorkerRequest =
  | { id: number; op: "runScan"; files: InputFile[] }
  | { id: number; op: "scanScanner"; body: ScanResultBody }
  | { id: number; op: "enrichUsage"; scan: ScanResult; records: Usage[] };

export type ScanWorkerResponse =
  | { id: number; ok: true; result: ScanResult }
  | { id: number; ok: false; error: string };

function handle(msg: ScanWorkerRequest): ScanResult {
  switch (msg.op) {
    case "runScan":
      return runScan(msg.files);
    case "scanScanner":
      // Mirrors the admin path's scoring tail (scannerToModels -> scanCards -> usage fusion).
      return recommendScan(scanCards(scannerToModels(msg.body)));
    case "enrichUsage":
      return enrichScanWithUsage(msg.scan, msg.records);
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as ScanWorkerRequest;
  try {
    const result = handle(msg);
    self.postMessage({ id: msg.id, ok: true, result } satisfies ScanWorkerResponse);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err) } satisfies ScanWorkerResponse);
  }
};
