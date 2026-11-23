# Review round 2: Respond integration API (`3c980a2`)

**Reviewed commit:** `3c980a2` "Address review of Respond integration API", on
`rework/smr-integration-api-postgres` in `SeattleMountainRescue/respond-next`.
- Base: `KingCountySAR/respond-next@4c7b26e`.
- Full change: `git diff 4c7b26e 3c980a2`.
- Round 1 report: `docs/integration-api-review.md` on the `review/smr-integration-api-postgres`
  branch.

This brief was itself reviewed twice by Codex and by Claude (Fable 5.2) against the code at
`3c980a2`, and corrected after each pass.

**Who this is for:** one coding session that fixes this round in a single pass. Every item
reuses code Respond already has. Nothing here asks for a new subsystem; designs that would need
one are listed in section 6 as follow-ups, not work for this round.

## 0. How to use this document

1. Read sections 1–3 first. They hold the decisions; don't re-decide them. If one looks wrong,
   say so in the reply and do the rest.
2. Do the work items in section 4 in order.
3. Each item ends with **Done when**. An item is finished only when all its checks pass.
4. Run section 5 last, and paste its output into the reply.
5. Add nothing this document doesn't ask for. Anything else you notice goes into the reply as a
   note.

**Facts this brief relies on:**
- **Not deployed:** nothing at `3c980a2` has been deployed anywhere. So change the
  `CREATE TABLE` statements directly. No upgrade migration, backfill or old-key handling is
  needed.
- **Test setup:** Postgres-backed tests run with
  `docker run --rm -d --name api-pg -p 5433:5432 -e POSTGRES_USER=sync -e POSTGRES_PASSWORD=sync -e POSTGRES_DB=sync postgres:18.6-alpine`
  and `TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/sync npx vitest run`. At
  `3c980a2`: 374 passed, 0 skipped, and `npm run typecheck` is clean.
- **Keys need Postgres:** after W1, keys exist only with a database pool
  (`server/src/organizations.ts:161`). Every key test must run under `TEST_DATABASE_URL`. Mark
  them the way `server/__tests__/integration.test.ts:199` does, and make sure the run above has
  0 skipped.

**Keep all of this as it is:**
- **Replay before stale:** the receipt check runs before the stale check
  (`packages/sync-server/src/activityActor.ts:197-199`).
- **Create id:** derived from the request key (`server/src/integration.ts:247-248`).
- **Batches:** all-or-nothing in one actor turn, with one version bump.
- **Detail reads:** ETag and 304, and 410 only after the visibility check.
- **Webhook signing:** HMAC over `timestamp.body`, the secret stored encrypted, operator-set
  HTTPS targets with `redirect: 'error'`, and the claim lease plus `attempts` guard
  (`organizations.ts:228-252`).
- **Key handling:** constant-time hash compare, the token shown once, and the reserved
  `integration:` client id.
- **`expectedParticipantVersion`:** keep it for `setEta`/`setMiles` batches, but see W8.

## 1. Where round 1 misled you

- **It left the old operations optional.** Round 1 P1-1 said to replace the six fixed
  operations "unless the maintainers want an extra cap", so both paths survived.
- **It asked for limits in the wrong layer.** Round 1 P2-7 asked for ETA, mileage and time
  limits in the API. That makes the API stricter than the screens.
- **It never said where the change signal should come from.** Round 1 P2-3 asked for a version
  on list summaries without saying where it would come from. Storing it in the shared archive
  summary added load on every site.

## 2. The principle

> **An API key is a person.** For the operations the API exposes, a key can do and see exactly
> what its person could do and see in Respond's screens, for any organization and member
> provider. The API adds only what a server caller needs: key authentication, version checks,
> idempotency, the body limit, webhooks and error mapping.

- **Exposed operations:** the eight in `NativeAction` (`integration.ts:56-66`):
  - `createActivity`, `updateActivity`
  - `addParticipant`, `setParticipantStatus`, `setEta`, `setMiles`
  - `assign`, `setUnitStatus`

  Adding more (close or reopen, team editing, corrections) is a later, separate change.
- **Where the API checks a choice the screens offer** (owner, unit), it uses the same server
  data and the same shared function the screens use. It never writes a rule of its own.

## 3. Decisions (don't re-decide)

| # | Decision | Why |
|---|---|---|
| D1 | A person can issue keys **only for themselves**. Org admins can list and revoke any key in their organization, but can't issue one for someone else. | Binding a key to another person is impersonation. Because a key always acts as its issuer, the existing history attribution is already truthful, so no attribution change is needed. |
| D2 | Delete the six convenience operations (`Change`, `prepare`, `permission`, the fallback route branch), the `INTEGRATION_API_KEYS` environment keys and per-key `permissions`. | Two permission systems drift apart. |
| D3 | A key's only narrowing is a scope chosen at issue time: `read` or `write`. | Simple. A key can still never exceed its person. |
| D4 | A key authenticates the way a session does: the same person lookup, tier and grants (`refreshSession`, `server/src/signIn.ts:85-88`), and the same viewer builders (`viewerOf`, `viewerOn`, `server/src/app.ts:76-80`), on the key's site. | `accessInOrganization` is stricter than sign-in: it needs a provider and unit match (`server/src/memberProviders.ts:59-65`). A person who can use a site's screens could then be unable to hold a key there. |
| D5 | Owner and unit choices are checked against what the screens offer, using the server's `orgs.siteConfig(site, …).organization` (`organizations.ts:492-506`) and the shared `ownerOptions` (`packages/domain/src/site.ts:43-46`). This replaces `owner_fixed` and the API's `canCreate*` check. No domain change. | The screens let a creator pick the owner from the site plus partners flagged for that kind, and let edits change it (`web/src/sections/respond/activityDraft.ts:104,140,201,212`). |
| D6 | Remove the API-only limits: `eta_too_far`, `mileage_too_high`, `status_before_window` and the past-ETA check. | Stricter than the screens. |
| D7 | Undo the `activityVersion` and `changedAt` fields in the archive summary, and drop the `since` filter. The change signal for this round is the webhook plus conditional detail reads. A change feed is a follow-up (section 6). | The summary change makes every commit on every site push to `$archive`. A correct feed over `mutation_log` needs its own design: rows commit out of `seq` order, rejected entries are logged, and imports have no log. |
| D8 | Keep Nick's webhook outbox and its operator-approved targets, with the fixes in W6: one row per key and activity, no lost newer version, and the shared identity helper. | It's already safe against server-side request forgery, and the fixes bound its growth. Self-service webhook URLs are a follow-up. |

## 4. Work items, in order

### W1. Delete the second permission system and the env keys (D2, D3)

**Change:**
1. **Delete from `server/src/integration.ts`:**
   - `Change` (`:43-51`)
   - `permission` (`:52-55`)
   - `prepare()` (`:100-160`)
   - the fallback branch of `POST /activities/:id/changes` (`:313-335`)
   - `integrationKeys()` (`:85-98`) and the `keys` parameter of `integrationRoutes`
   - `nativePermission` and `allows()`
2. **Scope:** add `scope text NOT NULL CHECK (scope IN ('read','write'))` to the
   `integration_keys` `CREATE TABLE` (`organizations.ts:44`). Select it in `integrationKey`.
   - `GET` routes need `read` or `write`.
   - `POST` routes need `write`.
   - A wrong scope gets `403 forbidden_scope`.
3. **Remove `INTEGRATION_API_KEYS`** from `server/src/main.ts`, `README.md`, `docs/` and the
   tests. The API is enabled when `organizations.managesIntegrationKeys` is true; otherwise every
   route returns 404, as now.
4. **Change route:** it parses only `NativeBatch`. A body that fails to parse returns
   `400 bad_args`, with the first zod issue as `message`.
5. **Delete `:293`** (the `updateActivity` `ownerOrgId` refusal). The screens send `ownerOrgId`
   on every edit; W4 handles it instead.

**Done when:**
- `grep -n "Rejection('forbidden'" server/src/integration.ts` prints nothing.
- `grep -rn "INTEGRATION_API_KEYS\|nativePermission\|prepare(change" server docs README.md`
  prints nothing.
- **T1:** a `read` key gets 403 `forbidden_scope` on both POST routes, and 200 on the GETs.
- **T2:** a `write` key bound to a person without manager rights, on a site that allows
  missions, is refused `createActivity` with `kind: 'mission'`. It's refused by the domain rule
  at `packages/domain/src/mutations/activity.ts:31` (`forbidden`, "Only a manager can create a
  mission"), and the response `message` proves where the refusal came from. The rule is at
  `activity.ts:32`. The same key
  succeeds with `kind: 'training'`.

### W2. Self-issued keys; authenticate like a session (D1, D4)

**Change:**
1. **Personal routes**, under the session's own site (sessions are per site,
   `server/src/app.ts:119`), all with `signedIn`, `Cache-Control: no-store` and the
   PostgreSQL-capability 404 that `keyAdmin` gives today (`app.ts:389-391`):
   - `GET /api/integration-keys`: the caller's own keys on this site, as id, name, scope,
     createdAt, lastUsedAt, revokedAt and webhook target id.
   - `POST /api/integration-keys` with `{ name, scope, webhookTarget? }`. The key is bound to
     `session.personRef` on `session.orgId`. It returns `{ id, token, signingSecret? }` once.
     - Refuse with `403 not_eligible` when `session.class !== 'member'` or `session.personRef`
       starts with `adhoc:`.
     - Refuse with `400` when `members.lookup(session.personRef)` finds nobody.
   - `DELETE /api/integration-keys/:keyId`: only a key whose `person_ref` and
     `organization_id` match the session. Anything else gets 404.
2. **Admin routes** keep `GET` and `DELETE /api/admin/organizations/:id/integration-keys…`
   with `keyAdmin` unchanged. Delete the admin `POST`. Add `person_ref` and `scope` to the
   admin list response.
3. **`NewIntegrationKey`** becomes `{ name, scope, webhookTarget? }`, strict. `personRef` is
   gone.
4. **Authentication middleware** (`integration.ts:165-187`), and the webhook worker through the
   same helper (W6.6):
   1. Call `found = await members.lookup(key.personRef)`. If it returns nothing, return 401. An
      adhoc person can't hold a key (step 1), so this lookup always applies.
   2. Build the session the same way sign-in does (`server/src/signIn.ts:75`):
      ```ts
      const session: SessionData = await refreshSession(people, {
        userId: key.personRef, personRef: key.personRef, name: found.member.name,
        email: found.member.email ?? '', class: 'member', orgId: key.organizationId,
        tier: found.tier,
      });
      ```
      `refreshSession` (`signIn.ts:85-88`) replaces `tier` and `grants`.
   3. Build viewers with the screens' own helpers: `viewerOf(session)` for lists, and
      `viewerOn(session, activityId)` for one activity (`app.ts:76-82`). Move both into
      `signIn.ts` and export them, so `app.ts`, `integration.ts` and `integrationWebhooks.ts`
      share one copy.
   4. Delete the `accessInOrganization` call.
5. **Directory errors:** wrap the lookup in try/catch. A thrown error returns
   `503 directory_unavailable`, logged once with the key id, never the token.
6. **UI:**
   - Add an "API keys" page for the signed-in person: list, issue (show the token once, and the
     signing secret when there's a webhook) and revoke.
   - Link it from the account menu, `web/src/shell/AppMenu.tsx`.
   - `OrganizationAdmin.tsx` keeps list and revoke, showing the owner and scope.

**Done when:**
- **T3:** `POST /api/integration-keys` binds the key to the caller's own `personRef`. A body
  that includes `personRef` gets 400.
- **T4:** member A gets 404 revoking member B's key through the personal route. An admin of the
  key's organization gets 200 through the admin route. An admin of an unrelated organization,
  one that isn't an ancestor or site admin (`canEdit` allows those, `organizations.ts:520`),
  gets 403.
- **T5:** a person who signs in on site S through their email domain's provider, which is
  different from S's provider, can issue and use a key on S. Their key gets the same tier their
  session gets.
  - **Setup:** this needs a two-provider seed imported into a Postgres organization store, as
    at `integration.test.ts:210-215`; `testSeed` has one provider.
  - **Sign-in:** sign in with no `tier` override. `helpers.ts:76` sends `tier: 'respond'` by
    default, which would make the comparison meaningless. Use a person whose provider groups
    give `manage` (`memberTiers`, as at `integration.test.ts:36`).
- **T6:** on a **mission** (ordinary members are managers on other kinds,
  `packages/domain/src/projector.ts:119`):
  - after the bound person's grant on the activity is removed, the next request uses the lower
    tier;
  - after the key is revoked, the next request gets 401.
- **T6b:** the webhook for a T5 person's key delivers for an activity that person can see. This
  proves the worker uses the same identity helper.
- **T6c:** a session with `class: 'external'`, or an `adhoc:` person, gets
  `403 not_eligible` when issuing a key.
- **T7:** a directory that throws gives 503 `directory_unavailable`.

### W3. Reads see exactly what the person sees

**Change** (`integration.ts:204-232`):
- Read detail with `viewerOn(session, activityId)`.
- Return `result.records` as projected for that viewer. Delete `readTypes`, the
  `tier === 'manage'` re-projection (`:213-216`) and the `cause` strip (`:217-220`).
- The list keeps `viewerOf(session)`.

**Done when:** **T8:** a person with a `manage` grant on mission A gets team `notes` on A, but
not on mission B, where they're a member. Use missions, as in T6.

### W4. Owner and unit choices: the same options the screens offer (D5)

**Problem:**
- Native writes pass the caller's `unit: { id, title, rosterName }` through (`:292-305`).
  `ensureUnit` then creates or **renames** `activityUnit` from it
  (`packages/domain/src/mutations/participants.ts:22-25`). `setUnitStatus` only creates a
  missing unit (`operations.ts:49`).
- Creation forces the owner to the site (`:252-254`), but the screens allow partner owners.

**Change.** Do all of this inside the `prepare` callback passed to `hub.submitIntegration`,
which runs after the receipt check, so replays never depend on it. It's synchronous, using only
`view` and the in-memory organization store.
1. **Site options:**
   ```ts
   const config = orgs.siteConfig(site, { devSignIn: false, buildId: 'integration' });
   ```
   It's synchronous, and those options don't affect the result. Use `config.organization` (the
   organization plus its partners, with their flags) and `config.operational`
   (`organizations.ts:492-507`).
2. **`createActivity` and `updateActivity` owner.** Reproduce the edit screen's rule exactly
   (`web/src/sections/respond/activityDraft.ts:140-145`):
   - **Owners allowed for a kind:** `ownerOptions(config.organization, kind === 'mission')`
     (`site.ts:43`), plus the activity's **stored** owner when that owner is neither the
     organization nor one of its partners.
   - **Compare by id:** `options.some((o) => o.id === ownerOrgId)`.
   - **Create:** `ownerOrgId` defaults to `config.organization.id`. One not allowed is refused
     `400 owner_not_allowed`.
   - **Within a batch, track the effective owner and kind through the operations in order.**
     Start from the stored activity; each `updateActivity` that sets `kind` or `ownerOrgId`
     updates the pair. Check each `updateActivity` against the pair as it stands after applying
     that operation, so a batch that changes kind and then owner is judged on the result.
   - **Only check changes:** check only when an operation actually changes the owner or kind.
     An `updateActivity` that resends the unchanged `ownerOrgId` and `kind` passes.
   - **Delete:** the `canCreateMissions`/`canCreateEvents` check (`:253`) and `owner_fixed`.
     `ownerOptions` already covers both.
3. **Units** for `addParticipant`, `setParticipantStatus` and `setUnitStatus`:
   - **API input:** the API accepts `unitId`. Refuse with `400 bad_args` when the operation's
     `args` contain a `unit` key. Args are passthrough today (`integration.ts:64`), so this has
     to be an explicit check. `unitId` defaults to `site.id`, the same unit the screens use for a
     self sign-in.
   - **Build `unit` on the server, in this order:**
     1. If the activity already has an `activityUnit` with that id
        (`view.get('activityUnit', unitId)`), use that record's `id`, `title` and `rosterName`.
        That's what the participant dialog sends for an existing participant.
     2. Else, if `unitId` is `config.organization.id` or one of `config.organization.partners`,
        use `{ id, title, rosterName: shortTitle }` from that entry. That's what the unit picker
        offers (`web/src/sections/respond/components/AddParticipantButton.tsx:65`).
     3. Else, **for `setUnitStatus` only**, if `unitId` is in `config.operational`, use that
        entry the same way. That's what the invite menu offers (`web/src/ui/UnitStatusMenu.tsx:73`,
        `invitableUnits(useSite().operational, …)`).
     4. Else, refuse with `400 unknown_unit`.
   - **Who may act:** the domain still decides who may act on that participant
     (`requireSelfOrManager`, `participants.ts:104`, and the add rule at `:83`). Don't add any
     unit-based permission check.
4. **Names stay caller-supplied,** as on the WebSocket path. Section 6 covers this.

**Done when:**
- **T9:** a manager key (the tier comes from `memberTiers`, as at `integration.test.ts:36`; a
  dev-chosen tier doesn't reach a key) creates a mission owned by a partner that's flagged
  `canCreateMissions` for the site (201).
  - An unflagged partner gets 400 `owner_not_allowed`.
  - An `updateActivity` that resends the unchanged `ownerOrgId` succeeds.
  - A batch that changes a mission to `training` and then sets an owner allowed only for
    missions gets 400. The reverse order, set the owner and then the kind, is judged on the
    final pair too.
  - Editing an activity whose stored owner is unknown to the site, and changing only its
    title, succeeds.
- **T10:** `setParticipantStatus` for an existing participant with `unitId` of a partner unit
  already on the activity stores that `activityUnit`'s existing title, not caller text. A body
  with `unit: {…}` gets 400. An unknown `unitId` gets 400 `unknown_unit`.
- **T11:** on a **mission**, a non-manager key changing **another person's** status is refused
  by `requireSelfOrManager` ("You can only change your own entry"). The same key changing its
  **own** status under the site's unit succeeds.
- **T11b:** a manager key's `setUnitStatus` inviting an operational unit that's neither the
  organization nor a partner succeeds.
- **Replay safety has no separate test:** the checks run inside `prepare`, which the actor calls
  only after the receipt lookup (`activityActor.ts:197-203`). Don't move any of them before
  `hub.submitIntegration`.

### W5. Undo the shared-summary change; drop `since` (D7)

**Change:**
1. **`packages/domain/src/summary.ts`:** remove `activityVersion` and `changedAt`. Keep
   `externalRef`.
2. **`server/src/summaries.ts`:**
   - Remove `liveSummary` and the extra `write` parameters.
   - Restore `SummaryWriter.onCommit` to `(activityId, view)`.
   - Change its call in `server/src/main.ts:116` back to `summaries.onCommit(activityId, view)`.
     The hub's own `changes` argument, and its use by `activityLog.onCommit` (`:118`), existed
     before this branch; leave them alone.
3. **`GET /activities`:** remove `since`. Keep `open` and `externalRef`. `externalRef` now
   matches among **all visible** summaries, whatever the owner. Drop the
   `r.ownerOrgId === key.organizationId` condition (`integration.ts:201`), so an activity owned
   by a partner can be found by its reference. It can return more than one.
4. **Stored data:** none to clean, because nothing is deployed.

**Done when:**
- **T13**, in the summaries tests (`testApp` has no `SummaryWriter`): a `setEta` with the
  debounce flushed causes **no** `setActivitySummary` push to `$archive`.
  - Wire a real `SummaryWriter`.
  - Flush the initial summaries.
  - Assert a nonzero baseline version of `$archive`.
  - Then assert that version is unchanged.
- `git diff 4c7b26e -- packages/domain/src/summary.ts` shows only `externalRef`.

### W6. Bound the webhook outbox (D8)

**Goal:** at most one job row per key and activity, a newer change is never lost, and the
existing claim lease keeps working. Auto-disable is not part of this round (section 6). With one
row per key and activity, the outbox can't grow without bound, and revoking the key stops a dead
webhook.

**Change** (`packages/sync-server/src/postgresStorage.ts:9-24,168-175`,
`server/src/organizations.ts:228-260`, `server/src/integrationWebhooks.ts`, `server/src/main.ts`):
1. **Table:** `integration_webhook_jobs` becomes `PRIMARY KEY (key_id, activity_id)`. The
   `version`, `changed_at`, `attempts` and `ready_at` columns stay.
2. **Enqueue** (`postgresStorage.ts:171`). Only `version` and `changed_at` move on a conflict;
   `attempts` and `ready_at` are never touched, so a leased job keeps its lease and backoff:

   ```sql
   INSERT INTO integration_webhook_jobs AS jobs (key_id, activity_id, version, changed_at)
   SELECT key_id, $1, $2, $3 FROM integration_webhooks FOR KEY SHARE
   ON CONFLICT (key_id, activity_id) DO UPDATE
     SET version = GREATEST(jobs.version, EXCLUDED.version),
         changed_at = GREATEST(jobs.changed_at, EXCLUDED.changed_at)
   ```
3. **Claim** (`organizations.ts:228-243`): unchanged, except that the `ready` CTE and the
   `UPDATE … WHERE` join on `(key_id, activity_id)` instead of `(key_id, activity_id, version)`.
   It still returns `version` and `attempts`; the pair is the claim token.
4. **Finish**, after a 2xx:
   ```sql
   DELETE FROM integration_webhook_jobs
   WHERE key_id = $1 AND activity_id = $2 AND version = $3 AND attempts = $4
   ```
   If that deletes no row and the row still has `attempts = $4`, a newer version arrived during
   delivery. Make it claimable again at once:
   ```sql
   UPDATE integration_webhook_jobs SET attempts = 0, ready_at = now()
   WHERE key_id = $1 AND activity_id = $2 AND attempts = $4
   ```
5. **Retry**, after a failure: the existing backoff update (`organizations.ts:253-260`), matched
   on `key_id`, `activity_id` and `attempts` only (drop `version`).
6. **Worker identity:** the worker builds its viewer with the same helper as the API middleware
   (W2.4), not `accessInOrganization` (`integrationWebhooks.ts:38-42`). Put that helper in one
   place, for example `integrationViewer(key, activityId)`, and use it in both.
   - A person who's no longer in the directory: delete the job, as revocation would.
   - A directory error: retry the job.
7. **Worker startup** (`main.ts:128`): start when `organizations.canSignIntegrationWebhooks` is
   true, whether or not any targets are configured. A job whose target is missing from
   `INTEGRATION_WEBHOOK_TARGETS` is retried with backoff.
8. **Drain:** the worker repeats `claimWebhookJobs` until a claim returns fewer than 16 jobs, up
   to 10 claims per tick.
9. **Payload:** as now, the version the worker reads at delivery time (`integrationWebhooks.ts:43-45`),
   so a delivery always carries the latest version.

**Done when:**
- **T14:** 50 commits on one activity, with no worker running, leave exactly **one** job row for
  that key and activity. After the worker runs, the **last** delivery carries the latest version
  and the row is gone.
- **T15:** this needs a test hook that holds the receiver open.
  1. Claim and start delivering version v1; the receiver holds the request.
  2. Commit v2 on the activity.
  3. A second claim during the hold gets nothing, because the lease held.
  4. Release the hold with 200.
  5. The row is still there with version v2 and is claimable again, and the next delivery
     carries v2.
- **T16:** with the receiver returning 500, 100 commits on one activity leave one row, and its
  `ready_at` follows the backoff. Revoking the key deletes it.

### W7. Remove the API-only limits (D6)

Delete:
- the `eta_too_far`, `mileage_too_high` and `status_before_window` checks (`:294-304`)
- their entries in `resultStatus`
- their docs
- the test at `server/__tests__/integration.test.ts:145`

**Done when:** `grep -rn "eta_too_far\|mileage_too_high\|status_before_window" server docs`
prints nothing.

### W8. Errors and small fixes

1. **`resultStatus`:**
   - `internal` → 500
   - `not_found` and `no_activity` → 404 (`no_activity` is from `common.ts:19`)
   - `forbidden` and `forbidden_scope` → 403
   - `bad_args`, `invalid_json`, `unknown_unit` and `owner_not_allowed` → 400
   - everything else → 409
2. **`POST /activities` malformed JSON:** return `invalid_json`. Move the idempotency-key,
   content-type and JSON parsing into one helper used by both POST routes (`:238-245` and
   `:265-274`).
3. **Missing participant:** with `expectedParticipantVersion` and a participant that doesn't
   exist, return `404 not_found`, not `stale_version` (`:288-291`).
4. **Docs:** say that `memberInfo` updates participant records in the background, after adds and
   unit changes, and only when the directory answers (`server/src/memberInfo.ts:29,48`). So a
   participant's version can move with no caller action. On `409 stale_version`, read again and
   retry; no single re-read prevents it.

**Done when:**
- **T17:** a test hub whose registry makes `setMiles` throw (one of the eight allowed names;
  `activityActor.ts:375` turns it into `internal`) gives 500.
- **T18:** malformed JSON on both POST routes gives `invalid_json`.
- **T19:** an unknown `participantId` with `expectedParticipantVersion` gives 404.

### W9. Docs

Rewrite `docs/integration-api.md` with these sections:
1. **Principle:** section 2, with the exposed operations listed.
2. **Keys:** self-issued, scopes, revocation, admin list and revoke, and the 5-minute directory
   cache lag (`server/src/cedar.ts:43`).
3. **Reads:** list and its filters, detail, ETag and 304, 410.
4. **Webhooks:** targets are set by the operator. Document the payload, signature, retries with
   backoff (no auto-disable; revoke the key to stop them), and one pending delivery per key and
   activity. The receiver's duties:
   - verify the signature, and that the timestamp is within 5 minutes;
   - de-duplicate by `(activityId, version)`;
   - treat a delivery as a hint to read detail.
5. **Writes:** batches, `expectedVersion`, `expectedParticipantVersion`, idempotency and replay,
   and the owner and unit rules from W4.
6. **Errors:** every status, every `error` code, and whether to retry with the same key, after
   a read, or not at all.
7. **Known limits and follow-ups:** section 6.

Remove every mention of the env keys, permission lists, convenience operations, `since`, the
removed limits and `owner_fixed`.

## 5. Definition of done (run all of it, paste the output into the reply)

```sh
npm run typecheck
docker run --rm -d --name api-pg -p 5433:5432 -e POSTGRES_USER=sync -e POSTGRES_PASSWORD=sync -e POSTGRES_DB=sync postgres:18.6-alpine
TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/sync npx vitest run      # 0 failed, 0 skipped
docker stop api-pg
grep -n "Rejection('forbidden'\|owner_fixed\|canCreateMissions\|canCreateEvents" server/src/integration.ts   # empty
grep -rn "INTEGRATION_API_KEYS\|nativePermission\|eta_too_far\|activityVersion" server packages web docs README.md   # empty
grep -n "accessInOrganization(" server/src/integration.ts server/src/integrationWebhooks.ts   # empty
git diff 4c7b26e -- packages/domain/src/summary.ts                              # only externalRef
```

**Tests:** T1–T19 (with T6b, T6c and T11b) extend `server/__tests__/integration.test.ts`; T13
goes in the summaries tests. Each one checks behaviour a
caller sees. The shared setup has two synthetic organizations with different member providers,
and one partner relationship with `canCreateMissions` set.

**Self-check.** Answer each in the reply with yes or no, and where:
1. Apart from scope, the body limit, version checks and the owner and unit options in W4 (the
   same options the screens offer), does `integration.ts` refuse anything the domain would
   allow? (Must be no.)
2. Can a request make the server store a unit title or roster name that came from the caller?
   (Must be no.)
3. With no webhooks configured anywhere on the server, does a commit do any more writes or
   pushes than at `4c7b26e`? (Must be no; T13.)
4. Can the job table hold more than one row per key and activity, or lose a newer version
   during delivery? (Must be no; T14, T15.)
5. Can a key act as anyone but its issuer? (Must be no; T3.)

## 6. Known limits and follow-ups (not this round; list them in the docs)

1. **Change feed:** a `GET /changes?after=` feed over `mutation_log` would let a client find
   changes without webhooks. It needs its own design for:
   - rows that commit out of `seq` order, for example by recording `pg_current_xact_id()` and
     reading only below `pg_snapshot_xmin`;
   - logged rejected mutations (`outcome = 'rejected'`, `activityActor.ts:315`);
   - visibility for removed activities, which have no summary (`summary.ts:70-72`);
   - imports, which have no log entries;
   - cursors that `INT8 → Number` parsing would round (`postgresStorage.ts:5-7`).
2. **Busy missions:**
   - Status writes still need the whole activity version.
   - Value-based preconditions (`expect` per operation) need their own design. They'd have to
     handle corrections that change a status in place (`participants.ts:113`), batch
     semantics, and structured error payloads, which `Rejection` can't carry today.
3. **Names come from the caller, on both the WebSocket and API paths.** Resolving names from
   the directory has to happen after the receipt check, so a replay never depends on the
   directory being up.
4. **The same unit gap on the WebSocket path:** the server never checks a client's `unit`
   object. Fix it in the domain or the hub for both paths.
5. **Self-service webhook URLs:** they need an allow-list of hosts, a block on private
   addresses, and connections pinned to the resolved address (with `node:https`'s `lookup`, or
   a new `undici` dependency).
6. **More operations:** close or reopen, timeline corrections and team editing.
7. **The outbox's location:** it lives in `sync-server` storage. Moving it to `server/`, filled
   from `onCommit`, is cleaner but not needed for correctness.
8. **Auto-disable for a dead webhook:** it needs locking that's compatible with enqueue (enqueue
   reads webhooks `FOR KEY SHARE`, `postgresStorage.ts:172`). Count failures per job, not per
   webhook, so a short outage doesn't trip it.

## 7. Reply format

Post one comment on SeattleMountainRescue/Basecamp#1322 with:
- a table of W1–W9, each with its commit and the test names that prove it;
- the output from section 5;
- the self-check answers;
- any decision from section 3 you disagree with, and why.
