// Slice 1a — metadata-table ingestion: CSV parsing, synonym-based column mapping,
// typed canonical usage records, and a confidence-scored identity join onto ModelCards.
//
// The canonical schema is a flatten of the PBI Scanner API + Admin activity log + refresh
// history. Real customer exports never use our column names, so a flexible mapper normalizes
// arbitrary headers, and the join carries an explicit confidence tier (identity is decision-critical:
// a silent mis-join attaches the wrong usage to the wrong model).

import type { JoinConfidence, ModelCard, Usage } from "./types";

export type CanonicalField =
  | "datasetId"
  | "workspaceId"
  | "datasetName"
  | "workspaceName"
  | "configuredBy"
  | "endorsement"
  | "certifiedBy"
  | "createdDate"
  | "modifiedDate"
  | "lastRefreshTime"
  | "refreshStatus"
  | "avgRefreshDurationMin"
  | "refreshesPerWeek"
  | "distinctUsers90d"
  | "views90d"
  | "lastAccessedDate"
  | "sizeMB"
  | "downstreamReportCount";

// Order matters: more specific fields are resolved before generic ones so a bare "id"/"name"
// column is claimed by dataset identity rather than a later field.
export const CANONICAL_FIELDS: CanonicalField[] = [
  "datasetId", "workspaceId", "datasetName", "workspaceName", "configuredBy",
  "endorsement", "certifiedBy", "createdDate", "modifiedDate", "lastRefreshTime",
  "refreshStatus", "avgRefreshDurationMin", "refreshesPerWeek", "distinctUsers90d",
  "views90d", "lastAccessedDate", "sizeMB", "downstreamReportCount",
];

export const FIELD_LABELS: Record<CanonicalField, string> = {
  datasetId: "Dataset ID (GUID)",
  workspaceId: "Workspace ID (GUID)",
  datasetName: "Dataset / model name",
  workspaceName: "Workspace name",
  configuredBy: "Owner (configured by)",
  endorsement: "Endorsement",
  certifiedBy: "Certified by",
  createdDate: "Created date",
  modifiedDate: "Modified date",
  lastRefreshTime: "Last refresh time",
  refreshStatus: "Refresh status",
  avgRefreshDurationMin: "Avg refresh duration (min)",
  refreshesPerWeek: "Refreshes / week",
  distinctUsers90d: "Distinct users (90d)",
  views90d: "Views (90d)",
  lastAccessedDate: "Last accessed date",
  sizeMB: "Size (MB)",
  downstreamReportCount: "Downstream report count",
};

const SYNONYMS: Record<CanonicalField, string[]> = {
  datasetId: ["datasetid", "modelid", "semanticmodelid", "artifactid", "objectid", "id"],
  workspaceId: ["workspaceid", "groupid", "folderid"],
  datasetName: ["datasetname", "modelname", "semanticmodel", "dataset", "itemname", "name"],
  workspaceName: ["workspacename", "workspace", "groupname", "folder"],
  configuredBy: ["configuredby", "ownerupn", "owner", "createdby", "contact", "modelowner"],
  endorsement: ["endorsement", "endorsementstatus", "certification", "certificationstatus"],
  certifiedBy: ["certifiedby", "certifier"],
  createdDate: ["createddate", "createddatetime", "createdon", "created"],
  modifiedDate: ["modifieddate", "lastmodified", "modifiedon", "updated", "modified"],
  lastRefreshTime: ["lastrefreshtime", "lastrefresh", "refreshdate", "lastrefreshdate", "lastrefreshedon"],
  refreshStatus: ["refreshstatus", "lastrefreshstatus", "refreshresult"],
  avgRefreshDurationMin: [
    "avgrefreshdurationmin", "refreshdurationmin", "avgrefreshminutes", "refreshdurationminutes",
    "avgrefreshduration", "avgrefreshmin",
  ],
  refreshesPerWeek: ["refreshesperweek", "weeklyrefreshes", "refreshfrequency", "refreshcountperweek", "refreshesweek", "refreshperweek"],
  distinctUsers90d: [
    "distinctusers90d", "distinctusers", "users90d", "uniqueusers", "usercount", "viewers", "users",
  ],
  views90d: ["views90d", "viewcount", "totalviews", "reportviews", "opens", "views"],
  lastAccessedDate: ["lastaccesseddate", "lastaccessed", "lastused", "lastviewed", "lastactivity", "lastaccess"],
  sizeMB: ["sizemb", "datasetsizemb", "modelsizemb", "sizeinmb", "size"],
  downstreamReportCount: ["downstreamreportcount", "downstreamreports", "dependentreports", "reportcount", "reports"],
};

const normHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export type ColumnMapping = Partial<Record<CanonicalField, number>>;

// A tolerant CSV parser: quoted fields, embedded commas/quotes/newlines, CRLF.
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ""));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty };
}

export function autoMap(headers: string[]): ColumnMapping {
  const normed = headers.map(normHeader);
  const mapping: ColumnMapping = {};
  const taken = new Set<number>();
  for (const field of CANONICAL_FIELDS) {
    for (const syn of SYNONYMS[field]) {
      const idx = normed.indexOf(syn);
      if (idx >= 0 && !taken.has(idx)) {
        mapping[field] = idx;
        taken.add(idx);
        break;
      }
    }
  }
  return mapping;
}

const asStr = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

const asNum = (v: string | undefined): number | undefined => {
  // A blank / whitespace-only cell is MISSING data, not zero. Number("") is 0 in JS, which would
  // silently turn an unknown users/views/downstream-reports count into a hard 0 — enough for
  // recommend.ts to (wrongly) classify the model as "unused" and surface a confident retirement
  // candidate from what is actually absent evidence. Treat empty as undefined so the
  // insufficient-evidence path catches it.
  const s = v?.trim();
  if (!s) return undefined;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

const asEndorsement = (v: string | undefined): Usage["endorsement"] => {
  const t = v?.trim().toLowerCase();
  if (!t) return undefined;
  if (t.startsWith("cert")) return "Certified";
  if (t.startsWith("prom")) return "Promoted";
  return "None";
};

export function buildUsageRecords(rows: string[][], mapping: ColumnMapping): Usage[] {
  const cell = (row: string[], f: CanonicalField): string | undefined => {
    const idx = mapping[f];
    return idx == null ? undefined : row[idx];
  };
  const out: Usage[] = [];
  for (const row of rows) {
    const datasetName = asStr(cell(row, "datasetName"));
    if (!datasetName) continue; // identity is required to be useful
    out.push({
      datasetName,
      workspaceName: asStr(cell(row, "workspaceName")) ?? "",
      datasetId: asStr(cell(row, "datasetId")),
      workspaceId: asStr(cell(row, "workspaceId")),
      configuredBy: asStr(cell(row, "configuredBy")),
      endorsement: asEndorsement(cell(row, "endorsement")),
      certifiedBy: asStr(cell(row, "certifiedBy")),
      createdDate: asStr(cell(row, "createdDate")),
      modifiedDate: asStr(cell(row, "modifiedDate")),
      lastRefreshTime: asStr(cell(row, "lastRefreshTime")),
      refreshStatus: asStr(cell(row, "refreshStatus")),
      avgRefreshDurationMin: asNum(cell(row, "avgRefreshDurationMin")),
      refreshesPerWeek: asNum(cell(row, "refreshesPerWeek")),
      distinctUsers90d: asNum(cell(row, "distinctUsers90d")),
      views90d: asNum(cell(row, "views90d")),
      lastAccessedDate: asStr(cell(row, "lastAccessedDate")),
      sizeMB: asNum(cell(row, "sizeMB")),
      downstreamReportCount: asNum(cell(row, "downstreamReportCount")),
      joinConfidence: "none",
    });
  }
  return out;
}

// Parse + auto-map in one shot; the UI can still tweak the mapping and re-run buildUsageRecords.
export function ingestCsv(text: string): { headers: string[]; rows: string[][]; mapping: ColumnMapping; records: Usage[] } {
  const { headers, rows } = parseCsv(text);
  const mapping = autoMap(headers);
  const records = buildUsageRecords(rows, mapping);
  return { headers, rows, mapping, records };
}

export interface JoinReport {
  matched: number;
  byTier: Record<JoinConfidence, number>;
  ambiguous: number;
  unmatchedCards: ModelCard[];
  unmatchedRecords: Usage[];
}

const norm = (s: string): string => s.trim().toLowerCase();

// Numeric confidence for gating: a GUID join is decision-grade; a workspace+name join is
// reliable-but-confirmable; a name-only join is weak; no match is disqualifying.
export const joinScore: Record<JoinConfidence, number> = { high: 1, medium: 0.8, low: 0.4, none: 0 };

// Attach usage to cards, mutating card.usage in place. Identity precedence:
//   datasetId (GUID)                -> high
//   unique (workspace + name)       -> medium
//   unique (name only)              -> low
//   ambiguous / no match            -> not attached
export function joinUsage(cards: ModelCard[], records: Usage[]): JoinReport {
  const byId = new Map<string, Usage[]>();
  const byWsName = new Map<string, Usage[]>();
  const byName = new Map<string, Usage[]>();
  const push = (m: Map<string, Usage[]>, k: string, u: Usage): void => {
    const arr = m.get(k);
    if (arr) arr.push(u);
    else m.set(k, [u]);
  };
  for (const u of records) {
    if (u.datasetId) push(byId, norm(u.datasetId), u);
    if (u.workspaceName) push(byWsName, `${norm(u.workspaceName)}\u0000${norm(u.datasetName)}`, u);
    push(byName, norm(u.datasetName), u);
  }

  const byTier: Record<JoinConfidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  const usedRecords = new Set<Usage>();
  const unmatchedCards: ModelCard[] = [];
  let matched = 0;
  let ambiguous = 0;

  for (const card of cards) {
    let match: Usage | undefined;
    let tier: JoinConfidence = "none";

    if (card.datasetId) {
      const hits = byId.get(norm(card.datasetId));
      if (hits && hits.length === 1) {
        match = hits[0];
        tier = "high";
      } else if (hits && hits.length > 1) {
        ambiguous++; // same GUID on multiple CSV rows = inconsistent export; don't guess a weaker tier
        unmatchedCards.push(card);
        continue;
      }
    }
    if (!match) {
      const hits = byWsName.get(`${norm(card.workspace)}\u0000${norm(card.name)}`);
      if (hits && hits.length === 1) {
        match = hits[0];
        tier = "medium";
      } else if (hits && hits.length > 1) {
        ambiguous++; // ambiguous (workspace, name) — refuse to attach; a name-only guess is worse
        unmatchedCards.push(card);
        continue;
      }
    }
    if (!match) {
      const hits = byName.get(norm(card.name));
      // Guard against attaching one record to several same-named cards: once a record is claimed,
      // a second card with the same name falls through to unmatched rather than sharing it.
      if (hits && hits.length === 1 && !usedRecords.has(hits[0])) {
        match = hits[0];
        tier = "low";
      } else if (hits && hits.length > 1) {
        ambiguous++; // several CSV rows share this name — a name-only guess is unsafe
      }
    }

    if (match) {
      usedRecords.add(match);
      // Clone per card: never share (or mutate) one Usage object across cards, which would
      // double-count savings and let one card's joinConfidence overwrite another's.
      card.usage = { ...match, joinConfidence: tier };
      byTier[tier]++;
      matched++;
    } else {
      unmatchedCards.push(card);
    }
  }

  const unmatchedRecords = records.filter((u) => !usedRecords.has(u));
  return { matched, byTier, ambiguous, unmatchedCards, unmatchedRecords };
}

// Merge an overlay usage record onto a base one (e.g. a CSV consumption table layered over a Scanner
// scan's governance/lineage). The overlay wins per-field WHERE it actually has a value; the base fills
// every gap the overlay left blank; identity confidence is the stronger of the two joins. This stops a
// partial CSV overlay from silently erasing Scanner-authoritative endorsement, owner, and lineage.
export function mergeUsage(base: Usage, overlay: Usage): Usage {
  const merged: Usage = { ...base };
  for (const key of Object.keys(overlay) as (keyof Usage)[]) {
    if (key === "joinConfidence") continue;
    const v = overlay[key];
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[key] = v;
  }
  merged.joinConfidence =
    joinScore[base.joinConfidence] >= joinScore[overlay.joinConfidence] ? base.joinConfidence : overlay.joinConfidence;
  return merged;
}
