import { describe, expect, it } from "vitest";
import type { InputFile } from "@engine/parser";
import { loadModelsFromFiles } from "@engine/parser";

// The TMDL exporter emits a whitespace-only line immediately after `measure X =`, before the body.
// That blank line must NOT terminate the expression block: it previously truncated ~38% of measures
// on real estates (FUAM_Core lost 172/270), silently emptying the strongest similarity facet.
function multilineModel(): InputFile[] {
  const metrics =
    "table Metrics\n" +
    "\tmeasure '# Capacities' =\n" +
    "\t\t\t\n" +
    "\t\t\tCALCULATE(\n" +
    "\t\t\t    COUNT(capacities[CapacityId]),\n" +
    "\t\t\t    capacities[fuam_deleted] = FALSE()\n" +
    "\t\t\t    )\n" +
    "\t\tformatString: #,0\n" +
    "\tmeasure 'Revenue YoY %' =\n" +
    "\t\t\tVAR _cur = [Revenue]\n" +
    "\t\t\tVAR _prior = CALCULATE([Revenue], DATEADD('Date'[Date], -1, YEAR))\n" +
    "\t\t\tRETURN DIVIDE(_cur - _prior, _prior)\n" +
    "\t\tformatString: 0.0%\n" +
    "\tmeasure 'Total Sales' = SUM(Sales[Amount])\n";
  return [{ path: "WS.Workspace/FUAM Core.SemanticModel/definition/tables/Metrics.tmdl", text: metrics }];
}

describe("multi-line DAX parsing (leading blank line)", () => {
  const cards = loadModelsFromFiles(multilineModel(), true);
  const card = cards.find((c) => c.name === "FUAM Core")!;

  it("captures the full CALCULATE body, not an empty string", () => {
    const cap = card.measures.find((m) => m.name === "# Capacities")!;
    expect(cap.dax).toContain("CALCULATE(");
    expect(cap.dax).toContain("capacities[CapacityId]");
    expect(cap.dax).not.toContain("formatString"); // a child property must not leak into the expression
  });

  it("captures a VAR/RETURN body across multiple lines", () => {
    const yoy = card.measures.find((m) => m.name === "Revenue YoY %")!;
    expect(yoy.dax.startsWith("VAR _cur = [Revenue]")).toBe(true);
    expect(yoy.dax).toContain("RETURN DIVIDE(_cur - _prior, _prior)");
    expect(yoy.dax).not.toContain("displayFolder");
  });

  it("leaves single-line measures unchanged", () => {
    const tot = card.measures.find((m) => m.name === "Total Sales")!;
    expect(tot.dax).toBe("SUM(Sales[Amount])");
  });
});

// Source-parser broadening: the physical-source detector previously only recognized a literal-arg
// `Sql.Database("host", "db")` and had no word boundary, so "PostgreSQL.Database(" / "MySQL.Database("
// only worked by substring accident and BigQuery/Snowflake/Databricks/CSV/Parquet weren't recognized
// at all. These pin down the broadened connector coverage and the parameterized-arg support.
function modelWithExpression(expression: string): InputFile[] {
  const text = `table Src\n\tpartition Src = m\n\t\tmode: import\n\t\tsource =\n\t\t\t\tlet\n\t\t\t\t\tSource = ${expression}\n\t\t\t\tin\n\t\t\t\t\tSource\n`;
  return [{ path: "WS.Workspace/Src.SemanticModel/definition/tables/Src.tmdl", text }];
}

describe("source-physical parser broadening", () => {
  const cardFor = (expression: string) => loadModelsFromFiles(modelWithExpression(expression), true)[0];

  it("still recognizes literal Sql.Database (baseline, unchanged)", () => {
    const card = cardFor('Sql.Database("prod-sql-01", "Sales")');
    expect(card.sourcePhysical.has("prod-sql-01\u0000sales")).toBe(true);
  });

  it("recognizes PostgreSQL.Database without misreading it as a generic SQL Server match", () => {
    const card = cardFor('PostgreSQL.Database("pg-host", "pgdb")');
    expect(card.sourcePhysical.has("pg-host\u0000pgdb")).toBe(true);
    expect(card.sourcePhysical.size).toBe(1); // no double-count from an unanchored "Sql.Database(" match
  });

  it("recognizes MySQL.Database (word-boundary fix must not drop this accidental-today coverage)", () => {
    const card = cardFor('MySQL.Database("my-host", "mydb", [ReturnSingleDatabase=true])');
    expect(card.sourcePhysical.has("my-host\u0000mydb")).toBe(true);
  });

  it("recognizes Snowflake.Databases", () => {
    const card = cardFor('Snowflake.Databases("xy12345.snowflakecomputing.com", "COMPUTE_WH")');
    expect(card.sourcePhysical.has("xy12345.snowflakecomputing.com\u0000compute_wh")).toBe(true);
  });

  it("recognizes Databricks.Catalogs", () => {
    const card = cardFor('Databricks.Catalogs("adb-123.azuredatabricks.net", "/sql/1.0/warehouses/abc")');
    expect(card.sourcePhysical.has("adb-123.azuredatabricks.net\u0000/sql/1.0/warehouses/abc")).toBe(true);
  });

  it("recognizes GoogleBigQuery.Database with a billing-project arg", () => {
    const card = cardFor('GoogleBigQuery.Database("my-project-id")');
    expect(card.sourcePhysical.has("my-project-id\u0000")).toBe(true);
  });

  it("does not fingerprint a zero-arg GoogleBigQuery.Database call", () => {
    const card = cardFor("GoogleBigQuery.Database()");
    expect(card.sourcePhysical.size).toBe(0);
  });

  it("recognizes Csv.Document(File.Contents(path))", () => {
    const card = cardFor('Csv.Document(File.Contents("C:\\data\\sales.csv"), [Delimiter=","])');
    expect(card.sourcePhysical.has("c:\\data\\sales.csv\u0000")).toBe(true);
  });

  it("recognizes Parquet.Document(File.Contents(path))", () => {
    const card = cardFor('Parquet.Document(File.Contents("C:\\data\\sales.parquet"))');
    expect(card.sourcePhysical.has("c:\\data\\sales.parquet\u0000")).toBe(true);
  });

  it("captures a parameterized Sql.Database(Server, Database) call symbolically", () => {
    const card = cardFor("Sql.Database(ServerParam, DatabaseParam)");
    expect(card.sourcePhysical.has("serverparam\u0000databaseparam")).toBe(true);
  });

  it("does not manufacture evidence from two unrelated models sharing only generic param names", () => {
    const card = cardFor("Sql.Database(Server, Database)");
    expect(card.sourcePhysical.size).toBe(0); // "Server"/"Database" alone are template placeholders, not evidence
  });

  // fix-parity-harness: JS's `\w` is ASCII-only regardless of regex flags, unlike Python's `\w`
  // (Unicode-aware by default) -- a non-ASCII M-query parameter name (plausible on a non-English
  // tenant) previously matched only its ASCII prefix here, diverging from the Python engine's parse
  // of the identical model. Fixed via `[\p{L}\p{N}_]` + the `u` flag on every ARG_SRC-consuming regex.
  it("captures a full non-ASCII parameterized Sql.Database(Server, Database) call", () => {
    const card = cardFor("Sql.Database(ServeurClientÉ, MonParamètre)");
    expect(card.sourcePhysical.has("serveurclienté\u0000monparamètre")).toBe(true);
  });
});

// dax-tokenizer-hardening: readColumn previously found a quoted name's closing "'" via
// body.indexOf("'", 1), which returns -1 when the quote is unterminated -- body.slice(1, -1) on a -1
// end index then silently drops the last real character instead of erroring or degrading safely.
function columnModel(): InputFile[] {
  const table =
    "table Cols\n" +
    "\tcolumn 'My Column'\n" +
    "\t\tdataType: string\n" +
    "\tcolumn MyColumn\n" +
    "\t\tdataType: int64\n" +
    "\tcolumn 'Calc Column' = SUM(Sales[Amount])\n" +
    "\tcolumn 'Broken\n";
  return [{ path: "WS.Workspace/Cols Model.SemanticModel/definition/tables/Cols.tmdl", text: table }];
}

describe("column name parsing", () => {
  const cards = loadModelsFromFiles(columnModel(), true);
  const card = cards.find((c) => c.name === "Cols Model")!;

  it("reads a quoted column name", () => {
    expect(card.columns.some((c) => c.name === "My Column")).toBe(true);
  });

  it("reads a bare column name", () => {
    expect(card.columns.some((c) => c.name === "MyColumn")).toBe(true);
  });

  it("stops a calculated column's quoted name at the '=' sign", () => {
    expect(card.columns.some((c) => c.name === "Calc Column")).toBe(true);
  });

  it("does not crash or drop a character on an unterminated quoted name", () => {
    const broken = card.columns.find((c) => c.name.includes("Broken"));
    expect(broken).toBeDefined();
  });
});

