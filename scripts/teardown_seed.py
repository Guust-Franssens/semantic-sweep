"""
purpose: tear down the seeded demo workspaces/models recorded in seed_manifest.json
usage:   python scripts/teardown_seed.py           (requires `fab auth login`)

Safety: only removes workspaces listed in the manifest whose name starts with SEED_PREFIX.
"""

from __future__ import annotations

# pylint: disable=duplicate-code  # deploy/teardown intentionally share the small _fab subprocess helper

import json
import os
import shutil
import subprocess
from pathlib import Path

SEED_PREFIX = "SS_DEMO"
MANIFEST = Path("seed_manifest.json")
FAB = shutil.which("fab")
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _fab(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [FAB, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=CHILD_ENV,
        timeout=180,
        check=False,
    )


def main() -> None:
    """Remove every SS_DEMO workspace recorded in the manifest and verify it is gone."""
    if not FAB:
        raise SystemExit("Fabric CLI ('fab') not found on PATH — run `fab auth login` first.")
    if not MANIFEST.exists():
        raise SystemExit(f"{MANIFEST} not found — nothing to tear down.")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    removed = 0
    for workspace in manifest.get("workspaces", []):
        if not workspace.startswith(SEED_PREFIX):
            print(f"SKIP (safety — not a {SEED_PREFIX} workspace): {workspace}")
            continue
        proc = _fab("rm", f"{workspace}.Workspace", "-f")
        exists = _fab("exists", f"{workspace}.Workspace")
        gone = "false" in ((exists.stdout or "") + (exists.stderr or "")).lower()
        print(f"[remove] {workspace}: {'gone' if gone else 'CHECK MANUALLY'}")
        if gone:
            removed += 1
        elif proc.returncode != 0:
            print("  " + ((proc.stdout or "") + (proc.stderr or "")).strip()[-200:])

    print(f"\nremoved {removed}/{len(manifest.get('workspaces', []))} seeded workspaces")


if __name__ == "__main__":
    main()
