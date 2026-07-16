// TMDL parsing in the browser (or Node). Ported from semantic_sweep/parser.py.
// Consumes in-memory files: { path, text }[] — environment-agnostic.

import type { Column, Measure, ModelCard } from "./types";

export interface InputFile {
  path: string;
  text: string;
}

const USAGE_METRICS_RE = /usage\s*metrics/i;
// One connection arg: a literal string value, OR a bare identifier (an M query parameter / let-bound
// name, e.g. `Sql.Database(ServerParam, DatabaseParam)`) captured symbolically so parameterized
// connections still contribute comparable physical-source evidence instead of being silently dropped.
const ARG_SRC = String.raw`(?:"([^"]+)"|(\w+))`;
// `\b` matters here: without it "Sql.Database(" also matches inside "PostgreSQL.Database(" and
// "MySQL.Database(" (both connector names literally end in "...SQL"), miscategorizing those sources
// as SQL Server. PostgreSQL and MySQL get their own dedicated (and correctly `\b`-anchored) regexes
// below so this fix doesn't silently drop coverage that previously worked only by substring accident.
const SQL_DATABASE_RE = new RegExp(String.raw`\bSql\.Database\(\s*` + ARG_SRC + String.raw`\s*,\s*` + ARG_SRC, "gi");
const POSTGRESQL_RE = new RegExp(
  String.raw`\bPostgreSQL\.Database\(\s*` + ARG_SRC + String.raw`\s*,\s*` + ARG_SRC,
  "gi",
);
const MYSQL_RE = new RegExp(String.raw`\bMySQL\.Database\(\s*` + ARG_SRC + String.raw`\s*,\s*` + ARG_SRC, "gi");
const SNOWFLAKE_RE = new RegExp(
  String.raw`\bSnowflake\.Databases?\(\s*` + ARG_SRC + String.raw`\s*,\s*` + ARG_SRC,
  "gi",
);
const DATABRICKS_RE = new RegExp(
  String.raw`\bDatabricks\.Catalogs\(\s*` + ARG_SRC + String.raw`\s*,\s*` + ARG_SRC,
  "gi",
);
// BigQuery rarely carries a comparable 2-arg identity (often zero args, or an options record); capture
// a single literal/identifier arg (billing project) when present, else there's nothing to fingerprint.
const BIGQUERY_RE = new RegExp(String.raw`\bGoogleBigQuery\.Database\(\s*` + ARG_SRC + "?", "gi");
// File-based connectors: the file path is the physical identity. Only a simple literal path or a
// single bare parameter reference is captured; a concatenation expression (e.g. folder & name &
// ".csv") is dynamic per-row/per-parameter and cannot be fingerprinted statically.
const CSV_RE = new RegExp(String.raw`\bCsv\.Document\(\s*File\.Contents\(\s*` + ARG_SRC + String.raw`\s*\)`, "gi");
const PARQUET_RE = new RegExp(
  String.raw`\bParquet\.Document\(\s*File\.Contents\(\s*` + ARG_SRC + String.raw`\s*\)`,
  "gi",
);
// Bare M parameter names common enough in templated connection setups (e.g. every environment's model
// has a query parameter literally called "Server"/"Database") that a shared PARAMETER NAME alone (not
// an actual literal value) must not manufacture physical-source evidence between unrelated models.
const GENERIC_PARAM_NAMES = new Set([
  "server", "database", "host", "hostname", "warehouse", "instance", "catalog", "schema",
  "port", "endpoint", "source", "db", "path", "filepath", "file", "url", "connection", "conn",
]);
// Composite / DirectQuery-to-Power-BI-dataset reference: a model built ON another semantic model.
const ANALYSIS_SERVICES_RE = /AnalysisServices\.Databases?\(\s*"([^"]*)"(?:\s*,\s*"([^"]+)")?/gi;
// Fabric/PBI DirectQuery-to-dataset via the dedicated connector (e.g. PowerBIDatasets / PowerPlatform.Dataflows-style).
const PBI_DATASETS_RE = /PowerBIDatasets\s*\(/i;
// M navigation step `{[Name="DatasetName"]}[Data]` — how the upstream dataset name appears when it
// isn't an inline argument to AnalysisServices.Database(s).
const NAV_NAME_RE = /\{\s*\[\s*Name\s*=\s*"([^"]+)"\s*\]\s*\}\s*\[\s*Data\s*\]/gi;
const SCHEMA_RE = /^\s*schemaName:\s*(.+?)\s*$/;
const ENTITY_RE = /^\s*entityName:\s*(.+?)\s*$/;

const tabIndent = (line: string): number => line.length - line.replace(/^\t+/, "").length;

function unquote(name: string): string {
  let n = name.trim();
  if (n.startsWith("'") && n.endsWith("'") && n.length >= 2) n = n.slice(1, -1);
  return n.trim();
}

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

function readMeasure(lines: string[], start: number): [Measure, number] {
  let i = start;
  const line = lines[i];
  const indent = tabIndent(line);
  const m = /^\t+measure\s+(.+?)\s*=\s*(.*)$/.exec(line);
  const name = unquote(m ? m[1] : "");
  const inline = (m ? m[2] : "").trim();
  const parts: string[] = [];
  i += 1;
  if (inline === "```") {
    while (i < lines.length && lines[i].trim() !== "```") {
      parts.push(lines[i].trim());
      i += 1;
    }
    i += 1;
  } else if (inline === "") {
    // The exporter emits a leading whitespace-only line before the body, so a blank line is part of
    // the expression block, not its terminator. Stop only at the first non-blank line shallow enough
    // to be a child property (indent + 1) or a sibling/parent (<= indent).
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === "") {
        i += 1;
        continue;
      }
      if (tabIndent(cur) <= indent + 1) break;
      parts.push(cur.trim());
      i += 1;
    }
  } else {
    parts.push(inline);
  }
  while (i < lines.length) {
    const cur = lines[i];
    if (cur.trim() === "") {
      i += 1;
      continue;
    }
    if (tabIndent(cur) <= indent) break;
    i += 1;
  }
  return [{ name, dax: parts.filter((p) => p).join(" ") }, i];
}

function readColumn(lines: string[], start: number, table: string): [Column, number] {
  let i = start;
  const indent = tabIndent(lines[i]);
  const body = lines[i].trim().slice("column".length).trim();
  let name: string;
  if (body.startsWith("'")) name = body.slice(1, body.indexOf("'", 1));
  else name = body.split("=")[0].trim();
  let dataType: string | null = null;
  let hidden = false;
  i += 1;
  while (i < lines.length) {
    const cur = lines[i];
    if (cur.trim() === "") {
      i += 1;
      continue;
    }
    if (tabIndent(cur) <= indent) break;
    const stripped = cur.trim();
    if (stripped.startsWith("dataType:")) dataType = stripped.split(/:(.*)/s)[1].trim();
    else if (stripped === "isHidden" || stripped.startsWith("isHidden:")) hidden = true;
    i += 1;
  }
  return [{ table, name: unquote(name), dataType, hidden }, i];
}

interface TableParse {
  tableName: string | null;
  columns: Column[];
  measures: Measure[];
  isCalcGroup: boolean;
}

function parseTableFile(text: string): TableParse {
  const lines = splitLines(text);
  let tableName: string | null = null;
  const columns: Column[] = [];
  const measures: Measure[] = [];
  let isCalcGroup = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();
    if (tabIndent(line) === 0 && stripped.startsWith("table ")) {
      tableName = unquote(stripped.slice("table ".length));
    } else if (stripped.startsWith("calculationGroup")) {
      isCalcGroup = true;
    } else if (/^\t+measure\s/.test(line)) {
      const [measure, next] = readMeasure(lines, i);
      measures.push(measure);
      i = next;
      continue;
    } else if (/^\t+column\s/.test(line)) {
      const [column, next] = readColumn(lines, i, tableName ?? "");
      columns.push(column);
      i = next;
      continue;
    }
    i += 1;
  }
  return { tableName, columns, measures, isCalcGroup };
}

function parseRelationships(text: string): string[] {
  const rels: string[] = [];
  let fromCol: string | null = null;
  for (const line of splitLines(text)) {
    const stripped = line.trim();
    if (stripped.startsWith("fromColumn:")) {
      fromCol = stripped.split(/:(.*)/s)[1].trim().toLowerCase();
    } else if (stripped.startsWith("toColumn:") && fromCol !== null) {
      rels.push(`${fromCol}\u0000${stripped.split(/:(.*)/s)[1].trim().toLowerCase()}`);
      fromCol = null;
    }
  }
  return rels;
}

function logicalFromTable(text: string): string | null {
  let schema: string | null = null;
  let entity: string | null = null;
  for (const line of splitLines(text)) {
    const s = SCHEMA_RE.exec(line);
    if (s) {
      schema = unquote(s[1]).toLowerCase();
      continue;
    }
    const e = ENTITY_RE.exec(line);
    if (e) entity = unquote(e[1]).toLowerCase();
  }
  return entity !== null ? `${schema ?? ""}\u0000${entity}` : null;
}

const normPath = (p: string): string => p.replace(/\\/g, "/");

interface ModelFiles {
  workspace: string;
  name: string;
  files: Array<{ rel: string; text: string }>;
}

function groupByModel(files: InputFile[]): ModelFiles[] {
  const groups = new Map<string, ModelFiles>();
  for (const f of files) {
    const parts = normPath(f.path).split("/");
    const idx = parts.findIndex((p) => p.endsWith(".SemanticModel"));
    if (idx === -1 || idx === 0) continue;
    const workspace = parts[idx - 1];
    const name = parts[idx].replace(/\.SemanticModel$/, "");
    const rel = parts.slice(idx + 1).join("/");
    const key = `${workspace}/${name}`;
    if (!groups.has(key)) groups.set(key, { workspace, name, files: [] });
    groups.get(key)!.files.push({ rel, text: f.text });
  }
  return [...groups.values()];
}

// Add a "server\u0000database"-shaped entry for every match of a 2-positional-arg connector regex
// (Sql.Database, PostgreSQL.Database, Snowflake.Databases, Databricks.Catalogs all share this shape).
function addTwoArgPhysicalSource(card: ModelCard, re: RegExp, text: string): void {
  for (const m of text.matchAll(re)) {
    const arg1 = m[1] ?? m[2];
    const arg2 = m[3] ?? m[4];
    if (!arg1 || !arg2) continue;
    const bothParams = m[2] !== undefined && m[4] !== undefined;
    if (bothParams && GENERIC_PARAM_NAMES.has(arg1.toLowerCase()) && GENERIC_PARAM_NAMES.has(arg2.toLowerCase())) {
      continue; // templated parameter names alone are not comparable evidence
    }
    card.sourcePhysical.add(`${arg1.toLowerCase()}\u0000${arg2.toLowerCase()}`);
  }
}

// Add a "value\u0000"-shaped entry (empty second component, matching the scanner's `db ?? ""`
// convention) for a single-arg connector regex (BigQuery billing project, CSV/Parquet file path).
function addSingleArgPhysicalSource(card: ModelCard, re: RegExp, text: string): void {
  for (const m of text.matchAll(re)) {
    const arg = m[1] ?? m[2];
    if (!arg) continue;
    if (m[2] !== undefined && GENERIC_PARAM_NAMES.has(arg.toLowerCase())) continue;
    card.sourcePhysical.add(`${arg.toLowerCase()}\u0000`);
  }
}

function parseModel(mf: ModelFiles): ModelCard {
  const card: ModelCard = {
    name: mf.name,
    workspace: mf.workspace,
    tables: [],
    columns: [],
    measures: [],
    relationships: [],
    sourceLogical: new Set(),
    sourcePhysical: new Set(),
    hasRls: false,
    hasCalcGroups: false,
    systemGenerated: USAGE_METRICS_RE.test(mf.name),
  };
  const defFiles = mf.files.filter((f) => f.rel.startsWith("definition/"));
  const tableFiles = defFiles
    .filter((f) => /^definition\/tables\/.+\.tmdl$/.test(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  for (const tf of tableFiles) {
    const parsed = parseTableFile(tf.text);
    if (parsed.tableName === null) continue;
    card.tables.push(parsed.tableName);
    card.columns.push(...parsed.columns);
    card.measures.push(...parsed.measures);
    card.hasCalcGroups = card.hasCalcGroups || parsed.isCalcGroup;
    const logical = logicalFromTable(tf.text);
    if (logical) card.sourceLogical.add(logical);
  }

  const rels = defFiles.find((f) => f.rel === "definition/relationships.tmdl");
  if (rels) card.relationships = parseRelationships(rels.text);

  const derived = new Set<string>();
  let compositeSeen = false;
  for (const f of defFiles) {
    if (!f.rel.endsWith(".tmdl")) continue;
    addTwoArgPhysicalSource(card, SQL_DATABASE_RE, f.text);
    addTwoArgPhysicalSource(card, POSTGRESQL_RE, f.text);
    addTwoArgPhysicalSource(card, MYSQL_RE, f.text);
    addTwoArgPhysicalSource(card, SNOWFLAKE_RE, f.text);
    addTwoArgPhysicalSource(card, DATABRICKS_RE, f.text);
    addSingleArgPhysicalSource(card, BIGQUERY_RE, f.text);
    addSingleArgPhysicalSource(card, CSV_RE, f.text);
    addSingleArgPhysicalSource(card, PARQUET_RE, f.text);
    // Collect M navigation names once per file; the deepest (last) nav is the queried dataset.
    const navNames = [...f.text.matchAll(NAV_NAME_RE)].map((n) => n[1].trim());
    let fileHasComposite = false;
    for (const m of f.text.matchAll(ANALYSIS_SERVICES_RE)) {
      // A PBI/AS dataset endpoint => this is a composite model chained onto another dataset.
      if (/pbiazure|powerbi|analysis\.windows\.net/i.test(m[1])) {
        compositeSeen = true;
        fileHasComposite = true;
        if (m[2]) derived.add(m[2].trim());
      }
    }
    if (PBI_DATASETS_RE.test(f.text)) {
      compositeSeen = true;
      fileHasComposite = true;
    }
    // If a composite source in this file didn't carry an inline dataset name, recover it from the
    // last `{[Name="…"]}[Data]` navigation step (the dataset the model actually DirectQueries).
    if (fileHasComposite && navNames.length) derived.add(navNames[navNames.length - 1]);
    if (f.text.includes("tablePermission")) card.hasRls = true;
  }
  if (compositeSeen && derived.size === 0) derived.add("a Power BI dataset");
  if (derived.size) card.derivedFrom = [...derived];
  return card;
}

export function loadModelsFromFiles(files: InputFile[], keepEmpty = false): ModelCard[] {
  const cards = groupByModel(files)
    .map(parseModel)
    .filter((c) => keepEmpty || c.tables.length > 0);
  cards.sort((a, b) => `${a.workspace}/${a.name}`.localeCompare(`${b.workspace}/${b.name}`));
  return cards;
}
