"""
purpose: enumerate every semantic model across all accessible Fabric workspaces -> inventory.json
usage:   python scripts/enumerate_estate.py   (requires `az login`)
"""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.fabric.microsoft.com/v1"
OUT = Path("inventory.json")


def _token() -> str:
    """Return a Fabric API bearer token from the Azure CLI."""
    az = shutil.which("az")
    if not az:
        raise SystemExit("Azure CLI ('az') not found on PATH — run `az login` first.")
    result = subprocess.run(
        [
            az,
            "account",
            "get-access-token",
            "--resource",
            BASE.rsplit("/v1", 1)[0],
            "--query",
            "accessToken",
            "-o",
            "tsv",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _get(url: str, token: str) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def _get_paged(url: str, token: str) -> list[dict]:
    items: list[dict] = []
    continuation: str | None = None
    while True:
        page_url = url
        if continuation:
            sep = "&" if "?" in page_url else "?"
            page_url = f"{page_url}{sep}continuationToken={urllib.parse.quote(continuation)}"
        data = _get(page_url, token)
        items.extend(data.get("value", []))
        continuation = data.get("continuationToken")
        if not continuation:
            return items


def main() -> None:
    """Enumerate workspaces and their semantic models; write inventory.json."""
    token = _token()
    workspaces = _get_paged(f"{BASE}/workspaces", token)
    inventory = []
    total = 0
    for workspace in sorted(workspaces, key=lambda w: w.get("displayName", "")):
        try:
            models = _get_paged(f"{BASE}/workspaces/{workspace['id']}/semanticModels", token)
        except urllib.error.HTTPError:
            continue
        total += len(models)
        inventory.append(
            {
                "workspace": workspace.get("displayName", "?"),
                "workspace_id": workspace["id"],
                "model_count": len(models),
                "models": [{"id": m["id"], "name": m.get("displayName", "?")} for m in models],
            }
        )
    OUT.write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    print(f"{len(workspaces)} workspaces, {total} semantic models -> {OUT}")


if __name__ == "__main__":
    main()
