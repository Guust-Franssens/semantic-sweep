"""
purpose: export every inventoried semantic model to TMDL via `fab export`, in parallel -> models/
usage:   python scripts/export_models.py [--workers 6]
         (reads inventory.json from `scripts/enumerate_estate.py`; requires `fab auth login`)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

INVENTORY = Path("inventory.json")
EXPORT_ROOT = Path("models")
RESULTS = Path("export_results.json")
FAB = shutil.which("fab")
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _safe_dir(name: str) -> str:
    bad = '<>:"/\\|?*'
    return ("".join("_" if c in bad else c for c in name).rstrip(". ")) or "ws"


def _export_one(workspace: str, model: str) -> dict:
    out_dir = EXPORT_ROOT / _safe_dir(workspace)
    out_dir.mkdir(parents=True, exist_ok=True)
    source = f"{workspace}.Workspace/{model}.SemanticModel"
    try:
        proc = subprocess.run(
            [FAB, "export", source, "-o", str(out_dir), "-f"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=CHILD_ENV,
            timeout=180,
            check=False,
        )
        ok = proc.returncode == 0 and "exported" in (proc.stdout or "").lower()
        return {
            "workspace": workspace,
            "model": model,
            "ok": ok,
            "msg": ((proc.stdout or "") + (proc.stderr or "")).strip()[-200:],
        }
    except (subprocess.TimeoutExpired, OSError) as err:
        return {"workspace": workspace, "model": model, "ok": False, "msg": str(err)[:200]}


def main() -> None:
    """Export all inventoried semantic models to TMDL in parallel."""
    if not FAB:
        raise SystemExit("Fabric CLI ('fab') not found on PATH — run `fab auth login` first.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    jobs = [(w["workspace"], m["name"]) for w in inventory for m in w["models"]]
    print(f"exporting {len(jobs)} semantic models with {args.workers} workers ...")

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_export_one, ws, model): (ws, model) for ws, model in jobs}
        for future in as_completed(futures):
            results.append(future.result())

    RESULTS.write_text(json.dumps(results, indent=2), encoding="utf-8")
    ok = sum(1 for r in results if r["ok"])
    print(f"done: {ok}/{len(results)} exported -> {EXPORT_ROOT}/  (results -> {RESULTS})")


if __name__ == "__main__":
    main()
