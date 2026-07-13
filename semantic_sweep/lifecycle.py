"""Dev/test/prod promotion (lifecycle) handling.

Promotion pipelines put the *same* model in dev -> test -> prod, which would otherwise look like a
"duplicate". We classify each workspace into a ``(family, environment)`` **conservatively** — only
stripping an environment token when it is terminal and delimiter-bounded (so ``...-sweden-prod``
keeps ``sweden`` as a domain token) — and group same-family / same-item models into promotion
chains. Whether a chain is a real lifecycle set (vs. drifted) is confirmed by content similarity in
the scorer; this module is metadata-only.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from semantic_sweep.parser import ModelCard

# Canonical environment -> rank (higher wins when picking a chain's representative).
ENV_RANK = {
    "prod": 5,
    "ppe": 4,
    "preprod": 4,
    "staging": 3,
    "test": 3,
    "qa": 3,
    "uat": 3,
    "sit": 3,
    "acc": 3,
    "base": 3,
    "dev": 2,
    "feat": 1,
}
# Recognised trailing tokens -> canonical environment (strict allowlist).
_ENV_ALIASES = {
    "prod": "prod",
    "prd": "prod",
    "production": "prod",
    "ppe": "ppe",
    "preprod": "preprod",
    "pre-prod": "preprod",
    "staging": "staging",
    "stg": "staging",
    "test": "test",
    "tst": "test",
    "qa": "qa",
    "uat": "uat",
    "sit": "sit",
    "acc": "acc",
    "dev": "dev",
    "develop": "dev",
    "development": "dev",
}
_DELIM = r"[ _.\-]"
_FEAT_RE = re.compile(rf"(?:^|{_DELIM})(?:feat|feature)(?:{_DELIM}|$)")
_TRAILING_ENV_RE = re.compile(
    rf"{_DELIM}(" + "|".join(re.escape(t) for t in sorted(_ENV_ALIASES, key=len, reverse=True)) + r")$"
)


@dataclass(frozen=True)
class EnvInfo:
    """A workspace's inferred promotion family and environment."""

    family: str
    env: str

    @property
    def rank(self) -> int:
        """Representative-selection rank for this environment."""
        return ENV_RANK.get(self.env, 3)


def _norm_family(text: str) -> str:
    return re.sub(rf"{_DELIM}+", " ", text.lower()).strip()


def normalized_item_name(name: str) -> str:
    """Normalize a semantic-model item name for same-item comparison."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def classify_workspace(workspace: str) -> EnvInfo:
    """Classify a workspace name into a ``(family, environment)`` conservatively."""
    low = workspace.lower().strip()
    feat = _FEAT_RE.search(low)
    if feat:
        family = low[: feat.start()].strip(" _.-") or low
        return EnvInfo(_norm_family(family), "feat")
    trailing = _TRAILING_ENV_RE.search(low)
    if trailing:
        family = low[: trailing.start()].strip(" _.-") or low
        return EnvInfo(_norm_family(family), _ENV_ALIASES[trailing.group(1)])
    return EnvInfo(_norm_family(low), "base")


def is_lifecycle_candidate(a: ModelCard, b: ModelCard) -> bool:
    """True if two models look like the same item promoted across environments (metadata only)."""
    ea, eb = classify_workspace(a.workspace), classify_workspace(b.workspace)
    return ea.family == eb.family and ea.env != eb.env and normalized_item_name(a.name) == normalized_item_name(b.name)


@dataclass
class PromotionChain:
    """A set of same-item models spanning multiple environments of one family."""

    family: str
    item: str
    members: list[ModelCard]

    @property
    def representative(self) -> ModelCard:
        """The highest-environment (then most-complete) member — the presentation canonical."""
        return max(
            self.members,
            key=lambda c: (classify_workspace(c.workspace).rank, c.measure_count, c.table_count),
        )

    @property
    def environments(self) -> list[str]:
        """Sorted distinct environments present in the chain."""
        return sorted({classify_workspace(c.workspace).env for c in self.members})


def find_promotion_chains(cards: list[ModelCard]) -> list[PromotionChain]:
    """Group models into promotion chains (same family + same item across >= 2 environments)."""
    groups: dict[tuple[str, str], list[ModelCard]] = defaultdict(list)
    for card in cards:
        info = classify_workspace(card.workspace)
        groups[(info.family, normalized_item_name(card.name))].append(card)

    chains: list[PromotionChain] = []
    for (family, item), members in groups.items():
        envs = {classify_workspace(c.workspace).env for c in members}
        if len(members) >= 2 and len(envs) >= 2:
            chains.append(PromotionChain(family=family, item=item, members=members))
    return chains
