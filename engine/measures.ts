// Measure-level similarity: weighted lexical DAX features + greedy one-to-one matching.
// Ported from semantic_sweep/measures.py (constants kept identical for parity).

import {
  type DaxFeatures,
  type Measure,
  type MeasureMatch,
  disjoint,
  intersection,
  round4,
  union,
} from "./types";

const AGGREGATORS = new Set([
  "sum", "average", "min", "max", "count", "counta", "countrows", "distinctcount",
  "sumx", "averagex", "minx", "maxx", "countx", "product", "productx", "median", "geomean",
]);

const FUNCTION_FAMILIES: Record<string, string> = {
  round: "rounding", roundup: "rounding", rounddown: "rounding", trunc: "rounding",
  int: "rounding", mround: "rounding", fixed: "rounding", ceiling: "rounding", floor: "rounding",
  sum: "additive", sumx: "additive",
  average: "mean", averagex: "mean",
  count: "counting", counta: "counting", countrows: "counting", countx: "counting",
  distinctcount: "counting",
};

const CONTEXT_FLAGS = new Set([
  "calculate", "calculatetable", "filter", "all", "allexcept", "allselected", "removefilters",
  "userelationship", "keepfilters", "sameperiodlastyear", "dateadd", "totalytd", "totalmtd",
  "totalqtd", "datesytd", "parallelperiod", "previousmonth", "previousyear", "datesinperiod",
]);

const GENERIC_NAMES = new Set([
  "total", "count", "sum", "amount", "value", "measure", "result", "kpi", "average", "max", "min",
]);

// Column/measure ref names common enough to recur across unrelated tables on any estate with a
// shared naming convention (e.g. every fact table has an [Amount], every dimension has a [Date]).
// A bare match on one of these must not, by itself, count as ref-backed strong-duplicate evidence
// (acc6) -- unlike GENERIC_NAMES above (measure-name weighting), this gates measure-level evidence.
const GENERIC_REF_NAMES = new Set([
  "id", "key", "code", "name", "date", "value", "amount", "total", "count", "sum", "status", "type",
  "description", "flag", "number", "quantity", "price", "region", "category", "year", "month", "day",
  "created", "modified", "updated",
]);

const COMPONENT_WEIGHTS: Record<string, number> = { refs: 0.45, functions: 0.3, flags: 0.15, operators: 0.1 };
const SKELETON_SCORE = 0.92;
// Same structural skeleton but the referenced names differ: score between SKELETON_FLOOR (pure shape
// collision, e.g. SUM(Sales[x]) vs SUM(HR[y])) and SKELETON_SCORE (renamed table, identical column),
// interpolated by how many referenced column/measure names coincide. Kept >= REVIEW_MEASURE so a
// fully-renamed clone still surfaces for review; the strong-duplicate gate is enforced separately
// via ref-backed evidence (see matchModelMeasures.strongMatched).
const SKELETON_FLOOR = 0.9;
const AGG_PENALTY = 0.6;

// A DAX string literal, escape-aware: an embedded literal `"` is written as a doubled `""` inside the
// string (e.g. `"He said ""hi"""`). A naive `"[^"]*"` stops at the first inner `"`, truncating the
// literal and leaking the remainder as if it were DAX code (dax-tokenizer-hardening).
const STRING_SRC = String.raw`"(?:[^"]|"")*"`;
const STRING_RE = new RegExp(STRING_SRC, "g");
// One pass, string-aware: tries a full string literal FIRST at each position, so a "//" or "/*" that
// appears INSIDE a string is consumed as part of the string and never misread as a comment start (the
// previous two-pass comment stripper had no string awareness at all).
const COMMENT_OR_STRING_RE = new RegExp(`${STRING_SRC}|/\\*[\\s\\S]*?\\*/|//[^\\n]*`, "g");

export function normalizeDax(dax: string): string {
  const text = dax.replace(COMMENT_OR_STRING_RE, (m) => (m.startsWith('"') ? m : " "));
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function skeleton(norm: string): string {
  // `[\p{L}\p{N}_]` (+ `u` flag) rather than `\w`: JS's `\w` is ASCII-only, unlike Python's (Unicode-aware
  // by default), so a non-ASCII bare table qualifier (e.g. `Clientèle[Amount]`) would otherwise be split
  // mid-identifier here, diverging from the Python engine's parse of the identical DAX expression.
  let text = norm.replace(/(?:'[^']*'|[\p{L}\p{N}_]+)?\[[^\]]*\]/gu, "#r#");
  text = text.replace(STRING_RE, "#s#");
  text = text.replace(/\b\d+(?:\.\d+)?\b/g, "#n#");
  return text.replace(/\s+/g, "");
}

function matchAll(re: RegExp, text: string, group = 0): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = r.exec(text)) !== null) {
    out.push(m[group]);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}

// "table.column" refs, captured only when a table qualifier (bare word or 'quoted name') immediately
// precedes the bracket in the source DAX. A bare [Column] with no qualifier (row-context reference or
// a measure call) contributes nothing here -- it stays in the unqualified `refs` set instead.
function extractQualifiedRefs(text: string): Set<string> {
  const out = new Set<string>();
  // Same Unicode-aware fix as skeleton() above: `[\p{L}\p{N}_]` + `u` flag instead of ASCII-only `\w`.
  const re = /(?:'([^']*)'|([\p{L}\p{N}_]+))?\[([^\]]+)\]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const qualifier = m[1] ?? m[2];
    if (qualifier) out.add(`${qualifier}.${m[3]}`);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

export function extractFeatures(dax: string): DaxFeatures {
  const norm = normalizeDax(dax);
  const functions = new Set(matchAll(/\b([a-z][a-z0-9]*)\s*\(/g, norm, 1));
  // Neutralize string literals before extracting column/measure refs so a format string like
  // FORMAT(x, "[Red]0") does not leak a bogus "red" reference (acc3).
  const noStrings = norm.replace(STRING_RE, '""');
  return {
    norm,
    skeleton: skeleton(norm),
    functions,
    refs: new Set(matchAll(/\[([^\]]+)\]/g, noStrings, 1).map((s) => s.toLowerCase())),
    qualifiedRefs: extractQualifiedRefs(noStrings),
    aggregators: intersection(functions, AGGREGATORS),
    operators: new Set(matchAll(/[+\-*/&<>=]/g, norm)),
    flags: intersection(functions, CONTEXT_FLAGS),
  };
}

// Two matched measures are "ref-backed" (real evidence, not a coincidental shape collision) when:
// identical normalized DAX, OR an exact table-qualified column/measure match, OR a shared BARE name
// that is specific enough to not be a coincidence. A bare match on a generic name alone (e.g. two
// unrelated tables both having an [Amount] or [Date] column) is NOT accepted -- that previously let
// Sales[Amount] and Budget[Amount] manufacture strong-duplicate evidence on shared-schema estates
// (acc6). Renamed-table clones with specific shared column names (e.g. Sales[amt0]~Revenue[amt0])
// still count, preserving the acc5 renamed-clone heuristic.
function isRefBacked(a: DaxFeatures, b: DaxFeatures): boolean {
  if (a.norm === b.norm) return true;
  if (intersection(a.qualifiedRefs, b.qualifiedRefs).size > 0) return true;
  const shared = intersection(a.refs, b.refs);
  for (const name of shared) if (!GENERIC_REF_NAMES.has(name)) return true;
  return false;
}

function jac(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  return intersection(a, b).size / union(a, b).size;
}

function functionSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const exact = intersection(a, b);
  const famA = new Set<string>();
  const famB = new Set<string>();
  for (const f of a) if (!exact.has(f) && FUNCTION_FAMILIES[f]) famA.add(FUNCTION_FAMILIES[f]);
  for (const f of b) if (!exact.has(f) && FUNCTION_FAMILIES[f]) famB.add(FUNCTION_FAMILIES[f]);
  const soft = exact.size + 0.5 * intersection(famA, famB).size;
  return Math.min(1, soft / union(a, b).size);
}

export function measureSimilarity(a: DaxFeatures, b: DaxFeatures): number {
  // No DAX on either side (e.g. a locked-down / admin scan that withholds expressions) is NOT
  // evidence of a match — two shape-identical models must not read as exact clones (acc1).
  if (!a.norm && !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  if (a.skeleton && a.skeleton === b.skeleton) {
    return round4(SKELETON_FLOOR + (SKELETON_SCORE - SKELETON_FLOOR) * jac(a.refs, b.refs));
  }
  const scores: Record<string, number> = {
    refs: jac(a.refs, b.refs),
    functions: functionSimilarity(a.functions, b.functions),
    flags: jac(a.flags, b.flags),
    operators: jac(a.operators, b.operators),
  };
  const present: Array<[string, boolean]> = [
    ["refs", a.refs.size > 0 || b.refs.size > 0],
    ["functions", a.functions.size > 0 || b.functions.size > 0],
    ["flags", a.flags.size > 0 || b.flags.size > 0],
    ["operators", a.operators.size > 0 || b.operators.size > 0],
  ];
  const active = present.filter(([, has]) => has).map(([k]) => k);
  if (active.length === 0) return 0;
  const wsum = active.reduce((s, k) => s + COMPONENT_WEIGHTS[k], 0);
  let base = active.reduce((s, k) => s + COMPONENT_WEIGHTS[k] * scores[k], 0) / wsum;
  if (
    a.aggregators.size > 0 &&
    b.aggregators.size > 0 &&
    disjoint(a.aggregators, b.aggregators) &&
    intersection(a.refs, b.refs).size > 0
  ) {
    base *= AGG_PENALTY;
  }
  return round4(Math.min(1, base));
}

function measureWeight(m: Measure, f: DaxFeatures): number {
  // Tokenize on word boundaries (not a single concatenated blob) so a multi-word name like "Total
  // Sales" is judged word-by-word against GENERIC_NAMES instead of vanishing into "totalsales",
  // which matches nothing and was silently never downweighted. Square the generic-word fraction
  // before applying the discount: a name that is ALL generic words (e.g. "Total", or "Total Count")
  // still gets the full 0.4 floor exactly as before, but a name that is only PARTLY generic (e.g.
  // "Total Sales") is discounted much more gently, since one specific word ("Sales") already carries
  // most of the discriminating signal -- informativeness doesn't fall off linearly with word count.
  const words = m.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const genericFrac = words.length ? words.filter((w) => GENERIC_NAMES.has(w)).length / words.length : 0;
  const base = 1 - 0.6 * genericFrac * genericFrac;
  const complexity = 1 + 0.1 * Math.min(f.functions.size + f.refs.size, 6);
  return base * complexity;
}

// Maximum-cardinality bipartite matching via Kuhn's augmenting-path algorithm, restricted to edges
// scoring >= threshold. A plain greedy "sort candidates by score, take first-come-first-served"
// pass under-counts matches: whichever side of a contested pair loses out is left unmatched even
// when a different, equally-valid assignment would have matched EVERY measure that has a
// candidate. Example: A0~B0=0.90, A0~B1=0.85, A1~B0=0.88 (A1~B1 below threshold). Greedy takes
// A0-B0 first (highest score) and then discards both A1~B0 (B0 taken) and A0~B1 (A0 taken),
// leaving A1 unmatched -- even though A0-B1 + A1-B0 matches both sides. Kuhn's algorithm finds
// that second assignment by letting a contested node "steal" its match and pushing the displaced
// node to search for an alternative (an augmenting path), which is guaranteed to find a maximum
// matching regardless of processing order. Node order (by each node's best candidate score,
// descending) and per-node edge order (by score, descending) are both deterministic tie-breakers
// that bias the search toward higher-weight matchings among the (possibly several) maximum ones.
function maxWeightBipartiteMatch(
  scoreOf: (i: number, j: number) => number,
  sizeA: number,
  sizeB: number,
  threshold: number,
): Array<[number, number, number]> {
  const adj: Array<Array<[number, number]>> = []; // adj[i] = [[score, j], ...] desc by score, then j
  for (let i = 0; i < sizeA; i++) {
    const row: Array<[number, number]> = [];
    for (let j = 0; j < sizeB; j++) {
      const score = scoreOf(i, j);
      if (score >= threshold) row.push([score, j]);
    }
    row.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    adj.push(row);
  }

  const matchB = new Map<number, number>(); // j -> i
  const matchA = new Map<number, number>(); // i -> j
  const matchScore = new Map<number, number>(); // i -> score of its current match

  function tryAugment(i: number, visitedB: Set<number>): boolean {
    for (const [score, j] of adj[i]) {
      if (visitedB.has(j)) continue;
      visitedB.add(j);
      const occupant = matchB.get(j);
      if (occupant === undefined || tryAugment(occupant, visitedB)) {
        matchB.set(j, i);
        matchA.set(i, j);
        matchScore.set(i, score);
        return true;
      }
    }
    return false;
  }

  const order = Array.from({ length: sizeA }, (_, i) => i)
    .filter((i) => adj[i].length > 0)
    .sort((x, y) => adj[y][0][0] - adj[x][0][0] || x - y);
  for (const i of order) tryAugment(i, new Set());

  const result: Array<[number, number, number]> = [];
  for (const [i, j] of matchA) result.push([matchScore.get(i)!, i, j]);
  result.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]); // highest-confidence matches first
  return result;
}

export function matchModelMeasures(
  measuresA: Measure[],
  measuresB: Measure[],
  threshold = 0.8,
): MeasureMatch {
  // Drop measures whose DAX is unavailable (empty) so they neither match each other nor dilute the
  // weights — otherwise a tenant that withholds expressions scores every model pair as a clone (acc1).
  const realA = measuresA.filter((m) => (m.dax ?? "").trim() !== "");
  const realB = measuresB.filter((m) => (m.dax ?? "").trim() !== "");
  const featsA = realA.map((m) => extractFeatures(m.dax));
  const featsB = realB.map((m) => extractFeatures(m.dax));
  const weightsA = realA.map((m, i) => measureWeight(m, featsA[i]));
  const weightsB = realB.map((m, i) => measureWeight(m, featsB[i]));

  const assignment = maxWeightBipartiteMatch(
    (i, j) => measureSimilarity(featsA[i], featsB[j]),
    featsA.length,
    featsB.length,
    threshold,
  );

  const matched: Array<{ a: string; b: string; score: number }> = [];
  let matchedWeight = 0;
  let strongMatched = 0;
  for (const [score, i, j] of assignment) {
    matched.push({ a: realA[i].name, b: realB[j].name, score });
    matchedWeight += Math.min(weightsA[i], weightsB[j]) * score;
    // Ref-backed = identical DAX, an exact qualified column match, or a shared SPECIFIC bare name. A
    // pure structural shape match (disjoint refs) or a generic-name-only coincidence is NOT counted,
    // so it can surface for review but never manufactures a strong dup.
    if (isRefBacked(featsA[i], featsB[j])) {
      strongMatched += 1;
    }
  }

  const totalA = weightsA.reduce((s, w) => s + w, 0);
  const totalB = weightsB.reduce((s, w) => s + w, 0);
  const maxT = Math.max(totalA, totalB);
  const minT = Math.min(totalA, totalB);
  const similarity = maxT ? matchedWeight / maxT : 0;
  const containment = minT ? matchedWeight / minT : 0;
  return { similarity: round4(similarity), containment: round4(Math.min(1, containment)), matched, strongMatched };
}
