import { describe, expect, it } from "vitest";

import { enrichScanWithUsage, runScan, type ScanResult } from "@engine/scan";
import type { Usage } from "@engine/types";

import { decodeScan, encodeScan } from "./scanCodec";
import { CHUNK_CHARS, packScan, unpackScan } from "./scanBlob";
import { sampleFiles } from "../sample";
import { usageDemoScan } from "../usageDemo";

// A scan round-tripped through the codec must be structurally identical AND preserve the shared
// ModelCard reference graph + Set-typed facets that the UI relies on.
function assertRoundTrip(scan: ScanResult): ScanResult {
  const decoded = decodeScan(encodeScan(scan));

  expect(decoded.cards.length).toBe(scan.cards.length);
  expect(decoded.pairs.length).toBe(scan.pairs.length);
  expect(decoded.clusters.length).toBe(scan.clusters.length);
  expect(decoded.chains.length).toBe(scan.chains.length);

  // Set facets survive as real Sets (not {}), with the same members.
  const c0 = decoded.cards[0];
  expect(c0.sourcePhysical).toBeInstanceOf(Set);
  expect(c0.sourceLogical).toBeInstanceOf(Set);
  expect([...c0.sourceLogical].sort()).toEqual([...scan.cards[0].sourceLogical].sort());

  // Shared reference identity: a pair's a/b are the SAME instances as entries in cards[] (this is
  // what makes heatmap indexing + drill-downs work after a restore).
  if (decoded.pairs.length > 0) {
    expect(decoded.cards).toContain(decoded.pairs[0].a);
    expect(decoded.cards).toContain(decoded.pairs[0].b);
  }
  for (const cl of decoded.clusters) {
    expect(decoded.cards).toContain(cl.keep);
    for (const m of cl.members) expect(decoded.cards).toContain(m);
  }

  // Lossless: re-encoding the decoded scan reproduces the exact same wire string.
  expect(encodeScan(decoded)).toBe(encodeScan(scan));
  return decoded;
}

describe("scanCodec", () => {
  it("round-trips a plain scan losslessly", () => {
    assertRoundTrip(runScan(sampleFiles));
  });

  it("preserves usage recommendations + join report and their card refs", () => {
    const scan = usageDemoScan();
    const decoded = assertRoundTrip(scan);
    expect(decoded.usageLoaded).toBe(true);
    expect(decoded.recommendations?.length).toBe(scan.recommendations?.length);
    // Recommendation.member/keeper resolve back to canonical cards.
    const rec = decoded.recommendations?.[0];
    if (rec) {
      expect(decoded.cards).toContain(rec.member);
      if (rec.keeper) expect(decoded.cards).toContain(rec.keeper);
    }
  });

  it("keeps a card's usage overlay through the round trip", () => {
    const records: Usage[] = [
      {
        datasetName: sampleFiles.length ? "x" : "x",
        workspaceName: "w",
        joinConfidence: "none",
        views90d: 42,
      },
    ];
    const scan = enrichScanWithUsage(runScan(sampleFiles), records);
    assertRoundTrip(scan);
  });
});

describe("scanBlob", () => {
  it("packs into <=CHUNK_CHARS chunks and unpacks losslessly", async () => {
    const scan = usageDemoScan();
    const chunks = await packScan(scan);
    expect(chunks.length).toBeGreaterThan(0);
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(CHUNK_CHARS);

    const restored = await unpackScan(chunks);
    expect(restored.cards.length).toBe(scan.cards.length);
    expect(restored.pairs.length).toBe(scan.pairs.length);
    expect(restored.usageLoaded).toBe(true);
    // Identical wire form + shared-ref identity survive the gzip/base64/chunk transport.
    expect(encodeScan(restored)).toBe(encodeScan(scan));
    if (restored.pairs.length) expect(restored.cards).toContain(restored.pairs[0].a);
  });

  it("reassembles only when chunks are in seq order (why the store re-sorts)", async () => {
    const scan = usageDemoScan();
    const chunks = await packScan(scan);
    if (chunks.length < 2) return; // single-chunk payload can't demonstrate ordering
    // Out-of-order concatenation must NOT reproduce the original (it either throws on the corrupt
    // gzip stream, or decodes to something different). This is why loadScan re-sorts chunks by seq.
    const swapped = [chunks[1], chunks[0], ...chunks.slice(2)];
    let swappedWire: string | null = null;
    try {
      swappedWire = encodeScan(await unpackScan(swapped));
    } catch {
      swappedWire = null;
    }
    expect(swappedWire).not.toBe(encodeScan(scan));
    // In-order (what loadScan feeds after sorting by seq) round-trips cleanly.
    expect(encodeScan(await unpackScan(chunks))).toBe(encodeScan(scan));
  });
});
