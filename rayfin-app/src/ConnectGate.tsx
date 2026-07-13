import { useEffect, useRef, useState } from "react";
import { Boxes, ClipboardList, DatabaseZap, Layers, LayoutGrid, type LucideIcon, ScanSearch, ShieldCheck, Users } from "lucide-react";
import { getFabricToken, PbiSignInRequiredError, signInToPbi } from "./data/fabricAuth";
import { type AdminProbe, type ExportFailure } from "./data/fabric";
import { fabricProvider, scanFabricEstate } from "./data/fabricScan";
import type { ScanResult } from "@engine/scan";

type Progress = { done: number; total: number; label: string };

// Central connect gate (FabricAtlas-style): the first thing you see. Signs you in once and scans
// the workspaces you can access — the app never shows sample data by default. Returning visitors
// with a cached token skip straight to their estate (silent, no popup).
export function ConnectGate({
  onScan,
  onSample,
  loginHint,
}: {
  onScan: (scan: ScanResult, label: string, skipped?: ExportFailure[]) => void;
  onSample: () => void;
  loginHint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [admin, setAdmin] = useState<AdminProbe | null>(null);
  const tried = useRef(false);
  const started = useRef(false);

  const onProg = (done: number, total: number, label: string): void => {
    setProgress({ done, total, label });
    if (total > 0) setFeed((f) => (f[0] === label ? f : [label, ...f].slice(0, 5)));
  };

  // Per-user scan: export TMDL for the workspaces THIS user can open. Full fidelity (relationships,
  // RLS, calc groups) but a model on a PAUSED capacity can't be exported via getDefinition — it lands
  // in `failures` (surfaced by the SkippedBanner) rather than silently vanishing from the estate.
  async function scanWith(): Promise<void> {
    if (started.current) return; // guard: only one scan (silent auto-attempt vs button click)
    started.current = true;
    setBusy(true);
    setErr(null);
    setFeed([]);
    try {
      // scanFabricEstate picks the widest path (tenant-wide admin scan when available, else per-user)
      // and streams progress through onProg; onAdmin fires the moment the access probe resolves so the
      // capability pill shows before the scan finishes.
      const outcome = await scanFabricEstate(fabricProvider, onProg, setAdmin);
      onScan(outcome.result, outcome.label, outcome.skipped);
    } catch (e) {
      // Never leave the gate stuck on "Scanning…": reset so the button works, and surface the error.
      started.current = false;
      setBusy(false);
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  }

  // On mount, best-effort silent token in the BACKGROUND (the button is already shown). If a valid
  // token is cached, auto-scan; otherwise do nothing and let the user click. A failed silent attempt
  // (blocked 3rd-party-cookie iframe, no cached token) is EXPECTED and must never surface as an error.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new PbiSignInRequiredError()), 5000),
    );
    void Promise.race([getFabricToken(), timeout])
      .then(() => scanWith())
      .catch(() => {
        /* expected — user will click the sign-in button */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(): Promise<void> {
    setErr(null);
    started.current = false; // allow a fresh scan on explicit click
    setBusy(true);
    try {
      await signInToPbi(loginHint); // interactive popup from this click (user gesture)
      await scanWith();
    } catch (e) {
      const msg = e instanceof PbiSignInRequiredError ? "Sign-in was cancelled." : String(e);
      setErr(
        /consent|AADSTS65001|need admin/i.test(msg)
          ? "This app needs a one-time Entra admin consent before it can read your estate."
          : /timed_out|user_cancelled|cancelled/i.test(msg)
            ? "Sign-in was cancelled or timed out — try again."
            : msg,
      );
      setBusy(false);
    }
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const connectedLabel = loginHint ? `Connected to Fabric as ${loginHint}` : "Connected to Fabric";

  const features: { icon: LucideIcon; title: string; sub: string }[] = [
    { icon: Layers, title: "Duplicate clusters", sub: "cross-team copies, grouped" },
    { icon: LayoutGrid, title: "Similarity map", sub: "every model vs every model" },
    { icon: DatabaseZap, title: "Usage fusion", sub: "retire vs keep, with evidence" },
    { icon: ClipboardList, title: "Review & lifecycle", sub: "dev → test → prod chains" },
    { icon: Boxes, title: "Deep scan", sub: "tables, columns & DAX (TMDL)" },
    { icon: ShieldCheck, title: "Decision support", sub: "never auto-deletes anything" },
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground font-sans">
      <style>{`@keyframes ss-indet{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}.ss-indet{animation:ss-indet 1.05s ease-in-out infinite}`}</style>
      <div className="w-full max-w-[880px] text-center">
        <div
          className="mx-auto flex items-center justify-center rounded-2xl text-white"
          style={{ width: 64, height: 64, background: "linear-gradient(135deg,#0f6cbd,#3b82f6)" }}
        >
          <ScanSearch size={32} />
        </div>

        <div className="mt-[20px] inline-flex items-center gap-[8px] rounded-full border border-border bg-card px-[14px] py-[6px] text-[12.5px] text-muted-foreground">
          <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: "#22a565" }} />
          {connectedLabel}
        </div>

        {/* Access-level indicator: is this a whole-tenant admin scan, or a per-user scan of the
            workspaces you can open? Tells the user (and any customer) exactly what coverage they get,
            and — when tenant-wide isn't available — why (Tenant.Read.All admin consent). */}
        {admin && (
          <div className="mt-[10px] flex justify-center">
            {admin.available ? (
              <span className="inline-flex items-center gap-[7px] rounded-full border border-[#2f9e6b55] bg-[#22a5651a] px-[13px] py-[5px] text-[12px] font-semibold text-[#1a7f52]">
                <ShieldCheck size={14} /> Fabric admin · tenant-wide scan (all capacities)
              </span>
            ) : (
              <span
                title={admin.reason}
                className="inline-flex cursor-help items-center gap-[7px] rounded-full border border-border bg-card px-[13px] py-[5px] text-[12px] font-semibold text-muted-foreground"
              >
                <Users size={14} /> Standard access · your workspaces
                <span className="text-[11px] font-normal opacity-70">— why?</span>
              </span>
            )}
          </div>
        )}

        <h1 className="mt-[16px] text-[34px] font-bold leading-tight">
          Find duplicate semantic models, <span className="text-primary">in one place</span>
        </h1>
        <p className="mx-auto mt-[10px] max-w-[560px] text-[14.5px] text-muted-foreground">
          Scan every model across your estate, score the near-duplicates, and get evidence-backed
          consolidation calls. Everything is scored in your browser; results are saved to your own
          Fabric workspace, ready the moment you return.
        </p>

        <div className="mx-auto mt-[26px] max-w-[420px]">
          <button
            onClick={() => void connect()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-[10px] rounded-xl px-[18px] py-[13px] text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-80"
            style={{ background: "linear-gradient(135deg,#0f6cbd,#3b82f6)" }}
          >
            <ScanSearch size={17} className={busy ? "animate-spin" : ""} />
            {busy ? "Scanning estate…" : "Scan my estate"}
          </button>

          {busy && (
            <div className="mt-[12px]">
              <div className="h-[8px] w-full overflow-hidden rounded-full bg-secondary">
                {progress?.total ? (
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                ) : (
                  <div className="ss-indet h-full w-[38%] rounded-full bg-primary" />
                )}
              </div>
              <div className="mt-[7px] text-[12px] text-muted-foreground">
                {progress?.total
                  ? `${progress.done}/${progress.total} models · ${Math.round(pct)}%`
                  : (progress?.label ?? "Opening sign-in…")}
              </div>
              {feed.length > 0 && (
                <div className="mt-[10px] space-y-[3px] text-left">
                  {feed.map((item, i) => (
                    <div
                      key={item}
                      className="flex items-center gap-[7px] text-[11.5px] text-muted-foreground"
                      style={{ opacity: 1 - i * 0.17 }}
                    >
                      <span className="inline-block shrink-0 rounded-full bg-[#22a565]" style={{ width: 5, height: 5 }} />
                      <span className="truncate">{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {err && !busy && (
            <div className="mt-[12px] rounded-lg border border-[#e0b4b4] bg-[#fdf0f0] px-[12px] py-[9px] text-left text-[12px] text-[#a4262c]">
              {err}
            </div>
          )}
        </div>

        <div className="mx-auto mt-[30px] grid max-w-[820px] grid-cols-1 gap-[12px] sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, sub }) => (
            <div key={title} className="flex items-start gap-[11px] rounded-xl border border-border bg-card p-[14px] text-left">
              <span
                className="flex shrink-0 items-center justify-center rounded-lg text-primary"
                style={{ width: 32, height: 32, background: "#0f6cbd1a" }}
              >
                <Icon size={17} />
              </span>
              <div>
                <div className="text-[13.5px] font-bold text-foreground">{title}</div>
                <div className="mt-[1px] text-[12px] text-muted-foreground">{sub}</div>
              </div>
            </div>
          ))}
        </div>

        <button onClick={onSample} className="mt-[22px] text-[12.5px] font-semibold text-primary hover:underline">
          Explore with sample data instead →
        </button>
      </div>
    </div>
  );
}
