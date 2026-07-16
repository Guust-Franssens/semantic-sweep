// Multi-facet pair scoring, decision bands, lifecycle labeling, clustering, promotion chains.
// Ported from semantic_sweep/score.py.

import { classifyWorkspace, isLifecycleCandidate, normalizedItemName } from "./lifecycle";
import { matchModelMeasures } from "./measures";
import { type Cluster, type ModelCard, type PairResult, type PromotionChain, jaccard, modelId, round4 } from "./types";

export const FACET_WEIGHTS: Record<string, number> = {
  measure: 0.4, schema: 0.2, source_logical: 0.22, source_physical: 0.08, rel: 0.1,
};

const EXACT_MEASURE = 0.95, EXACT_SCHEMA = 0.95;
const STRONG_MEASURE = 0.55, STRONG_SUPPORT = 0.5;
const SUBSET_CONTAIN = 0.8, SUBSET_SCHEMA = 0.4;
// A strong-duplicate / subset claim needs genuine measure evidence: at least this many measures must
// actually match WITH ref backing (identical DAX or a shared column) — not merely a structural shape
// collision. Schema/source overlap with a handful of shape-only matches (e.g. two small models over a
// shared Date dimension) is never a duplicate — it falls through to related/review.
const MIN_DUP_MEASURES = 3;
const RELATED_SOURCE = 0.6, RELATED_MEASURE = 0.3;
const REVIEW_HEADLINE = 0.45, REVIEW_MEASURE = 0.85, LIFECYCLE_MEASURE = 0.6;

export const BAND_EXACT = "exact-clone";
export const BAND_STRONG = "strong-duplicate";
export const BAND_SUBSET = "subset";
export const BAND_RELATED = "related-source";
export const BAND_REVIEW = "needs-review";
export const BAND_UNRELATED = "unrelated";
export const DUPLICATE_BANDS = new Set([BAND_EXACT, BAND_STRONG]);
// Bands that earn a consolidation-cluster edge. Superset of DUPLICATE_BANDS: a SUBSET (a trimmed
// copy whose measures are largely contained in a larger model) is a real consolidation candidate
// — "redirect the small model into the large one" — so it must cluster too. It stays OUT of
// DUPLICATE_BANDS (which counts only co-equal exact/strong duplicate pairs) and is shown with its
// own "subset" label so a reviewer can dismiss an intentional companion model.
export const CLUSTER_BANDS = new Set([BAND_EXACT, BAND_STRONG, BAND_SUBSET]);

const qualifiedColumns = (c: ModelCard): Set<string> =>
  new Set(c.columns.map((col) => `${col.table}[${col.name}]`.toLowerCase()));

// True when one model is a composite/DirectQuery layer built directly on the other (its derivedFrom
// names the other model). That shared schema/measures is expected lineage, not organic duplication.
// `cards`, when supplied (scoreAll has full scan visibility), guards against a name-ambiguous
// suppression: if two unrelated models happen to share a name (e.g. cloned across workspaces), a
// derivedFrom match by name alone must not suppress cluster/duplicate evidence for the wrong model.
function isCompositeParentChild(a: ModelCard, b: ModelCard, cards?: ModelCard[]): boolean {
  const nameIsUnique = (name: string): boolean => {
    if (!cards) return true;
    const norm = name.trim().toLowerCase();
    return cards.filter((c) => c.name.trim().toLowerCase() === norm).length === 1;
  };
  const names = (c: ModelCard, other: ModelCard): boolean =>
    (c.derivedFrom ?? []).some(
      (n) => n.trim().toLowerCase() === other.name.trim().toLowerCase() && nameIsUnique(n),
    );
  return names(a, b) || names(b, a);
}

function schemaScore(a: ModelCard, b: ModelCard): number {
  const tables = jaccard(new Set(a.tables.map((t) => t.toLowerCase())), new Set(b.tables.map((t) => t.toLowerCase())));
  const columns = jaccard(qualifiedColumns(a), qualifiedColumns(b));
  return round4((tables + columns) / 2);
}

function applicable(name: string, a: ModelCard, b: ModelCard): boolean {
  const has = (c: ModelCard): boolean => {
    switch (name) {
      // A card only carries measure evidence if at least one measure has DAX. When a tenant withholds
      // expressions (admin scan) the facet deactivates rather than reading shape-identical models as
      // clones — the pair falls back to schema/source evidence and, at most, a "needs review" (acc1).
      case "measure": return c.measures.some((m) => (m.dax ?? "").trim() !== "");
      case "schema": return c.tables.length > 0;
      case "source_logical": return c.sourceLogical.size > 0;
      case "source_physical": return c.sourcePhysical.size > 0;
      case "rel": return c.relationships.length > 0;
      default: return false;
    }
  };
  return has(a) && has(b);
}

function classifyBand(
  measureSim: number, contain: number, schema: number, srcLogical: number, headline: number, refBackedCount: number,
): string {
  if (measureSim >= EXACT_MEASURE && schema >= EXACT_SCHEMA) return BAND_EXACT;
  const support = Math.max(schema, srcLogical);
  const hasEvidence = refBackedCount >= MIN_DUP_MEASURES;
  // STRONG needs genuine measure *similarity* + supporting schema/source. High containment with low
  // similarity (a small model whose few measures subset a larger one) is a SUBSET, handled below —
  // not a co-equal duplicate. This stops schema/source overlap alone from manufacturing duplicates.
  if (hasEvidence && measureSim >= STRONG_MEASURE && support >= STRONG_SUPPORT) return BAND_STRONG;
  // SUBSET: trimmed copy. The matched-measure floor stops a companion model that merely shares a
  // handful of base measures with a large one (e.g. FUAM_Item vs FUAM_Core) being mislabeled.
  if (hasEvidence && contain >= SUBSET_CONTAIN && schema >= SUBSET_SCHEMA && measureSim < STRONG_MEASURE) return BAND_SUBSET;
  if (srcLogical >= RELATED_SOURCE && measureSim < RELATED_MEASURE) return BAND_RELATED;
  if (measureSim >= REVIEW_MEASURE) return BAND_REVIEW;
  if (headline >= REVIEW_HEADLINE) return BAND_REVIEW;
  return BAND_UNRELATED;
}

function warnings(a: ModelCard, b: ModelCard, physical: number): string[] {
  const notes: string[] = [];
  if (a.hasRls !== b.hasRls) notes.push("different RLS (one model has row-level security, the other does not)");
  if (a.hasCalcGroups !== b.hasCalcGroups) notes.push("different calculation groups");
  if (applicable("source_physical", a, b) && physical < 1) notes.push("different physical source / endpoint");
  return notes;
}

export function scorePair(a: ModelCard, b: ModelCard, cards?: ModelCard[]): PairResult {
  const measure = matchModelMeasures(a.measures, b.measures);
  const facets = {
    measure: measure.similarity,
    schema: schemaScore(a, b),
    source_logical: round4(jaccard(a.sourceLogical, b.sourceLogical)),
    source_physical: round4(jaccard(a.sourcePhysical, b.sourcePhysical)),
    rel: round4(jaccard(new Set(a.relationships), new Set(b.relationships))),
  };
  const active = Object.keys(FACET_WEIGHTS).filter((n) => applicable(n, a, b));
  const wsum = active.reduce((s, n) => s + FACET_WEIGHTS[n], 0);
  const headline = wsum
    ? round4(active.reduce((s, n) => s + FACET_WEIGHTS[n] * (facets as Record<string, number>)[n], 0) / wsum)
    : 0;
  const band = classifyBand(
    facets.measure, measure.containment, facets.schema, facets.source_logical, headline, measure.strongMatched,
  );
  const lifecycle = isLifecycleCandidate(a, b) && facets.measure >= LIFECYCLE_MEASURE;
  const composite = isCompositeParentChild(a, b, cards);
  return { a, b, facets, headline, band, lifecycle, composite, measure, warnings: warnings(a, b, facets.source_physical) };
}

export function scoreAll(cards: ModelCard[]): PairResult[] {
  const results: PairResult[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) results.push(scorePair(cards[i], cards[j], cards));
  }
  results.sort((x, y) => y.headline - x.headline);
  return results;
}

function betterNominee(a: ModelCard, b: ModelCard): ModelCard {
  const ta: [number, number, number] = [classifyWorkspace(a.workspace).rank, a.measures.length, a.tables.length];
  const tb: [number, number, number] = [classifyWorkspace(b.workspace).rank, b.measures.length, b.tables.length];
  for (let k = 0; k < 3; k++) {
    if (ta[k] > tb[k]) return a;
    if (ta[k] < tb[k]) return b;
  }
  return a;
}

// `includeLifecycle` re-admits dev/test/prod promotion copies as duplicate edges. Default false:
// lifecycle pairs are surfaced as promotion chains, not consolidation targets. The Consolidation view
// exposes this as a toggle so users can still see planted lifecycle duplicates as clusters on demand.
export function organicClusters(cards: ModelCard[], pairs: PairResult[], includeLifecycle = false): Cluster[] {
  const index = new Map<ModelCard, number>();
  cards.forEach((c, i) => index.set(c, i));
  const key = (i: number, j: number): string => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const edgeLookup = new Map<string, PairResult>();

  const eligible = (p: PairResult): boolean =>
    !((!includeLifecycle && p.lifecycle) || p.composite || p.a.systemGenerated || p.b.systemGenerated);

  // Union-Find over card indices (path-compressed) so chained subsets (T⊂M⊂S) resolve robustly.
  const parent = cards.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) [parent[x], x] = [r, parent[x]];
    return r;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const addEdge = (p: PairResult): void => {
    const i = index.get(p.a)!;
    const j = index.get(p.b)!;
    edgeLookup.set(key(i, j), p);
    unite(i, j);
  };

  // 1. Co-equal duplicates (exact/strong) merge unconditionally — the relation is symmetric.
  for (const p of pairs) if (DUPLICATE_BANDS.has(p.band) && eligible(p)) addEdge(p);

  // 2. Subset (trimmed-copy) edges are DIRECTIONAL: redirect the smaller model into its SINGLE best
  //    container. Linking a subset to every superset it fits into would let a shared small model
  //    (e.g. a Date dimension contained in two unrelated fact models) bridge them into one bogus
  //    cluster (acc4). Two subsets of the *same* hub still cluster (both pick that hub); a subset
  //    of two *different* hubs no longer spans them.
  const bestContainer = new Map<number, PairResult>();
  for (const p of pairs) {
    if (p.band !== BAND_SUBSET || !eligible(p)) continue;
    const i = index.get(p.a)!;
    const j = index.get(p.b)!;
    const child = p.a.measures.length <= p.b.measures.length ? i : j; // subset = fewer measures
    const prev = bestContainer.get(child);
    if (!prev || p.facets.measure > prev.facets.measure || (p.facets.measure === prev.facets.measure && p.headline > prev.headline)) {
      bestContainer.set(child, p);
    }
  }
  for (const p of bestContainer.values()) addEdge(p);

  // Emit connected components (>= 2 members) in ascending card order; members sorted by card index so
  // TS and Python produce byte-identical clusters.
  const touched = new Set<number>();
  for (const k of edgeLookup.keys()) for (const n of k.split("|")) touched.add(Number(n));
  const byRoot = new Map<number, number[]>();
  for (let n = 0; n < cards.length; n++) {
    if (!touched.has(n)) continue;
    const r = find(n);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(n);
  }

  const clusters: Cluster[] = [];
  for (const component of byRoot.values()) {
    if (component.length < 2) continue;
    const members = component.map((n) => cards[n]);
    // Keep EVERY member of the component. Over-merge stays bounded: exact/strong edges are symmetric
    // duplicates and each subset attaches to only one container, so a component is a genuine
    // consolidation group (imp-a5 subset copy, imp-a6 transitive hub member both retained).
    const keep = members.reduce((best, m) => betterNominee(best, m));
    const clusterPairs = component
      .flatMap((ni, ci) => component.slice(ci + 1).map((nj) => edgeLookup.get(key(ni, nj))))
      .filter((p): p is PairResult => p !== undefined);
    clusters.push({ members, keep, pairs: clusterPairs });
  }
  return clusters;
}

export function findPromotionChains(cards: ModelCard[], pairs: PairResult[]): PromotionChain[] {
  const groups = new Map<string, ModelCard[]>();
  for (const c of cards) {
    const info = classifyWorkspace(c.workspace);
    const k = `${info.family}\u0000${normalizedItemName(c.name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  const simLookup = new Map<string, number>();
  for (const p of pairs) simLookup.set([modelId(p.a), modelId(p.b)].sort().join("|"), p.facets.measure);

  const chains: PromotionChain[] = [];
  for (const [k, members] of groups) {
    const envs = new Set(members.map((c) => classifyWorkspace(c.workspace).env));
    if (members.length < 2 || envs.size < 2) continue;
    const [family, item] = k.split("\u0000");
    const representative = members.reduce((best, m) => betterNominee(best, m));
    let lowest = 1;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const s = simLookup.get([modelId(members[i]), modelId(members[j])].sort().join("|")) ?? 1;
        lowest = Math.min(lowest, s);
      }
    }
    chains.push({
      family, item, members, representative,
      environments: [...envs].sort(),
      drift: lowest < 0.999,
      lowestSim: lowest,
    });
  }
  return chains;
}
