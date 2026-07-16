"""Precision-fix coverage (mirrors rayfin-app precision.test.ts).

Guards the Tier-1 accuracy fixes that reduce false positives without losing recall:

* acc1 - withheld/empty DAX (admin scan) must NOT read two shape-identical models as exact clones;
* acc3 - a bracketed token inside a DAX string literal must not leak as a column reference;
* acc5 - a pure structural shape match (disjoint refs) is review evidence, never strong-dup evidence;
* acc4 - a shared date model contained in two unrelated fact models must not bridge them into one
  cluster (directional subset attachment);
* acc6 - a shared GENERIC bare column name (e.g. [Amount], [Date]) on unrelated tables must not
  manufacture ref-backed strong-duplicate evidence on a shared-schema estate.

Kept in lockstep with ``engine/measures.ts`` / ``engine/index.ts`` so TS and Python stay identical.
"""

# pylint: disable=missing-function-docstring,redefined-outer-name

from pathlib import Path

from semantic_sweep.measures import extract_features, match_model_measures
from semantic_sweep.parser import Measure, load_models
from semantic_sweep.score import (
    BAND_EXACT,
    BAND_SUBSET,
    CLUSTER_BANDS,
    DUPLICATE_BANDS,
    organic_clusters,
    score_all,
    score_pair,
)


def _table(name: str, columns: list[str]) -> str:
    lines = [f"table {name}", ""]
    for col in columns:
        lines += [f"\tcolumn {col}", "\t\tdataType: string", f"\t\tsourceColumn: {col}", ""]
    lines += [
        f"\tpartition {name} = m",
        "\t\tmode: import",
        "\t\tsource =",
        "\t\t\tlet",
        '\t\t\t\tSource = Sql.Database("wh.contoso.com", "GoldLH"),',
        f'\t\t\t\tData = Source{{[Schema="dbo", Item="{name}"]}}[Data]',
        "\t\t\tin",
        "\t\t\t\tData",
        "",
    ]
    return "\n".join(lines)


def _measures_tmdl(measures: list[tuple[str, str]]) -> str:
    lines = ["table _Measures", ""]
    for name, dax in measures:
        lines += [f"\tmeasure '{name}' = {dax}", "\t\tformatString: 0", ""]
    return "\n".join(lines)


def _write_model(
    root: Path, workspace: str, name: str, tables: dict[str, list[str]], measures: list[tuple[str, str]]
) -> None:
    base = root / workspace / f"{name}.SemanticModel" / "definition" / "tables"
    base.mkdir(parents=True, exist_ok=True)
    for table, columns in tables.items():
        (base / f"{table}.tmdl").write_text(_table(table, columns), encoding="utf-8")
    if measures:
        (base / "_Measures.tmdl").write_text(_measures_tmdl(measures), encoding="utf-8")


def _shape(agg: str, table: str, cols: list[str]) -> list[tuple[str, str]]:
    return [(f"{table} {c}", f"{agg}({table}[{c}])") for c in cols]


def test_withheld_dax_is_not_a_clone(tmp_path):
    # acc1: two identical models over the same schema/source, expressions later withheld.
    cols = ["V0", "V1", "V2", "V3"]
    measures = _shape("SUM", "FactUsage", cols)
    _write_model(tmp_path, "WS", "Model A", {"FactUsage": cols}, measures)
    _write_model(tmp_path, "WS", "Model B", {"FactUsage": cols}, measures)
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}
    a, b = by_name["Model A"], by_name["Model B"]
    # Sanity: with DAX present they are an exact clone.
    assert score_pair(a, b).band == BAND_EXACT

    # Simulate an admin / locked-down scan that withholds every measure expression.
    for card in cards:
        for measure in card.measures:
            measure.dax = ""
    pair = score_pair(a, b)
    assert pair.facets["measure"] == 0  # no measure evidence
    assert pair.band not in DUPLICATE_BANDS  # schema/source alone is never a clone


def test_string_literal_bracket_not_leaked_as_ref():
    # acc3: a bracketed token inside a format string must not become a column ref.
    feats = extract_features('FORMAT(Sales[Amount], "[Red]#,0;[Green](#,0)")')
    assert "amount" in feats.refs
    assert "red" not in feats.refs and "green" not in feats.refs


def test_shape_only_match_is_not_ref_backed():
    # acc5: identical skeleton, disjoint refs -> matches structurally but zero ref-backed evidence.
    a = [Measure(name=f"MA{i}", dax=f"SUM(Sales[a{i}])") for i in range(4)]
    b = [Measure(name=f"MB{i}", dax=f"SUM(HR[b{i}])") for i in range(4)]
    match = match_model_measures(a, b)
    assert len(match.matched) >= 3
    assert match.strong_matched == 0


def test_shared_ref_is_ref_backed():
    # acc5: same column name, different table (renamed-clone shape) -> refs intersect -> ref-backed.
    a = [Measure(name=f"MA{i}", dax=f"SUM(Sales[amt{i}])") for i in range(4)]
    b = [Measure(name=f"MB{i}", dax=f"SUM(Revenue[amt{i}])") for i in range(4)]
    assert match_model_measures(a, b).strong_matched >= 3


def test_qualified_ref_captured_only_with_a_table_qualifier():
    # acc6: "table.column" is only captured when a qualifier is actually present in the source DAX.
    qualified = extract_features("SUM(Sales[Amount])")
    assert "sales.amount" in qualified.qualified_refs
    bare = extract_features("SUM([Amount])")
    assert not bare.qualified_refs
    assert "amount" in bare.refs  # still a bare ref, just not table-qualified


def test_generic_bare_ref_across_unrelated_tables_is_not_ref_backed():
    # acc6: Sales[Amount]/[Date]/[Id]/[Name] vs Budget[Amount]/[Date]/[Id]/[Name] -- same GENERIC
    # names, unrelated tables (the P0 false positive: "Sales[Amount] ~ Budget[Amount]"). Still
    # matches structurally (surfaces for review) but must not manufacture strong-dup evidence.
    cols = ["Amount", "Date", "Id", "Name"]
    a = [Measure(name=f"MA{i}", dax=f"SUM(Sales[{c}])") for i, c in enumerate(cols)]
    b = [Measure(name=f"MB{i}", dax=f"SUM(Budget[{c}])") for i, c in enumerate(cols)]
    match = match_model_measures(a, b)
    assert len(match.matched) >= 3
    assert match.strong_matched == 0


def test_date_hub_does_not_bridge_supersets(tmp_path):
    # acc4: a shared date model is a SUBSET of two unrelated fact models, but must not bridge them.
    date_cols = ["Year", "Quarter", "Month", "Day", "Date"]
    date_measures = [
        ("Row Count", "COUNTROWS(DimDate)"),
        ("Year Count", "DISTINCTCOUNT(DimDate[Year])"),
        ("Latest Date", "MAX(DimDate[Date])"),
        ("Earliest Date", "MIN(DimDate[Date])"),
    ]
    sales_cols = ["s0", "s1", "s2", "s3", "s4", "s5"]
    hr_cols = ["h0", "h1", "h2", "h3", "h4", "h5"]
    _write_model(tmp_path, "Finance", "Date Tools", {"DimDate": date_cols}, date_measures)
    _write_model(
        tmp_path,
        "Sales",
        "Sales Model",
        {"DimDate": date_cols, "FactSales": sales_cols},
        date_measures + _shape("SUM", "FactSales", sales_cols),
    )
    _write_model(
        tmp_path,
        "People",
        "HR Model",
        {"DimDate": date_cols, "FactHR": hr_cols},
        date_measures + _shape("AVERAGE", "FactHR", hr_cols),
    )
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}
    d, s, h = by_name["Date Tools"], by_name["Sales Model"], by_name["HR Model"]

    # Precondition: the date hub is a SUBSET of each fact model, but the fact models are unrelated
    # to each other (Sales uses SUM, HR uses AVERAGE -> the fact measures never shape-match).
    assert score_pair(d, s).band == BAND_SUBSET
    assert score_pair(d, h).band == BAND_SUBSET
    assert score_pair(s, h).band not in CLUSTER_BANDS

    clusters = organic_clusters(cards, score_all(cards))
    # No cluster may contain BOTH fact models (the old undirected subset edges bridged them).
    for cluster in clusters:
        names = {m.name for m in cluster.members}
        assert not (names >= {"Sales Model", "HR Model"})
    # The date hub attaches to exactly ONE container.
    d_cluster = next((cl for cl in clusters if any(m.name == "Date Tools" for m in cl.members)), None)
    assert d_cluster is not None
    assert len(d_cluster.members) == 2
