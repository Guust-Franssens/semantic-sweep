// DB persistence layer for estate scans (imp-c1). Saves a completed ScanResult to Rayfin's managed
// SQL DB so reopening the app restores the last estate instantly — the headline reason to ship this
// as a Fabric App rather than a static SPA. The heavy ScanResult is gzip+base64 chunked (scanBlob)
// across ScanChunk rows; a SavedScan header row carries summary counts so the history list renders
// without inflating any blob. All rows are stamped with user_id (= JWT sub) so the per-user row
// policy on both entities scopes reads, updates, and deletes to the signed-in user.
//
// SECURITY NOTE: that row policy does not cover this function's writes. Data API Builder has no
// database-policy support on the `create` action, so the `user_id` passed in below is trusted from
// the caller with no server-side check. See rayfin-app/SECURITY.md for the full finding; the readback
// check further down guards against accidental self-mismatch only, not a forged user_id.

import { BAND_REVIEW } from "@engine/index";
import type { ScanResult } from "@engine/scan";

import { getRayfinClient } from "../services/rayfinClient";
import { packScan, unpackScan } from "./scanBlob";

// Header fields fetched for the history list (everything except the chunk payload).
const SUMMARY_FIELDS = [
  "id",
  "label",
  "mode",
  "source",
  "models",
  "pairs",
  "clusters",
  "chains",
  "systemGenerated",
  "review",
  "usageLoaded",
  "chunkCount",
  "scannedAt",
] as const;

// Keep at most this many scans per user; older ones are pruned after each save.
const MAX_SAVED = 12;
// Safety ceiling for a single scan's chunk count (packScan yields ~16 for a 35-model estate).
const MAX_CHUNKS = 4000;

export interface SaveScanMeta {
  label: string; // human label shown in the history list
  mode: string; // 'tenant' | 'admin' | 'zip' — how the scan was produced
  source: string; // scope description (workspace filter, file name, …)
}

export interface ScanSummary {
  id: string;
  label: string;
  mode: string;
  source: string;
  models: number;
  pairs: number;
  clusters: number;
  chains: number;
  systemGenerated: number;
  review: number;
  usageLoaded: boolean;
  chunkCount: number;
  scannedAt: string; // ISO 8601
}

interface SavedScanRow {
  id: string;
  label: string;
  mode: string;
  source: string;
  models: number;
  pairs: number;
  clusters: number;
  chains: number;
  systemGenerated: number;
  review: number;
  usageLoaded: boolean;
  chunkCount: number;
  scannedAt: string | Date;
}

function summarize(scan: ScanResult): {
  models: number;
  pairs: number;
  clusters: number;
  chains: number;
  systemGenerated: number;
  review: number;
  usageLoaded: boolean;
} {
  return {
    models: scan.cards.length,
    pairs: scan.pairs.length,
    clusters: scan.clusters.length,
    chains: scan.chains.length,
    systemGenerated: scan.cards.filter((c) => c.systemGenerated).length,
    review: scan.pairs.filter((p) => p.band === BAND_REVIEW).length,
    usageLoaded: Boolean(scan.usageLoaded),
  };
}

function toSummary(row: SavedScanRow): ScanSummary {
  const at = new Date(row.scannedAt);
  return {
    id: row.id,
    label: row.label,
    mode: row.mode,
    source: row.source,
    models: row.models,
    pairs: row.pairs,
    clusters: row.clusters,
    chains: row.chains,
    systemGenerated: row.systemGenerated,
    review: row.review,
    usageLoaded: Boolean(row.usageLoaded),
    chunkCount: row.chunkCount,
    scannedAt: Number.isNaN(at.getTime()) ? String(row.scannedAt) : at.toISOString(),
  };
}

// Persist a completed scan. Returns the new SavedScan id. Chunks are written sequentially so a
// mid-way failure surfaces cleanly (rather than racing N parallel mutations against mssql).
export async function saveScan(
  scan: ScanResult,
  meta: SaveScanMeta,
  userId: string,
): Promise<string> {
  const client = getRayfinClient();
  const chunks = await packScan(scan);
  const id = crypto.randomUUID();
  const s = summarize(scan);
  await client.data.SavedScan.create({
    id,
    user_id: userId,
    label: meta.label.slice(0, 200),
    mode: meta.mode.slice(0, 40),
    source: meta.source.slice(0, 400),
    models: s.models,
    pairs: s.pairs,
    clusters: s.clusters,
    chains: s.chains,
    systemGenerated: s.systemGenerated,
    review: s.review,
    usageLoaded: s.usageLoaded,
    chunkCount: chunks.length,
    scannedAt: new Date(),
  });
  // Fail fast if the just-written header is not readable back under the per-user row policy. In Fabric
  // managed hosting the JWT `sub` can be a hierarchical path while the SDK exposes only its last
  // segment as user.id; if the DB compares the full sub the write succeeds but every read is filtered
  // out — a silent "no saved scans". Detect that here (before writing N chunks) so persistScan surfaces
  // a clear toast instead of the app quietly forgetting every scan.
  // Note: this only catches accidental self-mismatch (this app passing the wrong id for its own
  // signed-in user). It cannot catch a deliberate forged user_id from another caller, since a forged
  // row reads back fine for whoever's id was actually written; see the SECURITY NOTE at the top of
  // this file.
  const readback = (await client.data.SavedScan
    .select(["id"])
    .where({ id: { eq: id }, user_id: { eq: userId } })
    .first(1)
    .execute()) as unknown as { id: string }[];
  if (!readback.length) {
    await client.data.SavedScan.delete({ id }).catch(() => undefined);
    throw new Error(
      "Saved scan was written but is not readable back (row-level policy did not match your identity). " +
        "Persistence is unavailable in this environment.",
    );
  }
  for (let seq = 0; seq < chunks.length; seq++) {
    await client.data.ScanChunk.create({
      id: crypto.randomUUID(),
      user_id: userId,
      scan_id: id,
      seq,
      data: chunks[seq],
    });
  }
  // Best-effort retention prune — never let a full history block the save that just succeeded.
  await pruneOld(userId).catch(() => undefined);
  return id;
}

export async function listScans(userId: string): Promise<ScanSummary[]> {
  const client = getRayfinClient();
  const rows = (await client.data.SavedScan
    .select(SUMMARY_FIELDS)
    .where({ user_id: { eq: userId } })
    .orderBy({ scannedAt: "desc" })
    .first(MAX_SAVED * 4)
    .execute()) as unknown as SavedScanRow[];
  return rows.map(toSummary);
}

// Load the most recent scan for a user (header + inflated ScanResult), or null if none exist.
export async function loadLatest(
  userId: string,
): Promise<{ summary: ScanSummary; scan: ScanResult } | null> {
  const client = getRayfinClient();
  const rows = (await client.data.SavedScan
    .select(SUMMARY_FIELDS)
    .where({ user_id: { eq: userId } })
    .orderBy({ scannedAt: "desc" })
    .first(1)
    .execute()) as unknown as SavedScanRow[];
  if (!rows.length) return null;
  const summary = toSummary(rows[0]);
  const scan = await loadScan(summary.id);
  return scan ? { summary, scan } : null;
}

export async function loadScan(id: string): Promise<ScanResult | null> {
  const client = getRayfinClient();
  const rows = (await client.data.ScanChunk
    .select(["seq", "data"])
    .where({ scan_id: { eq: id } })
    .orderBy({ seq: "asc" })
    .first(MAX_CHUNKS)
    .execute()) as unknown as { seq: number; data: string }[];
  if (!rows.length) return null;
  // Defensive re-sort: don't trust the server to honor orderBy for reassembly correctness.
  const ordered = [...rows].sort((a, b) => a.seq - b.seq).map((r) => r.data);
  return unpackScan(ordered);
}

export async function deleteScan(id: string): Promise<void> {
  const client = getRayfinClient();
  const chunks = (await client.data.ScanChunk
    .select(["id"])
    .where({ scan_id: { eq: id } })
    .first(MAX_CHUNKS)
    .execute()) as unknown as { id: string }[];
  for (const ch of chunks) {
    await client.data.ScanChunk.delete({ id: ch.id }).catch(() => undefined);
  }
  await client.data.SavedScan.delete({ id }).catch(() => undefined);
}

// Drop scans beyond the newest MAX_SAVED for this user (newest-first, so slice off the tail).
async function pruneOld(userId: string): Promise<void> {
  const scans = await listScans(userId);
  const stale = scans.slice(MAX_SAVED);
  for (const s of stale) {
    await deleteScan(s.id).catch(() => undefined);
  }
}

// --- Consolidation decisions -----------------------------------------------------------------------
// The human-in-the-loop status on a recommendation (Approved / In progress / Done). Persisted so the
// decision survives refresh, tab switches, and re-scans, keyed by member_id (= the retired/redirected
// model's modelId), so the same duplicate keeps its status across re-scans. See ScanDecision.ts.

// Load every stored decision for this user as a { memberId -> status } map. "Proposed" is the implicit
// default and is never stored, so an absent key means Proposed.
export async function listDecisions(userId: string): Promise<Record<string, string>> {
  const client = getRayfinClient();
  const rows = (await client.data.ScanDecision
    .select(["member_id", "status"])
    .where({ user_id: { eq: userId } })
    .first(1000)
    .execute()) as unknown as { member_id: string; status: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.member_id] = r.status;
  return out;
}

// Upsert a decision by (user_id, member_id) via delete-then-create — avoids depending on the client's
// update semantics and keeps the row unique. Resetting to "Proposed" (the default) just deletes the
// row, so the table only ever holds real, actioned decisions.
export async function setDecision(
  userId: string,
  memberId: string,
  keeperId: string,
  status: string,
): Promise<void> {
  const client = getRayfinClient();
  const existing = (await client.data.ScanDecision
    .select(["id"])
    .where({ user_id: { eq: userId }, member_id: { eq: memberId } })
    .first(50)
    .execute()) as unknown as { id: string }[];
  for (const e of existing) await client.data.ScanDecision.delete({ id: e.id }).catch(() => undefined);
  if (status === "Proposed") return; // default state — leave no row
  await client.data.ScanDecision.create({
    id: crypto.randomUUID(),
    user_id: userId,
    member_id: memberId,
    keeper_id: keeperId,
    status,
    updated_at: new Date().toISOString(),
  });
}
