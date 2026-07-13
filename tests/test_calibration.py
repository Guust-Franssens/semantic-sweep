"""Calibration: graded synthetic models must land in the expected similarity bands.

The real tenant only exercises exact-or-unrelated; these fixtures stress the mid-range
(strong near-dup, partial overlap, renamed clone) so the scorer's discrimination is pinned down.
"""

# pylint: disable=missing-function-docstring,redefined-outer-name

import subprocess
import sys
from pathlib import Path

import pytest

from semantic_sweep.parser import load_models
from semantic_sweep.score import BAND_REVIEW, BAND_UNRELATED, DUPLICATE_BANDS, PairResult, score_pair

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "sample_models"


@pytest.fixture(scope="module")
def by_name() -> dict:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_sample_models.py")], cwd=ROOT, check=True)
    return {c.name: c for c in load_models(SAMPLE)}


def _pair(models: dict, a: str, b: str) -> PairResult:
    return score_pair(models[a], models[b])


def test_six_models(by_name):
    assert len(by_name) == 6


def test_round_variant_is_duplicate(by_name):
    result = _pair(by_name, "Commercial Sales", "Commercial Sales (rounded)")
    assert result.band in DUPLICATE_BANDS
    assert result.facets["measure"] >= 0.8


def test_trunc_variant_is_duplicate(by_name):
    assert _pair(by_name, "Commercial Sales", "Commercial Sales (truncated)").band in DUPLICATE_BANDS


def test_partial_overlap_is_review(by_name):
    result = _pair(by_name, "Commercial Sales", "Sales Margin")
    assert result.band == BAND_REVIEW
    assert 0.3 < result.headline < 0.8


def test_renamed_clone_surfaces(by_name):
    result = _pair(by_name, "Commercial Sales", "Revenue Report")
    assert result.facets["measure"] >= 0.85  # structural match detected despite full rename
    assert result.band != BAND_UNRELATED  # surfaced for a human to review


def test_unrelated_domain_is_low(by_name):
    result = _pair(by_name, "Commercial Sales", "Logistics KPIs")
    assert result.band == BAND_UNRELATED
    assert result.headline < 0.1


def test_band_ordering(by_name):
    strong = _pair(by_name, "Commercial Sales", "Commercial Sales (rounded)").headline
    partial = _pair(by_name, "Commercial Sales", "Sales Margin").headline
    unrelated = _pair(by_name, "Commercial Sales", "Logistics KPIs").headline
    assert strong > partial > unrelated
