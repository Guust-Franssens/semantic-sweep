"""Render scan results into ``report.md`` (three views + buckets) and ``similarity_matrix.csv``."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from semantic_sweep.lifecycle import PromotionChain, classify_workspace, find_promotion_chains
from semantic_sweep.parser import ModelCard
from semantic_sweep.score import (
    BAND_RELATED,
    BAND_REVIEW,
    CLUSTER_BANDS,
    Cluster,
    PairResult,
    organic_clusters,
)

# Subset/trimmed-copy pairs now cluster as consolidation candidates (section 1), so they are no
# longer listed here as "needs review" — that would double-list them. Only genuinely ambiguous
# related/review pairs remain in this bucket.
_REVIEW_BANDS = {BAND_RELATED, BAND_REVIEW}


def _label(card: ModelCard) -> str:
    return f"`{card.name}` ({card.workspace})"


def _pair_lookup(pairs: list[PairResult]) -> dict[frozenset[int], PairResult]:
    return {frozenset((id(p.a), id(p.b))): p for p in pairs}


def _chain_drift(chain: PromotionChain, lookup: dict[frozenset[int], PairResult]) -> tuple[bool, float]:
    sims = []
    members = chain.members
    for i, member in enumerate(members):
        for other in members[i + 1 :]:
            pair = lookup.get(frozenset((id(member), id(other))))
            if pair is not None:
                sims.append(pair.facets["measure"])
    low = min(sims) if sims else 1.0
    return (low < 0.999, low)


def _organic_lines(clusters: list[Cluster]) -> list[str]:
    out = ["## 1. Organic duplicate candidates (consolidation opportunities)", ""]
    if not clusters:
        out.append("_No cross-team organic duplicates found._")
        out.append("")
        return out
    for cluster in clusters:
        out.append(f"### Keep {_label(cluster.keep)}")
        for member in cluster.members:
            if member is cluster.keep:
                continue
            pair = next((p for p in cluster.pairs if member in (p.a, p.b)), None)
            band = pair.band if pair else "?"
            sim = pair.facets["measure"] if pair else 0.0
            out.append(f"- Retire / redirect {_label(member)} — **{band}**, measure similarity {sim:.2f}")
            if pair and pair.measure.matched:
                shared = ", ".join(f"`{m[0]}`" for m in pair.measure.matched[:6])
                out.append(f"  - shared measures ({len(pair.measure.matched)}): {shared}…")
            for note in pair.warnings if pair else []:
                out.append(f"  - ⚠ {note}")
        out.append("")
    return out


def _chains_lines(cards: list[ModelCard], lookup: dict[frozenset[int], PairResult]) -> list[str]:
    out = ["## 2. Promotion chains — dev/test/prod (expected, no action)", ""]
    chains = find_promotion_chains(cards)
    if not chains:
        out.append("_No promotion chains detected._")
        out.append("")
        return out
    for chain in chains:
        drifted, low = _chain_drift(chain, lookup)
        status = f"⚠ **DRIFT** (lowest pairwise measure similarity {low:.2f})" if drifted else "in sync"
        out.append(f"### `{chain.item}` — family `{chain.family}` — {status}")
        out.append(f"- representative (keep in sync from): {_label(chain.representative)}")
        for member in sorted(chain.members, key=lambda c: classify_workspace(c.workspace).env):
            env = classify_workspace(member.workspace).env
            out.append(f"- `{env}` — {member.workspace} ({member.measure_count} measures, {member.table_count} tables)")
        out.append("")
    return out


def _related_lines(pairs: list[PairResult]) -> list[str]:
    out = ["## 3. Related / needs review", ""]
    rows = [p for p in pairs if p.band in _REVIEW_BANDS and not p.lifecycle]
    if not rows:
        out.append("_No related/needs-review pairs above the noise floor._")
        out.append("")
        return out
    out.append("| headline | band | measure | schema | pair |")
    out.append("|---|---|---|---|---|")
    for pair in rows[:25]:
        out.append(
            f"| {pair.headline:.2f} | {pair.band} | {pair.facets['measure']:.2f} | "
            f"{pair.facets['schema']:.2f} | {_label(pair.a)} ~ {_label(pair.b)} |"
        )
    out.append("")
    return out


def _bucket_lines(cards: list[ModelCard], pairs: list[PairResult], unscored: list[tuple[str, str, str]]) -> list[str]:
    out = ["## 4. System-generated models (excluded from consolidation)", ""]
    system = [c for c in cards if c.system_generated]
    if system:
        out.extend(f"- {_label(c)}" for c in system)
    else:
        out.append("_None._")
    # Duplicate-band pairs held back solely because a member is system-generated. Listed for
    # transparency (so the scan never looks like it missed obvious clones such as Usage Metrics
    # copies) but explicitly not consolidation targets. Lifecycle dupes appear as chains instead.
    held = [
        p
        for p in pairs
        if p.band in CLUSTER_BANDS and not p.lifecycle and (p.a.system_generated or p.b.system_generated)
    ]
    if held:
        out.extend(["", "_Detected duplicates held back (system-generated — not consolidation targets):_"])
        out.extend(f"- {_label(p.a)} ≈ {_label(p.b)} — {p.band} ({p.headline:.2f})" for p in held)
    out.extend(["", "## 5. Inventoried but not scored", ""])
    if unscored:
        out.extend(f"- `{name}` ({ws}) — {reason}" for ws, name, reason in unscored)
    else:
        out.append("_None._")
    out.append("")
    return out


def build_report(cards: list[ModelCard], pairs: list[PairResult], unscored: list[tuple[str, str, str]]) -> str:
    """Build the full ``report.md`` markdown string."""
    lookup = _pair_lookup(pairs)
    clusters = organic_clusters(cards, pairs)
    chains = find_promotion_chains(cards)
    system = [c for c in cards if c.system_generated]
    workspaces = {c.workspace for c in cards}

    header = [
        "# semantic-sweep — duplicate scan report",
        "",
        f"Scanned **{len(cards)}** semantic models across **{len(workspaces)}** workspaces "
        f"({len(pairs)} pairs scored). Decision support — a human confirms each consolidation.",
        "",
        "## Summary",
        f"- **Organic duplicate candidates:** {len(clusters)} cluster(s)",
        f"- **Promotion chains (dev/test/prod):** {len(chains)}",
        f"- **System-generated models (excluded):** {len(system)}",
        f"- **Inventoried but not scored:** {len(unscored)}",
        "",
    ]
    lines = (
        header
        + _organic_lines(clusters)
        + _chains_lines(cards, lookup)
        + _related_lines(pairs)
        + _bucket_lines(cards, pairs, unscored)
    )
    return "\n".join(lines)


def _mid(card: ModelCard) -> str:
    return f"{card.workspace}/{card.name}"


def build_results(cards: list[ModelCard], pairs: list[PairResult], unscored: list[tuple[str, str, str]]) -> dict:
    """Build a machine-readable results dict (consumable by any HTML / Power BI / Rayfin layer)."""
    lookup = _pair_lookup(pairs)
    clusters = organic_clusters(cards, pairs)
    chains = find_promotion_chains(cards)
    return {
        "summary": {
            "models": len(cards),
            "pairs": len(pairs),
            "organic_clusters": len(clusters),
            "promotion_chains": len(chains),
            "system_generated": sum(1 for c in cards if c.system_generated),
            "unscored": len(unscored),
        },
        "models": [
            {
                "id": _mid(c),
                "name": c.name,
                "workspace": c.workspace,
                "tables": c.table_count,
                "measures": c.measure_count,
                "system_generated": c.system_generated,
                "has_rls": c.has_rls,
            }
            for c in cards
        ],
        "pairs": [
            {
                "a": _mid(p.a),
                "b": _mid(p.b),
                "headline": p.headline,
                "band": p.band,
                "lifecycle": p.lifecycle,
                "measure": p.facets["measure"],
                "containment": p.measure.containment,
                "schema": p.facets["schema"],
                "source_logical": p.facets["source_logical"],
                "matched_measures": len(p.measure.matched),
            }
            for p in pairs
            if p.headline >= 0.1
        ],
        "organic_clusters": [{"keep": _mid(cl.keep), "members": [_mid(m) for m in cl.members]} for cl in clusters],
        "promotion_chains": [
            {
                "family": ch.family,
                "item": ch.item,
                "environments": ch.environments,
                "representative": _mid(ch.representative),
                "drift": _chain_drift(ch, lookup)[0],
            }
            for ch in chains
        ],
        "system_generated": [_mid(c) for c in cards if c.system_generated],
        "unscored": [{"workspace": ws, "model": name, "reason": reason} for ws, name, reason in unscored],
    }


def write_matrix(cards: list[ModelCard], pairs: list[PairResult], path: Path) -> None:
    """Write the full pairwise headline-similarity matrix to ``path`` as CSV."""
    lookup = _pair_lookup(pairs)
    labels = [f"{c.workspace}/{c.name}" for c in cards]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([""] + labels)
        for row_card in cards:
            row = [f"{row_card.workspace}/{row_card.name}"]
            for col_card in cards:
                if row_card is col_card:
                    row.append("1.000")
                else:
                    pair = lookup.get(frozenset((id(row_card), id(col_card))))
                    row.append(f"{pair.headline:.3f}" if pair else "0.000")
            writer.writerow(row)


def write_outputs(
    cards: list[ModelCard], pairs: list[PairResult], out_dir: Path, unscored: list[tuple[str, str, str]]
) -> None:
    """Write ``report.md`` and ``similarity_matrix.csv`` into ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.md").write_text(build_report(cards, pairs, unscored), encoding="utf-8")
    (out_dir / "results.json").write_text(json.dumps(build_results(cards, pairs, unscored), indent=2), encoding="utf-8")
    write_matrix(cards, pairs, out_dir / "similarity_matrix.csv")
