"""
purpose: (re)generate sample_models/ and write the committed Python-reference results.json
         used by app/scripts/validate.ts to check TS/Python engine parity from a fresh clone,
         with zero external setup (no exported ../models estate required).
usage:   python scripts/make_parity_fixture.py    (writes -> sample_models/, tests/fixtures/sample_models.results.json)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from semantic_sweep.parser import load_models
from semantic_sweep.report import build_results
from semantic_sweep.score import dedupe_model_ids, score_all

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "sample_models"
FIXTURE = ROOT / "tests" / "fixtures" / "sample_models.results.json"


def main() -> None:
    """Regenerate sample_models/, score it, and write the committed parity fixture."""
    # Regenerated via subprocess (not a direct import) to match the established tests/test_calibration.py
    # convention -- scripts/ has no __init__.py, so it is not meant to be imported as a package.
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_sample_models.py")], cwd=ROOT, check=True)
    cards = dedupe_model_ids(load_models(SAMPLE))
    pairs = score_all(cards)
    results = build_results(cards, pairs, unscored=[])
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cards)} models, {len(pairs)} pairs -> {FIXTURE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
