"""model_id() collision guard (mirrors rayfin-app/src/__tests__ scan-identity coverage).

model_id() has no identity to fall back on beyond "workspace/name" (a TMDL-zip upload carries no
true unique id). Two cards sharing both fields -- an ad-hoc upload with a reused workspace label,
or a live-scan workspace deleted and recreated under the same display name -- must not collapse
into a single slot in anything keyed by model_id(): the report's identity map, and the UI's labels
map, which is what previously produced a duplicated-looking label like "Sales, Sales" instead of
two distinguishable rows.
"""

# pylint: disable=missing-function-docstring

from pathlib import Path

from semantic_sweep.parser import load_models, model_id
from semantic_sweep.score import dedupe_model_ids, organic_clusters, score_all


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


def test_same_workspace_and_name_collide_before_dedupe(tmp_path):
    # Two unrelated models that happen to share both workspace and name (e.g. an ad-hoc TMDL-zip
    # upload with a reused folder label). Documents the precondition the fix guards against.
    _write_model(tmp_path / "one", "Finance", "Sales", [("RevenueA", "SUM(FactUsage[Va0])")], ["Va0"])
    _write_model(tmp_path / "two", "Finance", "Sales", [("RevenueB", "SUM(FactUsage[Vb0])")], ["Vb0"])
    cards = load_models(tmp_path / "one") + load_models(tmp_path / "two")
    assert len(cards) == 2
    assert model_id(cards[0]) == model_id(cards[1]) == "Finance/Sales"


def test_dedupe_model_ids_disambiguates_collisions(tmp_path):
    _write_model(tmp_path / "one", "Finance", "Sales", [("RevenueA", "SUM(FactUsage[Va0])")], ["Va0"])
    _write_model(tmp_path / "two", "Finance", "Sales", [("RevenueB", "SUM(FactUsage[Vb0])")], ["Vb0"])
    cards = dedupe_model_ids(load_models(tmp_path / "one") + load_models(tmp_path / "two"))

    ids = [model_id(c) for c in cards]
    assert len(set(ids)) == 2  # no more collision
    assert ids[0] == "Finance/Sales"  # first collider keeps its original id
    assert ids[1] == "Finance (2)/Sales"  # second collider's workspace is suffixed, still readable
    # Names are untouched -- only the workspace field carries the disambiguator.
    assert all(c.name == "Sales" for c in cards)


def test_dedupe_leaves_non_colliding_cards_untouched(tmp_path):
    _write_model(tmp_path / "one", "Finance", "Sales", [("RevenueA", "SUM(FactUsage[Va0])")], ["Va0"])
    _write_model(tmp_path / "two", "Ops", "Logistics", [("CostB", "SUM(FactUsage[Vb0])")], ["Vb0"])
    cards = load_models(tmp_path / "one") + load_models(tmp_path / "two")
    deduped = dedupe_model_ids(cards)

    assert deduped == cards  # same cards, same order, nothing rewritten
    assert deduped[0] is cards[0]  # identity preserved for the non-colliding path


def test_deduped_collision_scores_and_clusters_as_two_distinct_models(tmp_path):
    # Without the fix, both cards would report the same model_id() and any identity-keyed structure
    # downstream would only ever see one of them. With the fix, they are scored as an ordinary pair
    # and (being dissimilar: disjoint measures/columns) do NOT cluster as duplicates of each other.
    _write_model(tmp_path / "one", "Finance", "Sales", [("RevenueA", "SUM(FactUsage[Va0])")], ["Va0"])
    _write_model(tmp_path / "two", "Finance", "Sales", [("RevenueB", "SUM(FactUsage[Vb0])")], ["Vb0"])
    cards = dedupe_model_ids(load_models(tmp_path / "one") + load_models(tmp_path / "two"))

    pairs = score_all(cards)
    assert len(pairs) == 1
    assert not organic_clusters(cards, pairs)  # disjoint measures -> not flagged as duplicates
