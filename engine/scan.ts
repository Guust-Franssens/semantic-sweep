// Top-level scan orchestration + results.json-compatible serializer.

import { loadModelsFromFiles, type InputFile } from "./parser";
import {
  BAND_UNRELATED,
  findPromotionChains,
  organicClusters,
  scoreAll,
} from "./index";
import { recommendAll, type RecommendOptions } from "./recommend";
import { joinUsage, type JoinReport } from "./usage";
import {
  type Cluster,
  type ModelCard,
  type PairResult,
  type PromotionChain,
  type Recommendation,
  type Usage,
  modelId,
} from "./types";

export interface CompositeLink {
  from: ModelCard; // the composite / derived model
  toName: string; // upstream dataset it is built on (DirectQuery)
  to?: ModelCard; // resolved upstream model, if it's part of this scan
}

export interface ScanResult {
  cards: ModelCard[];
  pairs: PairResult[];
  clusters: Cluster[];
  chains: PromotionChain[];
  emptyModels: ModelCard[];
  compositeLinks?: CompositeLink[];
  // Slice 1a — populated by enrichScanWithUsage:
  recommendations?: Recommendation[];
  joinReport?: JoinReport;
  usageLoaded?: boolean;
}

// Explicit "built on" links from composite / chained models (DirectQuery to another dataset) — a
// high-confidence relationship, distinct from coincidental similarity.
function computeCompositeLinks(cards: ModelCard[]): CompositeLink[] {
  const byName = new Map<string, ModelCard>();
  for (const c of cards) byName.set(c.name.trim().toLowerCase(), c);
  const links: CompositeLink[] = [];
  for (const c of cards) {
    for (const up of c.derivedFrom ?? []) {
      links.push({ from: c, toName: up, to: byName.get(up.trim().toLowerCase()) });
    }
  }
  return links;
}

// Score + cluster + chain a set of ModelCards (post-parse pipeline; shared by the TMDL and
// Scanner-API paths).
export function scanCards(cards: ModelCard[]): ScanResult {
  const pairs = scoreAll(cards);
  return {
    cards,
    pairs,
    clusters: organicClusters(cards, pairs),
    chains: findPromotionChains(cards, pairs),
    emptyModels: [],
    compositeLinks: computeCompositeLinks(cards),
  };
}

export function runScan(files: InputFile[]): ScanResult {
  const all = loadModelsFromFiles(files, true);
  const cards = all.filter((c) => c.tables.length > 0);
  const emptyModels = all.filter((c) => c.tables.length === 0);
  return { ...scanCards(cards), emptyModels };
}

// Overlay a usage/metadata table onto a completed scan: confidence-scored identity join, then the
// usage x similarity fusion over the clusters. Mutates card.usage + cluster.recommendations in place.
// Run the usage x similarity fusion over an already usage-annotated scan (each card.usage set).
export function recommendScan(scan: ScanResult, opts?: Partial<RecommendOptions>): ScanResult {
  const recommendations = recommendAll(scan.clusters, opts);
  return { ...scan, recommendations, usageLoaded: true };
}

// Overlay a usage/metadata table onto a scan (confidence-scored identity join), then run the fusion.
export function enrichScanWithUsage(
  scan: ScanResult,
  records: Usage[],
  opts?: Partial<RecommendOptions>,
): ScanResult {
  for (const c of scan.cards) c.usage = undefined; // reset so re-applying a different table is clean
  const joinReport = joinUsage(scan.cards, records);
  return { ...recommendScan(scan, opts), joinReport };
}

// Mirrors semantic_sweep/report.py build_results (for parity checks + optional export).
export function toResults(scan: ScanResult): Record<string, unknown> {
  const { cards, pairs, clusters, chains, emptyModels } = scan;
  const out: Record<string, unknown> = {
    summary: {
      models: cards.length,
      pairs: pairs.length,
      organic_clusters: clusters.length,
      promotion_chains: chains.length,
      system_generated: cards.filter((c) => c.systemGenerated).length,
      unscored: emptyModels.length,
    },
    models: cards.map((c) => ({
      id: modelId(c),
      name: c.name,
      workspace: c.workspace,
      tables: c.tables.length,
      measures: c.measures.length,
      system_generated: c.systemGenerated,
      has_rls: c.hasRls,
    })),
    pairs: pairs
      .filter((p) => p.headline >= 0.1)
      .map((p) => ({
        a: modelId(p.a),
        b: modelId(p.b),
        headline: p.headline,
        band: p.band,
        lifecycle: p.lifecycle,
        measure: p.facets.measure,
        containment: p.measure.containment,
        schema: p.facets.schema,
        source_logical: p.facets.source_logical,
        matched_measures: p.measure.matched.length,
      })),
    organic_clusters: clusters.map((cl) => ({
      keep: modelId(cl.keep),
      members: cl.members.map(modelId),
    })),
    promotion_chains: chains.map((ch) => ({
      family: ch.family,
      item: ch.item,
      environments: ch.environments,
      representative: modelId(ch.representative),
      drift: ch.drift,
    })),
    system_generated: cards.filter((c) => c.systemGenerated).map(modelId),
    unscored: emptyModels.map((c) => ({
      workspace: c.workspace,
      model: c.name,
      reason: "default/empty model (0 tables)",
    })),
  };
  // Usage fusion output is appended only when a usage table was loaded, so a plain scan stays
  // byte-identical to the Python engine's results.json (parity harness).
  if (scan.usageLoaded && scan.recommendations) {
    out.recommendations = scan.recommendations.map((r) => ({
      member: modelId(r.member),
      keeper: r.keeper ? modelId(r.keeper) : null,
      action: r.action,
      reason_codes: r.reasonCodes,
      blockers: r.blockers,
      drift_dims: r.driftDims,
      confidence: r.confidence,
      savings_refresh_min_per_year: r.savingsRefreshMinPerYear,
      priority: r.priority,
    }));
    if (scan.joinReport) {
      out.usage_join = {
        matched: scan.joinReport.matched,
        by_tier: scan.joinReport.byTier,
        ambiguous: scan.joinReport.ambiguous,
        unmatched_cards: scan.joinReport.unmatchedCards.length,
        unmatched_records: scan.joinReport.unmatchedRecords.length,
      };
    }
  }
  return out;
}

export const NON_UNRELATED = (p: PairResult): boolean => p.band !== BAND_UNRELATED;
