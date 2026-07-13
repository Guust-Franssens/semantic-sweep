// In-browser Microsoft Fabric REST client: enumerate workspaces + semantic models and export
// their TMDL definitions directly from the browser (CORS-verified). No server, no CLI.

import type { InputFile } from "@engine/parser";
import { recommendScan, scanCards, type ScanResult } from "@engine/scan";
import { scannerToModels, type ScannerDatasourceInstance, type ScannerWorkspace } from "@engine/scanner";

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

// A refreshable token source: returns the current access token, or — with { forceRefresh } — mints a
// fresh one via the underlying MSAL silent refresh. A plain "() => Promise.resolve(pastedToken)" is a
// valid (non-refreshable) provider: it just returns the same token, so an expiry surfaces normally.
export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A mutable auth session shared by every request in one scan: holds the current token plus a
// *coalesced* forced-refresh, so concurrent workers all hitting a mid-scan 401 trigger ONE silent
// renewal (not N racing STS round-trips) and immediately pick up the new token.
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

// Fetch with backoff+jitter retries for transient failures (429/5xx/408, network errors), honoring
// Retry-After. Additionally, on a 401 (token expired mid-scan) it silently renews the token ONCE and
// retries the same request — so a long scan doesn't start failing every remaining model as "no access"
// the moment the ~1h token lifetime elapses. A 403 (genuine authorization failure) is NOT retried.
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
  if (low.includes("direct lake")) return "Direct Lake — needs an active capacity";
  if (low.includes("capacity")) return "capacity paused / unavailable";
  if (low.includes("forbidden") || low.includes("401") || low.includes("403")) return "no access";
  return raw.slice(0, 80);
}

async function getDefinitionParts(s: Session, wsId: string, modelId: string): Promise<DefinitionPart[]> {
  const url = `${BASE}/workspaces/${wsId}/semanticModels/${modelId}/getDefinition?format=TMDL`;
  let resp = await authedFetch(s, url, { method: "POST" });
  let body: { definition?: { parts: DefinitionPart[] } } | null = null;

  if (resp.status === 202) {
    const opUrl = resp.headers.get("Location");
    if (!opUrl) throw new Error("no operation location");
    for (let i = 0; i < 30; i++) {
      const wait = Number(resp.headers.get("Retry-After") ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait || 2000, 3000)));
      const st: { status: string; error?: unknown } = await getJson(s, opUrl);
      if (st.status === "Succeeded") {
        body = await getJson(s, `${opUrl}/result`);
        break;
      }
      if (st.status === "Failed") throw new Error(JSON.stringify(st.error ?? st).slice(0, 120));
      resp = await authedFetch(s, opUrl); // refresh Retry-After
    }
  } else if (resp.ok) {
    body = await resp.json();
  } else {
    throw new Error(`${resp.status} ${resp.statusText}`);
  }
  if (!body?.definition) throw new Error("no definition returned");
  return body.definition.parts;
}

export async function exportWorkspaces(
  provider: TokenProvider,
  workspaces: WorkspaceInfo[],
  onProgress: (done: number, total: number, label: string) => void,
): Promise<ExportResult> {
  // One shared session for the whole export: every worker reads s.token, and a single mid-scan 401
  // silently renews it once for all of them (see openSession / authedFetch).
  const s = await openSession(provider);

  // Discover models per selected workspace.
  const jobs: Array<{ ws: WorkspaceInfo; model: ModelRef }> = [];
  for (const ws of workspaces) {
    onProgress(0, 0, `Listing models in ${ws.displayName}…`);
    try {
      for (const model of await listModels(s, ws.id)) jobs.push({ ws, model });
    } catch {
      /* skip workspaces we can't read */
    }
  }

  const files: InputFile[] = [];
  const failures: ExportFailure[] = [];
  let done = 0;
  const CONCURRENCY = 4;

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
        onProgress(done, jobs.length, `Exported ${done}/${jobs.length} models…`);
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

async function listAllWorkspaceIds(s: Session): Promise<string[]> {
  const rows = await getJson<Array<{ id: string }>>(s, `${PBI_ADMIN}/workspaces/modified?excludePersonalWorkspaces=true`);
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

export async function scanTenantAdmin(
  provider: TokenProvider,
  onProgress: (done: number, total: number, label: string) => void,
): Promise<ScanResult> {
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
  return recommendScan(scanCards(scannerToModels({ workspaces, datasourceInstances })));
}
