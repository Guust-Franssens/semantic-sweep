"""DAX sanity matrix: the measure-similarity properties the design must guarantee."""

# pylint: disable=missing-function-docstring

from semantic_sweep.measures import extract_features, measure_similarity


def _sim(a: str, b: str) -> float:
    return measure_similarity(extract_features(a), extract_features(b))


def test_identical_is_one():
    assert _sim("SUM(Sales[Amount])", "SUM(Sales[Amount])") == 1.0


def test_sum_vs_average_are_distinct():
    # Same column, incompatible aggregator -> must not look near-identical.
    assert _sim("SUM(Sales[Amount])", "AVERAGE(Sales[Amount])") < 0.8


def test_round_vs_trunc_similar_not_identical():
    score = _sim("ROUND(Sales[Amount], 2)", "TRUNC(Sales[Amount])")
    assert 0.5 <= score < 1.0


def test_renamed_refs_stay_high():
    # Same calculation structure, renamed table -> still a strong match.
    assert _sim("SUM(Sales[Amount])", "SUM(Revenue[Amount])") >= 0.85


def test_unrelated_measures_are_low():
    assert _sim("SUM(Sales[Amount])", "CALCULATE([Foo], ALL(Bar[Region]))") < 0.3
