"""Measured precision/recall over sample_models/, not just per-pair smoke assertions.

test_calibration.py pins individual pairs to expected bands one at a time. This file instead
computes an explicit confusion matrix across ALL 15 pairs in the 6-model sample estate against a
hand-labeled ground truth, and asserts on precision/recall/F1 directly -- so a change that keeps
every individual calibration test green but quietly trades recall for precision (or vice versa)
across the whole estate is still caught.

Ground truth (mirrors the intent documented in scripts/make_sample_models.py and
test_calibration.py): the three "Commercial Sales" / "(rounded)" / "(truncated)" variants are
deliberate near-duplicates of each other (3 positive pairs); every other pair -- including the
partial-overlap "Sales Margin" and the fully-renamed "Revenue Report", both of which must still
surface for human review -- is a true negative for the DUPLICATE_BANDS label specifically.
"""

# pylint: disable=missing-function-docstring,redefined-outer-name

import subprocess
import sys
from itertools import combinations
from pathlib import Path

import pytest

from semantic_sweep.parser import load_models
from semantic_sweep.score import DUPLICATE_BANDS, score_pair

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "sample_models"

_DUPLICATE_FAMILY = {"Commercial Sales", "Commercial Sales (rounded)", "Commercial Sales (truncated)"}


@pytest.fixture(scope="module")
def by_name() -> dict:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_sample_models.py")], cwd=ROOT, check=True)
    return {c.name: c for c in load_models(SAMPLE)}


def test_precision_and_recall_are_perfect_on_the_sample_estate(by_name):
    names = sorted(by_name)
    assert len(names) == 6  # precondition: the fixture set hasn't silently grown/shrunk

    tp = fp = fn = tn = 0
    for a, b in combinations(names, 2):
        is_duplicate_pair = {a, b} <= _DUPLICATE_FAMILY
        flagged = score_pair(by_name[a], by_name[b]).band in DUPLICATE_BANDS
        if is_duplicate_pair and flagged:
            tp += 1
        elif is_duplicate_pair and not flagged:
            fn += 1
        elif not is_duplicate_pair and flagged:
            fp += 1
        else:
            tn += 1

    assert tp + fp + fn + tn == 15  # 6 choose 2
    assert (tp, fp, fn, tn) == (3, 0, 0, 12)

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    assert precision == 1.0
    assert recall == 1.0
    assert f1 == 1.0
