// Main-thread client for the scan worker: exposes the CPU-bound engine calls as promises that resolve
// off the UI thread, so the progress bar and interactions stay smooth on large estates.
//
// Falls back to the synchronous engine when Workers are unavailable (jsdom/vitest, SSR) or if the
// worker fails to start — identical results, just on the main thread. Tests import the engine
// directly and never touch this client, so the fallback keeps them worker-free.

import type { InputFile } from "@engine/parser";
import { enrichScanWithUsage, recommendScan, runScan, scanCards, type ScanResult } from "@engine/scan";
import { scannerToModels, type ScanResultBody } from "@engine/scanner";
import type { Usage } from "@engine/types";
import type { ScanWorkerRequest, ScanWorkerResponse } from "./scanWorker";

let worker: Worker | null = null;
let broken = typeof Worker === "undefined"; // no Worker (tests/SSR) -> always run synchronously
let seq = 0;
const pending = new Map<number, { resolve: (v: ScanResult) => void; reject: (e: unknown) => void }>();

function failAll(err: unknown): void {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
  worker = null;
  broken = true; // subsequent calls take the synchronous path
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<ScanWorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  w.onerror = (e: ErrorEvent) => failAll(e.error ?? new Error("scan worker crashed"));
  worker = w;
  return w;
}

// Omit must distribute over the discriminated union, else it collapses to the common `op` key only.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function call(req: DistributiveOmit<ScanWorkerRequest, "id">): Promise<ScanResult> {
  const id = ++seq;
  return new Promise<ScanResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...req, id });
  });
}

export function runScanAsync(files: InputFile[]): Promise<ScanResult> {
  if (broken) return Promise.resolve(runScan(files));
  return call({ op: "runScan", files });
}

export function scanScannerAsync(body: ScanResultBody): Promise<ScanResult> {
  if (broken) return Promise.resolve(recommendScan(scanCards(scannerToModels(body))));
  return call({ op: "scanScanner", body });
}

export function enrichScanWithUsageAsync(scan: ScanResult, records: Usage[]): Promise<ScanResult> {
  if (broken) return Promise.resolve(enrichScanWithUsage(scan, records));
  return call({ op: "enrichUsage", scan, records });
}
