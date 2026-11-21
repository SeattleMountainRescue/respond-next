# Review: Respond integration API (`rework/smr-integration-api-postgres`)

Reviewed commit: `29452b4` "Add PostgreSQL-backed Respond integration API" in
`SeattleMountainRescue/respond-next`, on top of `KingCountySAR/respond-next@4c7b26e`.
Compared with the November branch (`d48898bf5`). The branch `rework/smr-integration-api-20261104`
was deleted on 2026-11-20 and `archive/smr-integration-api-20261104` was never created, so that
commit is reachable by SHA only. Push it to a branch if you want to keep it.

This report is written for a coding agent to act on. Each work item has a goal, the evidence,
a proposed change and acceptance checks. File paths are relative to the respond-next root.

## Summary

The PostgreSQL port is sound at its core:
- Writes go through the activity actor's serial queue.
- The idempotency receipt is committed in the same transaction as the records.
- Connected clients receive the change through the normal broadcast.

The main problem is the design, not a bug. The API has its own permission system: a fixed
viewer plus about a dozen hand-written rules. It doesn't act through Respond's existing
group-based permissions. That makes it fit one unit's workflow and drift from what Respond's
screens allow. Respond's maintainers will want an API that any organization can use unchanged,
so this is the first thing to fix. It also brings back mission and event creation, which the
November version had and the port dropped.

The other items fall into four groups:
1. Two correctness bugs on the write path.
2. Missing efficiency features: change signal, filters, batching.
3. Documentation gaps.
4. Test gaps.

Test run at `29452b4`:
- `npm run test:unit`: 246 passed, 3 skipped. The skips are the Postgres storage suite, which
  had no local Postgres at `localhost:5433`, so the Postgres receipt path was not exercised.
- `npm run typecheck`: clean.

Severity: **P1** blocks a credible proposal. **P2** should fix. **P3** is cleanup.

---

## P1-1. Act as a real person through Respond's own permissions; drop the parallel permission system

**Goal:** an integration can do exactly what its user could do in Respond's screens, no more
and no less, for any organization, with no integration-specific authorization rules.

**Evidence:**
- `server/src/integration.ts:107-109` builds a synthetic viewer `integration:<keyId>`.
- Reads use tier `respond` (`:126`, `:134`). Writes use tier `manage` (`:164`), whatever the
  key's organization's people are allowed.
- `prepare()` (`:57-101`) then hand-codes the limits. Each of these duplicates or contradicts a
  rule in `packages/domain/src/mutations/*`:
  - "only your unit's responders"
  - "unit status only on your own missions"
  - "assignments on missions only, teams only"
  - "no team-leader moves"
- Keys carry their own permission list (`:19`): `read`, `participants:write`,
  `assignments:write`, `unit-status:write`.
- Respond already derives a person's rights from their groups and per-mission grants at sign-in:
  `server/src/signIn.ts:36-39` (`access()`: tier from groups, plus `grants.forPerson`). The
  mutations enforce those rights, for example `packages/domain/src/mutations/activity.ts:31`
  ("Only a manager can create a mission").

**Proposed change:**
1. Bind each key to a person in the organization's directory: a service member the unit
   chooses (`personRef`), plus the organization id.
2. On each request, build the viewer exactly as a signed-in session would: call `access()`
   from `signIn.ts`, or the shared function behind it, to get tier and grants. Set `siteId` to
   the key's organization.
3. Replace the six fixed operation types with the domain mutations the screens already send,
   by name and args, validated by each mutation's own schema. Examples: `createActivity`,
   `updateActivity`, `addParticipant`, `setParticipantStatus`, `assign`, `setUnitStatus`.
   Let the mutations allow or refuse.
4. Keep only what a server caller needs on top:
   - `expectedVersion`
   - the idempotency key and receipt
   - the body limit
   - a list of mutations allowed over the API (see below)
5. Delete the hand-written scope checks in `prepare()`, and the per-key permission list, unless
   the maintainers want an extra cap. If they do, make it a narrowing filter on mutation names,
   never a grant of rights the person lacks.
6. Attribute changes to the bound person, so Respond's history shows who did it.

**Which mutations to allow:** default to the ones a member-facing screen uses. Leave out admin
and organization-configuration mutations.

**Acceptance:**
- A key bound to a person without manager rights gets `forbidden` on `createActivity` with
  `kind: 'mission'`. The same key succeeds with `kind: 'event'`. Swapping in a manager's
  `personRef` flips the first result.
- Removing the person from the qualifying group, with no config change, removes the right on the
  next request.
- No integration-specific authorization branch is left in `server/src/integration.ts`
  (grep for `Rejection('forbidden'`).
- The same test suite passes for two synthetic organizations with different providers. No
  organization id appears in non-test code.

## P1-2. Mission and event creation, plus editing details

**Goal:** an integration can create a mission or an event and fix its details, under the same
rules as the screens.

**Evidence:**
- November `d48898bf5:docs/integration-api.md:83-84` had `POST /api/v1/missions` and
  `POST /api/v1/events`, gated by the organization's creation flags.
- The port says it "cannot create or edit missions or teams" (`docs/integration-api.md`, Push).

**Proposed change:** this comes for free with P1-1 (`createActivity`, `updateActivity`).
Make sure of three things:
1. **Owner:** `ownerOrgId` is forced to the key's organization. A caller can't create for
   another organization.
2. **Retry safety:** creation is retry-safe through the idempotency key. The receipt for a
   create returns the new activity id. Today's receipts are scoped per activity
   (`packages/sync-server/src/activityActor.ts:189-190`), which doesn't work for a create,
   because there's no activity yet. Store create receipts at the organization level.
3. **External reference:** add an optional `externalRef`, stored on the activity, readable in
   detail and list, and filterable. A client can then find its own activity again without
   matching on number or start time.

**Acceptance:**
- Retrying a create with the same key returns the same activity id, and the activity count
  doesn't change.
- `GET /activities?externalRef=...` returns exactly that activity.

## P1-3. Keys an organization's own admin can issue

**Goal:** any unit can start using the API without Respond's maintainers editing server
configuration.

**Evidence:** keys come only from the `INTEGRATION_API_KEYS` environment variable
(`server/src/integration.ts`, `integrationKeys`). Adding or revoking one means a deploy or
restart by whoever runs the server.

**Proposed change:**
1. Store keys in Postgres: id, organization, bound `personRef`, SHA-256 hash, created-by,
   created-at, last-used-at, revoked-at.
2. Add a screen in organization admin to issue a key (shown once), name it, see when it was last
   used, and revoke it.
3. Keep the environment variable only as an optional bootstrap, or remove it.

**Acceptance:**
- An organization admin issues a key, uses it, revokes it, and the next request gets 401, with
  no restart.
- An admin of organization A can't see or revoke organization B's keys.

---

## P2-1. A committed request's retry can be refused, then resent and applied twice

**Evidence:** `packages/sync-server/src/activityActor.ts:187-190`. The `this.stale` check
returns `stale_version` before the receipt lookup. Verified by reading the code.

**Scenario:**
1. A request commits, but the response is lost.
2. The actor is marked stale.
3. The client retries with the same key and gets `409 stale_version`.
4. The doc tells it to pull and resend under a new key.
5. A `status` sent without `at` gets a new `now` and is applied a second time.

**Fix:** look up the receipt before the stale and version checks. Keep the hidden-activity check
first.

**Acceptance:** add a test that commits, marks the actor stale, retries with the same key, and
gets the original version.

## P2-2. Any change anywhere on the activity makes the caller's write stale

**Evidence:**
- `activityActor.ts:196` compares `expectedVersion` with the whole activity's version.
- Respond's own background writes also move it. The review reported that `onCommit` in
  `server/src/memberInfo.ts` writes `setMemberInfo` after a participant is added; check this
  before fixing.

**Scenario:** on a busy mission, every other unit's status change and every system write turns
the caller's next write into 409. A background writer then loops: read, write, 409.

**Fix (choose one, and document it):**
- Make `expectedVersion` optional and add a per-record precondition, such as
  `expectedParticipantVersion` (records already carry `version`, as seen in detail output).
- Or compare only the records the mutation touches.

**Acceptance:** an unrelated participant's status change between read and write doesn't refuse
the write. A change to the same participant does.

## P2-3. Cheap change detection: a webhook, a version in the list, filters

**Goal:** a client re-reads only what changed, and Respond serves far fewer full-roster reads.

**Evidence:**
- The list strips each summary's version: `server/src/integration.ts:127`,
  `.map(({ version: _, ...summary }) => summary)`.
- The list takes no parameters (`:123-127`).
- The doc says "a sync client must fetch detail at its chosen cadence". So every client polls
  every open activity's full detail.

**Proposed change:**
1. **Version:** keep `version` on list summaries.
2. **Filters:** `GET /activities?open=true`, `?since=<epoch ms>` for activities changed after a
   time, and `?externalRef=`.
3. **Not changed:** detail answers `ETag: <version>` and `304 Not Modified` to `If-None-Match`.
4. **Webhook:** an outbound webhook per key, set up by the organization admin.
   - The payload is thin: `{ activityId, version, changedAt }`, with no record data. Even a
     forged call can then only cause the receiver to re-read through its own key.
   - Signing: HMAC-SHA256 over `timestamp + "." + body` with a per-webhook secret, sent as
     `X-Respond-Signature` and `X-Respond-Timestamp`. Receivers reject anything older than five
     minutes.
   - Delivery: retry with backoff, at least once; the payload is idempotent by `version`.
   - Fire only for activities the key's person can see.

**Acceptance:**
- Two list reads with no change in between return identical versions.
- A detail read with a matching `If-None-Match` gets 304.
- A status change causes one signed webhook call with the new version, and the signature checks
  out with the shared secret.

## P2-4. Several changes in one request

**Evidence:** one operation per POST (`docs/integration-api.md`, Push). A check-in that sets
status, ETA and mileage takes three calls, each needing a fresh version, which makes P2-2 worse.
A training roster of 20 people takes 20.

**Proposed change:**
- Accept `operations: [...]`, at most about 50, applied in one actor turn and one commit, under
  one idempotency key.
- Choose between all-or-nothing (simplest) and a result per item. Document the choice.

**Acceptance:** a batch of status, ETA and mileage for one person makes one commit and one
version bump, and a retry returns the same result.

## P2-5. Removed versus not visible

**Evidence:** `server/src/integration.ts:135`. Removed, missing and invisible activities all
return 404, and the doc says a 404 "is not proof of deletion". So a client can never learn that
an activity was removed.

**Fix:** for an activity the caller could see before it was removed, return `410 Gone` with
`{ removedAt }`. Or list removed activities in `?since=` results with `removedAt` set. Keep 404
for anything never visible.

## P2-6. A server error is reported as a conflict

**Evidence:** `server/src/integration.ts:187` maps every refusal reason except `not_found`,
`forbidden` and `bad_args` to 409, including `internal`.

**Fix:** return 500 for `internal`, so clients follow the doc's "retry with the same key" advice.

## P2-7. Sanity limits on caller-supplied values

**Evidence (reported by review; verify):** `server/src/integration.ts:24`, `:28-31`. A status
`at` needs only to be after the last status, and a first-status `at` can be any positive epoch,
including 1970. ETA and mileage have no upper limit.

**Fix:**
- Reject an `at` before the activity's start minus a small allowance.
- Cap ETA, for example at 7 days ahead.
- Cap mileage, for example at 2,000.
- Return a named error for each.

---

## P3-1. Dead check in the detail read

`server/src/integration.ts:140`: `result.view === 'manage'` never matches in production, because
view keys are site-qualified (`manage@<site>`, see `packages/domain/src/projector.ts:184-189`).
A throwaway test with a training activity showed team notes already hidden, so it doesn't leak.
Either delete the line or compare the key part before `@`. P1-1 likely removes it anyway.

## P3-2. Document every response

`docs/integration-api.md` documents only `409 stale_version`. Document every status and error
code, with when it happens and whether to retry:

| Status | When |
|---|---|
| 404 | the API is disabled |
| 401 `unauthorized` | the key is wrong or revoked |
| 403 `forbidden` | the person lacks the right |
| 400 | `invalid_idempotency_key`, `invalid_json`, `bad_args` |
| 413 | `body_too_large` |
| 415 | `expected_json` |
| 502 / 503 | `directory_unavailable` |
| 409 | every refusal reason: `closed`, `stale_time`, `standby_only`, `participant_exists`, `idempotency_conflict`, `at_in_future`, `stale_version`, and mutation-rule refusals |

Also document that an ETA more than 5 minutes in the past is refused, and that `unit-status` and
`assignment` use server time.

## P3-3. Tests that would catch a broken limit

`server/__tests__/integration.test.ts:16-18` uses one key with every permission, so deleting a
scope check still passes. After P1-1, test with keys bound to people of different tiers. Also
cover:
- the list endpoint and its site filtering
- a refused request leaving the key free to reuse
- 413 and 415
- a closed activity
- creation and retried creation
- a batch
- the webhook signature
- P2-1's stale-then-retry case

Run the Postgres storage suite against a local Postgres. It was skipped in this review.

## P3-4. Guests

`first-status` accepts only people found in the organization's directory
(`server/src/memberProviders.ts`, `lookupInOrganization`). If Respond's screens let a manager add
a guest who isn't in the directory, P1-1 inherits that through `addParticipant`. If not, leave it.

---

## Out of scope for now

Using the API to push a whole mission's teams and other units' people from an outside mission
board. It needs team create and edit, and changes to other organizations' people, which belong
to Respond's own rules and to each organization.

## Suggested order

1. P2-1. It's small and stands alone.
2. P1-1, then P1-2. P3-1 falls out of P1-1.
3. P1-3.
4. P2-3, P2-4, P2-2.
5. P2-5, P2-6, P2-7.
6. P3-2 and P3-3, alongside each change.
