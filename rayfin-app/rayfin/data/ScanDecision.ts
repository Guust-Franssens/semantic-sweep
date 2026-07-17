import { authenticated, entity, text, uuid } from '@microsoft/rayfin-core';

// A human's consolidation decision on one recommendation (the model being retired/redirected), so the
// human-in-the-loop call survives refresh, tab switches, and re-scans instead of living only in React
// state. Keyed by member_id (the modelId = "workspace/name" of the non-keeper), so the same duplicate
// keeps its status across re-scans of the estate. "Proposed" is the implicit default and is never
// stored (the store deletes the row when a status is reset), so this table only holds real decisions.
//
// SECURITY NOTE: same caveat as SavedScan/ScanChunk. This policy scopes read/update/delete to the
// signed-in user, but Data API Builder does not support database policies on the `create` action, so
// user_id is unenforced on insert. See rayfin-app/SECURITY.md.
@entity()
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ScanDecision {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @text({ max: 400 }) member_id!: string; // modelId of the model this decision retires/redirects
  @text({ max: 400 }) keeper_id!: string; // modelId of the keeper it redirects into
  @text({ max: 40 }) status!: string; // Approved | In progress | Done (Proposed is the unstored default)
  @text({ max: 40 }) updated_at!: string; // ISO 8601
}
