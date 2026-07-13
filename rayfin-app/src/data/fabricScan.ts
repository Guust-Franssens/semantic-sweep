// Shared Fabric estate scan orchestration: probe the user's access level, then take the widest path
// available — a tenant-wide Admin Scanner read (all capacities, no getDefinition) when the app has the
// Tenant.Read.All admin scope, else a per-user TMDL export of the workspaces this user can open. Both
// the first-run ConnectGate and the in-app "Re-scan" button call this, so the two paths never drift.

import { getFabricToken } from "./fabricAuth";
import { type AdminProbe, exportWorkspaces, type ExportFailure, fetchTenantAdminBody, listWorkspaces, probeAdminScan, type TokenProvider } from "./fabric";
import type { ScanResult } from "@engine/scan";
import { runScanAsync, scanScannerAsync } from "../worker/scanClient";

// The signed-in user's token, re-acquired silently on demand (and force-refreshed by the fetch layer
// on a mid-scan 401) so a long estate scan doesn't start failing once the ~1h token lifetime elapses.
export const fabricProvider: TokenProvider = (o) => getFabricToken(o);

export type ScanProgress = (done: number, total: number, label: string) => void;

export interface FabricScanOutcome {
  result: ScanResult; // scored, ready to render
  label: string; // human source label (drives the scan-scope pill)
  skipped: ExportFailure[]; // models that couldn't be exported (e.g. paused capacity)
  admin: AdminProbe; // access-level probe result (drives the capability pill)
}

// Run one full scan. `onProgress` streams status; `onAdmin` (optional) fires the moment the access
// probe resolves so the UI can show the capability pill before the (potentially long) scan finishes.
export async function scanFabricEstate(
  provider: TokenProvider,
  onProgress: ScanProgress,
  onAdmin?: (probe: AdminProbe) => void,
): Promise<FabricScanOutcome> {
  onProgress(0, 0, "Checking your access level…");
  const admin = await probeAdminScan(provider);
  onAdmin?.(admin);

  // Widest coverage first: a Fabric admin whose token carries Tenant.Read.All can read EVERY model in
  // the tenant (incl. paused capacities and workspaces they aren't a member of) with no capacity spend.
  if (admin.available) {
    try {
      const body = await fetchTenantAdminBody(provider, onProgress);
      onProgress(0, 0, "Scoring models…");
      const result = await scanScannerAsync(body);
      if (result.cards.length > 0) {
        return { result, label: `Fabric · admin scan · ${result.cards.length} models across the tenant (all capacities)`, skipped: [], admin };
      }
    } catch {
      /* admin scan unavailable/empty (e.g. detailed-metadata tenant setting off) — fall back below */
    }
  }

  // Per-user export: full fidelity for the workspaces this user can open. A model on a PAUSED capacity
  // can't be exported via getDefinition — it lands in `failures` (surfaced as a skip) rather than
  // silently vanishing from the estate.
  onProgress(0, 0, "Listing workspaces you can access…");
  const ws = await listWorkspaces(provider);
  onProgress(0, 0, `Found ${ws.length} workspaces — discovering models…`);
  const { files, failures } = await exportWorkspaces(provider, ws, onProgress);
  if (files.length === 0) {
    throw new Error(`No models could be exported. ${failures[0]?.reason ?? "Check the workspaces have semantic models."}`);
  }
  onProgress(0, 0, "Scoring models…");
  const result = await runScanAsync(files);
  const skip = failures.length ? ` · ${failures.length} skipped` : "";
  return { result, label: `Fabric · ${result.cards.length} models from ${ws.length} workspaces${skip}`, skipped: failures, admin };
}
