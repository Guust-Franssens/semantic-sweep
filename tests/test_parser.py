"""Parser regression tests: the TMDL shapes the exporter actually emits.

The exporter writes a multi-line measure as ``measure X =`` followed by a whitespace-only line and
then the body indented two levels deeper. That leading blank line used to terminate the expression
block, silently emptying ~38% of measures on real estates (the measure facet is the strongest
similarity signal). These tests pin the shapes down so the regression cannot come back.
"""

# pylint: disable=missing-function-docstring,protected-access

from semantic_sweep.parser import _read_measure


def _dax(*lines: str) -> str:
    measure, nxt = _read_measure(list(lines), 0)
    assert nxt == len(lines)  # the whole block is consumed
    return measure.dax


def test_multiline_measure_with_leading_blank_line_is_captured():
    dax = _dax(
        "\tmeasure '# Capacities' =",
        "\t\t\t",
        "\t\t\tCALCULATE(",
        "\t\t\t    COUNT(capacities[CapacityId]),",
        "\t\t\t    capacities[fuam_deleted] = FALSE()",
        "\t\t\t    )",
        "\t\tformatString: #,0",
    )
    assert "CALCULATE(" in dax
    assert "capacities[CapacityId]" in dax
    assert "formatString" not in dax  # a child property must not leak into the expression


def test_multiline_var_return_measure_is_captured():
    dax = _dax(
        "\tmeasure 'Revenue YoY %' =",
        "\t\t\tVAR _cur = [Revenue]",
        "\t\t\tVAR _prior = CALCULATE([Revenue], DATEADD('Date'[Date], -1, YEAR))",
        "\t\t\tRETURN DIVIDE(_cur - _prior, _prior)",
        "\t\tformatString: 0.0%",
        "\t\tdisplayFolder: Time Intelligence",
    )
    assert dax.startswith("VAR _cur = [Revenue]")
    assert "RETURN DIVIDE(_cur - _prior, _prior)" in dax
    assert "displayFolder" not in dax


def test_single_line_measure_unchanged():
    assert _dax("\tmeasure 'Total Sales' = SUM(Sales[Amount])") == "SUM(Sales[Amount])"


def test_blank_measure_stays_empty():
    measure, _ = _read_measure(["\tmeasure Medida =", "\t\tlineageTag: abc-123"], 0)
    assert measure.dax == ""
