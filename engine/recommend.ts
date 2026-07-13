// Slice 1a — usage x similarity fusion. Turns "these are duplicates" into a defensible,
// evidence-backed recommendation. Never emits an absolute "safe to retire": output is a ranked
// retirement CANDIDATE with confidence + blockers + reason codes. Decision support, not deletion.
//
// Two-phase keeper: usage can influence which model is canonical, but only when candidates are
// semantically equivalent. If they materially drift, we refuse to canonize one over the other and
// surface a "source of truth" decision instead (usage must never bless older/wrong logic).

import { normalizeDax } from "./measures";
import { joinScore } from "./usage";
import {
  type Cluster,
  type Confidence,
  type ModelCard,
  type RecAction,
  type Recommendation,
  type Usage,
  round4,
} from "./types";

export interface RecommendOptions {
  now: number; // ms epoch — injectable for deterministic tests
  investigateDays: number; // 90d window for "unused"
  candidateDays: number; // 365d dormancy before a dormant model is retirement-eligible
}

function resolve(opts?: Partial<RecommendOptions>): RecommendOptions {
  return {
    now: opts?.now ?? Date.now(),
    investigateDays: opts?.investigateDays ?? 90,
    candidateDays: opts?.candidateDays ?? 365,
  };
}

// Dimensions we actually inspect for material drift today (drift-v1). Deferred to 1b (needs new
// parsing): RLS *rule* text, partition/M expressions, sort-by columns, perspectives, incremental refresh.
export const DRIFT_COVERAGE = [
  "measure logic (same-name)",
  "relationships",
  "column data types",
  "RLS presence",
  "calc-group presence",
];

// Material drift-v1 between two models — differences that mean the numbers may not tie out.
export function materialDrift(a: ModelCard, b: ModelCard): { drift: boolean; dims: string[] } {
  const dims: string[] = [];

  // 1. Same measure NAME on both sides but different DAX — the classic "won't tie out".
  const bDax = new Map(b.measures.map((m) => [m.name.toLowerCase(), normalizeDax(m.dax)]));
  const conflicting: string[] = [];
  for (const m of a.measures) {
    const other = bDax.get(m.name.toLowerCase());
    if (other != null && other !== normalizeDax(m.dax)) conflicting.push(m.name);
  }
  if (conflicting.length) {
    dims.push(`measure logic differs: ${conflicting.slice(0, 4).join(", ")}${conflicting.length > 4 ? "…" : ""}`);
  }

  // 2. Relationships the MEMBER has that the KEEPER lacks — the keeper couldn't reproduce those
  //    joins, so the numbers may not tie out. A pure subset/trimmed copy (member ⊆ keeper) has no
  //    member-only relationships, so containment alone is NOT flagged as drift (only genuine
  //    divergence is), which lets a trimmed copy be a clean redirect instead of a semantic-conflict.
  if (a.relationships.length && b.relationships.length) {
    const keeperRels = new Set(b.relationships);
    if (a.relationships.some((r) => !keeperRels.has(r))) dims.push("relationship set differs");
  }

  // 3. Column data-type mismatch on shared (table[column]) keys.
  const bType = new Map(b.columns.map((c) => [`${c.table}[${c.name}]`.toLowerCase(), c.dataType]));
  const typeConflicts: string[] = [];
  for (const c of a.columns) {
    const t = bType.get(`${c.table}[${c.name}]`.toLowerCase());
    if (t !== undefined && c.dataType != null && t != null && t !== c.dataType) {
      typeConflicts.push(`${c.table}[${c.name}]`);
    }
  }
  if (typeConflicts.length) {
    dims.push(`data types differ: ${typeConflicts.slice(0, 3).join(", ")}${typeConflicts.length > 3 ? "…" : ""}`);
  }

  // 4/5. Security / calc-group presence mismatch.
  if (a.hasRls !== b.hasRls) dims.push("RLS present on one side only");
  if (a.hasCalcGroups !== b.hasCalcGroups) dims.push("calc groups present on one side only");

  return { drift: dims.length > 0, dims };
}

const endorsementRank = (u?: Usage): number => (u?.endorsement === "Certified" ? 2 : u?.endorsement === "Promoted" ? 1 : 0);

// Phase 2 — rank the keeper: certified > most-used > most-complete. (Phase 1 equivalence is
// enforced per-member below: a member that drifts from this keeper becomes a semantic-conflict.)
function pickKeeper(members: ModelCard[]): { keeper: ModelCard; basis: string } {
  const scored = members.map((m) => ({
    m,
    key: [endorsementRank(m.usage), m.usage?.distinctUsers90d ?? -1, m.measures.length, m.tables.length],
  }));
  scored.sort((x, y) => {
    for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return y.key[i] - x.key[i];
    return 0;
  });
  const keeper = scored[0].m;
  const parts: string[] = [];
  if (keeper.usage?.endorsement === "Certified") parts.push("certified");
  else if (keeper.usage?.endorsement === "Promoted") parts.push("promoted");
  if (keeper.usage?.distinctUsers90d != null) parts.push(`${keeper.usage.distinctUsers90d} users/90d`);
  parts.push(`${keeper.measures.length} measures`);
  return { keeper, basis: parts.join(" · ") };
}

function daysSince(dateStr: string | undefined, now: number): number | undefined {
  if (!dateStr) return undefined;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((now - t) / 86_400_000);
}

const BASE_PRIORITY: Record<RecAction, number> = {
  "retirement-candidate": 100,
  "retirement-candidate-blocked": 80,
  merge: 60,
  "governance-conflict": 50,
  "semantic-conflict": 45,
  "insufficient-evidence": 15,
};

function recommendMember(
  member: ModelCard,
  keeper: ModelCard,
  simToKeeper: number | undefined,
  opts: RecommendOptions,
): Recommendation {
  const u = member.usage;
  const idJoin = joinScore[u?.joinConfidence ?? "none"];
  const consumptionKnown = u != null && (u.distinctUsers90d != null || u.views90d != null);
  const lineageKnown = u?.downstreamReportCount != null;
  const usageLineage = u ? 0.4 + (consumptionKnown ? 0.3 : 0) + (lineageKnown ? 0.3 : 0) : 0;
  const metadataFidelity = 1; // full TMDL model in 1a; Scanner-rich fidelity scoring is 1b
  const overall = round4(Math.min(idJoin, usageLineage, metadataFidelity));
  const confidence: Confidence = { identityJoin: round4(idJoin), usageLineage: round4(usageLineage), metadataFidelity, overall };

  const drift = materialDrift(member, keeper);
  const savings = Math.round((u?.refreshesPerWeek ?? 0) * (u?.avgRefreshDurationMin ?? 0) * 52);
  const reasonCodes: string[] = [`duplicate of keeper (${simToKeeper != null ? simToKeeper.toFixed(2) : "cluster edge"})`];
  const blockers: string[] = [];
  let action: RecAction;

  if (drift.drift) {
    action = "semantic-conflict";
    reasonCodes.push("does not tie out to the keeper — resolve source of truth");
    if (u?.modifiedDate) reasonCodes.push(`this copy modified ${u.modifiedDate}`);
    blockers.push(...drift.dims);
  } else if (!u || idJoin < joinScore.medium) {
    action = "insufficient-evidence";
    reasonCodes.push(u ? `identity join weak (${u.joinConfidence}) — confirm before acting` : "no usage/metadata matched this model");
  } else if (u.endorsement === "Certified") {
    action = "governance-conflict";
    reasonCodes.push(keeper.usage?.endorsement === "Certified" ? "two certified copies" : "certified duplicate");
    reasonCodes.push("governance owner must approve retirement");
  } else {
    const daysAccess = daysSince(u.lastAccessedDate ?? u.lastRefreshTime, opts.now);
    const hasAudience = (u.distinctUsers90d ?? 0) > 0 || (u.views90d ?? 0) > 0;
    const unused90 = (u.distinctUsers90d ?? -1) === 0 && (u.views90d ?? -1) === 0;

    if (!consumptionKnown) {
      action = "insufficient-evidence";
      reasonCodes.push("no consumption data — unknown usage risk");
    } else if (hasAudience) {
      action = "merge";
      reasonCodes.push(`${u.distinctUsers90d ?? "?"} users / ${u.views90d ?? "?"} views in 90d — has an audience`);
      blockers.push("redirect reports/users to keeper (report rebind)");
      if (member.hasRls) blockers.push("RLS / permission migration");
    } else if (unused90 && daysAccess != null && daysAccess < opts.candidateDays) {
      action = "insufficient-evidence"; // dormant but used within the year (e.g. quarterly) — protect
      reasonCodes.push(`0 users in 90d, but last activity ${daysAccess}d ago (<${opts.candidateDays}d) — investigate, don't retire`);
    } else if (unused90 && !lineageKnown) {
      action = "insufficient-evidence";
      reasonCodes.push("0 users in 90d but no downstream lineage — unknown usage risk");
    } else if (unused90 && (u.downstreamReportCount ?? 0) > 0) {
      action = "retirement-candidate-blocked";
      reasonCodes.push(`0 users / 0 views in 90d; dormant ${daysAccess ?? "?"}d`);
      blockers.push(`${u.downstreamReportCount} downstream report(s) still bound`);
    } else if (unused90) {
      action = "retirement-candidate";
      reasonCodes.push(`0 users / 0 views in 90d; dormant ${daysAccess ?? ">365"}d`);
      reasonCodes.push("no downstream reports · not certified");
    } else {
      action = "insufficient-evidence";
      reasonCodes.push("usage inconclusive");
    }
  }

  const priority = BASE_PRIORITY[action] + Math.round(overall * 10) + Math.min(Math.round(savings / 60), 20);
  return {
    member,
    keeper,
    action,
    reasonCodes,
    blockers,
    driftDims: drift.dims,
    driftCoverage: DRIFT_COVERAGE,
    confidence,
    savingsRefreshMinPerYear: savings,
    priority,
  };
}

export function recommendCluster(cluster: Cluster, opts?: Partial<RecommendOptions>): Recommendation[] {
  const o = resolve(opts);
  const { keeper, basis } = pickKeeper(cluster.members);
  const simTo = new Map<ModelCard, number>();
  for (const p of cluster.pairs) {
    if (p.a === keeper) simTo.set(p.b, p.headline);
    else if (p.b === keeper) simTo.set(p.a, p.headline);
  }
  const recs = cluster.members.filter((m) => m !== keeper).map((m) => recommendMember(m, keeper, simTo.get(m), o));
  const anyDrift = recs.some((r) => r.action === "semantic-conflict");
  cluster.usageKeeper = keeper;
  cluster.keeperBasis = anyDrift ? `${basis} — proposed; drift detected, confirm source of truth` : basis;
  cluster.recommendations = recs;
  return recs;
}

export function recommendAll(clusters: Cluster[], opts?: Partial<RecommendOptions>): Recommendation[] {
  const all: Recommendation[] = [];
  for (const c of clusters) all.push(...recommendCluster(c, opts));
  all.sort((a, b) => b.priority - a.priority);
  return all;
}

export const REC_LABELS: Record<RecAction, string> = {
  "retirement-candidate": "Retirement candidate",
  "retirement-candidate-blocked": "Retire — blocked by downstream",
  merge: "Merge & redirect",
  "governance-conflict": "Governance conflict",
  "semantic-conflict": "Semantic conflict",
  "insufficient-evidence": "Insufficient evidence",
};

// Actions whose recommendation carries a real refresh-savings estimate (shown in the UI + CSV).
export const SHOWS_SAVINGS = new Set<RecAction>([
  "retirement-candidate",
  "retirement-candidate-blocked",
  "merge",
]);
