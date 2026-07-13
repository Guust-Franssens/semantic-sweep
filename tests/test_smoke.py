"""Smoke tests against the real exported estate (models/ must be present)."""

# pylint: disable=missing-function-docstring,redefined-outer-name

from pathlib import Path

import pytest

from semantic_sweep.lifecycle import classify_workspace, find_promotion_chains
from semantic_sweep.parser import load_models
from semantic_sweep.score import BAND_UNRELATED, organic_clusters, score_all

MODELS = Path(__file__).resolve().parent.parent / "models"
pytestmark = pytest.mark.skipif(not MODELS.exists(), reason="models/ export not present")


@pytest.fixture(scope="module")
def cards():
    return load_models(MODELS)


@pytest.fixture(scope="module")
def pairs(cards):
    return score_all(cards)


def test_models_loaded(cards):
    assert len(cards) >= 25


def test_salessense_is_lifecycle_not_organic(cards, pairs):
    ss_pairs = [p for p in pairs if p.a.name == "SM_SalesSense" and p.b.name == "SM_SalesSense"]
    assert ss_pairs, "expected SalesSense copies"
    assert all(p.lifecycle for p in ss_pairs)
    organic_members = {m.name for cl in organic_clusters(cards, pairs) for m in cl.members}
    assert "SM_SalesSense" not in organic_members


def test_promotion_chain_detected(cards):
    assert any(ch.item == "smsalessense" for ch in find_promotion_chains(cards))


def test_usage_metrics_tagged_system_generated(cards):
    usage = [c for c in cards if "usage metrics" in c.name.lower()]
    assert usage and all(c.system_generated for c in usage)


def test_domains_stay_apart(pairs):
    domains = {"sm_commercial", "sm_logistics", "sm_hr"}
    cross = [p for p in pairs if {p.a.name, p.b.name} <= domains and p.a.name != p.b.name]
    assert cross and all(p.band == BAND_UNRELATED for p in cross)


def test_sweden_is_domain_not_environment():
    assert classify_workspace("sales-journal-sweden-prod").family != classify_workspace("sales-journal-prod").family


def test_organic_duplicate_found(cards, pairs):
    member_sets = [{m.name for m in cl.members} for cl in organic_clusters(cards, pairs)]
    assert any("test" in names and "traffic-accidents-semantic-model-translations" in names for names in member_sets)
