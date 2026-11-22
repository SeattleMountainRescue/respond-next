# Review round 2: Respond integration API (`3c980a2`)

**Reviewed commit:** `3c980a2` "Address review of Respond integration API" on
`rework/smr-integration-api-postgres` in `SeattleMountainRescue/respond-next`.
- Base: `KingCountySAR/respond-next@4c7b26e`.
- Full change: `git diff 4c7b26e 3c980a2`.
- Round 1 report: `docs/integration-api-review.md` on this branch.

**Who this is for:** one coding session that fixes everything in a single pass, with no
further review round. It gives the target design, the decisions already made, exact code
changes, the tests to write, and a final self-check. Read it all before you change anything.

## 0. How to use this document

1. Read sections 1–3 first. They hold the decisions. Don't re-decide them; if one looks
   wrong, say so in the reply and implement the rest.
2. Do the work items in section 4 in the order given. Later items depend on earlier ones.
3. Every item ends with **Done when**. An item is finished only when all its checks pass.
4. Run section 5 (definition of done) last, and paste its output into the reply.
5. Don't add things this document doesn't ask for. Anything else you notice goes into the
   reply as a note, not into code.

**State at `3c980a2`:**
- `npm run typecheck`: clean.
- `TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/sync npx vitest run`: 374 passed, 0
  skipped. That's with `docker run --rm -d -p 5433:5432 -e POSTGRES_USER=sync -e
  POSTGRES_PASSWORD=sync -e POSTGRES_DB=sync postgres:18.6-alpine`.

**What round 2 got right; keep all of it:**
- **The key's person:** keys are bound to a directory person, whose tier and grants are
  re-read on every request (`server/src/integration.ts:179-184`).
- **Respond's rules:** native mutations go through the domain's own rules.
- **Key management:** keys live in Postgres, and an admin can revoke one, effective
  immediately.
- **Replay before stale:** the receipt check runs before the stale check
  (`packages/sync-server/src/activityActor.ts:197-199`).
- **Creation:**
  - the create id is derived from the request key (`integration.ts:247-248`);
  - the owner is forced to the issuing site;
  - `createActivity` is blocked inside change batches.
- **Batches:** all-or-nothing in one actor turn, with one version bump.
- **Detail reads:** ETag and 304, and a 410 only after the visibility check.
- **Webhook signing:** HMAC over `timestamp.body`, the secret stored encrypted, and
  `redirect: 'error'`.
- **Key handling:** constant-time hash compare, the token shown once, and the reserved
  `integration:` client id.

## 1. Where round 1 misled you (our mistakes, now corrected)

Three gaps in the round 1 report caused part of this round's rework:

- **It left the old operations optional.** Round 1 P1-1 said to replace the six fixed
  operations, "unless the maintainers want an extra cap". That let both paths survive. This
  report says delete, with a grep to prove it.
- **It asked for limits in the wrong layer.** Round 1 P2-7 asked for ETA, mileage and time
  limits in the API. That makes the API stricter than Respond's screens, which breaks the
  main principle. This report removes them from the API.
- **It never said how to serve the change signal.** Round 1 P2-3 asked for "version on list
  summaries" without saying where it should come from. Putting it in the shared archive
  summary changed load for every Respond site. This report gives the mechanism.

## 2. The principle every change must satisfy

> **An API key is a person.** Whatever that person could do or see in Respond's screens, the
> key can do or see. Nothing more, nothing less, for any organization, with any member
> provider.

From that principle:

- **Authorization:** the API adds no rules of its own. Every allow or refuse comes from
  `packages/domain/src/mutations/*` (`allow`, `run`, `Rejection`) and from the projector.
- **Server-caller additions:** the API only adds what a server needs:
  - authenticating the key
  - the version and precondition checks
  - idempotency
  - the body limit
  - resolving ids to the server's own records (section 4, W4)
  - the change feed and webhooks
  - error mapping
- **Other units:** the change must not alter behaviour, load or stored data for Respond sites
  that issue no API keys. W6 has a test for this.
- **No organization-specific code:** no hard-coded organization, provider or unit.

## 3. Decisions already made (don't re-decide)

| # | Decision | Why |
|---|---|---|
| D1 | A person can issue keys **only for themselves**. Admins can list and revoke every key in their organization, but can't issue a key for someone else. | Binding a key to another person is impersonation: the history would credit them for changes they didn't make. Sign-in never allows that. A unit that wants a service account has that member sign in and issue their own key. |
| D2 | Delete the six convenience operations (`Change`, `prepare`, `permission`) and the `INTEGRATION_API_KEYS` environment variable keys. | Two permission systems drift apart. The env keys carry a second permissions model and need an operator. |
| D3 | A key's only narrowing is a scope the issuer picks: `read` or `write`. No per-mutation permission lists. | It's simple and every unit understands it. A key can still never exceed its person. |
| D4 | Detail reads return exactly the person's own projection for that activity, using `tierOn`, the same as their screen. Drop `readTypes` and the manage-to-member downgrade. | Same as the screens. A narrower read was a second visibility rule. |
| D5 | Remove the API-only limits `eta_too_far`, `mileage_too_high` and `status_before_window`, and the past-ETA check. If they're wanted, propose them to the domain mutations in a separate change. | They make the API stricter than the screens (see section 1). |
| D6 | Move the `canCreateMissions` / `canCreateEvents` check into the domain `createActivity` rule, so screens and API share it. | It's enforced only in the browser today (`integration.ts:253` is the only server check). |
| D7 | The change signal is a **change feed read from `mutation_log`**, not a field in the shared archive summary. Webhooks deliver that feed. Delete the per-version job table. | One mechanism serves both polling and push. It keeps no per-commit queue, leaves non-API sites untouched, and coalesces naturally. |
| D8 | Webhook destinations are HTTPS URLs that the key's issuer enters, checked against an operator host allow-list (`INTEGRATION_WEBHOOK_HOSTS`) and a private-address check. Replaces `INTEGRATION_WEBHOOK_TARGETS`. | A unit can set up its own receiver without an operator change, and request-forgery protection stays. |
| D9 | Out of scope: pushing whole teams from an outside board, guests beyond what the domain already allows, and fixing the same unit-trust gap on the WebSocket path. Mention the WebSocket gap in the reply as a follow-up; don't fix it here. | Keeps this change reviewable. |

## 4. Work items, in order

### W1. Delete the parallel permission system (D2, D3)

**Change:**
1. In `server/src/integration.ts`, delete:
   - `Change` (`:43-51`)
   - `permission` (`:52-55`)
   - `prepare()` (`:100-160`)
   - the whole fallback branch in `POST /activities/:id/changes` (`:313-335`), including the
     `first-status` lookup-and-resubmit
   - `integrationKeys()` (`:85-98`) and the `keys` parameter of `integrationRoutes`
2. Remove `permissions` from the `Key` schema, and `nativePermission`. Replace `allows()`
   with one check: reads need scope `read` or `write`, and writes need scope `write`.
3. Add a `scope text NOT NULL CHECK (scope IN ('read','write'))` column to `integration_keys`.
   `NewIntegrationKey` takes `scope`.
4. Remove `INTEGRATION_API_KEYS` from `server/src/main.ts`, `README.md`,
   `docs/integration-api.md` and the tests. The API is enabled when
   `organizations.managesIntegrationKeys` is true.
5. In the change route, parse only `NativeBatch` (W5 updates it). A body that doesn't parse
   returns `400 bad_args`, with the first zod issue as `message`.

**Done when:**
- `grep -n "Rejection('forbidden'" server/src/integration.ts` prints nothing, after W2 too.
- `grep -rn "INTEGRATION_API_KEYS\|nativePermission\|prepare(change" server docs README.md`
  prints nothing.
- A test (T1 in section 5) shows a `read`-scope key gets 403 on every POST, and a
  `write`-scope key of a non-manager is refused `createActivity` with `kind: 'mission'` by
  the domain rule, not the API.

### W2. Keys are issued by and for the signed-in person (D1)

**Change:**
1. `POST /api/admin/organizations/:id/integration-keys` (`server/src/app.ts:400-418`):
   - Drop `personRef` from the request body. Bind the key to the issuing session's own
     `personRef`.
   - Refuse with 400 if that person isn't in the organization's directory
     (`members.accessInOrganization(orgId, session.personRef)`).
   - Any signed-in member of the organization can issue their own key. So split the route:
     - `POST /api/organizations/:id/integration-keys` for issuing your own key (`signedIn`
       only, plus the directory check).
     - `GET` and `DELETE` under `/api/admin/...` for admins (`keyAdmin`, unchanged).
   - Also let a person revoke their own key through
     `DELETE /api/organizations/:id/integration-keys/:keyId`, checking that the key belongs
     to their `personRef`.
2. `NewIntegrationKey` becomes `{ name, scope, webhookUrl? }`. `personRef` is gone, and
   `webhookUrl` replaces `webhookTarget` (W7).
3. **History:** set the API viewer's `name` (`integration.ts:184`) to
   `` `${member.name} (API: ${key.name})` ``, keeping `userId` and `personRef` as the
   person's. That way the activity log shows the change came through a key. Load `name` with
   the key (`organizations.integrationKey` must also select `name` and `scope`).
4. **UI** (`web/src/sections/admin/OrganizationAdmin.tsx`, `web/src/shell/api.tsx`):
   - Admins see the list with owner, name, scope, last used, revoked, and a revoke button.
   - A person's own key screen (place it next to their profile or settings, wherever the app
     keeps personal settings) issues a key and shows the token once, plus the signing secret
     when there's a webhook.

**Done when:**
- **T2:** an admin calling the issue route gets a key bound to their own `personRef`. Sending
  a `personRef` in the body returns 400 (strict schema).
- **T3:** member A can't revoke member B's key through the personal route (404). An org admin
  can (200). An admin of another organization gets 403.
- **T4:** a change made with a key shows `"<name> (API: <key name>)"` as the actor in
  `GET /api/activities/:id/log`, or wherever `server/src/activityLog.ts` narrations are
  served.

### W3. Reads and writes see exactly what the person sees (D4)

**Change:**
1. **Detail read** (`integration.ts:204-232`):
   - Read with `{ ...memberViewer, tier: tierOn(memberAccess, activityId) }`.
   - Return `result.records` as projected for that viewer.
   - Delete `readTypes`, the `tier === 'manage'` re-projection (`:213-216`) and the
     `participantStatus.cause` strip (`:217-220`), unless the screens also strip it. Check
     `web/` before deleting; if the screens never receive `cause`, the projector already
     drops it.
2. **List read:** keep the base-tier viewer. The archive list is what the person's home
   screen shows.
3. **Webhook visibility** (W7) uses the same viewer the detail read uses.

**Done when:** **T5:** a person who has the `manage` tier on one activity through a grant
gets the manager projection of that activity, for example team `notes` present, and the
member projection on another activity.

### W4. Resolve units and people on the server, never from the caller

**Problem (verified):** native `addParticipant`, `setParticipantStatus` and `setUnitStatus`
accept a `unit: { id, title, rosterName }` object straight from the caller
(`integration.ts:292-305`). The domain's `ensureUnit` and `setUnitStatus.run` then create or
rename `activityUnit` from that object (`packages/domain/src/mutations/participants.ts:22-25`,
`operations.ts:49`). So a key can rename another unit's title for everyone, or sign in under a
unit id that doesn't exist. Respond's screens have the same gap on the WebSocket path, because
the server never checks the object (D9). The API makes it easy to script.

**What must stay allowed:** in the screens a mission manager can invite partner units
(`web/src/sections/respond/activityDraft.ts:205`) and add a person under any unit
(`web/src/sections/respond/components/AddParticipantButton.tsx:66`). So **don't** force the
unit to the key's organization; that would make the API stricter than the screens.

**Change**, at the API boundary in `server/src/integration.ts`, before the operations go to
`hub.submitIntegration`:
1. For these three mutations, the API schema takes `unitId: string`, not `unit`. Build `unit`
   on the server from `organizations.get(unitId)` as
   `{ id, title: org.title, rosterName: org.shortTitle }`. This is the same mapping the deleted
   `prepare()` used at `:104`.
   - An unknown `unitId` returns `400 unknown_unit`.
   - A caller-supplied `unit` object fails the strict schema with 400.
2. For `addParticipant`, the API schema takes `personRef`, `unitId`, `status`, `at` and
   optional `firstname`/`lastname`:
   - **Person in the directory:** if `members.lookupInOrganization(unitId, personRef)` finds
     them, use the directory's names and ignore the caller's.
   - **Not found:** pass the caller's names through. The domain still decides whether this
     viewer may add that person (`participants.ts:83`). The names are required in this case;
     if they're missing, return `400 bad_args`.
   - **Directory errors:** a thrown error returns `503 directory_unavailable`.
   - This lookup is the one server-side enrichment worth keeping from the old `first-status`.
     It isn't a permission rule.
3. Write down the rule in one comment above the resolver: "The API resolves ids to Respond's
   own records so a caller can never supply display data. It never refuses what the domain
   would allow."

**Done when:**
- **T6:** `setParticipantStatus` with `unitId` set to a partner organization's id succeeds
  for a manager key, and the stored `activityUnit` title equals that organization's title, not
  caller text. The same call from a non-manager key is refused by the domain rule.
- **T7:** a body with `unit: {...}` gets 400, and an unknown `unitId` gets
  `400 unknown_unit`.
- **T8:** `addParticipant` for a directory member ignores caller-supplied names.

### W5. Preconditions by value, including status (replaces `expectedParticipantVersion`)

**Problem (verified):**
- `expectedParticipantVersion` covers only `setEta`/`setMiles` (`integration.ts:68-75`).
- Status changes don't touch the `participant` record: `applyStatus` writes
  `participantStatus` rows. So a status write still needs the whole-activity version and gets
  refused on a busy mission.
- The participant record's version also moves for reasons the caller doesn't care about:
  `server/src/memberInfo.ts` `onCommit` updates `memberTags` right after an add.
- A missing participant returns `stale_version` (`:288-291`) where it should return
  `not_found`.

**Change:** replace `ParticipantBatch` with an optional `expect` object on each operation, a
compare-and-set on exactly the values the operation changes.

```ts
// one operation
{ name: 'setParticipantStatus', args: { participantId, status, unitId, at },
  expect: { lastStatusId: 'ps-123' | null } }          // id of the latest participantStatus the caller saw
{ name: 'setEta',   args: { participantId, eta },   expect: { eta: 1732150000000 | null } }
{ name: 'setMiles', args: { participantId, miles }, expect: { miles: 12 | null } }
{ name: 'assign',   args: { participantId, target }, expect: { assignmentId: 'as-9' | null } }
{ name: 'updateActivity', args: {...}, expect: { fields: { title: 'Old title' } } } // only the fields being changed
```

**Rules:**
- **Which check:** a batch may send `expectedVersion`, `expect` on every operation, or both.
  If any operation has no `expect`, `expectedVersion` is required. That keeps every write
  protected by one of the two.
- **Where:** check `expect` inside `prepare`, against the `view` passed in. It's the same
  serialized turn as the commit, so there's no race.
- **Results:**
  - A missing participant returns `404 not_found`.
  - A mismatch returns `409 precondition_failed`, with
    `{ operationIndex, field, current }` so the caller can reconcile without another read.
    `current` comes from the same projection the caller can read, so it never leaks
    anything.
- **Cleanup:** remove `expectedParticipantVersion` and its docs.

**Done when:**
- **T9:** between a read and a write, another unit's participant changes status. A status
  write with `expect.lastStatusId` from the read still succeeds.
- **T10:** the same participant gets a new status first. The write gets
  `409 precondition_failed` with the new `lastStatusId` in `current`.
- **T11:** right after `addParticipant`, a `setEta` with `expect: { eta: null }` succeeds,
  even though `memberInfo` moved the participant's version.
- **T12:** an unknown `participantId` with `expect` gets 404.

### W6. Change feed from `mutation_log`; undo the shared-summary change (D7)

**Problem (verified):** `server/src/summaries.ts:96` writes `activityVersion` and `changedAt`
into the `$archive` summary. `put` compares the whole summary (`:113-117`), so every commit
on any activity, even an ETA change, now pushes `setActivitySummary` to `$archive` and fans
out to every archive subscriber. That's extra load on every Respond site, including those
without keys.

**Change:**
1. **Revert the summary changes:**
   - Remove `activityVersion` and `changedAt` from `ActivitySummary`
     (`packages/domain/src/summary.ts`).
   - Remove `liveSummary` and the extra `write` parameters from `server/src/summaries.ts`.
   - Restore `onCommit`'s old signature, unless something else needs `changes`.
   - **Keep `externalRef`** on the summary. It changes only when the activity's own fields
     change.
2. **Add a storage method** to the `ActivityStorage` interface
   (`packages/sync-server/src/storage.ts`), implemented in both storages:

   ```ts
   /** Activities changed after `afterSeq`, oldest first: each one's latest version and the seq of that change. */
   changesSince(afterSeq: bigint, limit: number): Promise<{ activityId: string; version: number; seq: bigint; changedAt: number }[]>;
   ```

   - **Postgres:** one statement, using the existing `seq` primary key:
     ```sql
     SELECT activity_id AS "activityId", max(version) AS version, max(seq) AS seq,
            max((entry->>'receivedAt')::bigint) AS "changedAt"
     FROM mutation_log
     WHERE seq > $1 AND activity_id NOT LIKE '$%'
     GROUP BY activity_id
     ORDER BY max(seq)
     LIMIT $2
     ```
     Check with `EXPLAIN` that it uses the `seq` index range scan.
   - **`MemoryStorage`:** the same result from `this.log`, using the array index plus 1 as
     `seq`.
3. **Endpoint:** `GET /api/integration/v1/changes?after=<cursor>&limit=<1..500, default 200>`:
   - The cursor is the decimal `seq`. An absent cursor means `0`.
   - Call `changesSince`, then keep only activities visible to the key's person. Read
     `$archive` once with the base-tier viewer and intersect on `id`: one read per request,
     never one per activity.
   - Respond with
     `{ changes: [{ activityId, version, changedAt }], cursor: "<max seq scanned>", more: boolean }`.
     The cursor advances past invisible changes too, so a client never re-scans them.
   - A removal is a change. The client reads detail and gets 410.
4. **List:** remove `since` from `GET /activities`. Keep `open` and `externalRef`. The list no
   longer returns versions; clients use `/changes` for that.
5. **Docs:** document the polling pattern: store `cursor`, call `/changes?after=cursor`, then
   use a conditional detail read for each changed activity.

**Done when:**
- **T13 (protects other sites):** with no integration keys, a `setEta` on an activity causes
  **no** `setActivitySummary` push to `$archive`. Spy on `hub.pushAsSystem`, or count `$archive`
  versions before and after, with the debounce flushed.
- **T14:** after three commits on activity A and one on B, `/changes?after=0` lists A once with
  its latest version, and B. Passing the returned cursor gives an empty list.
- **T15:** an activity the key's person can't see never appears, and the cursor still
  advances past it.
- **T16:** a removed activity appears in `/changes`, and its detail read returns 410.

### W7. Webhooks deliver the feed; delete the job table (D7, D8)

**Problem (verified):**
- Every commit inserts one row per webhook key server-wide, with no organization filter
  (`packages/sync-server/src/postgresStorage.ts:168-175`).
- Each `(key, activity, version)` is its own row.
- Failures retry forever at most hourly (`server/src/organizations.ts`,
  `retryWebhookJob`).
- Rows keep piling up even when the worker isn't running.
- The worker sends about 3 per second, with one actor load per job.

**Change:**
1. **Delete:**
   - `INTEGRATION_WEBHOOK_SCHEMA` and `integration_webhook_jobs`
   - the insert in `postgresStorage.ts`
   - `claimWebhookJobs`, `finishWebhookJob` and `retryWebhookJob`
   - `webhookTargets` / `INTEGRATION_WEBHOOK_TARGETS`

   The sync-server package goes back to knowing nothing about integrations.
2. **New table**, in `server/src/organizations.ts` next to `integration_keys`:

   ```sql
   CREATE TABLE IF NOT EXISTS integration_webhooks (
     key_id text PRIMARY KEY REFERENCES integration_keys(id) ON DELETE CASCADE,
     url text NOT NULL,
     signing_secret text NOT NULL,          -- encrypted, as now
     cursor bigint NOT NULL DEFAULT 0,      -- last mutation_log seq delivered
     failures integer NOT NULL DEFAULT 0,
     next_attempt_at timestamptz NOT NULL DEFAULT now(),
     disabled_at timestamptz,               -- set after too many failures
     last_error text
   );
   ```
3. **Worker** (`server/src/integrationWebhooks.ts`), one loop per process, every 5 s:
   1. Claim the webhooks due: `next_attempt_at <= now()`, `disabled_at IS NULL`, and the key
      not revoked, with `FOR UPDATE SKIP LOCKED LIMIT 50`. One statement.
   2. For each, call `changesSince(cursor, 200)`, then keep what the key's person can see,
      with one `$archive` read per key as in W6.
   3. **Nothing visible:** advance `cursor` to the scanned max and send nothing.
   4. **Something visible:** POST one request with
      `{ changes: [...], cursor: "<scanned max>" }`, signed as now.
      - On 2xx, set `cursor` and `failures = 0`.
      - On failure, `failures + 1` and `next_attempt_at = now() + min(2^failures s, 1 h)`.
      - After 20 consecutive failures, set `disabled_at` and `last_error`; the admin and key
        owner screens show it with a "re-enable" button.
   5. If `more` is true, loop for that key straight away, up to 10 pages per tick.
   6. One statement updates each webhook's state after its send. No statement per change.
4. **Destination checks**, at issue time and again on every send:
   - The URL must be `https:` with no userinfo or fragment, and its host must match
     `INTEGRATION_WEBHOOK_HOSTS`. That's a comma-separated list of hostnames or `*.suffix`
     patterns. If it's unset, webhooks are off.
   - Resolve the host and refuse loopback, private, link-local, CGNAT and metadata addresses
     (IPv4 and IPv6). Pin the connection to the resolved address with an undici `Agent` and
     a `connect.lookup` that returns it, so a DNS change between the check and the connect
     can't redirect the request.
   - Keep `redirect: 'error'` and the 5 s timeout.
5. **Payload doc:** list the receiver's duties:
   - check the signature and that the timestamp is within 5 minutes;
   - de-duplicate by `(activityId, version)`;
   - treat a delivery as a hint and read detail.

**Done when:**
- **T17:** 50 commits on one activity with a slow receiver produce at most a few deliveries,
  all with the latest version, and the receiver de-duplicates. The webhook table always holds
  exactly one row per webhook.
- **T18:** with the receiver returning 500, `failures` grows and the webhook gets
  `disabled_at` after 20 failures. No rows are added per commit, so assert the row count of
  every integration table before and after 100 commits.
- **T19:** a webhook URL on a host outside `INTEGRATION_WEBHOOK_HOSTS` is refused at issue
  time (400), and so is a host that resolves to `127.0.0.1` or `169.254.169.254`. Inject the
  resolver into the check so the test can fake it.
- **T20:** the signature checks out for the body as sent, and a revoked key's webhook sends
  nothing.

### W8. Error mapping and directory failures

**Change:**
1. Wrap `members.accessInOrganization` in the auth middleware (`integration.ts:179`) in
   try/catch. A thrown error returns `503 directory_unavailable`, logged once with the key id,
   never the token.
2. **`resultStatus`** (`:340-346`):
   - `internal` → 500, `not_found` → 404, `forbidden` → 403
   - `bad_args` and `unknown_unit` → 400
   - `precondition_failed`, `stale_version` and `idempotency_conflict` → 409
   - every other domain `Rejection` code → 409 (name them all in the docs table)
3. `POST /activities` with malformed JSON returns `invalid_json`, the same as the change
   route. Pull the idempotency-key, content-type and JSON parsing into one helper used by
   both routes, to remove the duplication at `:238-245` and `:265-274`.
4. **Directory cache:** `server/src/cedar.ts` caches lookups for 5 minutes (`:43`), so a
   removed member keeps access for up to 5 minutes. Document this as a known limit. Don't
   bypass the cache.

**Done when:**
- **T21:** a directory that throws gives 503 on any API call.
- **T22:** a domain `Rejection('internal')` gives 500.
- **T23:** malformed JSON on both POST routes gives `invalid_json`.

### W9. Creation flags in the domain (D6)

**Change:**
1. `createActivity` (`packages/domain/src/mutations/activity.ts`) refuses
   `Rejection('forbidden', ...)` when the owning organization's `canCreateMissions` or
   `canCreateEvents` flag is false.
   - The mutation needs the flags. Pass them through the mutation context the same way the
     site viewer is passed (`siteId` on the viewer), or as a hub dependency. Read how
     `organizations.seesActivity` reaches `siteActivityProjector` in `server/src/main.ts:111`
     and follow that pattern.
2. Delete the API's own check at `integration.ts:253`, and keep the `ownerOrgId` forcing at
   `:252-254`.
   - The forcing is a server-caller rule: the screens set the owner from the site. It isn't
     a permission.
   - The forcing is the only `Rejection` that may stay in `integration.ts`. Use code
     `owner_fixed`, not `forbidden`, so W1's grep stays empty.

**Done when:** **T24:** with `canCreateEvents` false, both the API and a WebSocket client
pushing `createActivity` with `kind: 'event'` are refused. This proves the rule lives in the
domain.

### W10. Remove the API-only limits (D5)

Delete:
- the `eta_too_far`, `mileage_too_high` and `status_before_window` checks (`:294-304`)
- their codes in `resultStatus`
- their docs
- the test at `server/__tests__/integration.test.ts:145`, or rewrite it to cover W8's error
  mapping

**Done when:** `grep -n "eta_too_far\|mileage_too_high\|status_before_window" server docs`
prints nothing.

### W11. Docs

Rewrite `docs/integration-api.md` around the person-is-the-key principle. Sections:
1. Keys: who issues them, scope, revocation and the 5-minute directory lag.
2. Reads: list, detail, ETag and 304, 410.
3. The change feed and the polling pattern.
4. Webhooks: setup, host allow-list, payload, signature, retries, disabling and the receiver's
   duties.
5. Writes: batches, `expect`, `expectedVersion`, idempotency and what a replay returns.
6. A complete error table: every status, every `error` code, when it happens and whether to
   retry with the same key, after a read, or not at all.
7. Out of scope (D9).

Remove every mention of the deleted features: env keys, permissions lists, convenience
operations, `since`, `expectedParticipantVersion`, webhook targets and the job table.

## 5. Definition of done (run all, paste the output into the reply)

```sh
npm run typecheck
docker run --rm -d --name api-pg -p 5433:5432 -e POSTGRES_USER=sync -e POSTGRES_PASSWORD=sync -e POSTGRES_DB=sync postgres:18.6-alpine
TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/sync npx vitest run      # 0 failed, 0 skipped
docker stop api-pg
grep -n "Rejection('forbidden'" server/src/integration.ts                       # empty
grep -rn "INTEGRATION_API_KEYS\|INTEGRATION_WEBHOOK_TARGETS\|nativePermission\|expectedParticipantVersion\|integration_webhook_jobs\|eta_too_far\|activityVersion" server packages web docs README.md   # empty
git diff 4c7b26e -- packages/domain/src/summary.ts                              # only externalRef
```

**Tests:** T1–T24 above, extending `server/__tests__/integration.test.ts`, plus
`packages/sync-server/__tests__/storage.test.ts` for `changesSince` (both storages). Each test
checks behaviour a caller sees, not internals. Use two synthetic organizations with
**different member providers** in the shared setup, and run every key test against both, so
nothing organization-specific can pass.

**Self-check before replying.** Answer each in the reply with yes or no and where:
1. Does any line in `server/src/integration.ts` refuse something the domain would allow?
   (Must be no; `owner_fixed` is the one allowed exception.)
2. Can any request make the server use display text (title, roster name, person name) that
   came from the caller for a unit, or for a person who is in the directory?
3. Does any commit on a site with no keys now do more database writes or pushes than at
   `4c7b26e`?
4. Does any integration table grow with each commit?
5. Is there a statement inside a loop over changes, activities or jobs? (One per webhook per
   tick is fine.)
6. Can a key act as anyone other than the person who issued it?

## 6. Reply format

Post one comment on SeattleMountainRescue/Basecamp#1322 that has:
- a table of W1–W11, each with its commit and the test names that prove it;
- the output from section 5;
- the self-check answers;
- any decision from section 3 you disagree with, and why.
