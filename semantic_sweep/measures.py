"""Measure-level similarity: weighted lexical DAX features + maximum bipartite matching.

We deliberately avoid embeddings (a general text model collapses ``SUM`` vs ``AVERAGE``). Instead
each measure becomes a small feature set (functions, referenced columns/measures, operators,
context flags, a clone *skeleton*) and pairs are scored by a weighted blend with two guards:
an **incompatible-aggregator penalty** (``SUM`` vs ``AVERAGE``) and **function-family partial
credit** (``ROUND`` vs ``TRUNC``). Models are then matched one-to-one via Kuhn's augmenting-path
algorithm (see ``_max_weight_bipartite_match``), which finds a maximum-cardinality assignment
instead of the smaller matching a naive greedy first-come-first-served pass can get stuck with.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from semantic_sweep.parser import Measure

AGGREGATORS = {
    "sum",
    "average",
    "min",
    "max",
    "count",
    "counta",
    "countrows",
    "distinctcount",
    "sumx",
    "averagex",
    "minx",
    "maxx",
    "countx",
    "product",
    "productx",
    "median",
    "geomean",
}
FUNCTION_FAMILIES = {
    "round": "rounding",
    "roundup": "rounding",
    "rounddown": "rounding",
    "trunc": "rounding",
    "int": "rounding",
    "mround": "rounding",
    "fixed": "rounding",
    "ceiling": "rounding",
    "floor": "rounding",
    "sum": "additive",
    "sumx": "additive",
    "average": "mean",
    "averagex": "mean",
    "count": "counting",
    "counta": "counting",
    "countrows": "counting",
    "countx": "counting",
    "distinctcount": "counting",
}
CONTEXT_FLAGS = {
    "calculate",
    "calculatetable",
    "filter",
    "all",
    "allexcept",
    "allselected",
    "removefilters",
    "userelationship",
    "keepfilters",
    "sameperiodlastyear",
    "dateadd",
    "totalytd",
    "totalmtd",
    "totalqtd",
    "datesytd",
    "parallelperiod",
    "previousmonth",
    "previousyear",
    "datesinperiod",
}
GENERIC_NAMES = {
    "total",
    "count",
    "sum",
    "amount",
    "value",
    "measure",
    "result",
    "kpi",
    "average",
    "max",
    "min",
}

# Column/measure ref names common enough to recur across unrelated tables on any estate with a
# shared naming convention (e.g. every fact table has an [Amount], every dimension has a [Date]). A
# bare match on one of these must not, by itself, count as ref-backed strong-duplicate evidence
# (acc6) -- unlike GENERIC_NAMES above (measure-name weighting), this gates measure-level evidence.
GENERIC_REF_NAMES = {
    "id",
    "key",
    "code",
    "name",
    "date",
    "value",
    "amount",
    "total",
    "count",
    "sum",
    "status",
    "type",
    "description",
    "flag",
    "number",
    "quantity",
    "price",
    "region",
    "category",
    "year",
    "month",
    "day",
    "created",
    "modified",
    "updated",
}

_BRACKET = re.compile(r"\[([^\]]+)\]")
_REF = re.compile(r"(?:'[^']*'|\w+)?\[[^\]]*\]")
# Same shape as _REF but captures the qualifier (quoted or bare) separately from the bracket content,
# so a "table.column" ref can be built only when a qualifier is actually present in the source DAX.
_QUALIFIED_REF = re.compile(r"(?:'([^']*)'|(\w+))?\[([^\]]+)\]")
# A DAX string literal, escape-aware: an embedded literal `"` is written as a doubled `""` inside the
# string (e.g. `"He said ""hi"""`). A naive `"[^"]*"` stops at the first inner `"`, truncating the
# literal and leaking the remainder as if it were DAX code (dax-tokenizer-hardening).
_STRING = re.compile(r'"(?:[^"]|"")*"')
# One pass, string-aware: tries a full string literal FIRST at each position, so a "//" or "/*" that
# appears INSIDE a string is consumed as part of the string and never misread as a comment start (the
# previous two-pass comment stripper had no string awareness at all).
_COMMENT_OR_STRING = re.compile(_STRING.pattern + r"|/\*.*?\*/|//[^\n]*", re.DOTALL)
_NUMBER = re.compile(r"\b\d+(?:\.\d+)?\b")
_FUNC = re.compile(r"\b([a-z][a-z0-9]*)\s*\(")
_OPERATOR = re.compile(r"[+\-*/&<>=]")

# Weighted blend over *present* feature components (renormalized when some are empty).
_COMPONENT_WEIGHTS = {"refs": 0.45, "functions": 0.30, "flags": 0.15, "operators": 0.10}
_SKELETON_SCORE = 0.92
# Same structural skeleton but the referenced names differ: interpolate between _SKELETON_FLOOR (a
# pure shape collision, e.g. SUM(Sales[x]) vs SUM(HR[y])) and _SKELETON_SCORE (renamed table, same
# column). Kept >= _REVIEW_MEASURE so a fully-renamed clone still surfaces; the strong-duplicate gate
# is enforced separately via ref-backed evidence (MeasureMatch.strong_matched).
_SKELETON_FLOOR = 0.90
_AGG_PENALTY = 0.6


@dataclass(frozen=True)
class DaxFeatures:  # pylint: disable=too-many-instance-attributes
    """Lexical features extracted from one measure's normalized DAX (cohesive feature bag)."""

    norm: str
    skeleton: str
    functions: frozenset[str]
    refs: frozenset[str]
    # "table.column" refs, populated only when a table qualifier is present in the source DAX (e.g.
    # "sales.amount" from Sales[Amount]). Used to require unambiguous evidence before two measures
    # referencing a common *generic* bare name (e.g. [Amount], [Date]) on different tables count as
    # ref-backed strong-duplicate evidence (acc6).
    qualified_refs: frozenset[str]
    aggregators: frozenset[str]
    operators: frozenset[str]
    flags: frozenset[str]


def normalize_dax(dax: str) -> str:
    """Lower-case the DAX and strip comments (string/escape aware) and redundant whitespace."""
    text = _COMMENT_OR_STRING.sub(lambda m: m.group(0) if m.group(0).startswith('"') else " ", dax)
    return re.sub(r"\s+", " ", text.lower()).strip()


def _skeleton(norm: str) -> str:
    """Structural skeleton: blank refs (incl. table prefix)/strings/numbers so renamed clones collide."""
    text = _REF.sub("#r#", norm)
    text = _STRING.sub("#s#", text)
    text = _NUMBER.sub("#n#", text)
    return re.sub(r"\s+", "", text)


def _extract_qualified_refs(no_strings: str) -> frozenset[str]:
    """Extract "table.column" refs, only when a table qualifier is present in the source DAX."""
    out = set()
    for quoted, bare, name in _QUALIFIED_REF.findall(no_strings):
        qualifier = quoted or bare
        if qualifier:
            out.add(f"{qualifier}.{name}")
    return frozenset(out)


def extract_features(dax: str) -> DaxFeatures:
    """Extract :class:`DaxFeatures` from a raw DAX expression."""
    norm = normalize_dax(dax)
    functions = frozenset(_FUNC.findall(norm))
    # Neutralize string literals before extracting refs so a format string like FORMAT(x, "[Red]0")
    # does not leak a bogus "red" reference (acc3).
    no_strings = _STRING.sub('""', norm)
    return DaxFeatures(
        norm=norm,
        skeleton=_skeleton(norm),
        functions=functions,
        refs=frozenset(m.lower() for m in _BRACKET.findall(no_strings)),
        qualified_refs=_extract_qualified_refs(no_strings),
        aggregators=frozenset(functions & AGGREGATORS),
        operators=frozenset(_OPERATOR.findall(norm)),
        flags=frozenset(functions & CONTEXT_FLAGS),
    )


def _is_ref_backed(a: DaxFeatures, b: DaxFeatures) -> bool:
    """True if two matched measures share genuine reference evidence, not a coincidental collision.

    Identical DAX or an exact table-qualified column/measure match is unambiguous. A shared BARE name
    is only accepted when it is specific enough to not be a coincidence -- a shared *generic* name
    like [Amount] or [Date] recurs across unrelated tables on any estate with a common naming
    convention and must not manufacture strong-duplicate evidence on its own (acc6). Renamed-table
    clones with specific shared column names (e.g. Sales[amt0] ~ Revenue[amt0]) still count,
    preserving the acc5 renamed-clone heuristic.
    """
    if a.norm == b.norm:
        return True
    if a.qualified_refs & b.qualified_refs:
        return True
    shared = a.refs & b.refs
    return any(name not in GENERIC_REF_NAMES for name in shared)


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def round4(x: float) -> float:
    """Round to 4 decimals using round-half-up, matching the TS engine's ``Math.round``-based
    ``round4`` (engine/types.ts). Python's builtin ``round()`` uses banker's rounding (ties-to-even),
    which disagrees with JS on exact 4th-decimal ties -- e.g. ``round(0.03125, 4)`` is ``0.0312`` in
    Python but ``0.0313`` in JS. Every value passed here (jaccard ratios, weighted headline scores)
    is non-negative, so round-half-up is unambiguous and reproduces the JS result exactly.
    """
    return math.floor(x * 10000 + 0.5) / 10000


def _function_similarity(a: frozenset[str], b: frozenset[str]) -> float:
    """Jaccard over functions, but same-family functions (round/trunc) get half credit."""
    if not a and not b:
        return 0.0
    exact = a & b
    rest_a = {FUNCTION_FAMILIES[f] for f in (a - exact) if f in FUNCTION_FAMILIES}
    rest_b = {FUNCTION_FAMILIES[f] for f in (b - exact) if f in FUNCTION_FAMILIES}
    soft = len(exact) + 0.5 * len(rest_a & rest_b)
    return min(1.0, soft / len(a | b))


def measure_similarity(a: DaxFeatures, b: DaxFeatures) -> float:
    """Similarity in [0, 1] between two measures' features (1.0 = identical normalized DAX)."""
    # No DAX on either side (e.g. a locked-down / admin scan that withholds expressions) is NOT
    # evidence of a match -- two shape-identical models must not read as exact clones (acc1).
    if not a.norm and not b.norm:
        return 0.0
    if a.norm == b.norm:
        return 1.0
    if a.skeleton and a.skeleton == b.skeleton:
        return round4(_SKELETON_FLOOR + (_SKELETON_SCORE - _SKELETON_FLOOR) * _jaccard(a.refs, b.refs))
    scores = {
        "refs": _jaccard(a.refs, b.refs),
        "functions": _function_similarity(a.functions, b.functions),
        "flags": _jaccard(a.flags, b.flags),
        "operators": _jaccard(a.operators, b.operators),
    }
    present = {
        ("refs", a.refs or b.refs),
        ("functions", a.functions or b.functions),
        ("flags", a.flags or b.flags),
        ("operators", a.operators or b.operators),
    }
    active = [(k, _COMPONENT_WEIGHTS[k]) for k, has in present if has]
    if not active:
        return 0.0
    base = sum(w * scores[k] for k, w in active) / sum(w for _, w in active)
    if a.aggregators and b.aggregators and a.aggregators.isdisjoint(b.aggregators) and (a.refs & b.refs):
        base *= _AGG_PENALTY  # SUM(x) vs AVERAGE(x): same column, incompatible aggregator
    return round4(min(1.0, base))


def _measure_weight(measure: Measure, feats: DaxFeatures) -> float:
    """Informativeness weight: generic-named measures count less; complex ones count more.

    Tokenize on word boundaries (not a single concatenated blob) so a multi-word name like "Total
    Sales" is judged word-by-word against GENERIC_NAMES instead of vanishing into "totalsales",
    which matches nothing and was silently never downweighted. Square the generic-word fraction
    before applying the discount: a name that is ALL generic words (e.g. "Total", or "Total Count")
    still gets the full 0.4 floor exactly as before, but a name that is only PARTLY generic (e.g.
    "Total Sales") is discounted much more gently, since one specific word ("Sales") already carries
    most of the discriminating signal -- informativeness doesn't fall off linearly with word count.
    """
    words = [w for w in re.split(r"[^a-z0-9]+", measure.name.lower()) if w]
    generic_frac = (sum(1 for w in words if w in GENERIC_NAMES) / len(words)) if words else 0.0
    base = 1.0 - 0.6 * generic_frac * generic_frac
    complexity = 1.0 + 0.1 * min(len(feats.functions) + len(feats.refs), 6)
    return base * complexity


@dataclass
class MeasureMatch:
    """Result of matching two models' measure sets."""

    similarity: float
    containment: float
    matched: list[tuple[str, str, float]] = field(default_factory=list)
    # Matched pairs backed by real reference overlap (identical DAX or a shared column), not just a
    # coincidental structural shape. Gates the strong-duplicate / subset bands (see score.py).
    strong_matched: int = 0


def _max_weight_bipartite_match(
    score_of: Callable[[int, int], float], size_a: int, size_b: int, threshold: float
) -> list[tuple[float, int, int]]:
    """Maximum-cardinality bipartite matching via Kuhn's augmenting-path algorithm.

    A plain greedy "sort candidates by score, take first-come-first-served" pass under-counts
    matches: whichever side of a contested pair loses out is left unmatched even when a different,
    equally-valid assignment would have matched EVERY measure that has a candidate. Example:
    A0~B0=0.90, A0~B1=0.85, A1~B0=0.88 (A1~B1 below threshold). Greedy takes A0-B0 first (highest
    score) and then discards both A1~B0 (B0 taken) and A0~B1 (A0 taken), leaving A1 unmatched --
    even though A0-B1 + A1-B0 matches both sides. Kuhn's algorithm finds that second assignment by
    letting a contested node "steal" its match and pushing the displaced node to search for an
    alternative (an augmenting path), which is guaranteed to find a maximum matching regardless of
    processing order. Node order (by each node's best candidate score, descending) and per-node
    edge order (by score, descending) are both deterministic tie-breakers that bias the search
    toward higher-weight matchings among the (possibly several) maximum ones.
    """
    adj: list[list[tuple[float, int]]] = []  # adj[i] = [(score, j), ...] desc by score, then j
    for i in range(size_a):
        row = [(score_of(i, j), j) for j in range(size_b) if score_of(i, j) >= threshold]
        row.sort(key=lambda t: (-t[0], t[1]))
        adj.append(row)

    match_b: dict[int, int] = {}  # j -> i
    match_a: dict[int, int] = {}  # i -> j
    match_score: dict[int, float] = {}  # i -> score of its current match

    def try_augment(i: int, visited_b: set[int]) -> bool:
        for score, j in adj[i]:
            if j in visited_b:
                continue
            visited_b.add(j)
            occupant = match_b.get(j)
            if occupant is None or try_augment(occupant, visited_b):
                match_b[j] = i
                match_a[i] = j
                match_score[i] = score
                return True
        return False

    order = sorted((i for i in range(size_a) if adj[i]), key=lambda i: (-adj[i][0][0], i))
    for i in order:
        try_augment(i, set())

    result = [(match_score[i], i, j) for i, j in match_a.items()]
    result.sort(key=lambda t: (-t[0], t[1], t[2]))  # highest-confidence matches first
    return result


def match_model_measures(
    measures_a: list[Measure], measures_b: list[Measure], *, threshold: float = 0.8
) -> MeasureMatch:
    """Maximum one-to-one match between two measure sets; return similarity + containment.

    ``similarity = matched_weight / max(total)`` (penalizes size gaps), while
    ``containment = matched_weight / min(total)`` flags a subset/trimmed copy.
    """
    # pylint: disable=too-many-locals  # cohesive matching algorithm
    # Drop measures whose DAX is unavailable (empty) so they neither match each other nor dilute the
    # weights -- otherwise a tenant that withholds expressions scores every model pair as a clone (acc1).
    real_a = [m for m in measures_a if (m.dax or "").strip()]
    real_b = [m for m in measures_b if (m.dax or "").strip()]
    feats_a = [extract_features(m.dax) for m in real_a]
    feats_b = [extract_features(m.dax) for m in real_b]
    weights_a = [_measure_weight(m, f) for m, f in zip(real_a, feats_a)]
    weights_b = [_measure_weight(m, f) for m, f in zip(real_b, feats_b)]

    assignment = _max_weight_bipartite_match(
        lambda i, j: measure_similarity(feats_a[i], feats_b[j]), len(feats_a), len(feats_b), threshold
    )

    matched: list[tuple[str, str, float]] = []
    matched_weight = 0.0
    strong_matched = 0
    for score, i, j in assignment:
        matched.append((real_a[i].name, real_b[j].name, score))
        matched_weight += min(weights_a[i], weights_b[j]) * score
        # Ref-backed = identical DAX, an exact qualified column match, or a shared SPECIFIC bare name.
        # A pure structural shape match (disjoint refs) or a generic-name-only coincidence is not
        # counted, so it surfaces for review but never manufactures a dup.
        if _is_ref_backed(feats_a[i], feats_b[j]):
            strong_matched += 1

    total_a, total_b = sum(weights_a), sum(weights_b)
    similarity = matched_weight / max(total_a, total_b) if max(total_a, total_b) else 0.0
    containment = matched_weight / min(total_a, total_b) if min(total_a, total_b) else 0.0
    return MeasureMatch(
        similarity=round4(similarity),
        containment=round4(min(1.0, containment)),
        matched=matched,
        strong_matched=strong_matched,
    )
