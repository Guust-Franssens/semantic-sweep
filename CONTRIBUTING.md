# Contributing

semantic-sweep has two implementations of one scoring engine, kept in parity:

- `semantic_sweep/` is the Python engine (reference), with the CLI and the calibration / precision
  tests.
- `engine/` is the TypeScript port, consumed by both `app/` (browser-only) and `rayfin-app/` (the
  Fabric App) through the `@engine/*` alias.

Any change to scoring or parsing must be made in **both** engines and stay in parity.

## Python

```bash
uv venv --python 3.11
uv sync
uv run pytest -q                 # DAX sanity, clusters, precision, calibration, parser
uv run ruff format .             # format
uv run ruff check . --fix        # lint
uv run pylint semantic_sweep     # naming + code quality (fail-under 10)
```

## TypeScript

```bash
cd app          # or: cd rayfin-app
npm install
npm test        # Vitest: banding, clusters, composite, precision, parser, ...
npm run build   # app/: single-file build. rayfin-app/: Fabric build
```

Engine parity (TypeScript vs Python) is checked from `app/`:

```bash
cd app && npm run validate       # requires an exported ../models estate
```

## Conventions

- Keep the two engines behaviourally identical. Add a matching test on both sides for any parser or
  scoring change (see `tests/test_parser.py` and `rayfin-app/src/__tests__/parser.test.ts`).
- `models/` and `out/` are gitignored: they hold real tenant metadata. Never commit them.
- Decision support, not auto-deletion: features rank and explain, a human confirms.
