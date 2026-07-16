"""Parser regression tests: the TMDL shapes the exporter actually emits.

The exporter writes a multi-line measure as ``measure X =`` followed by a whitespace-only line and
then the body indented two levels deeper. That leading blank line used to terminate the expression
block, silently emptying ~38% of measures on real estates (the measure facet is the strongest
similarity signal). These tests pin the shapes down so the regression cannot come back.

Also covers the physical-source connector broadening: the detector previously only recognized a
literal-arg ``Sql.Database("host", "db")`` and had no word boundary, so "PostgreSQL.Database(" /
"MySQL.Database(" only worked by substring accident and BigQuery/Snowflake/Databricks/CSV/Parquet
weren't recognized at all.
"""

# pylint: disable=missing-function-docstring,protected-access

from semantic_sweep.parser import _parse_physical_source, _read_measure


def _dax(*lines: str) -> str:
    measure, nxt = _read_measure(list(lines), 0)
    assert nxt == len(lines)  # the whole block is consumed
    return measure.dax


def test_multiline_measure_with_leading_blank_line_is_captured():
    dax = _dax(
        "\tmeasure '# Capacities' =",
        "\t\t\t",
        "\t\t\tCALCULATE(",
        "\t\t\t    COUNT(capacities[CapacityId]),",
        "\t\t\t    capacities[fuam_deleted] = FALSE()",
        "\t\t\t    )",
        "\t\tformatString: #,0",
    )
    assert "CALCULATE(" in dax
    assert "capacities[CapacityId]" in dax
    assert "formatString" not in dax  # a child property must not leak into the expression


def test_multiline_var_return_measure_is_captured():
    dax = _dax(
        "\tmeasure 'Revenue YoY %' =",
        "\t\t\tVAR _cur = [Revenue]",
        "\t\t\tVAR _prior = CALCULATE([Revenue], DATEADD('Date'[Date], -1, YEAR))",
        "\t\t\tRETURN DIVIDE(_cur - _prior, _prior)",
        "\t\tformatString: 0.0%",
        "\t\tdisplayFolder: Time Intelligence",
    )
    assert dax.startswith("VAR _cur = [Revenue]")
    assert "RETURN DIVIDE(_cur - _prior, _prior)" in dax
    assert "displayFolder" not in dax


def test_single_line_measure_unchanged():
    assert _dax("\tmeasure 'Total Sales' = SUM(Sales[Amount])") == "SUM(Sales[Amount])"


def test_blank_measure_stays_empty():
    measure, _ = _read_measure(["\tmeasure Medida =", "\t\tlineageTag: abc-123"], 0)
    assert measure.dax == ""


def _physical(text: str, tmp_path) -> set[tuple[str, str]]:
    (tmp_path / "src.tmdl").write_text(f"Source = {text}", encoding="utf-8")
    return _parse_physical_source(tmp_path)


def test_still_recognizes_literal_sql_database(tmp_path):
    # Baseline, unchanged.
    assert _physical('Sql.Database("prod-sql-01", "Sales")', tmp_path) == {("prod-sql-01", "sales")}


def test_recognizes_postgresql_without_misreading_as_generic_sql_server(tmp_path):
    physical = _physical('PostgreSQL.Database("pg-host", "pgdb")', tmp_path)
    assert physical == {("pg-host", "pgdb")}  # no double-count from an unanchored "Sql.Database(" match


def test_recognizes_mysql_word_boundary_fix_must_not_drop_this_accidental_today_coverage(tmp_path):
    physical = _physical('MySQL.Database("my-host", "mydb", [ReturnSingleDatabase=true])', tmp_path)
    assert physical == {("my-host", "mydb")}


def test_recognizes_snowflake_databases(tmp_path):
    physical = _physical('Snowflake.Databases("xy12345.snowflakecomputing.com", "COMPUTE_WH")', tmp_path)
    assert physical == {("xy12345.snowflakecomputing.com", "compute_wh")}


def test_recognizes_databricks_catalogs(tmp_path):
    physical = _physical('Databricks.Catalogs("adb-123.azuredatabricks.net", "/sql/1.0/warehouses/abc")', tmp_path)
    assert physical == {("adb-123.azuredatabricks.net", "/sql/1.0/warehouses/abc")}


def test_recognizes_bigquery_with_billing_project_arg(tmp_path):
    assert _physical('GoogleBigQuery.Database("my-project-id")', tmp_path) == {("my-project-id", "")}


def test_does_not_fingerprint_a_zero_arg_bigquery_call(tmp_path):
    assert _physical("GoogleBigQuery.Database()", tmp_path) == set()


def test_recognizes_csv_document_file_contents(tmp_path):
    physical = _physical('Csv.Document(File.Contents("C:\\data\\sales.csv"), [Delimiter=","])', tmp_path)
    assert physical == {("c:\\data\\sales.csv", "")}


def test_recognizes_parquet_document_file_contents(tmp_path):
    physical = _physical('Parquet.Document(File.Contents("C:\\data\\sales.parquet"))', tmp_path)
    assert physical == {("c:\\data\\sales.parquet", "")}


def test_captures_a_parameterized_sql_database_call_symbolically(tmp_path):
    physical = _physical("Sql.Database(ServerParam, DatabaseParam)", tmp_path)
    assert physical == {("serverparam", "databaseparam")}


def test_does_not_manufacture_evidence_from_generic_param_names_alone(tmp_path):
    # "Server"/"Database" alone are template placeholders, not evidence.
    assert _physical("Sql.Database(Server, Database)", tmp_path) == set()
