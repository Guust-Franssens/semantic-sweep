// Lossless (de)serializer for a ScanResult so it can round-trip through JSON storage (the Rayfin
// managed DB). Two things break a naive JSON.stringify of a scan and both are handled here:
//   1. Set<string> facet fields (ModelCard.sourceLogical / sourcePhysical) — JSON drops Sets to {}.
//   2. Shared ModelCard references — the same card is referenced by scan.cards AND by every pair,
//      cluster, chain, recommendation, composite link and the usage join report. JSON.stringify
//      would inline a *copy* everywhere (bloating the payload and destroying `pair.a === cards[i]`
//      identity that the heatmap / drill-downs rely on).
//
// Encoding: cards are written once (canonical, Sets tagged as {__ss_set:[...]}); everywhere else a
// card is replaced by {__ss_ref: <index into cards>}. Decoding rebuilds the cards first (reviving
// Sets), then resolves every ref back to the SAME canonical card instance — so the in-memory
// reference graph is identical to a fresh scan.

import type { ScanResult } from "@engine/scan";
import type { ModelCard } from "@engine/types";

const SET_TAG = "__ss_set";
const REF_TAG = "__ss_ref";

interface EncodedScan {
  v: 1;
  cards: unknown[];
  pairs: unknown;
  clusters: unknown;
  chains: unknown;
  emptyModels: unknown[];
  compositeLinks?: unknown;
  recommendations?: unknown;
  joinReport?: unknown;
  usageLoaded?: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// JSON.stringify replacer: Sets -> tagged arrays (canonical cards keep their full shape).
function setReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? { [SET_TAG]: [...value] } : value;
}

// Deep-clone through JSON with the given replacer (parse back to a plain object graph).
function cloneWith(value: unknown, replacer: (k: string, v: unknown) => unknown): unknown {
  return JSON.parse(JSON.stringify(value, replacer)) as unknown;
}

export function encodeScan(scan: ScanResult): string {
  const idx = new Map<ModelCard, number>();
  scan.cards.forEach((c, i) => idx.set(c, i));

  // Everywhere except the canonical cards[]: replace a known card by its index, tag Sets.
  const refReplacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Set) return { [SET_TAG]: [...value] };
    if (isObject(value) && idx.has(value as unknown as ModelCard)) return { [REF_TAG]: idx.get(value as unknown as ModelCard) };
    return value;
  };

  const encoded: EncodedScan = {
    v: 1,
    cards: scan.cards.map((c) => cloneWith(c, setReplacer)),
    pairs: cloneWith(scan.pairs, refReplacer),
    clusters: cloneWith(scan.clusters, refReplacer),
    chains: cloneWith(scan.chains, refReplacer),
    emptyModels: scan.emptyModels.map((c) => cloneWith(c, setReplacer)),
    compositeLinks: scan.compositeLinks ? cloneWith(scan.compositeLinks, refReplacer) : undefined,
    recommendations: scan.recommendations ? cloneWith(scan.recommendations, refReplacer) : undefined,
    joinReport: scan.joinReport ? cloneWith(scan.joinReport, refReplacer) : undefined,
    usageLoaded: scan.usageLoaded,
  };
  return JSON.stringify(encoded);
}

// Revive tagged Sets in a plain node graph (used for the canonical cards).
function reviveSets(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(reviveSets);
  if (isObject(node)) {
    if (Array.isArray(node[SET_TAG])) return new Set(node[SET_TAG] as unknown[]);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) out[k] = reviveSets(node[k]);
    return out;
  }
  return node;
}

// Revive tagged Sets AND resolve {__ss_ref} back to the shared canonical card instance.
function resolveRefs(node: unknown, cards: ModelCard[]): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, cards));
  if (isObject(node)) {
    if (typeof node[REF_TAG] === "number") return cards[node[REF_TAG] as number];
    if (Array.isArray(node[SET_TAG])) return new Set(node[SET_TAG] as unknown[]);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) out[k] = resolveRefs(node[k], cards);
    return out;
  }
  return node;
}

export function decodeScan(json: string): ScanResult {
  const p = JSON.parse(json) as EncodedScan;
  const cards = p.cards.map(reviveSets) as ModelCard[];
  const opt = <T>(v: unknown): T | undefined => (v === undefined ? undefined : (resolveRefs(v, cards) as T));
  return {
    cards,
    pairs: resolveRefs(p.pairs, cards) as ScanResult["pairs"],
    clusters: resolveRefs(p.clusters, cards) as ScanResult["clusters"],
    chains: resolveRefs(p.chains, cards) as ScanResult["chains"],
    emptyModels: (p.emptyModels ?? []).map(reviveSets) as ModelCard[],
    compositeLinks: opt<ScanResult["compositeLinks"]>(p.compositeLinks),
    recommendations: opt<ScanResult["recommendations"]>(p.recommendations),
    joinReport: opt<ScanResult["joinReport"]>(p.joinReport),
    usageLoaded: p.usageLoaded,
  };
}
