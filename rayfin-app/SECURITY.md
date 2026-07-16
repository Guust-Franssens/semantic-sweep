# Security notes for rayfin-app

## Known limitation: `user_id` is not server-enforced on create (SavedScan, ScanChunk)

**Status:** confirmed, unmitigated at the platform level. Documented here per project decision, no
code fix shipped (see "Why this isn't fixed in code" below).

### Summary

`SavedScan` and `ScanChunk` (`rayfin/data/SavedScan.ts`, `rayfin/data/ScanChunk.ts`) both declare:

```ts
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
```

The intent is that every row is scoped to its owner: only the signed-in user whose JWT `sub` claim
matches `user_id` can read, update, or delete it. That intent **is** correctly enforced by Data API
Builder (DAB) for `read`, `update`, and `delete`. It is **not** enforced for `create`.

### Root cause

Data API Builder does not support database policies on the `create` action:

| Action | Supported | How it works |
| --- | --- | --- |
| `read` | Yes | Adds a WHERE predicate to SELECT queries |
| `update` | Yes | Adds a WHERE predicate to UPDATE statements |
| `delete` | Yes | Adds a WHERE predicate to DELETE statements |
| `create` | **No** | INSERT statements don't support WHERE predicates |

(Source: [Microsoft Learn, "Configure database policies for row-level filtering"](https://learn.microsoft.com/en-us/azure/data-api-builder/concept/security/database-policies).)

Rayfin's compiler (`@microsoft/rayfin-core`, `analysis/schema-analyzer.js`) takes the single `'*'`
action from `@authenticated('*', { policy })` and emits one DAB permission entry covering all four
CRUD actions with the same policy string. It does not expand `'*'` into per-action entries, and does
not special-case or warn about `create` being a no-op for policies. Rayfin's own official docs
(`rayfin-core:permissions.md` "Row-level policy" section, and `rayfin-guide:data/permissions.md`
"Basic example") both demonstrate this exact `@authenticated('*', {policy...})` / `@role(...,
['create', 'read', 'update', 'delete'], {check...})` pattern as their canonical row-scoping example,
with no caveat that `create` is exempt. So this app followed the documented, recommended pattern
exactly; the gap is in the DAB/Rayfin permission model, not an app-code mistake.

### Practical impact

Because `create` has no enforced policy, `user_id` on a new `SavedScan`/`ScanChunk` row is only as
trustworthy as the caller. The SPA (`src/data/scanStore.ts`) always sends the current signed-in
user's own id, but nothing stops a caller who bypasses the SPA (e.g. a direct HTTP request to the DAB
REST/GraphQL endpoint with a valid bearer token) from setting `user_id` to an arbitrary value,
including someone else's real `sub` claim.

- This is **not** a direct read/data-leak vulnerability: `read` policies are enforced correctly, so a
  user can never fetch another user's genuine rows via the app or the API.
- It **is** a data-integrity / spoofing risk: an attacker who knows or guesses a victim's `sub` claim
  could plant fabricated `SavedScan`/`ScanChunk` rows with `user_id = victim's sub`. Those rows would
  later be returned by the victim's own legitimate `listScans()` / `loadLatest()` / `loadScan()` calls
  (the read policy only checks "does this row's user_id match my own claim", which is true for a
  forged row too) and rendered in the victim's UI as if they were their own saved scans.
- Blast radius here is limited by context: this is an internal hackathon/demo tool, the "victim" data
  is scan results (workspace/model metadata), not secrets or PII, and exploitation requires a valid
  authenticated session plus knowledge of another user's `sub` claim.

### Why the existing readback check is not a fix

`saveScan()` in `scanStore.ts` reads the just-written `SavedScan` row back under the caller's own
identity and deletes it if that fails. This exists to catch a *different*, accidental bug (JWT `sub`
truncation in some Fabric-hosted environments causing a self-mismatch), not malicious forgery. An
attacker forging another user's `user_id` never fails this check, because the check runs under the
attacker's own request/session, and the attacker isn't trying to read the row back as the victim.
There is no client-side or app-code check that can close this gap: the vulnerable path is a direct
call to the DAB endpoint that bypasses this file entirely.

### Why this isn't fixed in code in this pass

Closing this properly requires binding `user_id` server-side from validated request identity,
independent of the client payload. Options considered:

1. **A server-side compute layer that rebinds `user_id` before insert.** Rayfin has a `functions`
   service toggle in `rayfin.yml` (currently `enabled: false`), which maps to an Azure Functions
   integration, but as of `@microsoft/rayfin-core` 1.33.x this is undocumented: none of the 33 guide
   pages installed with the CLI describe how to define a function, how it would receive/validate
   claims, or whether it can front DAB's auto-generated create endpoint at all. Building on it would
   mean reverse-engineering an unreleased/unsupported feature for a security control, which is worse
   than not fixing it.
2. **DAB claims-to-`SESSION_CONTEXT` + a stored procedure that reads the session context instead of a
   client-supplied column.** `execute` actions also don't support database policies, and stored
   procedures aren't expressible in Rayfin's declarative `@entity` schema model; this would require
   direct DB/DAB-config changes outside Rayfin's deployment pipeline.
3. **A database trigger that overwrites `user_id` from `SESSION_CONTEXT` on insert.** Requires direct
   database/infra access outside Rayfin's declarative config; not currently available in this project.

None of these are achievable purely through this repo's application code without either depending on
an undocumented platform feature or making out-of-band infrastructure changes. If/when this app moves
past hackathon/demo stage, option 1 (once Rayfin documents and stabilizes `functions`) or option 2 are
the recommended paths — whichever lands first upstream.

### Recommendation if this goes beyond a demo

- Track Rayfin's `functions` support; once documented, add a thin create handler that ignores the
  client's `user_id` and substitutes the value from the validated token's `sub` claim.
- Alternatively, ask upstream Rayfin/DAB whether a "computed/claims-bound field" concept (a column
  always set from claims, never client-writable, on `create`) could be added, since the current
  `include`/`exclude` field-permission mechanism only controls visibility, not value substitution.
- Until then, do not treat this app's saved-scan history as tamper-proof against another authenticated
  user of the same deployment.
