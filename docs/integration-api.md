# Respond integration API

The November 2026 API proposal for the old Respond server used MongoDB request
reservations and the legacy command queue. This port uses the current Respond
site projection, activity actor, domain mutations and PostgreSQL commit. It
does not give a client database access or enable Basecamp writes.

## Credentials and scope

Organization admins can issue or revoke keys under **Admin > Organizations**.
The secret is shown only at issuance; PostgreSQL stores only its hash, and
revocation takes effect on the next request. The displayed last-used time
updates at most every five minutes.

`INTEGRATION_API_KEYS` is an optional bootstrap JSON array. Each entry has
`id`, `organizationId`, `personRef`, and `sha256` (the lowercase SHA-256 of
the entire `id.secret` token). `personRef` must resolve in the site's member
directory; Respond refreshes the member's tier and activity grants on each
request. An optional `permissions` array can narrow, but never grant, access:

- `read`
- `participants:write`
- `assignments:write`
- `unit-status:write`
- `activities:write`

Send `x-api-key` over HTTPS to the organization's Respond hostname. Use a
cryptographically random secret; never put it in a browser, URL, or source
control. Revocation removes the entry; rotation keeps the nonsecret ID so
committed receipts survive. Browser sessions do not authenticate integration
routes. Enabling keys
requires `DATABASE_URL`; the API does not fall back to in-memory storage.

## Pull

`GET /api/integration/v1/activities` returns `{ "data": [...] }`, the same
site-filtered summaries as Respond's archive. Use `?open=true` for open
activities or `?open=false` for closed ones. `?since=<epoch ms>` returns
summaries with `changedAt` after that time, and `?externalRef=...` matches a
reference on an activity owned by the caller's site. Use an overlapping
window and deduplicate: the summary update is debounced, and `since` is not
a durable cursor. A summary's `version` is its archive record version;
`activityVersion` is the version of the activity when summarized. Existing
archive entries get the change metadata on their next update.
`GET /api/integration/v1/activities/:id`
returns `{ activityId, version, records }` for a visible activity. Records cover
the activity, units, roster, status history and the responder's view of teams
and assignments. Contact and management-only fields are omitted. On a
participant assignment the responder view exposes the target kind, not the
target's ID. Free-text status causes are omitted. Detail returns an `ETag`;
send it as `If-None-Match` on the next read for a bodyless `304` if unchanged.
Closed activities can be read. Removed activities that are still visible under
site rules return `410 { error: "gone", removedAt }`; missing or invisible ones
return 404.

The archive is a snapshot, not a cursor or deletion feed. Summary refresh is
asynchronous; use the detail version for writes. Absence from the archive or
a detail 404 is not proof of deletion.

### Webhooks

Operators may configure an `INTEGRATION_WEBHOOK_TARGETS` JSON map from target
names to `{ organizationId, url }`, with trusted HTTPS destinations and no URL
credentials, queries, or redirects. Organization admins can select one of their
approved target names when issuing a key. The separate signing secret is shown
once and stored encrypted using `SECRETS_KEY`.

The outbox delivers `{ activityId, version, changedAt }` at least once for
currently visible activities. Respond commits the outbox entry with the change
and retries failures with backoff. Verify the hex HMAC-SHA256 in
`X-Respond-Signature` over `X-Respond-Timestamp + "." + rawBody` with the signing
secret; reject timestamps more than five minutes off your clock. The header
timestamp is epoch seconds, `changedAt` is epoch milliseconds. Deduplicate
by activity and version, and re-read with the integration key.

## Push

`POST /api/integration/v1/activities/:id/changes` takes a convenience
operation below, or `{ expectedVersion, operations: [{ name, args }, ...] }`
with up to 50 native Respond operations. A batch is all-or-nothing and advances
the version once. Native operations are `addParticipant`, `setParticipantStatus`,
`setEta`, `setMiles`, `assign`, `setUnitStatus`, and `updateActivity`; their
arguments and rights are the ones Respond uses. Ownership changes are not
supported. Convenience operations add the unit and input limits below.
For a native batch containing only `setEta`/`setMiles` for one participant,
send `participantId` and `expectedParticipantVersion` instead of
`expectedVersion`. Use that participant record's detail `version`. Other
participants' changes won't invalidate the batch; an edit to that participant
will. Other mutations still use the whole activity version.
The body is limited to 16 KiB. Send an
`Idempotency-Key` of 16–128 ASCII letters, digits, underscores or hyphens.

| `type` | Other fields | Scope |
| --- | --- | --- |
| `status` | `participantId`, `status`, optional `at` (epoch ms) | A responder currently recorded under the key's unit |
| `first-status` | `personRef`, `status`, optional `at` | A verified member of that unit's directory not already on the roster |
| `eta` | `participantId`, `eta` (epoch ms or `null`) | A responder currently recorded under the unit |
| `mileage` | `participantId`, `miles` (nonnegative or `null`) | A responder currently recorded under the unit |
| `assignment` | `participantId`, `teamId` (`null` to unassign) | The unit's responder on a visible mission; existing teams only |
| `unit-status` | `status` | The key's unit on a mission owned by that unit |

`POST /api/integration/v1/activities` takes `{ args }` using Respond's
`createActivity` arguments. Ownership is fixed to the key's site. Site
creation flags and the bound member's tier both apply. Pass an optional
`externalRef` to link the activity to an external record. Success is
`201 { activityId, version }`; retrying the same create returns the same ID.

Use Respond's native status names and identifiers, not legacy numeric statuses
or bare D4H IDs. The API cannot create or edit teams. The convenience operations cannot change another
unit's status, replace a team leader, or unassign someone from a place or group.
Respond's mutation rules still apply. In particular, standing down the unit uses
Respond's normal sign-out behavior for its active roster.
Participant writes cannot reactivate a stood-down or non-responding unit
(`409 unit_out`). Status times before the start minus the configured early
sign-in window (with at least five minutes of leeway), ETAs over seven days
ahead, and mileage over 2,000 miles return 400 with `status_before_window`,
`eta_too_far`, or `mileage_too_high`, respectively.

A success is `200 { "version": ... }` after the actor commits the records and
the receipt together. A replay of the same committed request returns the
original version, including after actor unload or server restart. Reusing the
same key with different input on that activity returns 409. On transport
failure or a server error, retry the same body and key to resolve an uncertain
outcome. For `409 stale_version`, pull, reconsider the write against current
state, then send any revised intent with a new key. Rejected operations aren't
committed or reserved. The idempotency scope is organization, integration ID,
activity and key.

Writes return 400 for invalid keys in `Idempotency-Key`, malformed JSON or
invalid arguments; 401 for invalid API credentials; 403 for disallowed
operations; 404 for missing or invisible resources; 413 for oversized bodies;
and 415 for non-JSON content. Domain refusals (such as `closed`, `stale_time`,
or `standby_only`) return 409: correct the cause before resubmitting. Directory
failures return 502/503; internal failures return 500. For 5xx responses retry
with the original body and key.

Use a local PostgreSQL instance for validation. No real API keys, member records,
or deployment changes are needed to run the test suites.
