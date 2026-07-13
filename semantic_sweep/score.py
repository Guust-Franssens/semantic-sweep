"""Multi-facet pair scoring, decision bands, lifecycle labeling, and organic clustering.

A blended ``headline`` score *ranks* pairs, but the duplicate **label** comes from decision bands
with per-facet gates (source-alone or schema-alone never imply a duplicate). Pairs that are
same-item promotions across environments are tagged ``lifecycle`` and kept out of the organic
consolidation clusters.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from semantic_sweep.lifecycle import classify_workspace, is_lifecycle_candidate
from semantic_sweep.measures import MeasureMatch, match_model_measures
from semantic_sweep.parser import ModelCard

FACET_WEIGHTS = {"measure": 0.40, "schema": 0.20, "source_logical": 0.22, "source_physical": 0.08, "rel": 0.10}

# Band thresholds (tunable; frozen from reasoning, not fitted to the labels we report).
_EXACT_MEASURE, _EXACT_SCHEMA = 0.95, 0.95
_STRONG_MEASURE, _STRONG_SUPPORT = 0.55, 0.50
_SUBSET_CONTAIN, _SUBSET_SCHEMA = 0.80, 0.40
_RELATED_SOURCE, _RELATED_MEASURE = 0.60, 0.30
_REVIEW_HEADLINE = 0.45
_REVIEW_MEASURE = 0.85  # high structural measure match alone -> surface for review (e.g. renamed clone)
_LIFECYCLE_MEASURE = 0.60
# A strong-duplicate / subset claim needs genuine measure evidence: at least this many measures must
# actually match WITH ref backing (identical DAX or a shared column) -- not merely a structural shape
# collision. Schema/source overlap with a handful of shape-only matches (e.g. two small models over a
# shared Date dimension) is never a duplicate -> it falls through to related/review.
_MIN_DUP_MEASURES = 3

BAND_EXACT = "exact-clone"
BAND_STRONG = "strong-duplicate"
BAND_SUBSET = "subset"
BAND_RELATED = "related-source"
BAND_REVIEW = "needs-review"
BAND_UNRELATED = "unrelated"
DUPLICATE_BANDS = {BAND_EXACT, BAND_STRONG}
# Bands that earn a consolidation-cluster edge. Superset of DUPLICATE_BANDS: a SUBSET (trimmed copy
# largely contained in a larger model) is a real "redirect X -> Y" consolidation candidate, so it
# clusters too — while staying out of DUPLICATE_BANDS, which counts only co-equal exact/strong pairs.
CLUSTER_BANDS = {BAND_EXACT, BAND_STRONG, BAND_SUBSET}


@dataclass
class PairResult:  # pylint: disable=too-many-instance-attributes
    """Scored result for one model pair."""

    a: ModelCard
    b: ModelCard
    facets: dict[str, float]
    headline: float
    band: str
    lifecycle: bool
    measure: MeasureMatch
    warnings: list[str] = field(default_factory=list)


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def _schema_score(a: ModelCard, b: ModelCard) -> float:
    tables = _jaccard({t.lower() for t in a.tables}, {t.lower() for t in b.tables})
    columns = _jaccard(a.qualified_columns, b.qualified_columns)
    return round((tables + columns) / 2, 4)


def _applicable(name: str, a: ModelCard, b: ModelCard) -> bool:
    getters = {
        # A card only carries measure evidence if at least one measure has DAX. When a tenant withholds
        # expressions (admin scan) the facet deactivates rather than reading shape-identical models as
        # clones -- the pair falls back to schema/source evidence and, at most, "needs review" (acc1).
        "measure": lambda c: any((m.dax or "").strip() for m in c.measures),
        "schema": lambda c: c.tables,
        "source_logical": lambda c: c.source_logical,
        "source_physical": lambda c: c.source_physical,
        "rel": lambda c: c.relationships,
    }
    get = getters[name]
    return bool(get(a)) and bool(get(b))


def _classify_band(
    measure_sim: float, contain: float, schema: float, src_logical: float, headline: float, ref_backed_count: int
) -> str:
    # pylint: disable=too-many-return-statements,too-many-arguments,too-many-positional-arguments  # cohesive band cascade
    if measure_sim >= _EXACT_MEASURE and schema >= _EXACT_SCHEMA:
        return BAND_EXACT
    support = max(schema, src_logical)
    has_evidence = ref_backed_count >= _MIN_DUP_MEASURES
    # STRONG needs genuine measure *similarity* + supporting schema/source. High containment with low
    # similarity (a small model whose few measures subset a larger one) is a SUBSET, handled below --
    # not a co-equal duplicate. This stops schema/source overlap alone from manufacturing duplicates.
    if has_evidence and measure_sim >= _STRONG_MEASURE and support >= _STRONG_SUPPORT:
        return BAND_STRONG
    # SUBSET: trimmed copy. The matched-measure floor stops a companion model that merely shares a
    # handful of base measures with a large one (e.g. FUAM_Item vs FUAM_Core) being mislabeled.
    if has_evidence and contain >= _SUBSET_CONTAIN and schema >= _SUBSET_SCHEMA and measure_sim < _STRONG_MEASURE:
        return BAND_SUBSET
    if src_logical >= _RELATED_SOURCE and measure_sim < _RELATED_MEASURE:
        return BAND_RELATED
    if measure_sim >= _REVIEW_MEASURE:
        return BAND_REVIEW
    if headline >= _REVIEW_HEADLINE:
        return BAND_REVIEW
    return BAND_UNRELATED


def _warnings(a: ModelCard, b: ModelCard, facets: dict[str, float]) -> list[str]:
    notes: list[str] = []
    if a.has_rls != b.has_rls:
        notes.append("different RLS (one model has row-level security, the other does not)")
    if a.has_calc_groups != b.has_calc_groups:
        notes.append("different calculation groups")
    if _applicable("source_physical", a, b) and facets["source_physical"] < 1.0:
        notes.append("different physical source / endpoint")
    return notes


def score_pair(a: ModelCard, b: ModelCard) -> PairResult:
    """Score one model pair into facets, a headline, a band, and a lifecycle flag."""
    measure = match_model_measures(a.measures, b.measures)
    facets = {
        "measure": measure.similarity,
        "schema": _schema_score(a, b),
        "source_logical": round(_jaccard(a.source_logical, b.source_logical), 4),
        "source_physical": round(_jaccard(a.source_physical, b.source_physical), 4),
        "rel": round(_jaccard(set(a.relationships), set(b.relationships)), 4),
    }
    active = [(name, weight) for name, weight in FACET_WEIGHTS.items() if _applicable(name, a, b)]
    headline = round(sum(w * facets[name] for name, w in active) / sum(w for _, w in active), 4) if active else 0.0
    band = _classify_band(
        facets["measure"],
        measure.containment,
        facets["schema"],
        facets["source_logical"],
        headline,
        measure.strong_matched,
    )
    lifecycle = is_lifecycle_candidate(a, b) and facets["measure"] >= _LIFECYCLE_MEASURE
    return PairResult(
        a=a,
        b=b,
        facets=facets,
        headline=headline,
        band=band,
        lifecycle=lifecycle,
        measure=measure,
        warnings=_warnings(a, b, facets),
    )


def score_all(cards: list[ModelCard]) -> list[PairResult]:
    """Score every pair of models; return results sorted by headline descending."""
    results = [score_pair(cards[i], cards[j]) for i in range(len(cards)) for j in range(i + 1, len(cards))]
    results.sort(key=lambda r: r.headline, reverse=True)
    return results


@dataclass
class Cluster:
    """An organic (non-lifecycle) consolidation cluster with a nominated keep model."""

    members: list[ModelCard]
    keep: ModelCard
    pairs: list[PairResult] = field(default_factory=list)


def _keep_nominee(members: list[ModelCard]) -> ModelCard:
    return max(members, key=lambda c: (classify_workspace(c.workspace).rank, c.measure_count, c.table_count))


def organic_clusters(cards: list[ModelCard], pairs: list[PairResult]) -> list[Cluster]:
    """Cluster non-system models: exact/strong edges merge symmetrically; subsets attach directionally.

    A subset (trimmed copy) is redirected into its SINGLE best container, so a small shared model
    (e.g. a Date dimension contained in two unrelated fact models) cannot bridge them into one bogus
    cluster (acc4). Two subsets of the *same* hub still cluster (both pick that hub). Every member of
    a component is retained, including members reachable only transitively (imp-a5 / imp-a6).
    """
    # pylint: disable=too-many-locals  # cohesive union-find clustering + directional subset attach

    def eligible(pair: PairResult) -> bool:
        return not pair.lifecycle and not pair.a.system_generated and not pair.b.system_generated

    index = {id(c): i for i, c in enumerate(cards)}
    parent = list(range(len(cards)))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def unite(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    edge_lookup: dict[frozenset[int], PairResult] = {}

    def add_edge(pair: PairResult) -> None:
        i, j = index[id(pair.a)], index[id(pair.b)]
        edge_lookup[frozenset((i, j))] = pair
        unite(i, j)

    for pair in pairs:  # 1. co-equal duplicates merge unconditionally
        if pair.band in DUPLICATE_BANDS and eligible(pair):
            add_edge(pair)

    best_container: dict[int, PairResult] = {}  # 2. subset -> single best container
    for pair in pairs:
        if pair.band != BAND_SUBSET or not eligible(pair):
            continue
        i, j = index[id(pair.a)], index[id(pair.b)]
        child = i if len(pair.a.measures) <= len(pair.b.measures) else j  # subset = fewer measures
        prev = best_container.get(child)
        if (
            prev is None
            or pair.facets["measure"] > prev.facets["measure"]
            or (pair.facets["measure"] == prev.facets["measure"] and pair.headline > prev.headline)
        ):
            best_container[child] = pair
    for pair in best_container.values():
        add_edge(pair)

    touched: set[int] = set()
    for edge_key in edge_lookup:
        touched |= edge_key
    by_root: dict[int, list[int]] = {}
    for n in range(len(cards)):
        if n in touched:
            by_root.setdefault(find(n), []).append(n)

    clusters: list[Cluster] = []
    for component in by_root.values():
        if len(component) < 2:
            continue
        members = [cards[n] for n in component]
        keep = _keep_nominee(members)
        member_ids = set(component)
        cluster_pairs = [pair for edge_key, pair in edge_lookup.items() if edge_key <= member_ids]
        clusters.append(Cluster(members=members, keep=keep, pairs=cluster_pairs))
    return clusters
