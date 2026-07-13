import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import type { AccountInfo } from "@azure/msal-browser";
import type { InputFile } from "@engine/parser";
import { exportWorkspaces, listWorkspaces, scanTenantAdmin, type TokenProvider, type WorkspaceInfo } from "./data/fabric";
import type { ScanResult } from "@engine/scan";
import {
  acquireToken,
  authConfigured,
  type AuthConfig,
  canSignIn,
  getConfig,
  restoreAccount,
  setConfig,
  signIn,
  signOut,
} from "./data/auth";
import { autoMap, buildUsageRecords, CANONICAL_FIELDS, FIELD_LABELS, parseCsv, type ColumnMapping } from "@engine/usage";
import type { Usage } from "@engine/types";

type Kind = "ok" | "err" | "info";
interface Props {
  onData: (files: InputFile[], label: string) => void;
  onSample: () => void;
  onLoadUsageDemo: () => void;
  onApplyUsage: (records: Usage[]) => void;
  onScan: (scan: ScanResult, label: string) => void;
  setProgress: (p: { done: number; total: number; label: string } | null) => void;
  toast: (msg: string, kind?: Kind) => void;
}

const AZ_CMD = "az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv";
const AZ_CMD_PBI = "az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv";

export function SourcePanel({ onData, onSample, onLoadUsageDemo, onApplyUsage, onScan, setProgress, toast }: Props) {
  const [tab, setTab] = useState<"fabric" | "folder" | "sample" | "usage">("fabric");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingWs, setLoadingWs] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const usageFileRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [uHeaders, setUHeaders] = useState<string[]>([]);
  const [uRows, setURows] = useState<string[][]>([]);
  const [uMapping, setUMapping] = useState<ColumnMapping>({});
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [cfg, setCfg] = useState<AuthConfig>(getConfig());
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    void (async () => {
      const acc = await restoreAccount();
      if (acc) {
        setAccount(acc);
        try {
          setToken(await acquireToken());
        } catch {
          // best-effort silent token restore; the user can click Sign in
        }
      }
    })();
  }, []);

  async function doSignIn(): Promise<void> {
    if (!authConfigured()) {
      setShowSetup(true);
      return toast("Enter your Entra app (client) ID in Sign-in setup first.", "err");
    }
    setSigningIn(true);
    try {
      const { token: t, account: acc } = await signIn();
      setToken(t);
      setAccount(acc);
      toast(`Signed in as ${acc.username}. Fetching workspaces…`, "ok");
      await fetchWorkspaces(t);
    } catch (e) {
      toast(`Sign-in failed: ${String(e)}`, "err");
    } finally {
      setSigningIn(false);
    }
  }

  async function doSignOut(): Promise<void> {
    try {
      await signOut();
    } catch {
      // ignore logout errors
    }
    setAccount(null);
    setToken("");
    setWorkspaces([]);
    setSelected(new Set());
    toast("Signed out.", "info");
  }

  function saveConfig(): void {
    setConfig(cfg);
    setCfg(getConfig());
    toast("Sign-in setup saved. Now click Sign in with Microsoft.", "ok");
  }

  async function fetchWorkspaces(tok: string = token): Promise<void> {
    if (!tok.trim()) return toast("Sign in or paste a Fabric access token first.", "err");
    setLoadingWs(true);
    try {
      const provider: TokenProvider = account ? (o) => acquireToken(o) : () => Promise.resolve(tok);
      const ws = await listWorkspaces(provider);
      setWorkspaces(ws);
      setSelected(new Set(ws.map((w) => w.id)));
      toast(`Found ${ws.length} workspaces. Pick which to scan.`, "ok");
    } catch (e) {
      toast(`Couldn't reach Fabric: ${String(e)}. Is the token valid?`, "err");
    } finally {
      setLoadingWs(false);
    }
  }

  async function scanFabric(): Promise<void> {
    const chosen = workspaces.filter((w) => selected.has(w.id));
    if (chosen.length === 0) return toast("Select at least one workspace.", "err");
    let provider: TokenProvider;
    if (account) {
      try {
        setToken(await acquireToken()); // surface a fresh token + fail early if the session is gone
        provider = (o) => acquireToken(o); // refreshable: the fetch layer renews it on a mid-scan 401
      } catch (e) {
        return toast(`Session expired — sign in again: ${String(e)}`, "err");
      }
    } else {
      provider = () => Promise.resolve(token); // pasted token — can't be renewed
    }
    setProgress({ done: 0, total: 0, label: "Connecting…" });
    try {
      const { files, failures } = await exportWorkspaces(provider, chosen, (done, total, label) =>
        setProgress({ done, total, label }),
      );
      if (files.length === 0) {
        toast(`No models exported. ${failures[0]?.reason ?? "Check capacity is running."}`, "err");
      } else {
        onData(files, `Fabric tenant · ${chosen.length} workspaces (in-browser)`);
        toast(`Scanned live from Fabric.${failures.length ? ` ${failures.length} skipped.` : ""}`, "ok");
      }
    } catch (e) {
      toast(`Export failed: ${String(e)}`, "err");
    } finally {
      setProgress(null);
    }
  }

  async function scanAdmin(): Promise<void> {
    if (!token.trim()) return toast("Paste a Power BI admin token first (see the command).", "err");
    setProgress({ done: 0, total: 0, label: "Connecting…" });
    try {
      const scan = await scanTenantAdmin(() => Promise.resolve(token), (done, total, label) => setProgress({ done, total, label }));
      if (scan.cards.length === 0) {
        toast("Admin scan returned no models — are you a Fabric/Power BI admin?", "err");
      } else {
        onScan(scan, `Fabric tenant · admin scan · ${scan.cards.length} models`);
        toast(`Scanned ${scan.cards.length} models tenant-wide.`, "ok");
      }
    } catch (e) {
      toast(`Admin scan failed: ${String(e)} — the admin API may block browser CORS (needs a proxy).`, "err");
    } finally {
      setProgress(null);
    }
  }

  async function readFolder(list: FileList): Promise<void> {
    const files: InputFile[] = [];
    for (const f of Array.from(list)) {
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (path.endsWith(".tmdl")) files.push({ path, text: await f.text() });
    }
    if (files.length === 0) return toast("No .tmdl files found in that folder.", "err");
    onData(files, "local folder (in-browser)");
    toast(`Loaded ${files.length} TMDL files from folder.`, "ok");
  }

  async function readZip(file: File): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(file);
      const files: InputFile[] = [];
      await Promise.all(
        Object.entries(zip.files).map(async ([path, entry]) => {
          if (!entry.dir && path.endsWith(".tmdl")) files.push({ path, text: await entry.async("string") });
        }),
      );
      if (files.length === 0) return toast("No .tmdl files in that zip.", "err");
      onData(files, `${file.name} (in-browser)`);
      toast(`Loaded ${files.length} TMDL files from ${file.name}.`, "ok");
    } catch (e) {
      toast(`Couldn't read zip: ${String(e)}`, "err");
    }
  }

  function loadUsageText(text: string): void {
    const { headers, rows } = parseCsv(text);
    if (headers.length === 0) return toast("Couldn't read any columns from that CSV.", "err");
    setUHeaders(headers);
    setURows(rows);
    setUMapping(autoMap(headers));
    toast(`Parsed ${rows.length} rows · ${headers.length} columns. Review the mapping, then apply.`, "ok");
  }

  async function readUsageFile(file: File): Promise<void> {
    loadUsageText(await file.text());
  }

  function setField(field: (typeof CANONICAL_FIELDS)[number], idx: number): void {
    setUMapping((m) => ({ ...m, [field]: idx < 0 ? undefined : idx }));
  }

  function applyMapped(): void {
    const records = buildUsageRecords(uRows, uMapping);
    if (records.length === 0) return toast("No rows have a dataset name — map the 'Dataset / model name' column.", "err");
    onApplyUsage(records);
  }

  const toggle = (id: string): void =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="source-panel">
      <div className="tabs">
        <button className={`tab${tab === "fabric" ? " active" : ""}`} onClick={() => setTab("fabric")}>
          🔗 Connect to Fabric
        </button>
        <button className={`tab${tab === "folder" ? " active" : ""}`} onClick={() => setTab("folder")}>
          📁 Open folder / zip
        </button>
        <button className={`tab${tab === "sample" ? " active" : ""}`} onClick={() => setTab("sample")}>
          ✨ Sample
        </button>
        <button className={`tab${tab === "usage" ? " active" : ""}`} onClick={() => setTab("usage")}>
          📊 Usage fusion
        </button>
      </div>

      {tab === "fabric" && (
        <div className="tab-body">
          <div className="hint">
            Scan your tenant directly — models are exported and scored <strong>in your browser</strong>; nothing is uploaded.
          </div>
          <label className="admin-toggle">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Whole-tenant scan
            (admin Scanner API) — no consent needed
          </label>

          {admin && (
            <div className="admin-box">
              <div className="hint">
                Uses the <strong>Admin Scanner API</strong> (you're Fabric Administrator) — reads every workspace's
                models with <strong>no app registration or consent</strong>. Paste a <strong>Power BI</strong> admin
                token:
                <code>{AZ_CMD_PBI}</code>
                <button className="copy" onClick={() => void navigator.clipboard.writeText(AZ_CMD_PBI)}>copy</button>
              </div>
              <textarea
                className="field"
                rows={2}
                placeholder="Paste Power BI admin token (eyJ0…)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void scanAdmin()}>
                Scan whole tenant
              </button>
              <div className="cov-note">
                Structure + governance + lineage; add a usage/activity table for consumption. If the browser blocks
                the admin API (CORS), this needs the small server-side proxy (Rayfin/UDF).
              </div>
            </div>
          )}

          {!admin && (
            <>
          {account ? (
            <div className="row signed-row">
              <span className="signed-in">✓ Signed in as <strong>{account.username}</strong></span>
              <button className="copy" onClick={() => void doSignOut()}>sign out</button>
            </div>
          ) : canSignIn() ? (
            <button className="btn primary" onClick={() => void doSignIn()} disabled={signingIn}>
              {signingIn ? "Signing in…" : "🔐 Sign in with Microsoft"}
            </button>
          ) : (
            <div className="hint warn">
              Sign-in needs the app served over http(s) (<code>npm run dev</code> or a host). From a downloaded file,
              use “paste a token” below.
            </div>
          )}

          <details
            className="foldout"
            open={showSetup}
            onToggle={(e) => setShowSetup((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>⚙ Sign-in setup (Entra app — one-time)</summary>
            <div className="hint">
              Register an Entra app as a <strong>Single-page application</strong> with redirect URI{" "}
              <code>{location.origin}</code>, grant a delegated Fabric permission, then paste its IDs:
            </div>
            <label className="cfg-row">
              <span>Client ID</span>
              <input
                className="field"
                value={cfg.clientId}
                onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </label>
            <label className="cfg-row">
              <span>Tenant</span>
              <input
                className="field"
                value={cfg.tenant}
                onChange={(e) => setCfg({ ...cfg, tenant: e.target.value })}
                placeholder="organizations · common · or tenant GUID"
              />
            </label>
            <button className="btn" style={{ marginTop: 8 }} onClick={saveConfig}>Save setup</button>
          </details>

          <details className="foldout">
            <summary>Advanced: paste a token instead</summary>
            <div className="hint">
              <code>{AZ_CMD}</code>
              <button className="copy" onClick={() => void navigator.clipboard.writeText(AZ_CMD)}>copy</button>
            </div>
            <textarea
              className="field"
              rows={2}
              placeholder="Paste access token (eyJ0…)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </details>

          <div className="row">
            <button className="btn" onClick={() => void fetchWorkspaces()} disabled={loadingWs}>
              {loadingWs ? "Fetching…" : "Fetch workspaces"}
            </button>
            {workspaces.length > 0 && (
              <>
                <span className="muted">{selected.size}/{workspaces.length} selected</span>
                <button className="copy" onClick={() => setSelected(new Set(workspaces.map((w) => w.id)))}>all</button>
                <button className="copy" onClick={() => setSelected(new Set())}>none</button>
                <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => void scanFabric()}>
                  Scan {selected.size} workspaces
                </button>
              </>
            )}
          </div>
          {workspaces.length > 0 && (
            <div className="ws-list">
              {workspaces.map((w) => (
                <label className="ws-item" key={w.id}>
                  <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                  {w.displayName}
                </label>
              ))}
            </div>
          )}
            </>
          )}
        </div>
      )}

      {tab === "folder" && (
        <div className="tab-body">
          <div className="hint">
            Point at your exported <code>models</code> folder, or a <code>.zip</code> of it — parsed and scored
            entirely in your browser. Export with <code>fab export "&lt;ws&gt;.Workspace/&lt;model&gt;.SemanticModel" -o models</code>.
          </div>
          <div className="row">
            <button className="btn" onClick={() => folderRef.current?.click()}>Choose folder…</button>
            <button className="btn" onClick={() => zipRef.current?.click()}>Choose .zip…</button>
          </div>
          <input
            ref={folderRef}
            type="file"
            style={{ display: "none" }}
            // @ts-expect-error non-standard directory attributes
            webkitdirectory=""
            directory=""
            multiple
            onChange={(e) => e.target.files && void readFolder(e.target.files)}
          />
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && void readZip(e.target.files[0])}
          />
        </div>
      )}

      {tab === "sample" && (
        <div className="tab-body">
          <div className="hint">Load the built-in brewery control set — a labeled near-duplicate demo (no data leaves your machine).</div>
          <button className="btn primary" onClick={onSample}>Load sample estate</button>
        </div>
      )}

      {tab === "usage" && (
        <div className="tab-body">
          <div className="hint">
            Fuse a usage / metadata table (PBI Scanner API + activity log + refresh-history shape) with the similarity
            scan → decommission-grade recommendations. Everything stays in your browser.
          </div>
          <button className="btn primary" onClick={onLoadUsageDemo}>▶ Load usage demo estate</button>
          <div className="usage-or">or bring your own metadata table (CSV)</div>
          <div className="row">
            <button className="btn" onClick={() => usageFileRef.current?.click()}>Choose CSV…</button>
            <button className="btn" onClick={() => loadUsageText(pasteText)} disabled={!pasteText.trim()}>
              Parse pasted CSV
            </button>
          </div>
          <textarea
            className="field"
            rows={3}
            placeholder="…or paste CSV here (a header row + data rows)"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <input
            ref={usageFileRef}
            type="file"
            accept=".csv,.tsv,.txt"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && void readUsageFile(e.target.files[0])}
          />
          {uHeaders.length > 0 && (
            <>
              <div className="mapper">
                {CANONICAL_FIELDS.map((f) => (
                  <label className="map-row" key={f}>
                    <span className="map-label">{FIELD_LABELS[f]}</span>
                    <select value={uMapping[f] ?? -1} onChange={(e) => setField(f, Number(e.target.value))}>
                      <option value={-1}>— none —</option>
                      {uHeaders.map((h, idx) => (
                        <option key={idx} value={idx}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <button className="btn primary" style={{ marginTop: 10 }} onClick={applyMapped}>
                Apply usage to current estate
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
