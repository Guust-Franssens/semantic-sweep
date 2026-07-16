"""DAX sanity matrix: the measure-similarity properties the design must guarantee."""

# pylint: disable=missing-function-docstring

from semantic_sweep.measures import extract_features, measure_similarity, normalize_dax


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


def test_escaped_quote_inside_string_does_not_leak_a_bracketed_ref():
    # dax-tokenizer-hardening: DAX embeds a literal quote in a string by doubling it (`""`). The old
    # non-escape-aware `"[^"]*"` stopped at the FIRST embedded quote, leaving the remainder of the
    # string (including a bracketed token) unneutralized and leaking it as a bogus column ref.
    feats = extract_features('FORMAT(Sales[Amount], "Say ""[Bracket]"" here")')
    assert "amount" in feats.refs
    assert "bracket" not in feats.refs


def test_line_comment_marker_inside_string_literal_is_not_treated_as_a_comment():
    # normalize_dax used to strip comments before any string protection, so a "//" occurring INSIDE
    # a string literal (e.g. "100 // percent") was misread as a real comment start and truncated
    # everything after it, silently deleting real DAX code later in the expression.
    norm = normalize_dax('VAR _x = "100 // percent" RETURN SUM(Sales[Amount])')
    assert "return sum(sales[amount])" in norm


def test_block_comment_marker_inside_string_literal_is_preserved():
    norm = normalize_dax('VAR _x = "50% /* not a comment */ done" RETURN SUM(Sales[Amount])')
    assert "return sum(sales[amount])" in norm
    assert "not a comment" in norm  # string content preserved, not stripped as a block comment
