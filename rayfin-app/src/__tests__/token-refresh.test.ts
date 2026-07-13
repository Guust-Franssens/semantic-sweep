import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkspaces } from "../data/fabric";

// Minimal Response stand-in for the fetch mock (only the fields authedFetch/getJson read).
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("authedFetch mid-scan token refresh (imp-c5)", () => {
  it("silently refreshes on a 401 and retries the same request with the fresh token", async () => {
    const provider = vi.fn(async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? "fresh" : "expired"));
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String((init.headers as Record<string, string>).Authorization ?? "");
      seen.push(auth);
      return auth.includes("expired") ? res(401, {}) : res(200, { value: [{ id: "w1", displayName: "Prod" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ws = await listWorkspaces(provider);

    expect(ws.map((w) => w.id)).toEqual(["w1"]);
    expect(seen[0]).toContain("expired"); // first attempt used the stale token -> 401
    expect(seen[1]).toContain("fresh"); //  retried with the silently-renewed token -> 200
    expect(provider).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("does NOT retry a 403 (genuine authorization failure) and surfaces it unchanged", async () => {
    const provider = vi.fn(async () => "tok");
    vi.stubGlobal("fetch", vi.fn(async () => res(403, {})));

    await expect(listWorkspaces(provider)).rejects.toThrow(/403/);
    expect(provider).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("refreshes at most once when renewal is futile (pasted token) — surfaces the 401, no loop", async () => {
    const provider = vi.fn(async () => "stale"); // can't actually renew — always the same token
    const fetchMock = vi.fn(async () => res(401, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listWorkspaces(provider)).rejects.toThrow(/401/);
    expect(provider).toHaveBeenCalledTimes(2); // initial token + exactly one (futile) forced refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
