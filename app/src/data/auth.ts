// Browser sign-in for Fabric via MSAL (Entra ID). "Sign in with Microsoft" acquires an access token
// for the Fabric REST API on the user's behalf — no pasted token, no az CLI.
//
// One-time setup (per tenant): register an Entra app as a *Single-page application*, add this app's
// origin as a redirect URI, and grant a delegated Fabric permission (or admin-consent the scope).
// The client ID can come from a build env (VITE_ENTRA_CLIENT_ID) or be entered in the UI (localStorage).
//
// NOTE: MSAL redirect/popup needs an http(s) origin — it does not work from a file:// build. The
// paste-token fallback remains for that case.

import { type AccountInfo, InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";

const FABRIC_SCOPES = [
  "https://api.fabric.microsoft.com/Workspace.Read.All",
  "https://api.fabric.microsoft.com/Item.ReadWrite.All",
];
const LS_CLIENT = "ss.entra.clientId";
const LS_TENANT = "ss.entra.tenant";

export interface AuthConfig {
  clientId: string;
  tenant: string;
}

const ENV = import.meta.env as Record<string, string | undefined>;
const envClient = ENV.VITE_ENTRA_CLIENT_ID ?? "";
const envTenant = ENV.VITE_ENTRA_TENANT ?? "organizations";

export function getConfig(): AuthConfig {
  return {
    clientId: (localStorage.getItem(LS_CLIENT) ?? envClient).trim(),
    tenant: (localStorage.getItem(LS_TENANT) ?? envTenant).trim() || "organizations",
  };
}

export function setConfig(c: AuthConfig): void {
  localStorage.setItem(LS_CLIENT, c.clientId.trim());
  localStorage.setItem(LS_TENANT, (c.tenant || "organizations").trim());
  pca = null; // recreate the client with the new config on next use
}

export const authConfigured = (): boolean => getConfig().clientId.length > 0;

// Redirect/popup auth requires a proper web origin — a downloaded file:// build cannot use it.
export const canSignIn = (): boolean => location.protocol === "http:" || location.protocol === "https:";

let pca: PublicClientApplication | null = null;
let initPromise: Promise<void> | null = null;

async function instance(): Promise<PublicClientApplication> {
  const { clientId, tenant } = getConfig();
  if (!clientId) throw new Error("No Entra app (client) ID configured.");
  if (!pca) {
    pca = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
        redirectUri: location.origin,
      },
      cache: { cacheLocation: "localStorage" },
    });
    initPromise = pca.initialize();
  }
  await initPromise;
  return pca;
}

export function getAccount(): AccountInfo | null {
  if (!pca) return null;
  return pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
}

// Restore a cached session on mount (best-effort); returns the account if already signed in.
export async function restoreAccount(): Promise<AccountInfo | null> {
  if (!authConfigured() || !canSignIn()) return null;
  await instance();
  return getAccount();
}

export async function signIn(): Promise<{ token: string; account: AccountInfo }> {
  const p = await instance();
  let account = p.getActiveAccount() ?? p.getAllAccounts()[0] ?? null;
  if (!account) {
    const res = await p.loginPopup({ scopes: FABRIC_SCOPES });
    account = res.account;
  }
  p.setActiveAccount(account);
  const token = await acquireToken();
  return { token, account };
}

export async function acquireToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const p = await instance();
  const account = p.getActiveAccount() ?? p.getAllAccounts()[0] ?? undefined;
  if (!account) throw new Error("Not signed in.");
  try {
    const res = await p.acquireTokenSilent({ scopes: FABRIC_SCOPES, account, forceRefresh: opts.forceRefresh });
    return res.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      const res = await p.acquireTokenPopup({ scopes: FABRIC_SCOPES });
      return res.accessToken;
    }
    throw e;
  }
}

export async function signOut(): Promise<void> {
  if (!pca) return;
  await pca.logoutPopup({ account: getAccount() ?? undefined });
  pca.setActiveAccount(null);
}
