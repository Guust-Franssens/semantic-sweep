import { useState } from "react";
import type { Cluster, ModelCard, PairResult, PromotionChain, RecAction, Recommendation } from "@engine/types";
import { fabricModelUrl, modelId } from "@engine/types";
import { REC_LABELS, SHOWS_SAVINGS } from "@engine/recommend";
import { downloadCsv, recsToCsv } from "./csv";
import { BAND_META, bandColor, bandLabel } from "./bands";
import { useFocusTrap } from "./hooks/useFocusTrap";

export const Pill = ({ band }: { band: string }) => (
  <span className="pill" style={{ background: bandColor(band) }}>
    {bandLabel(band)}
  </span>
);

const REC_META: Record<RecAction, { label: string; color: string }> = {
  "retirement-candidate": { label: REC_LABELS["retirement-candidate"], color: "var(--cp-success)" },
  "retirement-candidate-blocked": { label: REC_LABELS["retirement-candidate-blocked"], color: "var(--cp-warning)" },
  merge: { label: REC_LABELS.merge, color: "var(--cp-accent)" },
  "governance-conflict": { label: REC_LABELS["governance-conflict"], color: "var(--cp-warning)" },
  "semantic-conflict": { label: REC_LABELS["semantic-conflict"], color: "var(--cp-danger)" },
  "insufficient-evidence": { label: REC_LABELS["insufficient-evidence"], color: "var(--cp-text-soft)" },
};

const JOIN_LABEL: Record<string, string> = {
  high: "GUID", medium: "workspace+name", low: "name only", none: "no match",
};

export function UsageSummary({ recs }: { recs: Recommendation[] }) {
  const count = (a: RecAction): number => recs.filter((r) => r.action === a).length;
  const retire = count("retirement-candidate");
  const merge = count("merge");
  const conflicts = count("semantic-conflict") + count("governance-conflict");
  const evidence = count("insufficient-evidence") + count("retirement-candidate-blocked");
  const total = retire + merge + conflicts + evidence;
  const savingHrs = Math.round(
    recs.filter((r) => r.action === "retirement-candidate").reduce((s, r) => s + r.savingsRefreshMinPerYear, 0) / 60,
  );
  // Lead with the total surfaced for review, never a bare retirement count. On many real estates the
  // clean-retire number is 0 (everything is a conflict or needs more evidence), and opening with a big
  // "0" reads as "found nothing" when the tool actually surfaced several calls a human should action.
  if (total === 0)
    return (
      <div className="insights">
        <div className="txt">No cross-team consolidation calls in this estate. 🎉</div>
      </div>
    );
  return (
    <div className="insights">
      <div className="big">{total}</div>
      <div className="txt">
        consolidation call{total === 1 ? "" : "s"} surfaced for review:{" "}
        <strong>{retire}</strong> safe to retire
        {savingHrs > 0 && (
          <>
            {" "}
            (reclaiming ~<strong>{savingHrs.toLocaleString()} refresh-hrs/yr*</strong>)
          </>
        )}
        , <strong>{merge}</strong> to merge &amp; redirect, <strong>{conflicts}</strong> conflict
        {conflicts === 1 ? "" : "s"} to resolve, <strong>{evidence}</strong> needing more evidence.
        {savingHrs > 0 && <span className="muted"> *illustrative estimate.</span>}
      </div>
    </div>
  );
}

export function Worklist({ recs, onModel }: { recs: Recommendation[]; onModel: (c: ModelCard) => void }) {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  if (recs.length === 0) {
    return <p className="empty">No recommendations yet: load a usage / metadata table to fuse usage with similarity.</p>;
  }
  const query = q.trim().toLowerCase();
  const shown = query
    ? recs.filter((r) =>
        [r.member.name, r.member.workspace, r.keeper?.name ?? "", REC_META[r.action].label]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : recs;
  return (
    <>
      <div className="worklist-bar">
        <span className="muted">
          {query ? `${shown.length} of ${recs.length}` : recs.length} recommendation{recs.length === 1 ? "" : "s"}
        </span>
        <input
          className="search"
          placeholder="filter recommendations…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="wl-export"
          onClick={() =>
            downloadCsv(
              `semantic-sweep-consolidation-${new Date().toISOString().slice(0, 10)}.csv`,
              recsToCsv(recs, status),
            )
          }
          title="Download the worklist (incl. your Status decisions) as a CSV"
        >
          ⬇ Export CSV
        </button>
      </div>
      <div className="worklist">
        {shown.length === 0 && <p className="empty">No recommendations match “{q}”.</p>}
        {shown.map((r, i) => {
          const meta = REC_META[r.action];
          const id = modelId(r.member);
          return (
            <div className="rec-card" key={i}>
              <div className="rec-head">
                <span className="pill" style={{ background: meta.color }}>{meta.label}</span>
                <button className="mi-btn rec-name" onClick={() => onModel(r.member)}>{r.member.name}</button>
                <span className="muted">{r.member.workspace}</span>
                <span className="rec-spacer" />
                {SHOWS_SAVINGS.has(r.action) && r.savingsRefreshMinPerYear > 0 && (
                  <span className="rec-save" title="Estimated refresh minutes avoided per year (illustrative)">
                    {r.savingsRefreshMinPerYear.toLocaleString()} min/yr
                  </span>
                )}
                <select
                  className="rec-status"
                  value={status[id] ?? "Proposed"}
                  onChange={(e) => setStatus((s) => ({ ...s, [id]: e.target.value }))}
                >
                  <option>Proposed</option>
                  <option>Approved</option>
                  <option>In progress</option>
                  <option>Done</option>
                </select>
              </div>
              {r.keeper && (
                <div className="rec-keep">
                  ↳ keep <strong>{r.keeper.name}</strong> <span className="muted">{r.keeper.workspace}</span>
                </div>
              )}
              <div className="rec-why">{r.reasonCodes.join("  ·  ")}</div>
              {r.blockers.length > 0 && <div className="rec-block">⚠ {r.blockers.join("  ·  ")}</div>}
              <div className="rec-foot">
                <span
                  className="conf-chip"
                  title="Overall confidence = the weakest of identity-join, usage/lineage, metadata-fidelity"
                >
                  confidence {r.confidence.overall.toFixed(2)}
                </span>
                <span className="muted">
                  join {JOIN_LABEL[r.member.usage?.joinConfidence ?? "none"]} · usage {r.confidence.usageLineage.toFixed(2)}
                </span>
                {r.member.usage?.configuredBy && <span className="rec-owner">{r.member.usage.configuredBy}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="cov-note">
        Drift checked: measures (same-name), relationships, column data types, RLS/calc-group presence. Not yet checked
        (roadmap): RLS rule text, partition/M. Join: <strong>GUID</strong> = decision-grade,{" "}
        <strong>workspace+name</strong> = confirm identity. Decision support: never auto-deletes.
      </p>
    </>
  );
}

export function Kpis({ s }: { s: Record<string, number> }) {
  const cards: Array<[string, number]> = [
    ["Models scanned", s.models],
    ["Pairs scored", s.pairs],
    ["Duplicate clusters", s.clusters],
    ["Promotion chains", s.chains],
    ["System-generated", s.systemGenerated],
    ["Needs review", s.review],
  ];
  return (
    <section className="kpis">
      {cards.map(([label, value]) => (
        <div className="kpi" key={label}>
          <div className="kpi-value">{value}</div>
          <div className="kpi-label">{label}</div>
        </div>
      ))}
    </section>
  );
}

export const LegendBar = () => (
  <div className="legend-bar">
    {Object.entries(BAND_META).map(([band, m]) => (
      <span className="pill" style={{ background: m.color }} key={band}>
        {m.label}
      </span>
    ))}
  </div>
);

interface ClusterProps {
  clusters: Cluster[];
  labels: Map<string, string>;
  onWhy: (p: PairResult) => void;
}

export function Clusters({ clusters, labels, onWhy }: ClusterProps) {
  if (clusters.length === 0) return <p className="empty">No organic (cross-team) duplicate clusters found.</p>;
  return (
    <>
      {clusters.map((cl, idx) => (
        <div className="card" key={idx}>
          <div className="keep">✔ KEEP&nbsp; {labels.get(modelId(cl.keep))}</div>
          {cl.members
            .filter((m) => m !== cl.keep)
            .map((m) => {
              const p = cl.pairs.find((x) => x.a === m || x.b === m);
              return (
                <div className="retire" key={modelId(m)}>
                  ↳ retire / redirect <strong>{labels.get(modelId(m))}</strong>
                  {p && <Pill band={p.band} />}
                  {p && <span className="muted">measure {p.facets.measure.toFixed(2)} · {p.measure.matched.length} shared</span>}
                  {p && (
                    <button className="why-btn" onClick={() => onWhy(p)}>
                      why?
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      ))}
    </>
  );
}

interface ChainProps {
  chains: PromotionChain[];
  labels: Map<string, string>;
}

export function Chains({ chains, labels }: ChainProps) {
  if (chains.length === 0) return <p className="empty">No dev/test/prod promotion chains detected.</p>;
  return (
    <>
      {chains.map((ch, idx) => (
        <div className="card" key={idx}>
          <strong>{ch.item}</strong>{" "}
          <span className="pill" style={{ background: ch.drift ? "var(--cp-warning)" : "var(--cp-success)" }}>
            {ch.drift ? `DRIFT (${ch.lowestSim.toFixed(2)})` : "in sync"}
          </span>
          <div className="muted">family: {ch.family} &nbsp;·&nbsp; stages: {ch.environments.join(" → ")}</div>
          <div className="muted">canonical: {labels.get(modelId(ch.representative))}</div>
        </div>
      ))}
    </>
  );
}

interface ReviewProps {
  pairs: PairResult[];
  labels: Map<string, string>;
  onWhy: (p: PairResult) => void;
}

export function ReviewTable({ pairs, labels, onWhy }: ReviewProps) {
  const rows = pairs
    .filter((p) => ["needs-review", "related-source"].includes(p.band))
    .sort((a, b) => b.headline - a.headline);
  if (rows.length === 0) return <p className="empty">No related / needs-review pairs above the noise floor.</p>;
  return (
    <>
      <p className="muted mb-[6px] text-[12px]">
        {rows.length} pair{rows.length === 1 ? "" : "s"} · sorted by score
      </p>
      <table className="grid">
      <thead>
        <tr>
          <th>score</th>
          <th>band</th>
          <th>measure</th>
          <th>schema</th>
          <th>model A</th>
          <th>model B</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => (
          <tr className="click" key={i} onClick={() => onWhy(p)}>
            <td>{p.headline.toFixed(2)}</td>
            <td>
              <Pill band={p.band} />
            </td>
            <td>{p.facets.measure.toFixed(2)}</td>
            <td>{p.facets.schema.toFixed(2)}</td>
            <td>{labels.get(modelId(p.a))}</td>
            <td>{labels.get(modelId(p.b))}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

interface BucketProps {
  systemGenerated: ModelCard[];
  emptyModels: ModelCard[];
  excludedDupes: PairResult[];
  labels: Map<string, string>;
  onWhy: (p: PairResult) => void;
}

export function Buckets({ systemGenerated, emptyModels, excludedDupes, labels, onWhy }: BucketProps) {
  return (
    <>
      {excludedDupes.length > 0 && (
        <details open>
          <summary>Detected duplicates held back ({excludedDupes.length}): system-generated, excluded from the worklist</summary>
          <p className="muted" style={{ margin: "6px 0 8px" }}>
            These pairs score as duplicates but at least one side is an auto-generated model (Usage Metrics, default
            dataset). They are surfaced for transparency, not consolidation: retiring a system model breaks the feature
            that owns it.
          </p>
          <table className="grid">
            <thead>
              <tr>
                <th>score</th>
                <th>band</th>
                <th>model A</th>
                <th>model B</th>
              </tr>
            </thead>
            <tbody>
              {excludedDupes.map((p, i) => (
                <tr className="click" key={i} onClick={() => onWhy(p)}>
                  <td>{p.headline.toFixed(2)}</td>
                  <td>
                    <Pill band={p.band} />
                  </td>
                  <td>{labels.get(modelId(p.a))}</td>
                  <td>{labels.get(modelId(p.b))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <details>
        <summary>System-generated models ({systemGenerated.length}), excluded</summary>
        <ul className="plain">
          {systemGenerated.length ? systemGenerated.map((c) => <li key={modelId(c)}>{labels.get(modelId(c))}</li>) : <li>None</li>}
        </ul>
      </details>
      <details>
        <summary>Inventoried but not scored ({emptyModels.length})</summary>
        <ul className="plain">
          {emptyModels.length ? (
            emptyModels.map((c) => (
              <li key={modelId(c)}>
                {c.name} <span className="muted">({c.workspace}), default/empty model (0 tables)</span>
              </li>
            ))
          ) : (
            <li>None</li>
          )}
        </ul>
      </details>
    </>
  );
}

const FACET_LABELS: Array<[keyof PairResult["facets"], string]> = [
  ["measure", "Measures"],
  ["schema", "Schema (tables/cols)"],
  ["source_logical", "Source (logical)"],
  ["source_physical", "Source (physical)"],
  ["rel", "Relationships"],
];

export function Insights({ clusters, chains, composite = 0 }: { clusters: Cluster[]; chains: PromotionChain[]; composite?: number }) {
  const retirable = clusters.reduce((n, c) => n + (c.members.length - 1), 0);
  const driftChains = chains.filter((c) => c.drift).length;
  if (retirable === 0 && driftChains === 0 && composite === 0)
    return (
      <div className="insights">
        <div className="txt">No cross-team duplicates or promotion drift found in this estate. 🎉</div>
      </div>
    );
  return (
    <div className="insights">
      <div className="big">{retirable}</div>
      <div className="txt">
        model{retirable === 1 ? "" : "s"} could be <strong>retired &amp; redirected</strong> across{" "}
        {clusters.length} consolidation cluster{clusters.length === 1 ? "" : "s"}.
        {driftChains > 0 && (
          <>
            {" "}
            Plus <strong>{driftChains}</strong> promotion chain{driftChains === 1 ? "" : "s"} showing drift across
            dev/test/prod.
          </>
        )}
        {composite > 0 && (
          <>
            {" "}
            <strong>{composite}</strong> composite/derived model{composite === 1 ? "" : "s"} reuse{composite === 1 ? "s" : ""} a shared dataset via
            DirectQuery: intentional lineage, not a duplicate.
          </>
        )}
      </div>
    </div>
  );
}

interface ToolbarProps {
  bands: string[];
  active: Set<string>;
  onToggle: (b: string) => void;
  search: string;
  onSearch: (s: string) => void;
}

export function Toolbar({ bands, active, onToggle, search, onSearch }: ToolbarProps) {
  return (
    <div className="toolbar">
      {bands.map((b) => (
        <button key={b} className={`chip${active.has(b) ? " on" : ""}`} onClick={() => onToggle(b)}>
          {bandLabel(b)}
        </button>
      ))}
      <input className="search" placeholder="filter by model name…" value={search} onChange={(e) => onSearch(e.target.value)} />
    </div>
  );
}

interface ModelDrawerProps {
  card: ModelCard;
  pairs: PairResult[];
  labels: Map<string, string>;
  onClose: () => void;
  onOpenPair: (p: PairResult) => void;
}

export function ModelDrawer({ card, pairs, labels, onClose, onOpenPair }: ModelDrawerProps) {
  const related = pairs
    .filter((p) => p.a === card || p.b === card)
    .sort((a, b) => b.headline - a.headline)
    .slice(0, 8);
  const other = (p: PairResult): ModelCard => (p.a === card ? p.b : p.a);
  const drawerRef = useFocusTrap<HTMLDivElement>(onClose);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="model-drawer-title" onClick={(e) => e.stopPropagation()}>
        <button className="btn close" onClick={onClose}>
          ✕ close
        </button>
        <h3 id="model-drawer-title">{card.name}</h3>
        <div className="muted" style={{ marginBottom: 10 }}>{card.workspace}</div>
        {fabricModelUrl(card) && (
          <a
            className="btn"
            href={fabricModelUrl(card)!}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-block", marginBottom: 12, textDecoration: "none" }}
          >
            Open in Fabric ↗
          </a>
        )}
        <dl className="kv">
          <dt>Tables</dt>
          <dd>{card.tables.length}</dd>
          <dt>Measures</dt>
          <dd>{card.measures.length}</dd>
          <dt>Source (logical)</dt>
          <dd>{card.sourceLogical.size || "N/A"}</dd>
          <dt>Source (physical)</dt>
          <dd>{card.sourcePhysical.size || "N/A"}</dd>
          <dt>RLS</dt>
          <dd>{card.hasRls ? "yes" : "no"}</dd>
          <dt>Calc groups</dt>
          <dd>{card.hasCalcGroups === undefined ? "unknown" : card.hasCalcGroups ? "yes" : "no"}</dd>
        </dl>
        <div className="tag">Measures</div>
        <div className="chiplist">
          {card.measures.slice(0, 40).map((m, i) => (
            <span key={i}>{m.name}</span>
          ))}
          {card.measures.length === 0 && <span className="muted">none</span>}
        </div>
        <div className="tag" style={{ marginTop: 14 }}>Most similar models</div>
        {related.length === 0 && <div className="muted">No scored relationships.</div>}
        {related.map((p, i) => (
          <div className="mm-row click" key={i} onClick={() => onOpenPair(p)} style={{ cursor: "pointer" }}>
            <span>
              {labels.get(modelId(other(p)))} <Pill band={p.band} />
            </span>
            <span className="mono">{p.headline.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Toaster({ toasts }: { toasts: Array<{ id: number; msg: string; kind: string }> }) {
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

interface DrawerProps {
  pair: PairResult;
  labels: Map<string, string>;
  onClose: () => void;
}

export function WhyDrawer({ pair, labels, onClose }: DrawerProps) {
  const daxA = new Map(pair.a.measures.map((m) => [m.name, m.dax]));
  const daxB = new Map(pair.b.measures.map((m) => [m.name, m.dax]));
  const drift = pair.measure.matched.filter((m) => m.score < 0.999);
  const drawerRef = useFocusTrap<HTMLDivElement>(onClose);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="why-drawer-title" onClick={(e) => e.stopPropagation()}>
        <button className="btn close" onClick={onClose}>
          ✕ close
        </button>
        <h3 id="why-drawer-title">Why are these similar?</h3>
        <div className="muted" style={{ marginBottom: 10 }}>
          {labels.get(modelId(pair.a))} &nbsp;~&nbsp; {labels.get(modelId(pair.b))}
        </div>
        <div style={{ marginBottom: 12 }}>
          <Pill band={pair.band} /> <span className="muted">headline {pair.headline.toFixed(2)}</span>
        </div>

        <div className="tag" style={{ marginBottom: 4 }}>Facet breakdown (which dimension drove it)</div>
        {FACET_LABELS.map(([key, label]) => (
          <div className="facet-row" key={key}>
            <span>{label}</span>
            <span
              className="bar"
              role="progressbar"
              aria-label={label}
              aria-valuenow={Math.round(pair.facets[key] * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${pair.facets[key] * 100}%` }} />
            </span>
            <span className="mono">{pair.facets[key].toFixed(2)}</span>
          </div>
        ))}

        {pair.warnings.length > 0 && (
          <div style={{ margin: "12px 0" }}>
            <div className="tag">Difference warnings</div>
            {pair.warnings.map((w, i) => (
              <div key={i} style={{ color: "var(--cp-warning)", fontSize: 13 }}>
                ⚠ {w}
              </div>
            ))}
          </div>
        )}

        <div className="mm">
          <div className="tag">
            Matched measures ({pair.measure.matched.length}), containment {pair.measure.containment.toFixed(2)}
          </div>
          {pair.measure.matched.length === 0 && <div className="muted">No measures matched above threshold.</div>}
          {pair.measure.matched.map((m, i) => (
            <div className={`mm-row${m.score < 0.999 ? " drift" : ""}`} key={i}>
              <span>
                {m.a === m.b ? <code>{m.a}</code> : <span><code>{m.a}</code> ~ <code>{m.b}</code></span>}
                {m.score < 0.999 && " (differs)"}
              </span>
              <span className="mono">{m.score.toFixed(2)}</span>
            </div>
          ))}
        </div>

        {drift.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="tag">DAX differences (matched but not identical)</div>
            {drift.slice(0, 6).map((m, i) => (
              <div key={i}>
                <div style={{ fontSize: 12, margin: "8px 0 2px" }}>
                  <code>{m.a}</code> {m.a !== m.b && <>vs <code>{m.b}</code></>}{" "}
                  <span className="tag">({m.score.toFixed(2)})</span>
                </div>
                <div className="daxdiff">
                  <pre>{daxA.get(m.a) ?? "N/A"}</pre>
                  <pre>{daxB.get(m.b) ?? "N/A"}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
