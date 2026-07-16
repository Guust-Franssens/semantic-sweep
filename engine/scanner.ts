// Parse a Power BI / Fabric Admin **Scanner API** (getInfo/scanResult) payload into ModelCards +
// a usage overlay — enabling whole-tenant analysis without getDefinition or workspace membership.
//
// The Scanner returns structure (tables, columns+dataType, measures+DAX) plus governance metadata
// (endorsement, owner, created date) and lineage (reports -> datasetId). It does NOT return
// relationships or consumption (views/users), so those facets/signals degrade gracefully:
// - no relationships -> rel facet inactive (measure + schema + source still drive similarity);
// - no consumption -> a duplicate can't be called "unused", so it surfaces as "insufficient evidence"
//   until an activity/usage table is layered on. That is the honest, evidence-gated behavior.

import type { Column, Measure, ModelCard, Usage } from "./types";

export interface ScannerColumn {
  name: string;
  dataType?: string;
  isHidden?: boolean;
}
export interface ScannerMeasure {
  name: string;
  expression?: string;
}
export interface ScannerTable {
  name: string;
  columns?: ScannerColumn[];
  measures?: ScannerMeasure[];
  isHidden?: boolean;
}
export interface ScannerRole {
  name?: string;
}
export interface ScannerDataset {
  id: string;
  name: string;
  configuredBy?: string;
  endorsementDetails?: { endorsement?: string; certifiedBy?: string };
  createdDate?: string;
  tables?: ScannerTable[];
  datasourceUsages?: Array<{ datasourceInstanceId?: string }>;
  // RLS role definitions (documented Scanner field) — presence means RLS is configured.
  roles?: ScannerRole[];
  // Documented Scanner health flags: true/set when the scan couldn't confirm or fetch the schema.
  // There is no calculation-group field anywhere in this payload shape, so hasCalcGroups below is
  // always reported as unknown (undefined), never a known false.
  schemaMayNotBeUpToDate?: boolean;
  schemaRetrievalError?: string;
}
export interface ScannerReport {
  id?: string;
  name?: string;
  datasetId?: string;
}
export interface ScannerWorkspace {
  id: string;
  name?: string;
  type?: string;
  state?: string;
  datasets?: ScannerDataset[];
  reports?: ScannerReport[];
}
export interface ScannerDatasourceInstance {
  datasourceType?: string;
  connectionDetails?: { server?: string; database?: string; path?: string; url?: string };
  // The Scanner keys instances by `datasourceId`; a dataset's datasourceUsages reference the same
  // instance by `datasourceInstanceId` (identical GUID, different field name). Accept either.
  datasourceId?: string;
  datasourceInstanceId?: string;
}
export interface ScanResultBody {
  workspaces?: ScannerWorkspace[];
  datasourceInstances?: ScannerDatasourceInstance[];
}

const endorsementOf = (e?: string): Usage["endorsement"] => {
  const t = e?.trim().toLowerCase();
  if (t === "certified") return "Certified";
  if (t === "promoted") return "Promoted";
  return e != null ? "None" : undefined;
};

const SYSTEM_NAME = /usage metrics|report usage/i;

// A composite / DirectQuery-to-dataset model reaches its upstream Power BI semantic model through an
// AnalysisServices datasource whose `server` is a pbiazure/powerbi endpoint and whose `database` is
// the upstream model NAME. (Mirrors the TMDL parser's AnalysisServices.Databases("pbiazure://…")
// detection, so the admin Scanner path recovers the same composite lineage.)
const REMOTE_PBI_SERVER = /pbiazure|powerbi|analysis\.windows\.net/i;
function upstreamModelName(inst?: ScannerDatasourceInstance): string | undefined {
  if (!inst) return undefined;
  const server = inst.connectionDetails?.server ?? "";
  const db = inst.connectionDetails?.database?.trim();
  const isRemoteModel = inst.datasourceType?.toLowerCase() === "analysisservices" || REMOTE_PBI_SERVER.test(server);
  return isRemoteModel && REMOTE_PBI_SERVER.test(server) && db ? db : undefined;
}

export function scannerToModels(body: ScanResultBody): ModelCard[] {
  const instances = new Map<string, ScannerDatasourceInstance>();
  for (const d of body.datasourceInstances ?? []) {
    const key = d.datasourceId ?? d.datasourceInstanceId;
    if (key) instances.set(key, d);
  }

  // Downstream report count per datasetId (lineage from the Scanner's report list).
  const reportCount = new Map<string, number>();
  for (const ws of body.workspaces ?? []) {
    for (const r of ws.reports ?? []) {
      if (r.datasetId) reportCount.set(r.datasetId, (reportCount.get(r.datasetId) ?? 0) + 1);
    }
  }

  const cards: ModelCard[] = [];
  for (const ws of body.workspaces ?? []) {
    if (ws.state && ws.state !== "Active") continue;
    for (const ds of ws.datasets ?? []) {
      const tables = ds.tables ?? [];
      if (tables.length === 0) continue; // default/empty model — nothing to score

      const columns: Column[] = [];
      const measures: Measure[] = [];
      for (const t of tables) {
        for (const c of t.columns ?? []) {
          columns.push({ table: t.name, name: c.name, dataType: c.dataType ?? null, hidden: !!c.isHidden });
        }
        for (const m of t.measures ?? []) measures.push({ name: m.name, dax: m.expression ?? "" });
      }

      const sourcePhysical = new Set<string>();
      const derivedFrom = new Set<string>();
      for (const u of ds.datasourceUsages ?? []) {
        const inst = u.datasourceInstanceId ? instances.get(u.datasourceInstanceId) : undefined;
        const cd = inst?.connectionDetails;
        if (cd?.server) sourcePhysical.add(`${cd.server}\u0000${cd.database ?? ""}`.toLowerCase());
        const up = upstreamModelName(inst);
        if (up) derivedFrom.add(up);
      }

      const usage: Usage = {
        datasetName: ds.name,
        workspaceName: ws.name ?? "",
        datasetId: ds.id,
        workspaceId: ws.id,
        configuredBy: ds.configuredBy,
        endorsement: endorsementOf(ds.endorsementDetails?.endorsement),
        certifiedBy: ds.endorsementDetails?.certifiedBy,
        createdDate: ds.createdDate,
        downstreamReportCount: reportCount.get(ds.id) ?? 0,
        joinConfidence: "high", // authoritative: structure + metadata came from the same scan
      };

      cards.push({
        name: ds.name,
        workspace: ws.name ?? ws.id,
        tables: tables.map((t) => t.name),
        columns,
        measures,
        relationships: [], // Scanner does not return relationships
        sourceLogical: new Set<string>(),
        sourcePhysical,
        hasRls: (ds.roles?.length ?? 0) > 0,
        // The Scanner API's dataset schema has no calculation-group field at all (confirmed against
        // the documented WorkspaceInfoDataset shape) — genuinely unknown, not "false". See the
        // ModelCard.hasCalcGroups comment in engine/types.ts.
        hasCalcGroups: undefined,
        systemGenerated: SYSTEM_NAME.test(ds.name),
        datasetId: ds.id,
        workspaceId: ws.id,
        derivedFrom: derivedFrom.size ? [...derivedFrom] : undefined,
        schemaMayNotBeUpToDate: ds.schemaMayNotBeUpToDate,
        schemaRetrievalError: ds.schemaRetrievalError,
        usage,
      });
    }
  }
  return cards;
}
