"""
purpose: render out/results.json into a self-contained, shareable dashboard.html (Clawpilot theme)
usage:   python scripts/build_dashboard.py [--anonymize]
         (reads out/results.json from the scan; writes out/dashboard.html)

--anonymize replaces every non-seed (non SS_DEMO) workspace/model name with a generic code, so the
page can be shared externally without exposing other demo/customer names. The seeded brewery
control set is kept real because it is synthetic and is the illustrative story.
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

OUT = Path("out")
SEED_PREFIX = "SS_DEMO"

BAND_STYLE = {
    "exact-clone": ("Exact clone", "var(--cp-danger)"),
    "strong-duplicate": ("Strong duplicate", "var(--cp-accent)"),
    "subset": ("Subset", "var(--cp-warning)"),
    "needs-review": ("Needs review", "var(--cp-warning)"),
    "related-source": ("Related source", "var(--cp-text-soft)"),
    "unrelated": ("Unrelated", "var(--cp-border-strong)"),
}


def _esc(text: str) -> str:
    return html.escape(str(text))


def _display_names(results: dict, anonymize: bool) -> dict[str, str]:
    """Map each model id -> display label; anonymize non-seed names when requested."""
    labels: dict[str, str] = {}
    counter = 0
    for model in results["models"]:
        mid = model["id"]
        if not anonymize or model["workspace"].startswith(SEED_PREFIX):
            labels[mid] = f"{model['name']}  ·  {model['workspace']}"
        else:
            counter += 1
            labels[mid] = f"Model {counter:02d}  ·  Workspace {counter:02d}"
    return labels


def _kpis(summary: dict) -> str:
    cards = [
        ("Models scanned", summary["models"]),
        ("Pairs scored", summary["pairs"]),
        ("Duplicate clusters", summary["organic_clusters"]),
        ("Promotion chains", summary["promotion_chains"]),
        ("System-generated", summary["system_generated"]),
        ("Not scored", summary["unscored"]),
    ]
    items = "".join(
        f'<div class="kpi"><div class="kpi-value">{v}</div><div class="kpi-label">{_esc(k)}</div></div>'
        for k, v in cards
    )
    return f'<section class="kpis">{items}</section>'


def _short_codes(results: dict) -> dict[str, str]:
    return {m["id"]: f"M{i + 1:02d}" for i, m in enumerate(results["models"])}


def _clusters(results: dict, labels: dict, pair_lookup: dict) -> str:
    if not results["organic_clusters"]:
        return '<p class="empty">No organic (cross-team) duplicate clusters found.</p>'
    blocks = []
    for cluster in results["organic_clusters"]:
        keep = cluster["keep"]
        rows = [f'<div class="keep">✔ KEEP &nbsp;<strong>{_esc(labels[keep])}</strong></div>']
        for member in cluster["members"]:
            if member == keep:
                continue
            pair = pair_lookup.get(frozenset((keep, member)))
            band = pair["band"] if pair else "?"
            sim = pair["measure"] if pair else 0.0
            shared = pair["matched_measures"] if pair else 0
            label, color = BAND_STYLE.get(band, (band, "var(--cp-text)"))
            rows.append(
                f'<div class="retire">↳ retire / redirect <strong>{_esc(labels[member])}</strong>'
                f'<span class="pill" style="background:{color}">{_esc(label)}</span>'
                f'<span class="muted">measure sim {sim:.2f} · {shared} shared measures</span></div>'
            )
        blocks.append(f'<div class="cluster-card">{"".join(rows)}</div>')
    return "".join(blocks)


def _chains(results: dict, labels: dict) -> str:
    if not results["promotion_chains"]:
        return '<p class="empty">No dev/test/prod promotion chains detected.</p>'
    rows = []
    for chain in results["promotion_chains"]:
        drift = chain["drift"]
        status = (
            '<span class="pill" style="background:var(--cp-warning)">DRIFT</span>'
            if drift
            else '<span class="pill" style="background:var(--cp-success)">in sync</span>'
        )
        envs = " → ".join(_esc(e) for e in chain["environments"])
        canonical = _esc(labels.get(chain["representative"], chain["representative"]))
        rows.append(
            f'<div class="chain-card"><strong>{_esc(chain["item"])}</strong> {status}'
            f'<div class="muted">family: {_esc(chain["family"])} &nbsp;·&nbsp; stages: {envs}</div>'
            f'<div class="muted">canonical: {canonical}</div></div>'
        )
    return "".join(rows)


def _review_table(results: dict, labels: dict) -> str:
    rows = [p for p in results["pairs"] if p["band"] in ("subset", "needs-review", "related-source")]
    rows.sort(key=lambda p: -p["headline"])
    if not rows:
        return '<p class="empty">No related / needs-review pairs above the noise floor.</p>'
    body = "".join(
        f"<tr><td>{p['headline']:.2f}</td>"
        f'<td><span class="pill" style="background:{BAND_STYLE.get(p["band"], ("", "var(--cp-text)"))[1]}">'
        f"{_esc(BAND_STYLE.get(p['band'], (p['band'],))[0])}</span></td>"
        f"<td>{p['measure']:.2f}</td><td>{p['schema']:.2f}</td>"
        f"<td>{_esc(labels[p['a']])}</td><td>{_esc(labels[p['b']])}</td></tr>"
        for p in rows[:20]
    )
    return (
        '<table class="grid"><thead><tr><th>score</th><th>band</th><th>measure</th>'
        "<th>schema</th><th>model A</th><th>model B</th></tr></thead>"
        f"<tbody>{body}</tbody></table>"
    )


def _heatmap(results: dict, codes: dict, labels: dict, pair_lookup: dict) -> str:
    # pylint: disable=too-many-locals  # cohesive grid + legend rendering
    models = results["models"]
    header = '<th class="corner"></th>' + "".join(f'<th class="hx"><span>{codes[m["id"]]}</span></th>' for m in models)
    rows = []
    for row_model in models:
        cells = [f'<th class="hy">{codes[row_model["id"]]}</th>']
        for col_model in models:
            if row_model["id"] == col_model["id"]:
                cells.append('<td class="cell diag" title="self">·</td>')
                continue
            pair = pair_lookup.get(frozenset((row_model["id"], col_model["id"])))
            score = pair["headline"] if pair else 0.0
            band = pair["band"] if pair else "unrelated"
            opacity = round(0.08 + 0.92 * score, 3) if score > 0 else 0.0
            tip = f"{labels[row_model['id']]}  ~  {labels[col_model['id']]}\n{band} · score {score:.2f}"
            style = f"background:rgba(177,31,75,{opacity})" if score > 0 else ""
            cells.append(f'<td class="cell" style="{style}" title="{_esc(tip)}"></td>')
        rows.append(f"<tr>{''.join(cells)}</tr>")
    legend = "".join(f'<li><span class="code">{codes[m["id"]]}</span> {_esc(labels[m["id"]])}</li>' for m in models)
    return (
        '<div class="heatmap-wrap"><table class="heatmap"><thead><tr>'
        f"{header}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
        f'<details class="legend"><summary>Model index ({len(models)})</summary><ul>{legend}</ul></details>'
    )


def _buckets(results: dict, labels: dict) -> str:
    system = "".join(f"<li>{_esc(labels.get(mid, mid))}</li>" for mid in results["system_generated"])
    unscored = "".join(
        f'<li>{_esc(u["model"])} <span class="muted">({_esc(u["workspace"])}) — {_esc(u["reason"])}</span></li>'
        for u in results["unscored"]
    )
    return (
        f"<details><summary>System-generated models ({len(results['system_generated'])}) — excluded</summary>"
        f'<ul class="plain">{system or "<li>None</li>"}</ul></details>'
        f"<details><summary>Inventoried but not scored ({len(results['unscored'])})</summary>"
        f'<ul class="plain">{unscored or "<li>None</li>"}</ul></details>'
    )


def _legend_bar() -> str:
    items = "".join(
        f'<span class="pill" style="background:{color}">{_esc(label)}</span>' for label, color in BAND_STYLE.values()
    )
    return f'<div class="band-legend">{items}</div>'


def build_html(results: dict, anonymize: bool) -> str:
    """Assemble the full self-contained dashboard HTML string."""
    labels = _display_names(results, anonymize)
    codes = _short_codes(results)
    pair_lookup = {frozenset((p["a"], p["b"])): p for p in results["pairs"]}
    scope = f"{results['summary']['models']} semantic models · {results['summary']['pairs']} pairs scored"
    banner = '<div class="note">Shareable view — non-seed workspace/model names anonymized.</div>' if anonymize else ""
    return _TEMPLATE.format(
        css=_CSS,
        theme_script=_THEME_SCRIPT,
        scope=_esc(scope),
        banner=banner,
        kpis=_kpis(results["summary"]),
        legend_bar=_legend_bar(),
        clusters=_clusters(results, labels, pair_lookup),
        heatmap=_heatmap(results, codes, labels, pair_lookup),
        chains=_chains(results, labels),
        review=_review_table(results, labels),
        buckets=_buckets(results, labels),
    )


def main() -> None:
    """Read out/results.json and write out/dashboard.html."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--anonymize", action="store_true", help="anonymize non-seed names for external sharing")
    parser.add_argument("--out", type=Path, default=OUT / "dashboard.html")
    args = parser.parse_args()

    results = json.loads((OUT / "results.json").read_text(encoding="utf-8"))
    args.out.write_text(build_html(results, args.anonymize), encoding="utf-8")
    print(f"dashboard written -> {args.out}  (anonymize={args.anonymize})")


_THEME_SCRIPT = """<script>
  (() => {
    const param = new URLSearchParams(window.location.search).get("clawpilotTheme");
    const theme = param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
</script>"""

_CSS = """
:root{color-scheme:light;--cp-bg:#f7f4ef;--cp-bg-elevated:#fcfbf8;--cp-surface:#ffffff;
--cp-surface-soft:#f5f5f5;--cp-border:#dedede;--cp-border-strong:#919191;--cp-text:#242424;
--cp-text-muted:#5c5c5c;--cp-text-soft:#6f6f6f;--cp-accent:#b11f4b;--cp-accent-hover:#9a1a41;
--cp-accent-soft:rgba(177,31,75,0.08);--cp-accent-fg:#ffffff;--cp-success:#16a34a;--cp-danger:#dc2626;
--cp-warning:#f59e0b;--cp-link:#0078d4;--cp-shadow:0 18px 48px rgba(0,0,0,0.12);--cp-highlight:rgba(177,31,75,0.12);}
html[data-theme="dark"]{color-scheme:dark;--cp-bg:#3d3b3a;--cp-bg-elevated:#343231;--cp-surface:#292929;
--cp-surface-soft:#2e2e2e;--cp-border:#474747;--cp-border-strong:#5f5f5f;--cp-text:#dedede;
--cp-text-muted:#919191;--cp-text-soft:#b0b0b0;--cp-accent:#fd8ea1;--cp-accent-hover:#fb7b91;
--cp-accent-soft:rgba(253,142,161,0.14);--cp-accent-fg:#1a1a1a;--cp-success:#4ade80;--cp-danger:#f87171;
--cp-warning:#fbbf24;--cp-link:#4da6ff;--cp-shadow:0 18px 48px rgba(0,0,0,0.32);--cp-highlight:rgba(253,142,161,0.12);}
*{box-sizing:border-box;}
body{margin:0;background:var(--cp-bg);color:var(--cp-text);
font-family:"Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;}
.wrap{max-width:1120px;margin:0 auto;padding:32px 24px 64px;}
header h1{margin:0 0 4px;font-size:26px;}
header .scope{color:var(--cp-text-muted);font-size:14px;}
.note{margin-top:10px;padding:8px 12px;border-radius:10px;background:var(--cp-accent-soft);
color:var(--cp-accent);font-size:13px;display:inline-block;}
h2{font-size:16px;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--cp-border);}
.sub{color:var(--cp-text-soft);font-size:13px;margin:-6px 0 14px;}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:20px;}
.kpi{background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px;padding:16px;
box-shadow:0 0 2px rgba(0,0,0,0.12),0 1px 2px rgba(0,0,0,0.14);}
.kpi-value{font-size:28px;font-weight:700;color:var(--cp-accent);}
.kpi-label{font-size:12px;color:var(--cp-text-muted);margin-top:2px;}
.cluster-card,.chain-card{background:var(--cp-surface);border:1px solid var(--cp-border);
border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 0 2px rgba(0,0,0,0.12),0 1px 2px rgba(0,0,0,0.14);}
.keep{color:var(--cp-success);font-size:15px;margin-bottom:8px;}
.retire{font-size:14px;margin:6px 0 6px 14px;}
.pill{display:inline-block;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;margin:0 8px;}
.muted{color:var(--cp-text-muted);font-size:12px;}
.empty{color:var(--cp-text-muted);font-style:italic;}
.band-legend{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 4px;}
table.grid{width:100%;border-collapse:collapse;font-size:13px;background:var(--cp-surface);
border:1px solid var(--cp-border);border-radius:12px;overflow:hidden;}
table.grid th{background:var(--cp-surface-soft);color:var(--cp-text-muted);text-align:left;
padding:8px 10px;font-weight:600;}
table.grid td{padding:7px 10px;border-top:1px solid var(--cp-border);}
.heatmap-wrap{overflow:auto;border:1px solid var(--cp-border);border-radius:12px;background:var(--cp-surface);padding:6px;}
table.heatmap{border-collapse:collapse;}
table.heatmap th.hx span{writing-mode:vertical-rl;transform:rotate(180deg);font-size:9px;color:var(--cp-text-muted);}
table.heatmap th.hy{font-size:9px;color:var(--cp-text-muted);padding-right:4px;text-align:right;position:sticky;left:0;background:var(--cp-surface);}
table.heatmap th.corner{position:sticky;left:0;background:var(--cp-surface);}
.cell{width:16px;height:16px;border:1px solid var(--cp-border);}
.cell.diag{color:var(--cp-border-strong);text-align:center;font-size:9px;}
details{margin:8px 0;}
summary{cursor:pointer;color:var(--cp-text-muted);font-size:13px;}
.legend ul{columns:2;font-size:12px;color:var(--cp-text-soft);margin:8px 0;padding-left:18px;}
.legend .code{display:inline-block;width:34px;color:var(--cp-accent);font-family:Consolas,monospace;}
ul.plain{font-size:13px;color:var(--cp-text-soft);}
footer{margin-top:40px;color:var(--cp-text-soft);font-size:12px;border-top:1px solid var(--cp-border);padding-top:12px;}
"""

_TEMPLATE = """<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>semantic-sweep — duplicate scan</title>
{theme_script}
<style>{css}</style>
</head>
<body>
<div class="wrap">
<header>
<h1>semantic-sweep — Power BI duplicate scan</h1>
<div class="scope">{scope}</div>
{banner}
</header>
{kpis}
<h2>Duplicate consolidation candidates</h2>
<div class="sub">Cross-team models computing the same thing — the consolidation wins. Decision support: a human confirms.</div>
{legend_bar}
{clusters}
<h2>Estate similarity map</h2>
<div class="sub">Every model vs every model; deeper rose = higher similarity. Hover a cell for the pair and score.</div>
{heatmap}
<h2>Promotion chains (dev / test / prod)</h2>
<div class="sub">Same model promoted across environments — expected, not a consolidation target. Drift = numbers may differ across stages.</div>
{chains}
<h2>Related / needs review</h2>
<div class="sub">Partial overlap or mixed signals — worth a human look, not confirmed duplicates.</div>
{review}
<h2>Excluded buckets</h2>
{buckets}
<footer>Generated by semantic-sweep · decision support, not auto-deletion · all scores are explainable facets (measures · schema · source · relationships).</footer>
</div>
</body>
</html>
"""


if __name__ == "__main__":
    main()
