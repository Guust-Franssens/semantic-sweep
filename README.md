# semantic-sweep

Scan a Power BI **semantic-model estate** and automatically flag **near-duplicate models**, as
decision support for consolidation. Built to tackle a real-world "duplicate semantic models"
problem across a large Power BI estate.

## What it does
1. **Inventory + extract** every semantic model in a Fabric tenant to TMDL (`scripts/`).
2. **Parse** each model to a `ModelCard` (tables, columns, measures + DAX, relationships, source).
3. **Score** every pair with a multi-facet similarity (measures + schema + logical/physical source
   + relationships), using **weighted lexical DAX features** (not opaque embeddings).
4. **Separate the signal types** into three views:
   - **Promotion chains** — dev/test/prod copies of the same model (+ drift), *not* consolidation
     targets.
   - **Organic duplicate candidates** — genuine cross-team duplication (the real wins).
   - **Related / needs-review** — shared source only, or mixed evidence.
   System-generated models (Usage Metrics, default lakehouse models) are bucketed separately.

## Usage
```bash
uv venv --python 3.11
uv sync
uv run python -m semantic_sweep.cli --models models --out out   # -> report.md, results.json, matrix
uv run python scripts/build_dashboard.py                        # -> out/dashboard.html (shareable overview)
uv run python scripts/build_dashboard.py --anonymize --out out/dashboard_client.html  # external-safe
```

Re-extract the estate (needs `az login` + `fab`):
```bash
uv run python scripts/enumerate_estate.py     # -> inventory.json
uv run python scripts/export_models.py         # -> models/
```

Seed a labeled near-duplicate control set into a tenant (needs an active capacity):
```bash
uv run python scripts/make_seed_models.py      # -> seed_models/ (deployable TMDL)
uv run python scripts/deploy_seed.py           # create SS_DEMO workspaces + import (writes manifest)
uv run python scripts/teardown_seed.py         # remove everything afterwards
```

## Interactive app (fully browser-side)
A React + TypeScript SPA in `app/` runs the **entire scoring engine client-side** (ported to TS,
**parity-checked** against the Python engine) — drop a `.zip` of your exported TMDL and it scores in
the browser; **nothing leaves the machine**. Fancy UI: KPIs, an interactive similarity **heatmap**,
consolidation-cluster cards, promotion chains, needs-review, and a **"why" drill-down** (facet bars +
matched measures + side-by-side DAX diff). Ships as a single self-contained HTML.
```bash
cd app
npm install
npm run validate    # confirm TS engine == Python engine on ../models
npm run build       # -> app/dist/index.html (single self-contained file)
```
Promotable to a **Rayfin Fabric App** later (managed hosting + Entra SSO) — same frontend shape.

## Layout
```
semantic_sweep/   Python engine — parser · measures · lifecycle · score · report · cli
engine/           TypeScript engine — parity-checked against the Python engine
scripts/          enumerate_estate · export_models · make_sample_models · make_seed_models
                  · deploy_seed · teardown_seed · build_dashboard
sample_models/    synthetic, graded-overlap models for scoring calibration (committed)
seed_models/      synthetic, deployable near-duplicate control set (committed)
composite_demo/   synthetic composite (chained) semantic models for link detection
models/           exported TMDL (gitignored — real tenant metadata, never committed)
out/              report.md · results.json · similarity_matrix.csv (gitignored)
tests/            DAX sanity matrix · smoke tests · calibration · precision
app/              React+TS SPA — drop-a-zip, fully client-side engine + UI; single-file build
rayfin-app/       Rayfin Fabric App — live estate scan (Entra SSO, admin + per-user paths)
```

## Performance
Pure compute for 35 models / 595 pairs ≈ **2.6 s** (parse 1.3 s, score 1.4 s ≈ 2.3 ms/pair,
report 3 ms) — excludes `fab export` network I/O. Scoring is O(n²); for hundreds+ of models add the
deferred LSH blocking stage.

## Notes
- **Decision support, not auto-deletion** — flag candidates; a human confirms.
- `models/` and `out/` are gitignored: they hold real tenant metadata.
- MVP is **pure stdlib** (no embeddings/numpy) for portability; deferred enhancements include
  LSH blocking, embeddings, Hungarian matching, and a deployment-pipeline API.
