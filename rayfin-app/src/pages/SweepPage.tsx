import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Boxes,
  ClipboardList,
  DatabaseZap,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  type LucideIcon,
  Moon,
  RefreshCw,
  ScanSearch,
  Shield,
  Sun,
  Trash2,
  Users,
} from "lucide-react";
import type { InputFile } from "@engine/parser";
import type { ExportFailure } from "../data/fabric";
import { runScan, type CompositeLink, type ScanResult } from "@engine/scan";
import { enrichScanWithUsageAsync, runScanAsync } from "../worker/scanClient";
import { CLUSTER_BANDS, DUPLICATE_BANDS, organicClusters } from "@engine/index";
import type { ModelCard, PairResult, Usage } from "@engine/types";
import { modelId } from "@engine/types";
import { sampleFiles } from "../sample";
import { usageDemoScan } from "../usageDemo";
import { SourcePanel } from "../SourcePanel";
import { ConnectGate } from "../ConnectGate";
import {
  Buckets,
  Chains,
  Clusters,
  Insights,
  LegendBar,
  ModelDrawer,
  ReviewTable,
  Toaster,
  Toolbar,
  UsageSummary,
  WhyDrawer,
  Worklist,
} from "../components";
import { Heatmap } from "../Heatmap";
import { useAuth } from "@/hooks/AuthContext";
import { Avatar, Card, cn, StatCard } from "../ui";
import {
  deleteScan,
  listScans,
  loadLatest,
  loadScan as loadSavedScan,
  saveScan,
  type SaveScanMeta,
  type ScanSummary,
} from "../data/scanStore";
import { isLocalBackend } from "../services/rayfinClient";
import { fabricProvider, scanFabricEstate } from "../data/fabricScan";
import { getFabricToken, signInToPbi } from "../data/fabricAuth";
import { modeChipLabel } from "../scanModeLabels";
import "../theme.css";

const SEED_PREFIX = "SS_DEMO";
// Subset/trimmed-copy pairs now surface as consolidation candidates, not review rows.
const REVIEW_BANDS = ["needs-review", "related-source"];

type View = "overview" | "consolidation" | "map" | "review" | "connect";
const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "consolidation", label: "Consolidation", icon: GitMerge },
  { id: "map", label: "Similarity map", icon: LayoutGrid },
  { id: "review", label: "Review & lifecycle", icon: ClipboardList },
  { id: "connect", label: "Connect data", icon: DatabaseZap },
];

function buildLabels(cards: ModelCard[], anonymize: boolean): Map<string, string> {
  const labels = new Map<string, string>();
  let n = 0;
  for (const c of cards) {
    if (!anonymize || c.workspace.startsWith(SEED_PREFIX)) labels.set(modelId(c), `${c.name} · ${c.workspace}`);
    else {
      n += 1;
      labels.set(modelId(c), `Model ${String(n).padStart(2, "0")} · Workspace ${String(n).padStart(2, "0")}`);
    }
  }
  return labels;
}

function setTheme(dark: boolean): void {
  const el = document.documentElement;
  el.classList.toggle("dark", dark);
  el.setAttribute("data-theme", dark ? "dark" : "light");
}

// Classify how a scored ScanResult reached loadScan(), purely from its human label, so the saved-scan
// history can show a small mode chip without threading an extra argument through every call site.
function modeFromLabel(label: string): string {
  if (/admin scan/i.test(label)) return "admin";
  if (/^fabric/i.test(label)) return "tenant";
  return "scan";
}

// The persistent "scan scope" badge shown in the topbar. Derived from the estate's source label so it
// survives an auto-restore from the DB (where ConnectGate never mounts) — that's the only place a
// returning user can see whether the loaded estate is a whole-tenant admin scan, a per-user scan of
// their own workspaces, sample data, or an imported file.
function scanScope(source: string): { label: string; Icon: LucideIcon; tone: "admin" | "user" | "neutral"; title: string } {
  if (/admin scan/i.test(source)) {
    return { label: "Tenant-wide admin scan", Icon: Shield, tone: "admin", title: "Scanned every model across the tenant via the Admin Scanner API, includes models on paused capacities." };
  }
  if (/^fabric/i.test(source)) {
    return { label: "Per-user scan", Icon: Users, tone: "user", title: "Scanned the workspaces you can access. Models on paused capacities may be skipped. A tenant-wide admin scan (Power BI Tenant.Read.All, Entra admin consent) reads every model regardless of capacity." };
  }
  if (/demo|sample|usage demo/i.test(source)) {
    return { label: "Sample data", Icon: Boxes, tone: "neutral", title: "Embedded demo estate, not your Fabric tenant." };
  }
  return { label: "Imported file", Icon: Boxes, tone: "neutral", title: "Scored from an uploaded TMDL/zip export." };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Full-screen splash shown while the last saved scan is being pulled from the managed DB on open, so
// ConnectGate (with its own silent auto-scan) never flashes before the restore resolves.
function RestoreSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground font-sans">
      <style>{`@keyframes ss-indet{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}.ss-indet{animation:ss-indet 1.05s ease-in-out infinite}`}</style>
      <div className="w-full max-w-[380px] text-center">
        <div
          className="mx-auto flex items-center justify-center rounded-2xl text-white"
          style={{ width: 56, height: 56, background: "linear-gradient(135deg,#0f6cbd,#3b82f6)" }}
        >
          <ScanSearch size={28} />
        </div>
        <div className="mt-[16px] text-[15px] font-bold">Restoring your last scan…</div>
        <div className="mx-auto mt-[14px] h-[8px] w-[220px] overflow-hidden rounded-full bg-secondary">
          <div className="ss-indet h-full w-[38%] rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}

// Saved-scan history (managed-DB persistence, imp-c1). Restoring a row re-hydrates the full estate in
// one query; the active row is highlighted. Delete removes the header + its chunk rows.
function SavedScansPanel({
  scans,
  activeId,
  saving,
  onRestore,
  onDelete,
}: {
  scans: ScanSummary[];
  activeId: string | null;
  saving: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (scans.length === 0 && !saving) return null;
  return (
    <div className="mt-[26px]">
      <div className="mb-[8px] flex items-center gap-[8px]">
        <h2 className="text-[15px] font-bold text-foreground">Saved scans</h2>
        {saving && <span className="text-[12px] text-muted-foreground">saving…</span>}
      </div>
      <p className="mb-[10px] text-[13px] text-muted-foreground">
        Scans are saved to your own Fabric workspace and restored automatically when you return; pick an earlier one below.
      </p>
      <div className="space-y-[8px]">
        {scans.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={cn(
                "flex flex-wrap items-center gap-x-[10px] gap-y-[4px] rounded-xl border p-[12px] text-[13px]",
                active ? "border-primary bg-[#0f6cbd0f]" : "border-border bg-card",
              )}
            >
              <button
                className="font-bold text-primary hover:underline disabled:no-underline disabled:text-muted-foreground"
                onClick={() => onRestore(s.id)}
                disabled={active}
                title={active ? "Currently loaded" : "Restore this scan"}
              >
                {s.label}
              </button>
              <span className="rounded-md px-[6px] py-[1px] text-[10.5px] font-semibold uppercase" style={{ background: "#5c6b781f", color: "#5c6b78" }}>{modeChipLabel(s.mode)}</span>
              {active && <span className="rounded-md px-[6px] py-[1px] text-[10.5px] font-semibold" style={{ background: "#0f6cbd1f", color: "#0f6cbd" }}>loaded</span>}
              {s.usageLoaded && <span className="rounded-md px-[6px] py-[1px] text-[10.5px] font-semibold" style={{ background: "#0e700e1f", color: "#0e700e" }}>usage</span>}
              <span className="text-muted-foreground">
                {s.models} models · {s.clusters} cluster{s.clusters === 1 ? "" : "s"} · {s.chains} chain{s.chains === 1 ? "" : "s"}
              </span>
              <span className="ml-auto text-[11.5px] text-muted-foreground">{formatWhen(s.scannedAt)}</span>
              <button
                className="text-muted-foreground hover:text-[#a4262c]"
                onClick={() => onDelete(s.id)}
                title="Delete this saved scan"
                aria-label={`Delete saved scan "${s.label}"`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ViewHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-[18px]">
      <h1 className="text-[26px] font-bold leading-tight text-foreground">{title}</h1>
      <p className="mt-[4px] text-[13.5px] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

// Warns that some models couldn't be scored (almost always a PAUSED CAPACITY) so they never silently
// vanish — an admin might otherwise conclude a workspace is clean when it simply wasn't scanned.
// Composite / chained models: an explicit "built on" link (DirectQuery to another dataset) — high
// confidence, intentional reuse of a golden dataset, distinct from coincidental duplication.
function CompositeSection({ links, onModel }: { links: CompositeLink[]; onModel: (c: ModelCard) => void }) {
  if (links.length === 0) return null;
  return (
    <>
      <h2 className="mb-[8px] text-[15px] font-bold text-foreground">Composite &amp; derived models</h2>
      <p className="mb-[10px] text-[13px] text-muted-foreground">
        Models built on another dataset via <b>DirectQuery</b>: an explicit, intentional link (reuse of a shared/golden dataset), not a coincidental duplicate.
      </p>
      <div className="space-y-[8px]">
        {links.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-[8px] rounded-xl border border-border bg-card p-[12px] text-[13px]">
            <button className="font-bold text-primary hover:underline" onClick={() => onModel(l.from)}>{l.from.name}</button>
            <span className="text-muted-foreground">· {l.from.workspace}</span>
            <span className="rounded-md px-[7px] py-[1px] text-[11px] font-semibold" style={{ background: "#8764b81f", color: "#8764b8" }}>🔗 built on</span>
            {l.to ? (
              <button className="font-bold text-primary hover:underline" onClick={() => onModel(l.to as ModelCard)}>{l.to.name}</button>
            ) : (
              <>
                <span className="font-bold text-foreground">{l.toName}</span>
                <span className="text-[11px] text-muted-foreground">(source not in this scan)</span>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function SkippedBanner({ skipped }: { skipped: ExportFailure[] }) {
  const [open, setOpen] = useState(false);
  if (skipped.length === 0) return null;
  const byReason = new Map<string, ExportFailure[]>();
  for (const f of skipped) {
    const arr = byReason.get(f.reason) ?? [];
    arr.push(f);
    byReason.set(f.reason, arr);
  }
  return (
    <div className="mb-[16px] rounded-xl border border-[#d9a441] bg-[#d9a4411f] px-[16px] py-[12px]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-[8px] text-left text-[13px] font-bold text-[#b47500]">
        <span>⚠︎ {skipped.length} model{skipped.length > 1 ? "s" : ""} skipped, not scored</span>
        <span className="ml-auto text-[12px] font-semibold">{open ? "hide" : "show details"}</span>
      </button>
      {open && (
        <div className="mt-[10px] space-y-[8px] text-[12px]">
          {[...byReason.entries()].map(([reason, items]) => (
            <div key={reason}>
              <div className="font-semibold text-[#b47500]">{reason} ({items.length})</div>
              <div className="mt-[1px] text-muted-foreground">
                {items.slice(0, 10).map((i) => `${i.model} · ${i.workspace}`).join(", ")}
                {items.length > 10 ? ` +${items.length - 10} more` : ""}
              </div>
            </div>
          ))}
          <div className="text-muted-foreground">
            Most skips are <b>paused capacities</b>, resume the capacity (Fabric/Azure portal) to include them. A
            {" "}<b>tenant-wide admin scan</b> reads every model regardless of capacity, but needs this app granted the
            {" "}Power BI <b>Tenant.Read.All</b> permission (an Entra admin must consent).
          </div>
        </div>
      )}
    </div>
  );
}

export function SweepPage() {
  const { user, signOut, fabricAuthEnabled } = useAuth();
  const userId = user?.id ?? null;
  // DB persistence is only meaningful against the deployed managed backend with a real Entra session
  // (JWT sub → user_id row policy). Local preview / mock backend get no persistence.
  const persistEnabled = fabricAuthEnabled && !isLocalBackend() && !!userId;
  const [view, setView] = useState<View>("overview");
  const [dark, setDark] = useState(false);
  const [connected, setConnected] = useState(false);
  const [skipped, setSkipped] = useState<ExportFailure[]>([]);
  const [scan, setScan] = useState<ScanResult>(() => runScan(sampleFiles));
  const [source, setSource] = useState("embedded demo control set");
  const [anonymize, setAnonymize] = useState(false);
  const [why, setWhy] = useState<PairResult | null>(null);
  const [model, setModel] = useState<ModelCard | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [activeBands, setActiveBands] = useState<Set<string>>(new Set(REVIEW_BANDS));
  const [includeLifecycle, setIncludeLifecycle] = useState(false);
  const [search, setSearch] = useState("");
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const toastId = useRef(0);
  // Persistence (imp-c1): auto-restore the last scan on open; auto-save real scans afterward.
  const [restoring, setRestoring] = useState(persistEnabled);
  const [savedScans, setSavedScans] = useState<ScanSummary[]>([]);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const restoreTried = useRef(false);

  function toast(msg: string, kind: string = "info"): void {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }

  // On open: pull the most recent saved scan (if any) before ConnectGate can mount, so returning to
  // the app lands you straight on your estate. Best-effort — any failure falls through to ConnectGate.
  useEffect(() => {
    if (!persistEnabled || !userId || restoreTried.current) {
      setRestoring(false);
      return;
    }
    restoreTried.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const latest = await loadLatest(userId);
        if (!cancelled && latest) {
          setScan(latest.scan);
          setSource(latest.summary.source || latest.summary.label);
          setActiveScanId(latest.summary.id);
          setConnected(true);
          toast(`Restored your last scan · ${latest.summary.models} models`, "ok");
        }
        const list = await listScans(userId).catch(() => []);
        if (!cancelled) setSavedScans(list);
      } catch {
        /* restore is best-effort — fall through to the connect gate */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistEnabled, userId]);

  // Fire-and-forget save of a real (non-sample) scan to the managed DB. Optionally supersedes a prior
  // row (used when usage fusion re-saves the current estate rather than accumulating a new entry).
  async function persistScan(next: ScanResult, meta: SaveScanMeta, replaceId?: string): Promise<void> {
    if (!persistEnabled || !userId) return;
    setSaving(true);
    try {
      const id = await saveScan(next, meta, userId);
      setActiveScanId(id);
      if (replaceId && replaceId !== id) await deleteScan(replaceId).catch(() => undefined);
      const list = await listScans(userId).catch(() => []);
      setSavedScans(list);
    } catch (e) {
      toast(`Couldn't save scan: ${String(e).replace(/^Error:\s*/, "").slice(0, 120)}`, "err");
    } finally {
      setSaving(false);
    }
  }

  async function restoreScan(id: string): Promise<void> {
    if (!userId) return;
    const s = await loadSavedScan(id).catch(() => null);
    if (!s) {
      toast("Couldn't load that saved scan.", "err");
      return;
    }
    const summary = savedScans.find((x) => x.id === id);
    setScan(s);
    setSource(summary?.source || summary?.label || "saved scan");
    setActiveScanId(id);
    setModel(null);
    setWhy(null);
    setView("overview");
    setConnected(true);
    toast("Saved scan restored.", "ok");
  }

  async function removeScan(id: string): Promise<void> {
    if (!userId) return;
    await deleteScan(id).catch(() => undefined);
    const list = await listScans(userId).catch(() => []);
    setSavedScans(list);
    if (activeScanId === id) setActiveScanId(null);
    toast("Saved scan deleted.", "ok");
  }

  async function loadFiles(files: InputFile[], label: string, persist = true): Promise<void> {
    const next = await runScanAsync(files);
    setScan(next);
    setSource(label);
    setSkipped([]);
    setModel(null);
    setWhy(null);
    setView("overview");
    setConnected(true);
    if (persist) void persistScan(next, { label, mode: "zip", source: label });
  }

  function loadScan(next: ScanResult, label: string, skip: ExportFailure[] = []): void {
    setScan(next);
    setSource(label);
    setSkipped(skip);
    setModel(null);
    setWhy(null);
    setView("overview");
    setConnected(true);
    void persistScan(next, { label, mode: modeFromLabel(label), source: label });
  }

  // Re-scan the LIVE Fabric estate in place (without dropping back to the connect gate). Reuses the
  // exact same orchestration as first-run — tenant-wide admin scan when available, else per-user — and
  // saves the fresh snapshot as a new saved scan, so returning restores the latest.
  async function rescan(): Promise<void> {
    if (rescanning) return;
    setRescanning(true);
    setProgress({ done: 0, total: 0, label: "Starting re-scan…" });
    try {
      // Ensure a live token: silent (cached) first, then an interactive popup from THIS click (a real
      // user gesture, so the AAD popup is allowed) only if the silent refresh fails.
      try {
        await getFabricToken();
      } catch {
        await signInToPbi(user?.email);
      }
      const outcome = await scanFabricEstate(fabricProvider, (done, total, label) => setProgress({ done, total, label }));
      setScan(outcome.result);
      setSource(outcome.label);
      setSkipped(outcome.skipped);
      setModel(null);
      setWhy(null);
      setView("overview");
      setConnected(true);
      void persistScan(outcome.result, { label: outcome.label, mode: modeFromLabel(outcome.label), source: outcome.label });
      toast(`Re-scanned · ${outcome.result.cards.length} models${outcome.skipped.length ? ` · ${outcome.skipped.length} skipped` : ""}.`, "ok");
    } catch (e) {
      toast(`Re-scan failed: ${String(e).replace(/^Error:\s*/, "").slice(0, 140)}`, "err");
    } finally {
      setRescanning(false);
      setProgress(null);
    }
  }

  function loadUsageDemo(): void {
    const s = usageDemoScan();
    setScan(s);
    setSource("usage demo estate");
    setSkipped([]);
    setModel(null);
    setWhy(null);
    setView("consolidation");
    setConnected(true);
    toast(`Loaded usage demo · ${s.recommendations?.length ?? 0} recommendations across ${s.clusters.length} cluster(s).`, "ok");
  }

  async function applyUsage(records: Usage[]): Promise<void> {
    const enriched = await enrichScanWithUsageAsync(scan, records);
    setScan(enriched);
    setModel(null);
    setWhy(null);
    const jr = enriched.joinReport;
    const recN = enriched.recommendations?.length ?? 0;
    if (!jr || jr.matched === 0) {
      toast("No models in the current estate matched the usage table (check identity columns).", "err");
    } else {
      setView("consolidation");
      toast(`Matched ${jr.matched} model(s) to usage${jr.ambiguous ? `, ${jr.ambiguous} ambiguous` : ""} → ${recN} recommendation(s).`, "ok");
      // Re-save the current estate with usage fused, superseding the pre-fusion row.
      void persistScan(enriched, { label: `${source} · usage fused`, mode: "usage", source }, activeScanId ?? undefined);
    }
  }

  const labels = useMemo(() => buildLabels(scan.cards, anonymize), [scan, anonymize]);
  const systemGenerated = useMemo(() => scan.cards.filter((c) => c.systemGenerated), [scan]);
  // Duplicate pairs that were diverted into promotion chains because they are the SAME model across
  // dev/test/prod. Counted so the estate never looks like they silently vanished, and re-clusterable
  // via the Consolidation toggle (includeLifecycle) when the user wants to treat them as duplicates.
  const lifecycleDupCount = useMemo(
    () => scan.pairs.filter((p) => p.lifecycle && DUPLICATE_BANDS.has(p.band)).length,
    [scan],
  );
  // Duplicate-band pairs held out of the worklist solely because a member is system-generated (Usage
  // Metrics, default datasets). They aren't consolidation targets, but hiding them entirely makes the
  // tool look like it "missed" obvious clones (e.g. Report Usage Metrics Model ×3), so we surface them
  // in the excluded-buckets view for transparency (imp-a7). Lifecycle/composite dupes are shown
  // elsewhere (chains / composite section), so exclude those here to avoid double-listing.
  const excludedSystemDupes = useMemo(
    () =>
      scan.pairs.filter(
        (p) => CLUSTER_BANDS.has(p.band) && !p.lifecycle && !p.composite && (p.a.systemGenerated || p.b.systemGenerated),
      ),
    [scan],
  );
  const displayClusters = useMemo(
    () => (includeLifecycle ? organicClusters(scan.cards, scan.pairs, true) : scan.clusters),
    [scan, includeLifecycle],
  );
  const reviewPairs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scan.pairs.filter((p) => {
      if (!activeBands.has(p.band)) return false;
      if (!q) return true;
      return (modelId(p.a) + modelId(p.b)).toLowerCase().includes(q);
    });
  }, [scan, activeBands, search]);

  const usageOn = !!(scan.usageLoaded && scan.recommendations);
  const retire = usageOn ? scan.recommendations!.filter((r) => r.action === "retirement-candidate").length : 0;
  const s = {
    models: scan.cards.length,
    pairs: scan.pairs.length,
    clusters: displayClusters.length,
    chains: scan.chains.length,
    systemGenerated: systemGenerated.length,
    review: scan.pairs.filter((p) => REVIEW_BANDS.includes(p.band)).length,
    composite: scan.compositeLinks?.length ?? 0,
  };

  const toggleBand = (b: string): void =>
    setActiveBands((s2) => {
      const n = new Set(s2);
      if (n.has(b)) n.delete(b);
      else n.add(b);
      return n;
    });

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  // Hero row = the four numbers a customer acts on (it always fills one clean row). Engine-internal
  // and excluded/context counts drop to a muted strip below, instead of orphaning a 7th StatCard onto
  // a second row and stretching every sibling card with dead vertical space.
  const contextBits: string[] = [
    `${s.pairs.toLocaleString()} pairs scored`,
    `${s.systemGenerated} system-generated`,
  ];
  if (s.composite > 0) contextBits.push(`${s.composite} composite / derived`);
  if (usageOn) contextBits.push(`${s.chains} promotion chain${s.chains === 1 ? "" : "s"}`);

  const statCards = (
    <>
      <section className="grid grid-cols-2 gap-[12px] md:grid-cols-4">
        <StatCard icon={Boxes} value={s.models} label="Models scanned" tint="#0f6cbd" />
        <StatCard icon={Layers} value={s.clusters} label="Duplicate clusters" tint="#0f6cbd" accent />
        <StatCard icon={ClipboardList} value={s.review} label="Needs review" tint="#bc4b09" accent />
        {usageOn ? (
          <StatCard icon={Trash2} value={retire} label="Retirement candidates" tint="#0e700e" accent />
        ) : (
          <StatCard icon={GitBranch} value={s.chains} label="Promotion chains" tint="#8764b8" />
        )}
      </section>
      <div className="mt-[10px] flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[12px] text-muted-foreground">
        {contextBits.map((b, i) => (
          <span key={b} className="flex items-center gap-[8px]">
            {i > 0 && <span className="opacity-40">·</span>}
            {b}
          </span>
        ))}
      </div>
    </>
  );

  if (restoring) return <RestoreSplash />;

  if (!connected) {
    return (
      <ConnectGate
        onScan={loadScan}
        onSample={() => void loadFiles(sampleFiles, "embedded demo control set", false)}
        loginHint={user?.email}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
      {/* Sidebar */}
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-border bg-secondary">
        <div className="flex items-center gap-[11px] px-[16px] py-[16px]">
          <span
            className="flex items-center justify-center rounded-xl text-white"
            style={{ width: 34, height: 34, background: "linear-gradient(135deg,#0f6cbd,#3b82f6)" }}
          >
            <ScanSearch size={19} />
          </span>
          <div>
            <div className="text-[16px] font-bold leading-none">semantic-sweep</div>
            <div className="mt-[3px] text-[11px] text-muted-foreground">duplicate model finder</div>
          </div>
        </div>

        <nav className="flex flex-col gap-[2px] px-[10px]">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={cn(
                "flex items-center gap-[11px] rounded-lg px-[11px] py-[9px] text-left text-[13.5px] font-semibold transition-colors",
                view === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-auto p-[12px]">
          <Card className="p-[12px] text-[12px] text-muted-foreground">
            <div>Current estate</div>
            <div className="mt-[2px] truncate text-[13px] font-bold text-foreground" title={source}>{source}</div>
            <div className="mt-[6px] flex items-center gap-[6px] text-[11px]">
              <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: "#22a565" }} />
              {s.models} models · {s.pairs} pairs
            </div>
            {persistEnabled && (
              <div className="mt-[5px] flex items-center gap-[6px] text-[11px]" title="Scans are saved to your Fabric workspace and restored on your next visit.">
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: saving ? "#d9a441" : activeScanId ? "#0f6cbd" : "#8a94a0" }} />
                {saving ? "saving…" : activeScanId ? "saved to your workspace" : "not saved yet"}
              </div>
            )}
          </Card>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-border px-[22px]">
          <div className="text-[13px] text-muted-foreground">
            semantic-sweep · <b className="text-foreground">{NAV.find((n) => n.id === view)?.label}</b>
            {usageOn && <span className="ml-[8px] rounded-md bg-[#0f6cbd1f] px-[7px] py-[1px] text-[11px] font-semibold text-primary">usage fused</span>}
            {(() => {
              const sc = scanScope(source);
              const tone =
                sc.tone === "admin"
                  ? "border-[#2f9e6b55] bg-[#22a5651a] text-[#1a7f52]"
                  : sc.tone === "user"
                    ? "border-[#d9a44155] bg-[#d9a4411a] text-[#b47500]"
                    : "border-border bg-card text-muted-foreground";
              return (
                <span
                  title={sc.title}
                  className={cn("ml-[8px] inline-flex cursor-help items-center gap-[5px] rounded-md border px-[7px] py-[2px] text-[11px] font-semibold", tone)}
                >
                  <sc.Icon size={12} /> {sc.label}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-[12px]">
            {fabricAuthEnabled && !isLocalBackend() && (
              <button
                onClick={() => void rescan()}
                disabled={rescanning}
                title="Re-scan your live Fabric estate now, replaces the current view with a fresh scan and saves it."
                className="flex items-center gap-[6px] rounded-lg border border-border bg-card px-[11px] py-[7px] text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                <RefreshCw size={14} className={rescanning ? "animate-spin" : ""} /> {rescanning ? "Re-scanning…" : "Re-scan"}
              </button>
            )}
            <label className="flex cursor-pointer items-center gap-[6px] text-[12px] text-muted-foreground">
              <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} /> anonymize
            </label>
            <button
              onClick={() => { const d = !dark; setDark(d); setTheme(d); }}
              title="Toggle theme"
              className="flex items-center justify-center rounded-lg border border-border bg-card p-[8px] text-muted-foreground hover:text-foreground"
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {user && <Avatar name={user.name || user.email} size={30} />}
            {user && (
              <button onClick={() => void signOut()} className="text-[12px] text-muted-foreground hover:text-foreground">
                sign out
              </button>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto px-[24px] py-[22px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="mx-auto max-w-[1200px]"
            >
              {view === "overview" && (
                <>
                  <ViewHeader title="Estate overview" subtitle="Near-duplicate semantic models across your estate: decision support, not auto-deletion." />
                  <SkippedBanner skipped={skipped} />
                  {usageOn ? <UsageSummary recs={scan.recommendations!} /> : <Insights clusters={displayClusters} chains={scan.chains} composite={scan.compositeLinks?.length ?? 0} />}
                  <div className="mt-[16px]">{statCards}</div>
                  <div className="mt-[24px]">
                    <div className="mb-[8px] flex items-center justify-between">
                      <h2 className="text-[15px] font-bold text-foreground">Top consolidation candidates</h2>
                      <button className="text-[12px] font-semibold text-primary hover:underline" onClick={() => setView("consolidation")}>View all →</button>
                    </div>
                    <LegendBar />
                    <Clusters clusters={displayClusters.slice(0, 3)} labels={labels} onWhy={setWhy} />
                  </div>
                </>
              )}

              {view === "consolidation" && (
                <>
                  <ViewHeader title="Consolidation worklist" subtitle="Cross-team models computing the same thing. With usage fused, each becomes a ranked, evidence-backed call: a human confirms." />
                  {usageOn && scan.recommendations && (
                    <div className="mb-[24px]">
                      <Worklist recs={scan.recommendations} onModel={setModel} />
                    </div>
                  )}
                  <h2 className="mb-[8px] text-[15px] font-bold text-foreground">Duplicate clusters</h2>
                  {lifecycleDupCount > 0 && (
                    <div className="mb-[10px] flex flex-wrap items-center gap-x-[10px] gap-y-[6px] rounded-lg border border-border bg-card px-[12px] py-[8px] text-[12px] text-muted-foreground">
                      <span>
                        <b className="text-foreground">{lifecycleDupCount}</b> duplicate pair{lifecycleDupCount === 1 ? "" : "s"} {lifecycleDupCount === 1 ? "is" : "are"} the same model across dev/test/prod, shown as{" "}
                        <button className="font-semibold text-primary hover:underline" onClick={() => setView("review")}>promotion chains</button>, not consolidation targets.
                      </span>
                      <label className="ml-auto flex cursor-pointer items-center gap-[6px] font-semibold text-foreground">
                        <input type="checkbox" checked={includeLifecycle} onChange={(e) => setIncludeLifecycle(e.target.checked)} /> include lifecycle copies as duplicates
                      </label>
                    </div>
                  )}
                  <LegendBar />
                  <Clusters clusters={displayClusters} labels={labels} onWhy={setWhy} />
                </>
              )}

              {view === "map" && (
                <>
                  <ViewHeader title="Estate similarity map" subtitle="Every model vs every model; color = band (see legend), depth = similarity score. Click a cell for the “why”, or a model name for detail." />
                  <LegendBar />
                  <Heatmap cards={scan.cards} pairs={scan.pairs} labels={labels} onSelect={setWhy} onModel={setModel} />
                </>
              )}

              {view === "review" && (
                <>
                  <ViewHeader title="Review & lifecycle" subtitle="Related / needs-review pairs, dev→test→prod promotion chains, and the excluded buckets." />
                  {/* Composite/derived links are high-confidence, already-explained lineage — surfaced
                      first so a reviewer can dismiss them before wading into the harder ambiguous pairs
                      below, instead of being buried after the review table and promotion chains. */}
                  <CompositeSection links={scan.compositeLinks ?? []} onModel={setModel} />
                  <h2 className="mb-[8px] mt-[26px] text-[15px] font-bold text-foreground">Related / needs review</h2>
                  <Toolbar bands={REVIEW_BANDS} active={activeBands} onToggle={toggleBand} search={search} onSearch={setSearch} />
                  <ReviewTable pairs={reviewPairs} labels={labels} onWhy={setWhy} />
                  <h2 className="mb-[8px] mt-[26px] text-[15px] font-bold text-foreground">Promotion chains (dev / test / prod)</h2>
                  <p className="mb-[10px] text-[13px] text-muted-foreground">Same model promoted across environments: expected, not a consolidation target. Drift = numbers may differ across stages.</p>
                  <Chains chains={scan.chains} labels={labels} />
                  <h2 className="mb-[8px] mt-[26px] text-[15px] font-bold text-foreground">Excluded buckets</h2>
                  <Buckets systemGenerated={systemGenerated} emptyModels={scan.emptyModels} excludedDupes={excludedSystemDupes} labels={labels} onWhy={setWhy} />
                </>
              )}

              {view === "connect" && (
                <>
                  <ViewHeader title="Connect data" subtitle="Sign in to scan your Fabric estate, load a usage/metadata table, or open exported TMDL: everything is scored in your browser." />
                  <SourcePanel
                    onData={loadFiles}
                    onSample={() => void loadFiles(sampleFiles, "embedded demo control set", false)}
                    onLoadUsageDemo={loadUsageDemo}
                    onApplyUsage={applyUsage}
                    onScan={loadScan}
                    setProgress={setProgress}
                    toast={toast}
                    fabricUserEmail={user?.email}
                  />
                  {persistEnabled && (
                    <SavedScansPanel
                      scans={savedScans}
                      activeId={activeScanId}
                      saving={saving}
                      onRestore={(id) => void restoreScan(id)}
                      onDelete={(id) => void removeScan(id)}
                    />
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {why && <WhyDrawer pair={why} labels={labels} onClose={() => setWhy(null)} />}
      {model && (
        <ModelDrawer
          card={model}
          pairs={scan.pairs}
          labels={labels}
          onClose={() => setModel(null)}
          onOpenPair={(p) => { setModel(null); setWhy(p); }}
        />
      )}
      <Toaster toasts={toasts} />

      {progress && (
        <div className="progress-overlay">
          <div className="progress-box">
            <strong>Scanning…</strong>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={progress.label}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="muted">{progress.label}</div>
          </div>
        </div>
      )}
    </div>
  );
}
