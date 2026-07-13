// In-browser Microsoft Fabric REST client: enumerate workspaces + semantic models and export
// their TMDL definitions directly from the browser (CORS-verified). No server, no CLI.

import type { InputFile } from "@engine/parser";
import { type ScannerDatasourceInstance, type ScannerWorkspace, type ScanResultBody } from "@engine/scanner";

const BASE = "https://api.fabric.microsoft.com/v1";

export interface WorkspaceInfo {
  id: string;
  displayName: string;
  modelCount?: number;
}
export interface ModelRef {
  id: string;
  displayName: string;
}
export interface ExportFailure {
  workspace: string;
  model: string;
  reason: string;
}
export interface ExportResult {
  files: InputFile[];
  failures: ExportFailure[];
}

const authHeader = (token: string): HeadersInit => ({ Authorization: `Bearer ${token.trim()}` });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A refreshable token source: returns the current access token, or — with { forceRefresh } — mints a
// fresh one via the underlying MSAL silent refresh. A plain "() => Promise.resolve(pastedToken)" is a
// valid (non-refreshable) provider: it just returns the same token, so an expiry surfaces normally.
export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

// A mutable auth session shared by every request in one scan: holds the current token plus a
// *coalesced* forced-refresh, so the 8 concurrent workers all hitting a mid-scan 401 trigger ONE
// silent renewal (not 8 racing STS round-trips) and immediately pick up the new token.
interface Session {
  token: string;
  refresh: () => Promise<string>;
}

async function openSession(provider: TokenProvider): Promise<Session> {
  const s: Session = { token: await provider(), refresh: async () => s.token };
  let inFlight: Promise<string> | null = null;
  s.refresh = () => {
    inFlight ??= Promise.resolve(provider({ forceRefresh: true }))
      .then((t) => {
        s.token = t;
        return t;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return s;
}

// Fetch with backoff+jitter retries for transient failures (429/5xx/408 and network errors), honoring
// Retry-After. At concurrency 8 across a large estate, transient throttling would otherwise become
// permanent "skipped" models. Additionally, on a 401 (token expired mid-scan) it silently renews the
// token ONCE and retries the same request — so a long scan doesn't start failing every remaining
// model as "no access" the moment the ~1h token lifetime elapses. A 403 (genuine authorization
// failure) is NOT retried: it means the identity truly lacks access.
async function authedFetch(s: Session, url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  let renewed = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...init.headers, ...authHeader(s.token) } });
      if (r.status === 401 && !renewed) {
        renewed = true;
        try {
          await s.refresh();
          i--; // the silent renewal shouldn't consume a transient-retry attempt
          continue;
        } catch {
          return r; // no silent renewal possible (refresh token gone / pasted token) — surface the 401
        }
      }
      if ((r.status === 429 || r.status === 408 || (r.status >= 500 && r.status < 600)) && i < attempts - 1) {
        const ra = Number(r.headers.get("Retry-After"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000) + Math.random() * 300);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i >= attempts - 1) throw e;
      await sleep(Math.min(1000 * 2 ** i, 8000) + Math.random() * 300);
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

async function getJson<T>(s: Session, url: string): Promise<T> {
  const r = await authedFetch(s, url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

async function getPaged<T>(s: Session, path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${BASE}${path}`;
  while (url) {
    const data: { value?: T[]; continuationUri?: string } = await getJson(s, url);
    items.push(...(data.value ?? []));
    url = data.continuationUri ?? null;
  }
  return items;
}

export async function listWorkspaces(provider: TokenProvider): Promise<WorkspaceInfo[]> {
  const ws = await getPaged<WorkspaceInfo>(await openSession(provider), "/workspaces");
  return ws.filter((w) => w.displayName).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function listModels(s: Session, workspaceId: string): Promise<ModelRef[]> {
  return getPaged<ModelRef>(s, `/workspaces/${workspaceId}/semanticModels`);
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

interface DefinitionPart {
  path: string;
  payload: string;
  payloadType: string;
}

function cleanReason(raw: string): string {
  const low = raw.toLowerCase();
  if (low.includes("workload failed to export") || low.includes("direct lake") || low.includes("capacity")) {
    return "capacity paused / Direct Lake — model not exportable";
  }
  if (low.includes("forbidden") || low.includes("401") || low.includes("403")) return "no access";
  if (low.includes("timed out")) return "timed out";
  return raw.slice(0, 80);
}

async function getDefinitionParts(s: Session, wsId: string, modelId: string): Promise<DefinitionPart[]> {
  const url = `${BASE}/workspaces/${wsId}/semanticModels/${modelId}/getDefinition?format=TMDL`;
  const resp = await authedFetch(s, url, { method: "POST" });

  // Synchronous success.
  if (resp.ok && resp.status !== 202) {
    const body: { definition?: { parts: DefinitionPart[] } } = await resp.json();
    if (!body?.definition) throw new Error("no definition returned");
    return body.definition.parts;
  }
  if (resp.status !== 202) throw new Error(`${resp.status} ${resp.statusText}`);

  // Long-running operation: poll ONCE per iteration (single fetch), honoring Retry-After, until a
  // terminal state or timeout.
  const opUrl = resp.headers.get("Location");
  if (!opUrl) throw new Error("no operation location");
  let waitMs = (Number(resp.headers.get("Retry-After")) || 2) * 1000;
  for (let i = 0; i < 40; i++) {
    await sleep(Math.min(waitMs, 3000));
    const opResp = await authedFetch(s, opUrl);
    if (!opResp.ok) {
      waitMs = 2000;
      continue;
    }
    waitMs = (Number(opResp.headers.get("Retry-After")) || 2) * 1000;
    const st: { status: string; error?: unknown } = await opResp.json();
    if (st.status === "Succeeded") {
      const body: { definition?: { parts: DefinitionPart[] } } = await getJson(s, `${opUrl}/result`);
      if (!body?.definition) throw new Error("no definition returned");
      return body.definition.parts;
    }
    if (st.status === "Failed" || st.status === "Cancelled") {
      throw new Error(JSON.stringify(st.error ?? st).slice(0, 120));
    }
  }
  throw new Error("getDefinition timed out");
}

export async function exportWorkspaces(
  provider: TokenProvider,
  workspaces: WorkspaceInfo[],
  onProgress: (done: number, total: number, label: string) => void,
): Promise<ExportResult> {
  // One shared session for the whole export: every worker reads s.token, and a single mid-scan 401
  // silently renews it once for all of them (see openSession / authedFetch).
  const s = await openSession(provider);

  // Phase 1 — discover models across ALL workspaces in PARALLEL (concurrency-limited). Previously a
  // sequential per-workspace loop, which was the slow, indeterminate part of the scan.
  const jobs: Array<{ ws: WorkspaceInfo; model: ModelRef }> = [];
  const wsQueue = [...workspaces];
  let scannedWs = 0;
  async function discover(): Promise<void> {
    for (;;) {
      const ws = wsQueue.shift();
      if (!ws) return;
      try {
        for (const model of await listModels(s, ws.id)) jobs.push({ ws, model });
      } catch {
        /* skip workspaces we can't read */
      }
      scannedWs += 1;
      onProgress(0, 0, `Discovering models · ${scannedWs}/${workspaces.length} workspaces`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => discover()));

  const files: InputFile[] = [];
  const failures: ExportFailure[] = [];
  let done = 0;
  const CONCURRENCY = 8;

  async function worker(queue: typeof jobs): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const { ws, model } = job;
      try {
        const parts = await getDefinitionParts(s, ws.id, model.id);
        for (const part of parts) {
          if (part.payloadType === "InlineBase64" && part.path.endsWith(".tmdl")) {
            files.push({
              path: `${ws.displayName}/${model.displayName}.SemanticModel/${part.path}`,
              text: b64ToUtf8(part.payload),
            });
          }
        }
      } catch (e) {
        failures.push({ workspace: ws.displayName, model: model.displayName, reason: cleanReason(String(e)) });
      } finally {
        done += 1;
        onProgress(done, jobs.length, `${model.displayName} · ${ws.displayName}`);
      }
    }
  }

  const queue = [...jobs];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
  return { files, failures };
}

// ---- Whole-tenant admin scan (Admin Scanner API) --------------------------------------------
// Requires a Fabric/Power BI *admin* + a Power BI-audience token. Reads every workspace's model
// structure + governance metadata WITHOUT workspace membership or getDefinition. Lives on the Power
// BI admin host (api.powerbi.com), which may not permit browser CORS — if blocked, a small
// server-side proxy (Rayfin/UDF) is needed.
const PBI_ADMIN = "https://api.powerbi.com/v1.0/myorg/admin";

async function postJson<T>(s: Session, url: string, body: unknown): Promise<T> {
  const r = await authedFetch(s, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// Cheap capability probe: can this signed-in user + app run a WHOLE-TENANT admin scan? The Admin
// Scanner host (api.powerbi.com/.../admin) answers 200 for an admin whose token carries the
// Tenant.Read.All scope, and 401/403 otherwise. We hit its lightest endpoint purely as a permission
// check — if it's available we can scan EVERY model in the tenant (including models on paused
// capacities and workspaces the user isn't a member of), so nothing silently drops out of the estate.
export interface AdminProbe {
  available: boolean; // admin Scanner endpoint returned 200 → tenant-wide scan possible
  status: number; // HTTP status from the probe (0 = network/CORS error)
  reason?: string; // human-readable hint shown in the UI when tenant-wide scan is unavailable
}

// A 401/403 here does NOT necessarily mean "not an admin": the far more common cause (and the case in
// consent-restricted tenants) is that this app hasn't been granted the Power BI `Tenant.Read.All`
// delegated permission, which needs an Entra admin's consent. We can't tell the two apart from the
// browser, so the copy covers both. Any network/CORS error → treat as unavailable (per-user scan).
export async function probeAdminScan(provider: TokenProvider): Promise<AdminProbe> {
  try {
    const token = await provider();
    const r = await fetch(`${PBI_ADMIN}/workspaces/modified?excludePersonalWorkspaces=true`, {
      headers: authHeader(token),
    });
    if (r.ok) return { available: true, status: r.status };
    const reason =
      r.status === 401 || r.status === 403
        ? "Tenant-wide admin scan is unavailable — this app needs the Power BI Tenant.Read.All admin permission (an Entra admin must grant consent), or you must be a Fabric admin. Scanning the workspaces you can access instead."
        : `Admin Scanner API returned ${r.status}. Scanning the workspaces you can access instead.`;
    return { available: false, status: r.status, reason };
  } catch {
    return {
      available: false,
      status: 0,
      reason: "Admin Scanner API is unreachable from the browser. Scanning the workspaces you can access instead.",
    };
  }
}

// Back-compat boolean wrapper for callers that only need yes/no.
export async function isFabricAdmin(provider: TokenProvider): Promise<boolean> {
  return (await probeAdminScan(provider)).available;
}

async function listAllWorkspaceIds(s: Session): Promise<string[]> {
  const rows = await getJson<Array<{ id: string }>>(
    s,
    `${PBI_ADMIN}/workspaces/modified?excludePersonalWorkspaces=true`,
  );
  return rows.map((r) => r.id);
}

async function scanBatch(s: Session, ids: string[]): Promise<{ workspaces?: ScannerWorkspace[]; datasourceInstances?: ScannerDatasourceInstance[] }> {
  const q = "lineage=true&datasourceDetails=true&datasetSchema=true&datasetExpressions=true&getArtifactUsers=false";
  const { id: scanId } = await postJson<{ id: string }>(s, `${PBI_ADMIN}/workspaces/getInfo?${q}`, { workspaces: ids });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await getJson<{ status: string }>(s, `${PBI_ADMIN}/workspaces/scanStatus/${scanId}`);
    if (st.status === "Succeeded") return getJson(s, `${PBI_ADMIN}/workspaces/scanResult/${scanId}`);
    if (st.status === "Failed") throw new Error("admin scan failed");
  }
  throw new Error("admin scan timed out");
}

// Whole-tenant admin *fetch* (no scoring): returns the raw Scanner body so the caller can score it
// off the main thread (see worker/scanClient.scanScannerAsync). Kept fetch-only so the O(n^2)
// scoring never runs on the UI thread for a tenant-sized estate.
export async function fetchTenantAdminBody(
  provider: TokenProvider,
  onProgress: (done: number, total: number, label: string) => void,
): Promise<ScanResultBody> {
  const s = await openSession(provider);
  onProgress(0, 0, "Listing workspaces (admin)…");
  const ids = await listAllWorkspaceIds(s);
  const workspaces: ScannerWorkspace[] = [];
  const datasourceInstances: ScannerDatasourceInstance[] = [];
  let done = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    onProgress(done, ids.length, `Scanning ${done}/${ids.length} workspaces…`);
    const res = await scanBatch(s, batch);
    workspaces.push(...(res.workspaces ?? []));
    datasourceInstances.push(...(res.datasourceInstances ?? []));
    done += batch.length;
  }
  onProgress(ids.length, ids.length, "Parsing models…");
  return { workspaces, datasourceInstances };
}
