// Shared types + tiny set helpers for the client-side semantic-sweep engine.
// Ported faithfully from the Python engine (semantic_sweep/).

export interface Measure {
  name: string;
  dax: string;
}

export interface Column {
  table: string;
  name: string;
  dataType: string | null;
  hidden: boolean;
}

export interface ModelCard {
  name: string;
  workspace: string;
  tables: string[];
  columns: Column[];
  measures: Measure[];
  relationships: string[]; // "from\u0000to" normalized edges
  // Whether `relationships` is a KNOWN-complete list. A TMDL parse knows relationships definitively
  // (true); a Scanner-API card never returns them, so its empty array is "unknown" (false), NOT
  // "known to have none". Drift comparison must treat an unknown side as "can't tell" rather than
  // reading the other side's relationships as all member-only — see recommend.ts materialDrift().
  // `undefined` is treated as known (TMDL/test default) for backward compatibility.
  relationshipsKnown?: boolean;
  sourceLogical: Set<string>; // "schema\u0000entity"
  sourcePhysical: Set<string>; // "endpoint\u0000db"
  hasRls: boolean;
  // `undefined` = genuinely unknown (e.g. a Scanner-API-sourced card: that payload's dataset schema
  // has no calculation-group field at all), NOT "known false". Comparison sites must treat it as
  // "can't tell" rather than as a known non-match — see engine/index.ts warnings() and
  // engine/recommend.ts materialDrift().
  hasCalcGroups: boolean | undefined;
  systemGenerated: boolean;
  // Slice 1a: optional identity (populated by a live Fabric scan) + joined usage overlay.
  datasetId?: string;
  workspaceId?: string;
  usage?: Usage;
  // Scanner-reported schema-retrieval health (undefined for a TMDL-parsed card, or a clean scan).
  // Feeds metadataFidelity in engine/recommend.ts — a stale/failed admin scan must not claim the
  // same confidence as a full TMDL export.
  schemaMayNotBeUpToDate?: boolean;
  schemaRetrievalError?: string;
  // Composite / chained model: upstream semantic-model names this model DirectQueries. An explicit,
  // high-confidence "built on" link (not coincidental similarity).
  derivedFrom?: string[];
}

export type JoinConfidence = "high" | "medium" | "low" | "none";

// Canonical usage/metadata record — a flatten of PBI Scanner API + activity log + refresh history.
export interface Usage {
  datasetName: string;
  workspaceName: string;
  datasetId?: string;
  workspaceId?: string;
  configuredBy?: string;
  endorsement?: "Certified" | "Promoted" | "None";
  certifiedBy?: string;
  createdDate?: string;
  modifiedDate?: string;
  lastRefreshTime?: string;
  refreshStatus?: string;
  avgRefreshDurationMin?: number;
  refreshesPerWeek?: number;
  distinctUsers90d?: number;
  views90d?: number;
  lastAccessedDate?: string;
  sizeMB?: number;
  downstreamReportCount?: number;
  joinConfidence: JoinConfidence;
}

export interface DaxFeatures {
  norm: string;
  skeleton: string;
  functions: Set<string>;
  refs: Set<string>;
  // "table.column" refs, populated only when a table qualifier is present in the source DAX (e.g.
  // "sales.amount" from Sales[Amount]). Used to require unambiguous evidence before two measures
  // referencing a common *generic* bare name (e.g. [Amount], [Date]) on different tables count as
  // ref-backed strong-duplicate evidence (acc6).
  qualifiedRefs: Set<string>;
  aggregators: Set<string>;
  operators: Set<string>;
  flags: Set<string>;
}

export interface MeasureMatch {
  similarity: number;
  containment: number;
  matched: Array<{ a: string; b: string; score: number }>;
  // How many matched pairs are backed by real reference overlap (identical DAX or a shared column),
  // not just a coincidental structural shape (e.g. SUM(Sales[x]) vs SUM(HR[y])). Gates the
  // strong-duplicate / subset bands so shape-only collisions surface for review but never auto-cluster.
  strongMatched: number;
}

export interface PairResult {
  a: ModelCard;
  b: ModelCard;
  facets: {
    measure: number;
    schema: number;
    source_logical: number;
    source_physical: number;
    rel: number;
  };
  headline: number;
  band: string;
  lifecycle: boolean;
  composite: boolean;
  measure: MeasureMatch;
  warnings: string[];
}

export interface Cluster {
  members: ModelCard[];
  keep: ModelCard;
  pairs: PairResult[];
  // Slice 1a — present only when usage data is loaded:
  usageKeeper?: ModelCard;
  keeperBasis?: string;
  recommendations?: Recommendation[];
}

export type RecAction =
  | "retirement-candidate"
  | "retirement-candidate-blocked"
  | "merge"
  | "semantic-conflict"
  | "governance-conflict"
  | "insufficient-evidence";

export interface Confidence {
  identityJoin: number;
  usageLineage: number;
  metadataFidelity: number;
  overall: number; // the weakest dimension — a chain is only as strong as its weakest link
}

export interface Recommendation {
  member: ModelCard; // the model this recommendation is about (a non-keeper cluster member)
  keeper: ModelCard | null;
  action: RecAction;
  reasonCodes: string[];
  blockers: string[];
  driftDims: string[]; // material-drift dimensions found vs the keeper
  driftCoverage: string[]; // dimensions actually checked (honesty note; deferred dims excluded)
  confidence: Confidence;
  savingsRefreshMinPerYear: number;
  priority: number;
}

export interface PromotionChain {
  family: string;
  item: string;
  members: ModelCard[];
  representative: ModelCard;
  environments: string[];
  drift: boolean;
  lowestSim: number;
}

export const modelId = (c: ModelCard): string => `${c.workspace}/${c.name}`;

// Deep link to the semantic model's details page in the Fabric / Power BI portal. Only available
// when a live Fabric scan populated the identity (a drag-drop TMDL zip has no workspace/dataset id).
export function fabricModelUrl(c: ModelCard): string | null {
  if (!c.workspaceId || !c.datasetId) return null;
  return `https://app.powerbi.com/groups/${c.workspaceId}/datasets/${c.datasetId}/details`;
}

export function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

export function union<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>(a);
  for (const x of b) out.add(x);
  return out;
}

export function disjoint<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  return intersection(a, b).size / union(a, b).size;
}

export const round4 = (x: number): number => Math.round(x * 10000) / 10000;
