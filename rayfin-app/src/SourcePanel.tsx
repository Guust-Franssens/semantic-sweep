import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import type { InputFile } from "@engine/parser";
import { exportWorkspaces, fetchTenantAdminBody, listWorkspaces, type TokenProvider, type WorkspaceInfo } from "./data/fabric";
import { currentAccountEmail, getFabricToken, PbiSignInRequiredError, signInToPbi, signOutFabric } from "./data/fabricAuth";
import type { ScanResult } from "@engine/scan";
import { autoMap, buildUsageRecords, CANONICAL_FIELDS, FIELD_LABELS, parseCsv, type ColumnMapping } from "@engine/usage";
import { runScanAsync, scanScannerAsync } from "./worker/scanClient";
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
  fabricUserEmail?: string;
}

const AZ_CMD_PBI = "az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv";

// Signed-in user's token, re-acquired silently on demand and force-refreshed by the fetch layer on a
// mid-scan 401 (so a long scan doesn't fail once the ~1h token lifetime elapses).
const fabricProvider: TokenProvider = (o) => getFabricToken(o);

// Rayfin edition of the data-source hub. The primary Fabric path signs the user in and acquires a
// Fabric token silently (MSAL) — no paste — then scans the workspaces the user can see, in the
// browser (CORS is open from the deployed origin). A pasted Power BI *admin* token remains as an
// Advanced option for a tenant-wide admin scan. Sample / file / usage-fusion run fully client-side.
export function SourcePanel({ onData, onSample, onLoadUsageDemo, onApplyUsage, onScan, setProgress, toast, fabricUserEmail }: Props) {
  const [tab, setTab] = useState<"fabric" | "folder" | "sample" | "usage">("fabric");
  const [token, setToken] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const usageFileRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [uHeaders, setUHeaders] = useState<string[]>([]);
  const [uRows, setURows] = useState<string[][]>([]);
  const [uMapping, setUMapping] = useState<ColumnMapping>({});

  // Per-user Fabric sign-in (silent MSAL, pbi-fixer pattern).
  const [email, setEmail] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdmin, setShowAdmin] = useState(false);

  // On mount, try to acquire a token silently (works when already consented + cached). If it needs
  // interaction, stay signed-out and show the button — never auto-popup (browsers block that).
  useEffect(() => {
    void getFabricToken()
      .then(() => setEmail(currentAccountEmail()))
      .catch(() => {
        /* PbiSignInRequiredError expected on first visit — show the sign-in button */
      });
  }, []);

  async function doSignIn(): Promise<void> {
    setSigningIn(true);
    try {
      await signInToPbi(fabricUserEmail); // interactive popup — from this click (user gesture)
      setEmail(currentAccountEmail());
      const ws = await listWorkspaces(fabricProvider);
      setWorkspaces(ws);
      setSelected(new Set(ws.map((w) => w.id)));
      toast(`Signed in as ${currentAccountEmail() ?? "you"}. Scanning ${ws.length} workspaces…`, "ok");
      await runExport(ws); // auto-scan everything so the real estate loads on this one click (no second button)
    } catch (e) {
      const msg = e instanceof PbiSignInRequiredError ? "Sign-in was cancelled." : String(e);
      toast(`Sign-in failed: ${msg}. If it says "need admin approval", the app needs a one-time Entra admin consent.`, "err");
    } finally {
      setSigningIn(false);
    }
  }

  async function runExport(chosen: WorkspaceInfo[]): Promise<void> {
    if (chosen.length === 0) return toast("Select at least one workspace.", "err");
    setProgress({ done: 0, total: 0, label: "Connecting…" });
    try {
      const { files, failures } = await exportWorkspaces(fabricProvider, chosen, (done, total, label) =>
        setProgress({ done, total, label }),
      );
      if (files.length === 0) {
        toast(`No models exported. ${failures[0]?.reason ?? "Check the workspaces have semantic models."}`, "err");
      } else {
        setProgress({ done: 0, total: 0, label: "Scoring models…" });
        onScan(await runScanAsync(files), `Fabric · ${chosen.length} workspaces (signed in as ${currentAccountEmail() ?? "you"})`);
        toast(
          `Scanned ${files.length} TMDL parts from ${chosen.length} workspaces.${failures.length ? ` ${failures.length} skipped.` : ""}`,
          "ok",
        );
      }
    } catch (e) {
      toast(`Scan failed: ${String(e)}`, "err");
    } finally {
      setProgress(null);
    }
  }

  async function doSignOut(): Promise<void> {
    try {
      await signOutFabric();
    } catch {
      // ignore
    }
    setEmail(null);
    setWorkspaces([]);
    setSelected(new Set());
    toast("Signed out.", "info");
  }

  async function scanMine(): Promise<void> {
    const chosen = workspaces.filter((w) => selected.has(w.id));
    if (chosen.length === 0) return toast("Select at least one workspace.", "err");
    try {
      await getFabricToken({ interactive: true, loginHint: fabricUserEmail }); // ensure a fresh session (silent if cached)
    } catch (e) {
      return toast(`Session expired, sign in again: ${String(e)}`, "err");
    }
    await runExport(chosen);
  }

  const toggleWs = (id: string): void =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function scanAdmin(): Promise<void> {
    if (!token.trim()) return toast("Paste a Power BI admin token first (see the command).", "err");
    setProgress({ done: 0, total: 0, label: "Connecting…" });
    try {
      const body = await fetchTenantAdminBody(() => Promise.resolve(token), (done, total, label) => setProgress({ done, total, label }));
      setProgress({ done: 0, total: 0, label: "Scoring models…" });
      const scan = await scanScannerAsync(body);
      if (scan.cards.length === 0) {
        toast("Admin scan returned no models: are you a Fabric/Power BI admin?", "err");
      } else {
        onScan(scan, `Fabric tenant · admin scan · ${scan.cards.length} models`);
        toast(`Scanned ${scan.cards.length} models tenant-wide.`, "ok");
      }
    } catch (e) {
      toast(`Admin scan failed: ${String(e)}`, "err");
    } finally {
      setProgress(null);
      setToken(""); // don't retain a tenant-admin token in memory after the call
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
    if (records.length === 0) return toast("No rows have a dataset name: map the 'Dataset / model name' column.", "err");
    onApplyUsage(records);
  }

  return (
    <div className="source-panel">
      <div className="tabs">
        <button className={`tab${tab === "sample" ? " active" : ""}`} onClick={() => setTab("sample")}>
          ✨ Sample
        </button>
        <button className={`tab${tab === "usage" ? " active" : ""}`} onClick={() => setTab("usage")}>
          📊 Usage fusion
        </button>
        <button className={`tab${tab === "fabric" ? " active" : ""}`} onClick={() => setTab("fabric")}>
          🔗 Scan my Fabric
        </button>
        <button className={`tab${tab === "folder" ? " active" : ""}`} onClick={() => setTab("folder")}>
          📁 Open folder / zip
        </button>
      </div>

      {tab === "sample" && (
        <div className="tab-body">
          <div className="hint">Load the built-in demo estate: labeled near-duplicates plus a composite/DirectQuery lineage example (nothing leaves your machine).</div>
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
                      <option value={-1}>(none)</option>
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

      {tab === "fabric" && (
        <div className="tab-body">
          <div className="hint">
            Scan the workspaces <strong>you</strong> can access, sign in with your Fabric identity and the token is
            acquired silently (no paste). Models are exported and scored <strong>in your browser</strong>.
          </div>

          {email ? (
            <div className="row signed-row">
              <span className="signed-in">✓ Signed in as <strong>{email}</strong></span>
              <button className="copy" onClick={() => void doSignOut()}>sign out</button>
            </div>
          ) : (
            <button className="btn primary" onClick={() => void doSignIn()} disabled={signingIn}>
              {signingIn ? "Signing in & scanning…" : "🔐 Sign in & scan my Fabric"}
            </button>
          )}

          {workspaces.length > 0 && (
            <>
              <div className="row">
                <span className="muted">{selected.size}/{workspaces.length} selected</span>
                <button className="copy" onClick={() => setSelected(new Set(workspaces.map((w) => w.id)))}>all</button>
                <button className="copy" onClick={() => setSelected(new Set())}>none</button>
                <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => void scanMine()}>
                  Re-scan {selected.size} selected
                </button>
              </div>
              <div className="ws-list">
                {workspaces.map((w) => (
                  <label className="ws-item" key={w.id}>
                    <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggleWs(w.id)} />
                    {w.displayName}
                  </label>
                ))}
              </div>
            </>
          )}

          <details className="foldout" open={showAdmin} onToggle={(e) => setShowAdmin((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Advanced: tenant-wide admin scan (paste a Power BI admin token)</summary>
            <div className="hint">
              Whole-tenant via the Admin Scanner API (you must be a Fabric/Power BI admin). No app registration or
              consent needed.
              <code>{AZ_CMD_PBI}</code>
              <button className="copy" onClick={() => void navigator.clipboard.writeText(AZ_CMD_PBI)}>copy</button>
            </div>
            <input
              className="field"
              type="password"
              autoComplete="off"
              placeholder="Paste Power BI admin token (eyJ0…)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn" style={{ marginTop: 8 }} onClick={() => void scanAdmin()}>
              Scan whole tenant
            </button>
            <div className="cov-note">
              The token is sent only to <code>api.powerbi.com</code>, never stored, and cleared after the scan.
            </div>
          </details>
        </div>
      )}

      {tab === "folder" && (
        <div className="tab-body">
          <div className="hint">
            Point at an exported <code>models</code> folder, or a <code>.zip</code> of it: parsed and scored entirely
            in your browser. Export with <code>fab export "&lt;ws&gt;.Workspace/&lt;model&gt;.SemanticModel" -o models</code>.
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
    </div>
  );
}
