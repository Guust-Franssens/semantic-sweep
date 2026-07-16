import { useMemo, useRef, useState } from "react";
import type { InputFile } from "@engine/parser";
import { CLUSTER_BANDS } from "@engine/index";
import { enrichScanWithUsage, runScan, type ScanResult } from "@engine/scan";
import type { ModelCard, PairResult, Usage } from "@engine/types";
import { modelId } from "@engine/types";
import { sampleFiles } from "./sample";
import { usageDemoScan } from "./usageDemo";
import { SourcePanel } from "./SourcePanel";
import {
  Buckets,
  Chains,
  Clusters,
  Insights,
  Kpis,
  LegendBar,
  ModelDrawer,
  ReviewTable,
  Toaster,
  Toolbar,
  UsageSummary,
  WhyDrawer,
  Worklist,
} from "./components";
import { Heatmap } from "./Heatmap";

const SEED_PREFIX = "SS_DEMO";
// Subset/trimmed-copy pairs now surface as consolidation candidates, not review rows.
const REVIEW_BANDS = ["needs-review", "related-source"];

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

const toggleTheme = (): void => {
  const el = document.documentElement;
  el.setAttribute("data-theme", el.getAttribute("data-theme") === "dark" ? "light" : "dark");
};

export function App() {
  const [scan, setScan] = useState<ScanResult>(() => runScan(sampleFiles));
  const [source, setSource] = useState("embedded brewery control set");
  const [anonymize, setAnonymize] = useState(false);
  const [why, setWhy] = useState<PairResult | null>(null);
  const [model, setModel] = useState<ModelCard | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [activeBands, setActiveBands] = useState<Set<string>>(new Set(REVIEW_BANDS));
  const [search, setSearch] = useState("");
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const toastId = useRef(0);

  function toast(msg: string, kind: string = "info"): void {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }

  function loadFiles(files: InputFile[], label: string): void {
    setScan(runScan(files));
    setSource(label);
    setModel(null);
    setWhy(null);
  }

  function loadScan(next: ScanResult, label: string): void {
    setScan(next);
    setSource(label);
    setModel(null);
    setWhy(null);
  }

  function loadUsageDemo(): void {
    const s = usageDemoScan();
    setScan(s);
    setSource("usage demo estate");
    setModel(null);
    setWhy(null);
    toast(`Loaded usage demo · ${s.recommendations?.length ?? 0} recommendations across ${s.clusters.length} cluster(s).`, "ok");
  }

  function applyUsage(records: Usage[]): void {
    const enriched = enrichScanWithUsage(scan, records);
    setScan(enriched);
    setModel(null);
    setWhy(null);
    const jr = enriched.joinReport;
    const recN = enriched.recommendations?.length ?? 0;
    if (!jr || jr.matched === 0) {
      toast("No models in the current estate matched the usage table (check identity columns).", "err");
    } else {
      toast(
        `Matched ${jr.matched} model(s) to usage${jr.ambiguous ? `, ${jr.ambiguous} ambiguous` : ""} → ${recN} recommendation(s).`,
        "ok",
      );
    }
  }

  const labels = useMemo(() => buildLabels(scan.cards, anonymize), [scan, anonymize]);
  const systemGenerated = useMemo(() => scan.cards.filter((c) => c.systemGenerated), [scan]);
  // Duplicate-band pairs held out of the worklist because a member is system-generated — surfaced in
  // the excluded buckets for transparency (imp-a7). Lifecycle/composite dupes show elsewhere.
  const excludedSystemDupes = useMemo(
    () =>
      scan.pairs.filter(
        (p) => CLUSTER_BANDS.has(p.band) && !p.lifecycle && !p.composite && (p.a.systemGenerated || p.b.systemGenerated),
      ),
    [scan],
  );

  const reviewPairs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scan.pairs.filter((p) => {
      if (!activeBands.has(p.band)) return false;
      if (!q) return true;
      return (modelId(p.a) + modelId(p.b)).toLowerCase().includes(q);
    });
  }, [scan, activeBands, search]);

  const s = {
    models: scan.cards.length,
    pairs: scan.pairs.length,
    clusters: scan.clusters.length,
    chains: scan.chains.length,
    systemGenerated: systemGenerated.length,
    review: scan.pairs.filter((p) => REVIEW_BANDS.includes(p.band)).length,
  };

  const toggleBand = (b: string): void =>
    setActiveBands((s2) => {
      const n = new Set(s2);
      if (n.has(b)) n.delete(b);
      else n.add(b);
      return n;
    });

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <header className="appbar">
        <div className="appbar-inner">
          <div>
            <h1>semantic-sweep</h1>
            <div className="scope">
              {s.models} models · {s.pairs} pairs · scored 100% in your browser{scan.usageLoaded ? " · usage fused" : ""} · {source}
            </div>
          </div>
          <div className="actions">
            <label className="btn">
              <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} /> anonymize
            </label>
            <button className="btn" onClick={toggleTheme}>◐ theme</button>
          </div>
        </div>
      </header>

      <div className="wrap">
        <SourcePanel
          onData={loadFiles}
          onSample={() => loadFiles(sampleFiles, "embedded brewery control set")}
          onLoadUsageDemo={loadUsageDemo}
          onApplyUsage={applyUsage}
          onScan={loadScan}
          setProgress={setProgress}
          toast={toast}
        />

        {scan.usageLoaded && scan.recommendations ? (
          <UsageSummary recs={scan.recommendations} />
        ) : (
          <Insights clusters={scan.clusters} chains={scan.chains} />
        )}
        <Kpis s={s} />

        {scan.usageLoaded && scan.recommendations && (
          <>
            <h2>Consolidation worklist</h2>
            <p className="sub">
              Similarity fused with usage &amp; freshness → ranked, evidence-backed recommendations. Set a status;
              confirm before acting. Drift or a weak identity join blocks a "retire" call.
            </p>
            <Worklist recs={scan.recommendations} onModel={setModel} />
          </>
        )}

        <h2>Duplicate consolidation candidates</h2>
        <p className="sub">Cross-team models computing the same thing — the consolidation wins. Decision support: a human confirms.</p>
        <LegendBar />
        <Clusters clusters={scan.clusters} labels={labels} onWhy={setWhy} />

        <h2>Estate similarity map</h2>
        <p className="sub">Every model vs every model; color = band (see legend), depth = similarity score. Click a cell for the “why”, or a model name for its detail.</p>
        <LegendBar />
        <Heatmap cards={scan.cards} pairs={scan.pairs} labels={labels} onSelect={setWhy} onModel={setModel} />

        <h2>Promotion chains (dev / test / prod)</h2>
        <p className="sub">Same model promoted across environments — expected, not a consolidation target. Drift = numbers may differ across stages.</p>
        <Chains chains={scan.chains} labels={labels} />

        <h2>Related / needs review</h2>
        <p className="sub">Filter by band or model name; click a row for the facet + measure breakdown.</p>
        <Toolbar bands={REVIEW_BANDS} active={activeBands} onToggle={toggleBand} search={search} onSearch={setSearch} />
        <ReviewTable pairs={reviewPairs} labels={labels} onWhy={setWhy} />

        <h2>Excluded buckets</h2>
        <Buckets systemGenerated={systemGenerated} emptyModels={scan.emptyModels} excludedDupes={excludedSystemDupes} labels={labels} onWhy={setWhy} />

        <footer>
          semantic-sweep · runs fully client-side (TypeScript engine, parity-checked vs the Python engine) · exports
          TMDL live from Fabric via the browser (CORS) · decision support, not auto-deletion.
        </footer>
      </div>

      {why && <WhyDrawer pair={why} labels={labels} onClose={() => setWhy(null)} />}
      {model && (
        <ModelDrawer
          card={model}
          pairs={scan.pairs}
          labels={labels}
          onClose={() => setModel(null)}
          onOpenPair={(p) => {
            setModel(null);
            setWhy(p);
          }}
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
    </>
  );
}
