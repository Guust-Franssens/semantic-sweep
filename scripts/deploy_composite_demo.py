"""
purpose: create a REAL composite semantic model in the demo tenant to exercise semantic-sweep's
         composite/derived-model detection. Deploys a base "golden" model (import) + a composite model
         that DirectQueries it (live connection to a Power BI dataset), in one SS_DEMO workspace.
usage:   python scripts/deploy_composite_demo.py            (requires `fab auth login`)
         python scripts/deploy_composite_demo.py --teardown (remove the workspace again)

Safety: only ever creates/deletes a workspace whose name starts with SEED_PREFIX.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

CAPACITY_NAME = "fabsweden1"  # must be an ACTIVE capacity in a supported region
WORKSPACE = "SS_DEMO Composite"
SEED_PREFIX = "SS_DEMO"
BASE_NAME = "Sales Core"
COMPOSITE_NAME = "Sales Executive Cockpit"
OUT = Path("composite_demo")
FAB = shutil.which("fab")
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

# Base star schema: (column, TMDL dataType, M type, sample value).
FACT = [
    ("OrderDate", "dateTime", "date", "#date(2024, 1, 1)"),
    ("BrandKey", "int64", "Int64.Type", "1"),
    ("VolumeHL", "double", "number", "1250.0"),
    ("NetRevenue", "double", "number", "84000.0"),
    ("Discount", "double", "number", "3200.0"),
]
DIM_BRAND = [
    ("BrandKey", "int64", "Int64.Type", "1"),
    ("Brand", "string", "text", '"Stella"'),
]
BASE_TABLES = {"FactSales": FACT, "DimBrand": DIM_BRAND}

# Measures reference FactSales only (no time-intel), so no relationships are needed on either model.
BASE_MEASURES = [
    ("Total Volume (HL)", "SUM(FactSales[VolumeHL])"),
    ("Net Revenue", "SUM(FactSales[NetRevenue])"),
    ("Total Discount", "SUM(FactSales[Discount])"),
    ("Gross Revenue", "SUM(FactSales[NetRevenue]) + SUM(FactSales[Discount])"),
    ("Avg Revenue per HL", "DIVIDE(SUM(FactSales[NetRevenue]), SUM(FactSales[VolumeHL]))"),
]
# The composite re-exposes the base measures (=> strong-duplicate) plus one executive extra, so the
# scan must classify the pair as composite lineage and keep it OUT of the organic-duplicate clusters.
COMPOSITE_MEASURES = [*BASE_MEASURES, ("Revenue vs Target %", "DIVIDE([Net Revenue], 1000000)")]


def _fab(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [FAB, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=CHILD_ENV,
        timeout=240,
        check=False,
    )


def _ok(proc: subprocess.CompletedProcess, *needles: str) -> bool:
    blob = ((proc.stdout or "") + (proc.stderr or "")).lower()
    return proc.returncode == 0 or any(n in blob for n in needles)


def _col_tmdl(col: str, dtype: str) -> list[str]:
    return [f"\tcolumn {col}", f"\t\tdataType: {dtype}", "\t\tsummarizeBy: none", f"\t\tsourceColumn: {col}", ""]


def _import_table(table: str, cols: list[tuple[str, str, str, str]]) -> str:
    mtypes = ", ".join(f"{c[0]} = {c[2]}" for c in cols)
    row = "{" + ", ".join(c[3] for c in cols) + "}"
    lines = [f"table {table}", ""]
    for col, dtype, _m, _v in cols:
        lines += _col_tmdl(col, dtype)
    lines += [
        f"\tpartition {table} = m",
        "\t\tmode: import",
        "\t\tsource =",
        "\t\t\tlet",
        f"\t\t\t\tSource = #table(type table [{mtypes}], {{{row}}})",
        "\t\t\tin",
        "\t\t\t\tSource",
        "",
    ]
    return "\n".join(lines)


def _dq_table(table: str, cols: list[tuple[str, str, str, str]], endpoint: str) -> str:
    """A DirectQuery-to-Power-BI-dataset partition (the composite link the scanner must detect)."""
    lines = [f"table {table}", ""]
    for col, dtype, _m, _v in cols:
        lines += _col_tmdl(col, dtype)
    lines += [
        f"\tpartition {table} = m",
        "\t\tmode: directQuery",
        "\t\tsource =",
        "\t\t\tlet",
        f'\t\t\t\tSource = AnalysisServices.Databases("{endpoint}"),',
        f'\t\t\t\tDb = Source{{[Name = "{BASE_NAME}"]}}[Data],',
        f'\t\t\t\tData = Db{{[Name = "{table}", Kind = "Table"]}}[Data]',
        "\t\t\tin",
        "\t\t\t\tData",
        "",
    ]
    return "\n".join(lines)


def _measures_tmdl(measures: list[tuple[str, str]]) -> str:
    lines = [
        "table _Measures",
        "",
        "\tcolumn _dummy",
        "\t\tdataType: int64",
        "\t\tisHidden",
        "\t\tsummarizeBy: none",
        "\t\tsourceColumn: [_dummy]",
        "",
    ]
    for name, dax in measures:
        lines += [f"\tmeasure '{name}' = {dax}", "\t\tformatString: #,0", ""]
    lines += ["\tpartition _Measures = calculated", "\t\tmode: import", '\t\tsource = Row("_dummy", BLANK())', ""]
    return "\n".join(lines)


def _model_tmdl(tables: list[str]) -> str:
    refs = "\n".join(f"ref table {t}" for t in [*tables, "_Measures"])
    return (
        "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n"
        "\tdiscourageImplicitMeasures\n\tsourceQueryCulture: en-US\n\n"
        "annotation PBI_ProcessedLanguage = en-US\n\n" + refs + "\n"
    )


def _platform(display_name: str) -> str:
    return (
        '{\n    "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/'
        'platformProperties/2.0.0/schema.json",\n    "metadata": {\n        "type": "SemanticModel",\n'
        f'        "displayName": "{display_name}"\n    }},\n    "config": {{\n        "version": "2.0",\n'
        f'        "logicalId": "{uuid.uuid4()}"\n    }}\n}}\n'
    )


_PBISM = (
    '{\n    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/'
    'definitionProperties/1.0.0/schema.json",\n    "version": "4.2",\n    "settings": {}\n}\n'
)


def _write_model(name: str, tables_tmdl: dict[str, str], measures: list[tuple[str, str]]) -> Path:
    root = OUT / f"{name}.SemanticModel"
    definition = root / "definition"
    (definition / "tables").mkdir(parents=True, exist_ok=True)
    root.joinpath(".platform").write_text(_platform(name), encoding="utf-8")
    root.joinpath("definition.pbism").write_text(_PBISM, encoding="utf-8")
    definition.joinpath("database.tmdl").write_text("database\n\tcompatibilityLevel: 1700\n", encoding="utf-8")
    definition.joinpath("model.tmdl").write_text(_model_tmdl(list(tables_tmdl)), encoding="utf-8")
    for table, text in tables_tmdl.items():
        (definition / "tables" / f"{table}.tmdl").write_text(text, encoding="utf-8")
    (definition / "tables" / "_Measures.tmdl").write_text(_measures_tmdl(measures), encoding="utf-8")
    return root


def _workspace_id() -> str:
    got = _fab("get", f"{WORKSPACE}.Workspace", "-q", "id")
    return (got.stdout or "").strip().strip('"')


def teardown() -> None:
    """Delete the SS_DEMO Composite workspace (guarded by the SS_DEMO prefix)."""
    if not WORKSPACE.startswith(SEED_PREFIX):
        raise SystemExit("refusing to delete a non-SS_DEMO workspace")
    print(_fab("rm", f"{WORKSPACE}.Workspace", "-f").stdout)
    if OUT.exists():
        shutil.rmtree(OUT)


def deploy() -> None:
    """Generate + deploy the base and composite models; print the workspace + endpoint used."""
    if not FAB:
        raise SystemExit("Fabric CLI ('fab') not found on PATH — run `fab auth login` first.")
    if OUT.exists():
        shutil.rmtree(OUT)

    create = _fab("create", f"{WORKSPACE}.Workspace", "-P", f"capacityName={CAPACITY_NAME}")
    if not _ok(create, "alreadyexists", "same name exists"):
        raise SystemExit("workspace create FAILED:\n" + (create.stdout or "") + (create.stderr or ""))
    ws_id = _workspace_id()
    print(f"[workspace] {WORKSPACE}: id={ws_id}")

    # 1) Base golden model (import) — deploy first so the composite's live connection can resolve it.
    base_dir = _write_model(BASE_NAME, {t: _import_table(t, c) for t, c in BASE_TABLES.items()}, BASE_MEASURES)
    imp = _fab("import", f"{WORKSPACE}.Workspace/{BASE_NAME}.SemanticModel", "-i", str(base_dir), "-f")
    print(f"[base] {BASE_NAME}: {'ok' if _ok(imp, 'imported', 'created') else 'FAILED'}")
    if not _ok(imp, "imported", "created"):
        print("  " + ((imp.stdout or "") + (imp.stderr or "")).strip()[-400:])

    # 2) Composite model — DirectQuery to the base dataset via the workspace's XMLA endpoint.
    endpoint = f"pbiazure://api.powerbi.com/v1.0/myorg/{ws_id}"
    comp_tables = {t: _dq_table(t, c, endpoint) for t, c in BASE_TABLES.items()}
    comp_dir = _write_model(COMPOSITE_NAME, comp_tables, COMPOSITE_MEASURES)
    imp2 = _fab("import", f"{WORKSPACE}.Workspace/{COMPOSITE_NAME}.SemanticModel", "-i", str(comp_dir), "-f")
    print(f"[composite] {COMPOSITE_NAME}: {'ok' if _ok(imp2, 'imported', 'created') else 'FAILED'}")
    if not _ok(imp2, "imported", "created"):
        print("  " + ((imp2.stdout or "") + (imp2.stderr or "")).strip()[-600:])

    print(f"\nendpoint used: {endpoint}")
    print("done — run an admin scan (or inspect the Scanner getInfo) to confirm the composite link.")


def main() -> None:
    """CLI entry point: deploy by default, or --teardown to remove the workspace."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--teardown", action="store_true", help="delete the SS_DEMO Composite workspace")
    args = ap.parse_args()
    if args.teardown:
        teardown()
    else:
        deploy()


if __name__ == "__main__":
    sys.exit(main())
