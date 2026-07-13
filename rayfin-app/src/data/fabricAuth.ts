// MSAL helper that acquires a Power BI service token for the signed-in user — copied faithfully from
// Microsoft's pbi-fixer (awesome-rayfin/templates/pbi-fixer/src/services/fabricAuth.ts).
//
// Scope `https://analysis.windows.net/powerbi/api/.default` yields a Power BI service token that the
// Fabric REST endpoints under api.fabric.microsoft.com also accept — one token covers the scan.
//
// KEY (why the earlier version failed embedded in the Fabric portal): do NOT use ssoSilent — it loads
// login.microsoftonline.com in a hidden iframe, which the portal frame blocks (ERR_BLOCKED_BY_RESPONSE).
// Instead: silent (cached account) -> throw PbiSignInRequiredError -> acquireTokenPopup ONLY from a user
// gesture (button click), with prompt:'select_account'. The popup is the only reliable interactive path
// when embedded (AAD cannot be loaded via a same-frame redirect).

import { type AccountInfo, PublicClientApplication } from "@azure/msal-browser";

const ENV = import.meta.env as Record<string, string | undefined>;

// Non-secret identifiers — provide your own Entra SPA app registration + tenant via env
// (VITE_FABRIC_SPA_CLIENT_ID / VITE_FABRIC_SPA_TENANT). See README for the required API permissions.
const CLIENT_ID = ENV.VITE_FABRIC_SPA_CLIENT_ID || "";
const TENANT = ENV.VITE_FABRIC_SPA_TENANT || "";

const PBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

// Thrown when a token can't be obtained silently and interactive sign-in is required. The UI catches
// this and shows a "Sign in" button that calls signInToPbi() from the click handler (user gesture).
export class PbiSignInRequiredError extends Error {
  constructor() {
    super("Power BI sign-in required");
    this.name = "PbiSignInRequiredError";
  }
}

let pcaPromise: Promise<PublicClientApplication> | null = null;
let account: AccountInfo | null = null;

async function getPca(): Promise<PublicClientApplication> {
  if (!pcaPromise) {
    const pca = new PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: "localStorage" },
      // Silent renewal waits on a hidden iframe to login.microsoftonline.com; when that frame is
      // blocked (3rd-party cookies / portal embed) MSAL otherwise waits a long time. Cap the iframe
      // wait so acquireTokenSilent fails FAST and the UI falls back to the interactive button. (v3
      // name — popup completion uses windowHashTimeout, left at its default so URL polling can finish.)
      system: { iframeHashTimeout: 4000 },
    });
    pcaPromise = pca.initialize().then(() => {
      const accounts = pca.getAllAccounts();
      if (accounts.length > 0) account = accounts[0];
      return pca;
    });
  }
  return pcaPromise;
}

// Acquire a Power BI service token. Silent by default; throws PbiSignInRequiredError when an
// interactive prompt would be needed. Pass { interactive: true } ONLY from a user-gesture handler.
export async function getFabricToken(opts: { interactive?: boolean; loginHint?: string; forceRefresh?: boolean } = {}): Promise<string> {
  const pca = await getPca();
  try {
    const result = await pca.acquireTokenSilent({
      scopes: [PBI_SCOPE],
      account: account ?? undefined,
      forceRefresh: opts.forceRefresh, // bypass MSAL's access-token cache -> use the refresh token to
    }); //                                mint a fresh access token (self-heals an expired mid-scan token)
    account = result.account;
    return result.accessToken;
  } catch {
    if (!opts.interactive) throw new PbiSignInRequiredError();
    const result = await pca.acquireTokenPopup({
      scopes: [PBI_SCOPE],
      loginHint: opts.loginHint,
      prompt: "select_account", // the Fabric portal identity often differs from other signed-in accounts
    });
    account = result.account;
    return result.accessToken;
  }
}

// Start an interactive Power BI sign-in. MUST be called from a user-gesture handler so the popup is
// not blocked — the only reliable interactive path when embedded in the Fabric portal iframe.
export async function signInToPbi(loginHint?: string): Promise<string> {
  return getFabricToken({ interactive: true, loginHint });
}

export function currentAccountEmail(): string | null {
  return account?.username ?? null;
}

export async function signOutFabric(): Promise<void> {
  const pca = await getPca();
  await pca.logoutPopup({ account: account ?? undefined });
  account = null;
}
