// TMDL parsing in the browser (or Node). Ported from semantic_sweep/parser.py.
// Consumes in-memory files: { path, text }[] — environment-agnostic.

import type { Column, Measure, ModelCard } from "./types";

export interface InputFile {
  path: string;
  text: string;
}

const USAGE_METRICS_RE = /usage\s*metrics/i;
const SQL_DATABASE_RE = /Sql\.Database\(\s*"([^"]+)"\s*,\s*"([^"]+)"/gi;
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
    for (const m of f.text.matchAll(SQL_DATABASE_RE)) {
      card.sourcePhysical.add(`${m[1].toLowerCase()}\u0000${m[2].toLowerCase()}`);
    }
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
