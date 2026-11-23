# Respond integration API

## Principle

An API key acts as the person who issued it. For the operations below, the key
can see and do what that person can see and do in Respond on the key's site,
regardless of which organization or member provider they belong to. Respond
uses the same site visibility, activity grants and mutation rules as the
screens. The API adds key authentication and scope, version checks,
idempotency, a body limit, webhooks and HTTP error mapping.

The exposed operations are `createActivity`, `updateActivity`,
`addParticipant`, `setParticipantStatus`, `setEta`, `setMiles`, `assign` and
`setUnitStatus`.

## Keys

Open **Account menu > API keys** while signed in to the site where the
integration will run. A directory member can issue keys only for themselves.
External visitors and ad hoc accounts cannot issue keys. Choose a scope:

- `read` allows GET requests.
- `write` allows GET and POST requests. It does not grant the issuer any
  additional rights.

Send the token in the `X-API-Key` header over HTTPS to that site's Respond
hostname. Browser sessions do not authenticate integration requests. Copy the
token at issuance; it is never shown again, and Respond stores only its hash.
Keep it out of client-side code, URLs and source control. Key management and the
integration API require PostgreSQL (`DATABASE_URL`).

You can list and revoke your own keys in **API keys**. Under **Admin >
Organizations**, authorized admins can list keys (including owner and scope)
and revoke them, but cannot issue a key for someone else. Revocation takes
effect on the next API request. The displayed last-used time updates at most
once every five minutes. Separately, Cedar directory lookups are cached for
five minutes, so membership and group changes there may take that long to
affect the key. Activity grants are refreshed on each request.

The session-authenticated equivalents are `GET` and `POST
/api/integration-keys` and `DELETE /api/integration-keys/:keyId`. Send
`{ name, scope, webhookTarget? }` to issue a key; a successful POST returns
`201` with `{ id, token, signingSecret? }`. The optional `webhookTarget` is
an operator-approved target ID, not a URL. The admin equivalents are `GET
/api/admin/organizations/:id/integration-keys` and `DELETE
/api/admin/organizations/:id/integration-keys/:keyId`. The GETs return
`{ keys: [...] }` without secrets. Entries include `id`, `name`, `scope`,
`createdAt`, `lastUsedAt`, `revokedAt` and `webhookTarget`; admins also see
the owner's `personRef`. The DELETEs return `200 { status: "ok" }`.

## Reads

- `GET /api/integration/v1/activities` returns `200 { data: [...] }` with the
  site's visible archive summaries. Use `?open=true` for open activities or
  `?open=false` for closed activities. `?externalRef=...` matches the exact
  reference on any visible summary, including activities owned by partners.
  More than one result can match. The archive is an asynchronously refreshed
  snapshot, not a change or deletion feed. Use the detail version for writes.
- `GET /api/integration/v1/activities/:id` returns
  `200 { activityId, version, records }`. The records are the same projection
  the issuer would see on that activity, including any activity-specific
  grant. Detail responses include an `ETag`; send it in `If-None-Match` to
  receive a bodyless `304` if the representation is unchanged.

Closed activities remain readable. A removed activity returns
`410 { error: "gone", removedAt }` only if the issuer would otherwise be able
to see it. Missing or invisible activities return `404`; neither a `404` nor
absence from the archive proves deletion.

## Webhooks

Operators configure `INTEGRATION_WEBHOOK_TARGETS` as a JSON map of target IDs
to `{ organizationId, url }`. Use trusted HTTPS destinations without URL
credentials, query strings or fragments. Respond does not follow redirects.
When issuing a key, a member can choose an approved target for their site.
The separate signing secret is shown once and stored encrypted using
`SECRETS_KEY`.

Respond sends an HTTP POST with JSON `{ activityId, version, changedAt }`.
`version` is the activity version read when the worker sends the notification;
`changedAt` is the queued change time in epoch milliseconds. Respond queues
the notification as part of the activity commit. There is at most one pending
row per key and activity: newer changes can replace pending versions, so
notifications are not a record of every change. Respond checks
visibility as the issuer before sending. It retries failed deliveries with
backoff and does not auto-disable dead targets; revoke the key to stop its
webhooks. A `2xx` acknowledges the delivery.

Receivers should:

1. Verify the hex HMAC-SHA256 in `X-Respond-Signature` over the exact
   `X-Respond-Timestamp + "." + rawBody` with the signing secret. Compare
   signatures in constant time and reject timestamps more than five minutes
   from your clock. The header timestamp is in epoch seconds.
2. Deduplicate by `(activityId, version)`. A delivery can arrive more than
   once.
3. Treat a delivery as a hint to read detail with the key, using
   `If-None-Match` when you have an ETag. Do not infer activity state or
   deletion from the notification alone.

## Writes

Both POST routes require a `write` key, `Content-Type: application/json`,
a body no larger than 16 KiB, and an `Idempotency-Key` of 16–128 ASCII
letters, digits, underscores or hyphens.

- `POST /api/integration/v1/activities` accepts `{ args }` using the native
  `createActivity` arguments. An optional `externalRef` links the activity to
  an external record. Success is `201 { activityId, version }`; the activity
  ID is derived from the request key, so replaying a create returns the same
  ID.
- `POST /api/integration/v1/activities/:id/changes` accepts
  `{ expectedVersion, operations: [{ name, args }, ...] }`, using the
  activity version from detail and 1–50 native operations other than
  `createActivity`. A batch applies in order, all-or-nothing, with one
  version bump. Success is `200 { version }`.

For a batch of only `setEta` and/or `setMiles` operations on one participant,
you can instead send `{ participantId, expectedParticipantVersion, operations }`.
Use that participant record's `version` from detail and repeat the same
`participantId` in each operation's arguments. Edits to other participants
do not invalidate this precondition, but after a participant is added or
changes units, Respond's `memberInfo` worker can update their record when
the directory returns member info. Their version can therefore advance
without a client write. On `409 stale_version`, read again and retry if the
write still makes sense; the next read does not guarantee that the version
will stay current. An unknown participant yields `404 not_found`.

Use Respond's native argument names, identifiers and statuses. The argument
schemas live in the domain's
[activity](../packages/domain/src/mutations/activity.ts),
[participant](../packages/domain/src/mutations/participants.ts) and
[operations](../packages/domain/src/mutations/operations.ts) mutations,
with these API-specific adaptations:

- **Owners:** `createActivity` defaults `ownerOrgId` to the key's site.
  The owner must be a site or partner option configured for the activity's
  kind. On update, an actual change to owner or kind rechecks the resulting
  pair, in operation order; resending the unchanged pair does not. An
  activity can retain its stored owner if that owner is neither the site
  nor one of its partners. The domain still determines who may create or
  edit each kind of activity.
- **Units:** For `addParticipant`, `setParticipantStatus` and `setUnitStatus`,
  send `unitId` (defaults to the key's site), not a `unit` object. Respond
  uses the names of an existing activity unit first, otherwise the site's
  or a partner's configured names. `setUnitStatus` can also select a
  configured operational unit. The domain still decides who may act and
  which status transitions are allowed.

For writes, the idempotency scope is the site, API key ID, activity and
request key. A committed request and its receipt are stored together.
Resending the same input with the same key returns the original result,
even after a restart or when the original version is now stale, as long
as the key is valid and the activity is still visible to it. Reusing a
committed request key for different input gives `409 idempotency_conflict`.
Rejected writes are not reserved. After a lost response or a server error,
retry with the **same body and `Idempotency-Key`**. If you read again and
change the intent, body or version, use a **new request key**.

## Errors

The activity API returns an `error` code and may include a `message`.
Branch on the code, not the message.

| HTTP | `error` | What to do |
| --- | --- | --- |
| 400 | `invalid_idempotency_key`, `invalid_json`, `bad_args`, `owner_not_allowed`, `unknown_unit` | Fix the header or input; don't retry unchanged. |
| 401 | `unauthorized` | Check the hostname, token, revocation and whether the issuer is still in the directory. Don't retry unchanged. |
| 403 | `forbidden`, `forbidden_scope` | The issuer lacks access to the operation, or the key does not allow writes. Don't retry unchanged. |
| 404 | `not_found`, `no_activity` | Check the site, API availability and resource ID or visibility. A participant may no longer be on the activity. Don't retry unchanged. |
| 409 | `stale_version` | Read detail again, reconsider the write and send an updated version with a new request key. |
| 409 | `idempotency_conflict` | Use the original input to replay the committed write. Use a fresh request key only for a distinct write. |
| 409 | `at_in_future`, `closed`, `exists`, `light_mode`, `not_member`, `standby_only`, `target_gone`, `unit_out`, `unit_step` | Read current state and correct the input or resolve the domain refusal before making a new write. For `at_in_future`, also check the sender's clock. |
| 409 | `unknown_mutation`, other mutation rejection codes | Don't retry unchanged. Check the operation and server compatibility or resolve the cause reported in `message`. |
| 410 | `gone` | The visible activity was removed; stop retrying it. |
| 413 | `body_too_large` | Reduce the body. Splitting a batch makes each resulting request independently atomic. |
| 415 | `expected_json` | Set `Content-Type: application/json` and send JSON. |
| 500 | `internal`, or a generic server failure without an error code | Retry with backoff, keeping the same body and request key for writes. |
| 503 | `directory_unavailable` | Retry with backoff, keeping the same body and request key for writes. |

There is no retry needed for a `200`, `201` or `304`. Errors outside the
activity routes (for example, an unknown hostname) may not use these codes.
The session-based key management routes can also return `403 not_eligible`
when the caller is not eligible to issue a key, or `503 directory_unavailable`
for a failed directory lookup. Other failures on those routes use human-readable
errors (or `not_found` when personal key management is disabled): fix invalid
input (`400`/`415`) or an oversized body (`413`), sign in for `401`, and check
access or the target resource for `403`/`404`. Key issuance is not an
idempotent activity write; if the response was lost, list your keys and
revoke any key whose secret you could not save before issuing another.

## Known limits and follow-ups

- **Change feed:** There is no durable cursor. A feed over `mutation_log`
  must handle transactions committing out of sequence, log entries for
  rejected mutations, visibility of removed activities, imports that do not
  produce log entries, and cursors that would lose precision as JavaScript
  numbers.
- **Busy missions:** Status writes still need the whole activity version.
  Value-based preconditions would need rules for in-place timeline
  corrections, batches and structured rejection details.
- **Names:** Participant names are caller-supplied on both the API and
  WebSocket paths. Resolving them from the directory must not make committed
  replays depend on a new name lookup.
- **WebSocket units:** The WebSocket path does not validate client-supplied
  `unit` objects the way this API does. A shared check belongs in the domain
  or hub.
- **Webhook URLs:** Self-service URLs are not available. They would require
  a host allow-list, blocking private addresses and pinning the connection
  to the validated address.
- **Operations:** Closing and reopening, timeline corrections and team
  editing are not exposed.
- **Outbox location:** The webhook outbox lives in sync-server storage.
  Moving it to the server layer is a separate change.
- **Automatic disabling:** Failing webhooks are not auto-disabled. Any
  future implementation needs locking compatible with enqueue and failure
  counts per job, not just per webhook.
