"""CLI entry point: scan a ``models/`` folder and emit ``report.md`` + ``similarity_matrix.csv``.

usage: python -m semantic_sweep.cli --models models --out out
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from semantic_sweep.lifecycle import find_promotion_chains
from semantic_sweep.parser import load_models
from semantic_sweep.report import write_outputs
from semantic_sweep.score import dedupe_model_ids, organic_clusters, score_all


def _clean_reason(raw: str) -> str:
    """Map a raw fab-export error message to a short, human-readable reason."""
    low = raw.lower()
    if "direct lake" in low:
        return "Direct Lake model — export blocked by capacity"
    if "forbidden" in low:
        return "forbidden — no access"
    if "service app" in low:
        return "system app model — not exportable"
    if "invalid path" in low:
        return "workspace name contains '/' (system metrics model)"
    if "dataset workload failed" in low:
        return "default/system model — not exportable"
    return (raw.strip().splitlines()[-1] if raw.strip() else "export failed")[:80]


def _unscored(models_root: Path, export_results: Path) -> list[tuple[str, str, str]]:
    """Collect models inventoried but not scored: empty/default models + export failures."""
    rows: list[tuple[str, str, str]] = []
    for card in load_models(models_root, keep_empty=True):
        if not card.tables:
            rows.append((card.workspace, card.name, "default/empty model (0 tables)"))
    if export_results.exists():
        for entry in json.loads(export_results.read_text(encoding="utf-8")):
            if not entry.get("ok"):
                rows.append(
                    (entry.get("workspace", "?"), entry.get("model", "?"), _clean_reason(entry.get("msg") or ""))
                )
    return rows


def main(argv: list[str] | None = None) -> int:
    """Run the scan pipeline and write outputs; return a process exit code."""
    parser = argparse.ArgumentParser(description="Scan a Power BI semantic-model estate for duplicates.")
    parser.add_argument("--models", type=Path, default=Path("models"), help="root folder of exported TMDL models")
    parser.add_argument("--out", type=Path, default=Path("out"), help="output folder for report + matrix")
    parser.add_argument(
        "--export-results", type=Path, default=Path("export_results.json"), help="bulk-export result log"
    )
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards = load_models(args.models)
    if not cards:
        print(f"No semantic models found under {args.models}")
        return 1
    cards = dedupe_model_ids(cards)

    pairs = score_all(cards)
    unscored = _unscored(args.models, args.export_results)
    write_outputs(cards, pairs, args.out, unscored)

    clusters = len(organic_clusters(cards, pairs))
    chains = len(find_promotion_chains(cards))
    system = sum(1 for c in cards if c.system_generated)
    print(f"Scanned {len(cards)} models, {len(pairs)} pairs.")
    print(f"  organic duplicate clusters : {clusters}")
    print(f"  promotion chains           : {chains}")
    print(f"  system-generated (excluded): {system}")
    print(f"  inventoried, not scored    : {len(unscored)}")
    print(f"Report written to {args.out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
