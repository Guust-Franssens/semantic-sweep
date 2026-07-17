import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory fake of the Rayfin fluent data client for ScanDecision, enough to exercise the store's
// query/create/delete calls without a backend.
interface Row {
  id: string;
  user_id: string;
  member_id: string;
  keeper_id: string;
  status: string;
  updated_at: string;
}
let rows: Row[] = [];

function makeQuery() {
  let cond: Record<string, { eq: unknown }> = {};
  const builder = {
    select() {
      return builder;
    },
    where(c: Record<string, { eq: unknown }>) {
      cond = c;
      return builder;
    },
    first() {
      return builder;
    },
    async execute() {
      return rows.filter((r) => Object.entries(cond).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v.eq));
    },
  };
  return builder;
}

vi.mock("../services/rayfinClient", () => ({
  getRayfinClient: () => ({
    data: {
      ScanDecision: {
        select: () => makeQuery(),
        create: async (row: Row) => {
          rows.push({ ...row });
        },
        delete: async ({ id }: { id: string }) => {
          rows = rows.filter((r) => r.id !== id);
        },
      },
    },
  }),
  isLocalBackend: () => false,
}));

import { listDecisions, setDecision } from "../data/scanStore";

describe("scanStore consolidation decisions", () => {
  beforeEach(() => {
    rows = [];
  });

  it("stores a real decision and lists it as a member->status map", async () => {
    await setDecision("u1", "wsA/Sales", "wsB/SalesKeeper", "Approved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "u1",
      member_id: "wsA/Sales",
      keeper_id: "wsB/SalesKeeper",
      status: "Approved",
    });
    expect(await listDecisions("u1")).toEqual({ "wsA/Sales": "Approved" });
  });

  it("upserts by (user_id, member_id) so there is never a duplicate row", async () => {
    await setDecision("u1", "wsA/Sales", "wsB/K", "Approved");
    await setDecision("u1", "wsA/Sales", "wsB/K", "Done");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Done");
    expect(await listDecisions("u1")).toEqual({ "wsA/Sales": "Done" });
  });

  it("resetting to the default (Proposed) deletes the row", async () => {
    await setDecision("u1", "wsA/Sales", "wsB/K", "Approved");
    await setDecision("u1", "wsA/Sales", "wsB/K", "Proposed");
    expect(rows).toHaveLength(0);
    expect(await listDecisions("u1")).toEqual({});
  });

  it("scopes decisions to the given user", async () => {
    await setDecision("u1", "wsA/Sales", "wsB/K", "Approved");
    await setDecision("u2", "wsC/HR", "wsD/K", "Done");
    expect(await listDecisions("u1")).toEqual({ "wsA/Sales": "Approved" });
    expect(await listDecisions("u2")).toEqual({ "wsC/HR": "Done" });
  });
});
