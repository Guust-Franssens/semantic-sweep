"""Physical-source-mismatch banding coverage (mirrors rayfin-app physical-source-banding.test.ts).

Guards the P1 fix: a confirmed physical-source mismatch (e.g. two regional shards of the same
template) must downgrade the classified band, not just add a cosmetic warning. Kept in lockstep
with ``engine/index.ts`` so TS and Python bands stay identical.
"""

# pylint: disable=missing-function-docstring

from pathlib import Path

from semantic_sweep.parser import load_models
from semantic_sweep.score import BAND_EXACT, BAND_REVIEW, DUPLICATE_BANDS, score_pair


def _sales_table(server: str) -> str:
    lines = [
        "table Sales",
        "",
        "\tcolumn Amount",
        "\t\tdataType: double",
        "\t\tsourceColumn: Amount",
        "",
        "\tpartition Sales = m",
        "\t\tmode: import",
        "\t\tsource =",
        "\t\t\tlet",
        f'\t\t\t\tSource = Sql.Database("{server}", "SalesDB"),',
        '\t\t\t\tData = Source{[Schema="dbo", Item="Sales"]}[Data]',
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


def _write_model(root: Path, workspace: str, name: str, server: str) -> None:
    base = root / workspace / f"{name}.SemanticModel" / "definition" / "tables"
    base.mkdir(parents=True, exist_ok=True)
    (base / "Sales.tmdl").write_text(_sales_table(server), encoding="utf-8")
    measures = [("Total", "SUM(Sales[Amount])"), ("Count", "COUNTROWS(Sales)"), ("Avg", "AVERAGE(Sales[Amount])")]
    (base / "_Measures.tmdl").write_text(_measures_tmdl(measures), encoding="utf-8")


def test_physical_source_mismatch_downgrades_to_needs_review(tmp_path):
    # Byte-identical measures/schema, but SalesEU and SalesUS point at two different SQL endpoints
    # (a regional shard scenario) -- must never be reported as a consolidation-actionable duplicate.
    _write_model(tmp_path, "Prod", "SalesEU", "eu-sql.contoso.com")
    _write_model(tmp_path, "Prod", "SalesUS", "us-sql.contoso.com")
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}
    a, b = by_name["SalesEU"], by_name["SalesUS"]
    pair = score_pair(a, b)
    assert pair.facets["measure"] >= 0.95
    assert pair.facets["schema"] >= 0.95
    assert pair.facets["source_physical"] < 1
    assert pair.band not in DUPLICATE_BANDS
    assert pair.band == BAND_REVIEW
    assert "different physical source / endpoint" in pair.warnings


def test_physical_source_match_still_classifies_as_exact_clone(tmp_path):
    # Control case: same two models, SAME physical endpoint -- still an exact clone.
    _write_model(tmp_path, "Prod", "SalesA", "eu-sql.contoso.com")
    _write_model(tmp_path, "Prod", "SalesB", "eu-sql.contoso.com")
    cards = load_models(tmp_path)
    by_name = {c.name: c for c in cards}
    a, b = by_name["SalesA"], by_name["SalesB"]
    pair = score_pair(a, b)
    assert pair.band == BAND_EXACT
    assert "different physical source / endpoint" not in pair.warnings
