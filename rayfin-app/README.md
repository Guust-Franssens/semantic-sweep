# semantic-sweep - Rayfin Fabric App

Live, in-tenant estate scan for semantic-sweep. This is the app shown in the tour in the
[root README](../README.md): sign in with your Fabric identity, scan the semantic models you can
reach (or the whole tenant if you are a Fabric admin), and get the same evidence-backed duplicate
scoring that runs in the browser-only `app/`.

The scoring engine is the shared `engine/` (imported via `@engine/*`). This package adds Entra SSO,
live estate extraction over the Power BI / Fabric REST APIs, and per-user saved scans on a
Rayfin-managed SQL backend.

> Prefer a zero-setup demo? Use the browser-only `app/` instead: drop a `.zip` of exported TMDL and
> it scores fully client-side, with nothing leaving the machine. This `rayfin-app/` is for live,
> authenticated, in-tenant scans.

## Prerequisites

- A Microsoft Fabric capacity (trial or an F SKU) and a workspace you can deploy to.
- Node.js 18+ and npm.
- The Rayfin CLI, bundled as a dev dependency and invoked through the npm scripts below
  (see [microsoft/rayfin](https://github.com/microsoft/rayfin)).
- An Entra (Azure AD) SPA app registration for the Power BI scan token (step 1).
- Optional, for a tenant-wide scan: a Fabric admin identity plus Entra admin consent for
  `Tenant.Read.All`.

## 1. Register the Entra SPA app

The scan calls the Power BI / Fabric REST APIs on behalf of the signed-in user, so it needs its own
Entra app registration. The shipped code contains no client id: you provide your own.

1. In the Entra admin center, go to **App registrations**, **New registration**.
2. Supported account types: single tenant is fine for an internal tool.
3. Add a **Single-page application** platform with these redirect URIs:
   - `http://localhost:5173` (local dev)
   - your deployed app origin, for example `https://<your-app>.<region>.webapp.fabricapps.net`
4. Under **API permissions**, add **Power BI Service**, **Delegated**:
   - `Workspace.Read.All` (required: reads model metadata for the per-user scan).
   - `Tenant.Read.All` (optional: enables the whole-tenant admin scan through the Power BI Admin
     Scanner API. Requires Entra admin consent, and the signed-in user must hold a Fabric admin
     role).
5. Grant consent, then copy the **Application (client) ID** and **Directory (tenant) ID** for step 2.

The app requests the `https://analysis.windows.net/powerbi/api/.default` scope, so it uses exactly
the delegated Power BI permissions you consent above. Without `Tenant.Read.All` it falls back to a
per-user scan of the workspaces the signed-in user can open.

## 2. Configure environment

```bash
cp .env.example .env.local
# set VITE_FABRIC_SPA_CLIENT_ID and VITE_FABRIC_SPA_TENANT from step 1
```

The Rayfin-managed values (workspace id, item id, publishable key, API url) are written for you by
`rayfin up` / `rayfin env`. Do not hand-edit them.

## 3. Deploy and run

```bash
npm install

# Provision the Rayfin backend (auth + data) and run the UI locally at http://localhost:5173:
npm run dev

# Or deploy the full managed app (including static hosting) to your Fabric workspace:
npm run rayfin:up
```

After the first deploy, add the deployed app URL in two places so sign-in works:

- `rayfin/rayfin.yml`, under `services.auth.allowedRedirectUris`.
- the Entra app registration's SPA redirect URIs (step 1.3).

`npm run build:fabric` is the production build Rayfin uses for static hosting.

## Local UI preview (no backend)

To iterate on the UI with bundled sample data and no Fabric sign-in:

```bash
VITE_SS_LOCAL_PREVIEW=1 npm run dev:local   # http://localhost:5173
```

## Scan scopes

- **Per-user scan** (default): reads the semantic models in the workspaces the signed-in user can
  open. Models on paused capacities may be skipped.
- **Tenant-wide admin scan**: with `Tenant.Read.All` consented and a Fabric-admin identity, reads
  every model in the tenant through the Power BI Admin Scanner API, regardless of capacity.

Saved scans are stored per user in the app's Rayfin SQL backend (row-level security by user).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Provision the Rayfin backend and run the UI locally (http://localhost:5173) |
| `npm run dev:local` | Run the UI only, no backend (pair with `VITE_SS_LOCAL_PREVIEW=1`) |
| `npm run rayfin:up` | Deploy the full managed app to Fabric |
| `npm run build:fabric` | Production build used by Rayfin static hosting |
| `npm run test` | Unit tests (Vitest): engine parity, parser regression, banding, clusters, composite |
| `npm run lint` | Lint with ESLint |

See the [root README](../README.md) for how the scoring engine works and the browser-only `app/`.
