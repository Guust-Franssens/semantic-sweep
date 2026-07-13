"""Subset + transitive cluster-visibility coverage (mirrors rayfin-app clusters.test.ts).

Guards two correctness fixes that only manifest on customer estates (the seeded tenant has no
subset pairs and its one organic cluster is a full triangle):

* subset (trimmed copy) pairs must surface in the actionable worklist, not be silently excluded;
* every member of a strong/subset-connected component must be retained, including members reachable
  only transitively (A~B~C with A!~C and keep=A must not drop C).

Kept in lockstep with ``engine/index.ts`` / ``semantic_sweep/score.py`` so the TS and Python
clustering stay identical.
"""

# pylint: disable=missing-function-docstring,redefined-outer-name

from pathlib import Path

from semantic_sweep.parser import load_models
from semantic_sweep.report import build_report
from semantic_sweep.score import BAND_SUBSET, CLUSTER_BANDS, organic_clusters, score_all, score_pair


def _table_tmdl(columns: list[str]) -> str:
    lines = ["table FactUsage", ""]
    for col in columns:
        lines += [f"\tcolumn {col}", "\t\tdataType: double", "\t\tsummarizeBy: none", ""]
    lines += [
        "\tpartition FactUsage = entity",
        "\t\tmode: directLake",
        "\t\tsource",
        "\t\t\tentityName: FactUsage",
        "\t\t\tschemaName: dbo",
        "",
    ]
    return "\n".join(lines)


def _measures_tmdl(measures: list[tuple[str, str]]) -> str:
    lines = ["table _Measures", ""]
    for name, dax in measures:
        lines += [f"\tmeasure '{name}' = {dax}", "\t\tformatString: 0", ""]
    return "\n".join(lines)


def _write_model(root: Path, workspace: str, name: str, measures: list[tuple[str, str]], columns: list[str]) -> None:
    base = root / workspace / f"{name}.SemanticModel" / "definition" / "tables"
    base.mkdir(parents=True, exist_ok=True)
    (base / "FactUsage.tmdl").write_text(_table_tmdl(columns), encoding="utf-8")
    (base / "_Measures.tmdl").write_text(_measures_tmdl(measures), encoding="utf-8")


# n exact SUM-over-Va* / AVERAGE-over-Vc* measures — disjoint AND dissimilar across the two families
# (different aggregator + columns), so a SUM model never partially matches an AVERAGE one.
def _sum_a(n: int) -> list[tuple[str, str]]:
    return [(f"SalesA{i}", f"SUM(FactUsage[Va{i}])") for i in range(n)]


def _avg_c(n: int) -> list[tuple[str, str]]:
    return [(f"CostC{i}", f"AVERAGE(FactUsage[Vc{i}])") for i in range(n)]


def _va(n: int) -> list[str]:
    return [f"Va{i}" for i in range(n)]


def _vc(n: int) -> list[str]:
    return [f"Vc{i}" for i in range(n)]


def test_subset_copy_clusters_as_candidate(tmp_path):
    # Core has 8 SUM measures; Trim's 4 are an exact subset over the same schema/source.
    _write_model(tmp_path, "Ops", "Core Model", _sum_a(8), _va(8))
    _write_model(tmp_path, "Ops", "Trim Copy", _sum_a(4), _va(8))
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}

    assert score_pair(by_name["Core Model"], by_name["Trim Copy"]).band == BAND_SUBSET

    clusters = organic_clusters(cards, score_all(cards))
    cluster = next((cl for cl in clusters if any(m.name == "Trim Copy" for m in cl.members)), None)
    assert cluster is not None  # subset now surfaces (previously excluded from clusters)
    assert sorted(m.name for m in cluster.members) == ["Core Model", "Trim Copy"]
    assert cluster.keep.name == "Core Model"  # superset is the keep nominee


def test_transitive_member_retained(tmp_path):
    # A~B and B~C are cluster edges (B is the hub holding both measure sets); A's SUM-over-Va and
    # C's AVERAGE-over-Vc measures are disjoint AND dissimilar so A!~C. keep=A (prod outranks dev),
    # making A a LEAF -> the old direct-edge-to-keep filter dropped transitive member C.
    _write_model(tmp_path, "Alpha prod", "Alpha Sales", _sum_a(4), _va(4))
    _write_model(tmp_path, "Beta dev", "Beta Sales", _sum_a(4) + _avg_c(4), _va(4) + _vc(4))
    _write_model(tmp_path, "Gamma dev", "Gamma Sales", _avg_c(4), _vc(4))
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}
    a, b, c = by_name["Alpha Sales"], by_name["Beta Sales"], by_name["Gamma Sales"]

    # Precondition: the intended topology actually holds.
    assert score_pair(a, b).band in CLUSTER_BANDS
    assert score_pair(b, c).band in CLUSTER_BANDS
    assert score_pair(a, c).band not in CLUSTER_BANDS  # A!~C, no direct edge

    clusters = organic_clusters(cards, score_all(cards))
    cluster = next((cl for cl in clusters if any(m.name == "Alpha Sales" for m in cl.members)), None)
    assert cluster is not None
    assert cluster.keep.name == "Alpha Sales"  # prod outranks the dev hub
    # C is only transitively connected (via B) -- it must NOT vanish.
    assert sorted(m.name for m in cluster.members) == ["Alpha Sales", "Beta Sales", "Gamma Sales"]


def test_system_generated_duplicates_surface_as_held_back(tmp_path):
    # Two identical auto-generated models (name matches "usage metrics" -> system_generated). They are
    # correctly excluded from the consolidation worklist, but the report must still SHOW them as
    # detected duplicates held back, so the scan never looks like it missed obvious clones (imp-a7).
    _write_model(tmp_path, "Team A", "Usage Metrics Report", _sum_a(4), _va(4))
    _write_model(tmp_path, "Team B", "Usage Metrics Report Copy", _sum_a(4), _va(4))
    cards = load_models(tmp_path)
    assert all(c.system_generated for c in cards)
    pairs = score_all(cards)

    # Not a consolidation cluster (system-generated is excluded from the worklist).
    assert not organic_clusters(cards, pairs)

    report = build_report(cards, pairs, [])
    assert "held back" in report
    assert "Usage Metrics Report" in report and "Usage Metrics Report Copy" in report
