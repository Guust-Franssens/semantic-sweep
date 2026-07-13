"""
purpose: generate DEPLOYABLE, brewery-themed, import-mode near-duplicate semantic models (TMDL)
         as a labeled control set to seed the demo tenant, so the scan finds a real graded cluster.
usage:   python scripts/make_seed_models.py           (writes -> seed_models/<workspace>/<name>.SemanticModel)

Design (from rubber-duck review):
  * IMPORT mode with tiny inline #table data — self-contained, exportable, no Direct Lake / no lakehouse
    dependency (Direct Lake export is flaky on this capacity, and the scanner re-exports each model).
  * Authored fresh with a UNIQUE .platform logicalId per model (not cloned) — no lineage collisions,
    and not mistaken for a dev/test/prod promotion chain.
  * Deployed to clearly-prefixed SS_DEMO sandbox workspaces — cross-team realism, no pollution of
    existing workspaces, manifest-based teardown.
The brewery/commercial theme (Volume in HL, Net Revenue, Share) is generic synthetic sample content.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

ROOT = Path("seed_models")
SEED_PREFIX = "SS_DEMO"

# Shared brewery star schema (column name, TMDL dataType, M type, sample value).
FACT_SALES = [
    ("OrderDate", "dateTime", "date", "#date(2024,1,1)"),
    ("BrandKey", "int64", "Int64.Type", "1"),
    ("MarketKey", "int64", "Int64.Type", "10"),
    ("VolumeHL", "double", "number", "1250.0"),
    ("NetRevenue", "double", "number", "84000.0"),
    ("Discount", "double", "number", "3200.0"),
]
DIM_BRAND = [
    ("BrandKey", "int64", "Int64.Type", "1"),
    ("Brand", "string", "text", '"Stella"'),
    ("Category", "string", "text", '"Lager"'),
]
DIM_DATE = [
    ("Date", "dateTime", "date", "#date(2024,1,1)"),
    ("Month", "string", "text", '"Jan"'),
    ("Year", "int64", "Int64.Type", "2024"),
]
DIM_MARKET = [
    ("MarketKey", "int64", "Int64.Type", "10"),
    ("Market", "string", "text", '"Belgium"'),
    ("Region", "string", "text", '"EMEA"'),
]
BREWERY_TABLES = {"FactSales": FACT_SALES, "DimBrand": DIM_BRAND, "DimDate": DIM_DATE, "DimMarket": DIM_MARKET}
BREWERY_RELS = [
    ("FactSales.BrandKey", "DimBrand.BrandKey"),
    ("FactSales.OrderDate", "DimDate.Date"),
    ("FactSales.MarketKey", "DimMarket.MarketKey"),
]

BASE_MEASURES = [
    ("Total Volume (HL)", "SUM(FactSales[VolumeHL])"),
    ("Net Revenue", "SUM(FactSales[NetRevenue])"),
    ("Volume LY", "CALCULATE([Total Volume (HL)], SAMEPERIODLASTYEAR(DimDate[Date]))"),
    ("Net Revenue LY", "CALCULATE([Net Revenue], SAMEPERIODLASTYEAR(DimDate[Date]))"),
    ("Volume YoY %", "DIVIDE([Total Volume (HL)] - [Volume LY], [Volume LY])"),
    ("Avg Revenue per HL", "DIVIDE([Net Revenue], [Total Volume (HL)])"),
    ("Discount %", "DIVIDE(SUM(FactSales[Discount]), [Net Revenue])"),
]


def _col_tmdl(col: str, dtype: str) -> list[str]:
    return [f"\tcolumn {col}", f"\t\tdataType: {dtype}", "\t\tsummarizeBy: none", f"\t\tsourceColumn: {col}", ""]


def _inline_partition(table: str, cols: list[tuple[str, str, str, str]]) -> list[str]:
    mtypes = ", ".join(f"{c[0]} = {c[2]}" for c in cols)
    row = "{" + ", ".join(c[3] for c in cols) + "}"
    return [
        f"\tpartition {table} = m",
        "\t\tmode: import",
        "\t\tsource =",
        "\t\t\tlet",
        f"\t\t\t\tSource = #table(type table [{mtypes}], {{{row}}})",
        "\t\t\tin",
        "\t\t\t\tSource",
        "",
    ]


def _table_tmdl(table: str, cols: list[tuple[str, str, str, str]]) -> str:
    lines = [f"table {table}", ""]
    for col, dtype, _mtype, _val in cols:
        lines += _col_tmdl(col, dtype)
    lines += _inline_partition(table, cols)
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


def _rels_tmdl(rels: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for i, (frm, to) in enumerate(rels):
        lines += [f"relationship rel_{i}", f"\tfromColumn: {frm}", f"\ttoColumn: {to}", ""]
    return "\n".join(lines)


def _model_tmdl(tables: list[str]) -> str:
    refs = "\n".join(f"ref table {t}" for t in [*tables, "_Measures"])
    return (
        "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n"
        "\tdiscourageImplicitMeasures\n\tsourceQueryCulture: en-US\n\n"
        "annotation PBI_ProcessedLanguage = en-US\n\n" + refs + "\n"
    )


def _platform(display_name: str) -> str:
    logical_id = str(uuid.uuid4())
    return (
        '{\n    "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/'
        'platformProperties/2.0.0/schema.json",\n    "metadata": {\n        "type": "SemanticModel",\n'
        f'        "displayName": "{display_name}"\n    }},\n    "config": {{\n        "version": "2.0",\n'
        f'        "logicalId": "{logical_id}"\n    }}\n}}\n'
    )


_PBISM = (
    '{\n    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/'
    'definitionProperties/1.0.0/schema.json",\n    "version": "4.2",\n    "settings": {}\n}\n'
)


def write_seed_model(workspace: str, name: str, tables: dict, measures: list[tuple[str, str]], rels: list) -> None:
    """Write one deployable ``<name>.SemanticModel`` (import mode, unique logicalId) under seed_models/."""
    root = ROOT / workspace / f"{name}.SemanticModel"
    definition = root / "definition"
    (definition / "tables").mkdir(parents=True, exist_ok=True)
    root.joinpath(".platform").write_text(_platform(name), encoding="utf-8")
    root.joinpath("definition.pbism").write_text(_PBISM, encoding="utf-8")
    definition.joinpath("database.tmdl").write_text("database\n\tcompatibilityLevel: 1700\n", encoding="utf-8")
    definition.joinpath("model.tmdl").write_text(_model_tmdl(list(tables)), encoding="utf-8")
    for table, cols in tables.items():
        (definition / "tables" / f"{table}.tmdl").write_text(_table_tmdl(table, cols), encoding="utf-8")
    (definition / "tables" / "_Measures.tmdl").write_text(_measures_tmdl(measures), encoding="utf-8")
    if rels:
        definition.joinpath("relationships.tmdl").write_text(_rels_tmdl(rels), encoding="utf-8")


def _wrap(measures: list[tuple[str, str]], target: str, fn: str) -> list[tuple[str, str]]:
    """Return measures with the named measure's DAX wrapped in a function (ROUND/TRUNC drift)."""
    out = []
    for name, dax in measures:
        out.append((name, f"{fn}({dax}, 0)" if fn == "ROUND" else f"{fn}({dax})") if name == target else (name, dax))
    return out


def _seed_specs() -> list[dict]:
    """Graded brewery variants; expected band in comments (validated locally before deploy)."""
    # pylint: disable=too-many-locals  # cohesive fixture spec
    strong = _wrap(_wrap(BASE_MEASURES, "Total Volume (HL)", "ROUND"), "Net Revenue", "ROUND")
    subset_measures = _wrap(BASE_MEASURES[:5], "Total Volume (HL)", "TRUNC")  # fewer measures + TRUNC
    partial = [
        ("Total Volume (HL)", "SUM(FactSales[VolumeHL])"),
        (
            "Volume YoY %",
            "DIVIDE([Total Volume (HL)] - CALCULATE([Total Volume (HL)], "
            "SAMEPERIODLASTYEAR(DimDate[Date])), CALCULATE([Total Volume (HL)], "
            "SAMEPERIODLASTYEAR(DimDate[Date])))",
        ),
        ("Brand Count", "DISTINCTCOUNT(DimBrand[Brand])"),
        ("Distribution Points", "COUNTROWS(DimMarket)"),
    ]
    # Renamed clone: identical DAX structure, everything renamed.
    renamed_tables = {
        "Sales": [
            ("OrderDate", "dateTime", "date", "#date(2024,1,1)"),
            ("SkuKey", "int64", "Int64.Type", "1"),
            ("Hectolitres", "double", "number", "1250.0"),
            ("Turnover", "double", "number", "84000.0"),
        ],
        "Calendar": DIM_DATE,
        "Sku": [("SkuKey", "int64", "Int64.Type", "1"), ("Sku", "string", "text", '"Stella"')],
    }
    renamed_measures = [
        ("Total Hectolitres", "SUM(Sales[Hectolitres])"),
        ("Turnover", "SUM(Sales[Turnover])"),
        ("Hectolitres LY", "CALCULATE([Total Hectolitres], SAMEPERIODLASTYEAR(Calendar[Date]))"),
        ("Turnover LY", "CALCULATE([Turnover], SAMEPERIODLASTYEAR(Calendar[Date]))"),
        ("Hectolitres YoY %", "DIVIDE([Total Hectolitres] - [Hectolitres LY], [Hectolitres LY])"),
        ("Avg Turnover per HL", "DIVIDE([Turnover], [Total Hectolitres])"),
    ]
    renamed_rels = [("Sales.SkuKey", "Sku.SkuKey"), ("Sales.OrderDate", "Calendar.Date")]
    return [
        {
            "ws": f"{SEED_PREFIX} Sales West",
            "name": "Brewery Commercial Model",
            "tables": BREWERY_TABLES,
            "measures": BASE_MEASURES,
            "rels": BREWERY_RELS,
        },  # keep candidate
        {
            "ws": f"{SEED_PREFIX} Sales East",
            "name": "Regional Sales Report",
            "tables": BREWERY_TABLES,
            "measures": strong,
            "rels": BREWERY_RELS,
        },  # strong-duplicate
        {
            "ws": f"{SEED_PREFIX} Commercial Ops",
            "name": "Commercial Volume Tracker",
            "tables": BREWERY_TABLES,
            "measures": subset_measures,
            "rels": BREWERY_RELS,
        },  # subset
        {
            "ws": f"{SEED_PREFIX} Marketing",
            "name": "Brand Marketing Deck",
            "tables": {"FactSales": FACT_SALES, "DimBrand": DIM_BRAND, "DimDate": DIM_DATE, "DimMarket": DIM_MARKET},
            "measures": partial,
            "rels": BREWERY_RELS,
        },  # needs-review (partial overlap)
        {
            "ws": f"{SEED_PREFIX} Commercial Ops",
            "name": "Sales Performance (Ops)",
            "tables": renamed_tables,
            "measures": renamed_measures,
            "rels": renamed_rels,
        },  # renamed clone
    ]


def main() -> None:
    """(Re)generate the deployable seed_models/ set."""
    if ROOT.exists():
        shutil.rmtree(ROOT)
    specs = _seed_specs()
    for spec in specs:
        write_seed_model(spec["ws"], spec["name"], spec["tables"], spec["measures"], spec["rels"])
    print(f"wrote {len(specs)} deployable seed models -> {ROOT}")
    for spec in specs:
        print(f"  {spec['ws']:28} / {spec['name']}")


if __name__ == "__main__":
    main()
