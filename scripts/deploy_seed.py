"""
purpose: deploy the local seed_models/ near-duplicate control set into the demo tenant, and record
         a teardown manifest. Creates one SS_DEMO sandbox workspace per seed_models/<workspace> dir.
usage:   python scripts/deploy_seed.py            (requires `fab auth login`)
         python scripts/teardown_seed.py          (to remove everything afterwards)

Hardcoded for this PoC (edit the constants below; git history + the manifest cover rollback).
Safety: only ever creates/writes workspaces whose name starts with SEED_PREFIX.
"""

from __future__ import annotations

# pylint: disable=duplicate-code  # deploy/teardown intentionally share the small _fab subprocess helper

import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

CAPACITY_NAME = "fabeluxcap"  # Fabric BeLux capacity (same region as the existing demo estate)
SEED_ROOT = Path("seed_models")
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


def _ok(proc: subprocess.CompletedProcess, *needles: str) -> bool:
    blob = ((proc.stdout or "") + (proc.stderr or "")).lower()
    return proc.returncode == 0 or any(n in blob for n in needles)


def main() -> None:
    """Create the SS_DEMO sandbox workspaces and import each seed semantic model."""
    if not FAB:
        raise SystemExit("Fabric CLI ('fab') not found on PATH — run `fab auth login` first.")
    if not SEED_ROOT.exists():
        raise SystemExit("seed_models/ not found — run scripts/make_seed_models.py first.")

    workspaces = sorted(p.name for p in SEED_ROOT.iterdir() if p.is_dir())
    manifest = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "capacity": CAPACITY_NAME,
        "workspaces": [],
        "models": [],
    }

    for workspace in workspaces:
        if not workspace.startswith(SEED_PREFIX):
            print(f"SKIP (not a {SEED_PREFIX} workspace): {workspace}")
            continue
        create = _fab("create", f"{workspace}.Workspace", "-P", f"capacityName={CAPACITY_NAME}")
        status = "created" if _ok(create, "already exists") else "FAILED"
        print(f"[workspace] {workspace}: {status}")
        if status == "FAILED":
            print("  " + ((create.stdout or "") + (create.stderr or "")).strip()[-200:])
            continue
        manifest["workspaces"].append(workspace)
        for model_dir in sorted((SEED_ROOT / workspace).glob("*.SemanticModel")):
            name = model_dir.name.removesuffix(".SemanticModel")
            target = f"{workspace}.Workspace/{model_dir.name}"
            imported = _fab("import", target, "-i", str(model_dir), "-f")
            good = _ok(imported, "imported", "created")
            print(f"  [model] {name}: {'ok' if good else 'FAILED'}")
            if not good:
                print("    " + ((imported.stdout or "") + (imported.stderr or "")).strip()[-200:])
            manifest["models"].append({"workspace": workspace, "name": name, "ok": good})

    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    ok = sum(1 for m in manifest["models"] if m["ok"])
    print(
        f"\ndeployed {ok}/{len(manifest['models'])} models across {len(manifest['workspaces'])} "
        f"workspaces -> manifest {MANIFEST}"
    )


if __name__ == "__main__":
    main()
