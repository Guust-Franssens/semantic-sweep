"""
purpose: generate synthetic, deliberately-overlapping TMDL semantic models to calibrate scoring
usage:   python scripts/make_sample_models.py        (writes -> sample_models/)

The set is built around one "commercial sales" model and graded variants so the scorer is exercised
across the full band spectrum (exact / strong / subset / needs-review / unrelated), which the real
tenant (mostly exact-or-unrelated) does not cover.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path("sample_models")

# Shared building blocks for the "commercial" family.
SALES_TABLES = {
    "FactSales": [("OrderDate", "dateTime"), ("ProductKey", "int64"), ("Amount", "double"), ("Quantity", "int64")],
    "DimDate": [("Date", "dateTime"), ("Month", "string")],
    "DimProduct": [("ProductKey", "int64"), ("Category", "string")],
}
SALES_RELS = [("FactSales.ProductKey", "DimProduct.ProductKey"), ("FactSales.OrderDate", "DimDate.Date")]
BASE_MEASURES = [
    ("Total Sales", "SUM(FactSales[Amount])"),
    ("Total Quantity", "SUM(FactSales[Quantity])"),
    ("Avg Price", "DIVIDE([Total Sales], [Total Quantity])"),
    ("Sales LY", "CALCULATE([Total Sales], SAMEPERIODLASTYEAR(DimDate[Date]))"),
    ("Sales YoY %", "DIVIDE([Total Sales] - [Sales LY], [Sales LY])"),
]


def _table_tmdl(name: str, columns: list[tuple[str, str]], schema: str) -> str:
    lines = [f"table {name}", ""]
    for col, dtype in columns:
        lines += [f"\tcolumn {col}", f"\t\tdataType: {dtype}", "\t\tsummarizeBy: none", ""]
    lines += [
        f"\tpartition {name} = entity",
        "\t\tmode: directLake",
        "\t\tsource",
        f"\t\t\tentityName: {name}",
        f"\t\t\tschemaName: {schema}",
        "",
    ]
    return "\n".join(lines)


def _measures_tmdl(measures: list[tuple[str, str]]) -> str:
    lines = ["table _Measures", ""]
    for name, dax in measures:
        lines += [f"\tmeasure '{name}' = {dax}", "\t\tformatString: 0", ""]
    return "\n".join(lines)


def _rels_tmdl(rels: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for i, (frm, to) in enumerate(rels):
        lines += [f"relationship r{i}", f"\tfromColumn: {frm}", f"\ttoColumn: {to}", ""]
    return "\n".join(lines)


def write_model(spec: dict) -> None:
    """Write one synthetic ``<name>.SemanticModel`` TMDL folder under ``sample_models/``."""
    base = ROOT / spec["ws"] / f"{spec['name']}.SemanticModel" / "definition"
    (base / "tables").mkdir(parents=True, exist_ok=True)
    schema = spec["schema"]
    for tname, cols in spec["tables"].items():
        (base / "tables" / f"{tname}.tmdl").write_text(_table_tmdl(tname, cols, schema), encoding="utf-8")
    (base / "tables" / "_Measures.tmdl").write_text(_measures_tmdl(spec["measures"]), encoding="utf-8")
    if spec["rels"]:
        (base / "relationships.tmdl").write_text(_rels_tmdl(spec["rels"]), encoding="utf-8")


def _specs() -> list[dict]:
    """Return the graded model specifications (expected band noted per pair in the calibration test)."""
    # pylint: disable=too-many-locals  # cohesive fixture spec
    rounded = [(n, f"ROUND({d}, 0)") for n, d in BASE_MEASURES[:1]] + [
        ("Total Quantity", "SUM(FactSales[Quantity])"),
        ("Avg Price", "ROUND(DIVIDE([Total Sales], [Total Quantity]), 2)"),
        ("Sales LY", "CALCULATE([Total Sales], SAMEPERIODLASTYEAR(DimDate[Date]))"),
        ("Sales YoY %", "DIVIDE([Total Sales] - [Sales LY], [Sales LY])"),
    ]
    truncated = [("Total Sales", "TRUNC(SUM(FactSales[Amount]))")] + rounded[1:]
    # Partial-overlap: shares FactSales+DimDate and the Total Sales measure; adds margin measures.
    margin_tables = {
        "FactSales": [("OrderDate", "dateTime"), ("ProductKey", "int64"), ("Amount", "double"), ("Cost", "double")],
        "DimDate": SALES_TABLES["DimDate"],
    }
    margin_measures = [
        ("Total Sales", "SUM(FactSales[Amount])"),
        ("Total Cost", "SUM(FactSales[Cost])"),
        ("Margin", "[Total Sales] - [Total Cost]"),
        ("Margin %", "DIVIDE([Margin], [Total Sales])"),
    ]
    # Renamed clone (Type-2): identical DAX structure, every table/column/measure renamed.
    renamed_tables = {
        "Sales": [("OrderDate", "dateTime"), ("ProductKey", "int64"), ("Revenue", "double"), ("Units", "int64")],
        "Calendar": [("Date", "dateTime"), ("Month", "string")],
        "Product": [("ProductKey", "int64"), ("Category", "string")],
    }
    renamed_measures = [
        ("Revenue", "SUM(Sales[Revenue])"),
        ("Units", "SUM(Sales[Units])"),
        ("Avg Price", "DIVIDE([Revenue], [Units])"),
        ("Revenue LY", "CALCULATE([Revenue], SAMEPERIODLASTYEAR(Calendar[Date]))"),
        ("Revenue YoY %", "DIVIDE([Revenue] - [Revenue LY], [Revenue LY])"),
    ]
    logistics_tables = {
        "FactShipments": [("ShipDate", "dateTime"), ("WarehouseKey", "int64"), ("OnTime", "int64")],
        "DimWarehouse": [("WarehouseKey", "int64"), ("Region", "string")],
    }
    logistics_measures = [
        ("Shipment Count", "COUNTROWS(FactShipments)"),
        ("On-Time %", "DIVIDE(CALCULATE(COUNTROWS(FactShipments), FactShipments[OnTime] = 1), [Shipment Count])"),
    ]
    return [
        {
            "ws": "Sales Team A",
            "name": "Commercial Sales",
            "tables": SALES_TABLES,
            "measures": BASE_MEASURES,
            "schema": "dbo",
            "rels": SALES_RELS,
        },
        {
            "ws": "Sales Team B",
            "name": "Commercial Sales (rounded)",
            "tables": SALES_TABLES,
            "measures": rounded,
            "schema": "dbo",
            "rels": SALES_RELS,
        },
        {
            "ws": "Sales Team C",
            "name": "Commercial Sales (truncated)",
            "tables": SALES_TABLES,
            "measures": truncated,
            "schema": "dbo",
            "rels": SALES_RELS,
        },
        {
            "ws": "Finance Team",
            "name": "Sales Margin",
            "tables": margin_tables,
            "measures": margin_measures,
            "schema": "dbo",
            "rels": SALES_RELS[1:],
        },
        {
            "ws": "Exec Team",
            "name": "Revenue Report",
            "tables": renamed_tables,
            "measures": renamed_measures,
            "schema": "dbo",
            "rels": [("Sales.ProductKey", "Product.ProductKey"), ("Sales.OrderDate", "Calendar.Date")],
        },
        {
            "ws": "Ops Team",
            "name": "Logistics KPIs",
            "tables": logistics_tables,
            "measures": logistics_measures,
            "schema": "dbo",
            "rels": [("FactShipments.WarehouseKey", "DimWarehouse.WarehouseKey")],
        },
    ]


def main() -> None:
    """(Re)generate the sample_models/ fixture set."""
    if ROOT.exists():
        shutil.rmtree(ROOT)
    for spec in _specs():
        write_model(spec)
    print(f"wrote {len(_specs())} sample models -> {ROOT}")


if __name__ == "__main__":
    main()
