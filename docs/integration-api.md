# Respond integration API

The November 2026 API proposal for the old Respond server used MongoDB request
reservations and the legacy command queue. This port uses the current Respond
site projection, activity actor, domain mutations and PostgreSQL commit. It
does not give a client database access or enable Basecamp writes.

## Credentials and scope

`INTEGRATION_API_KEYS` is an optional server-side JSON array. Each entry has
`id`, `organizationId`, `sha256` (the lowercase SHA-256 of the entire
`id.secret` token), and `permissions`:

- `read`
- `participants:write`
- `assignments:write`
- `unit-status:write`

Send `x-api-key` over HTTPS to the organization's Respond hostname. Use a
cryptographically random secret; never put it in a browser, URL, or source
control. Revocation removes the entry; rotation keeps the nonsecret ID so
committed receipts survive. Empty config disables the API. Browser sessions
neither authenticate these routes nor gain any new access. Enabling keys
requires `DATABASE_URL`; the API does not fall back to in-memory storage.

## Pull

`GET /api/integration/v1/activities` returns `{ "data": [...] }`, the same
site-filtered summaries as Respond's archive. `GET /api/integration/v1/activities/:id`
returns `{ activityId, version, records }` for a visible activity. Records cover
the activity, units, roster, status history and the responder's view of teams
and assignments. Contact and management-only fields are omitted. On a
participant assignment the responder view exposes the target kind, not the
target's ID. Closed activities can be read; missing, removed and invisible ones
return 404.

The archive is a snapshot, not a cursor or deletion feed. Summary refresh is
asynchronous and can omit changes to fields such as mileage and ETA. A sync
client must fetch detail at its chosen cadence and use the detail version for
writes. Absence from the archive or a detail 404 is not proof of deletion.

## Push

`POST /api/integration/v1/activities/:id/changes` takes one JSON operation
(maximum 16 KiB) and a positive `expectedVersion` from the detail read. Send an
`Idempotency-Key` of 16–128 ASCII letters, digits, underscores or hyphens.

| `type` | Other fields | Scope |
| --- | --- | --- |
| `status` | `participantId`, `status`, optional `at` (epoch ms) | A responder currently recorded under the key's unit |
| `first-status` | `personRef`, `status`, optional `at` | A verified member of that unit's directory not already on the roster |
| `eta` | `participantId`, `eta` (epoch ms or `null`) | A responder currently recorded under the unit |
| `mileage` | `participantId`, `miles` (nonnegative or `null`) | A responder currently recorded under the unit |
| `assignment` | `participantId`, `teamId` (`null` to unassign) | The unit's responder on a visible mission; existing teams only |
| `unit-status` | `status` | The key's unit on a mission owned by that unit |

Use Respond's native status names and identifiers, not legacy numeric statuses
or bare D4H IDs. The API cannot create or edit missions or teams, change another
unit's status, replace a team leader, or unassign someone from a place or group.
Respond's mutation rules still apply. In particular, standing down the unit uses
Respond's normal sign-out behavior for its active roster.

A success is `200 { "version": ... }` after the actor commits the records and
the receipt together. A replay of the same committed request returns the
original version, including after actor unload or server restart. Reusing the
same key with different input on that activity returns 409. On transport
failure or a server error, retry the same body and key to resolve an uncertain
outcome. For `409 stale_version`, pull, reconsider the write against current
state, then send any revised intent with a new key. Rejected operations aren't
committed or reserved. The idempotency scope is organization, integration ID,
activity and key.

Use a local PostgreSQL instance for validation. No real API keys, member records,
or deployment changes are needed to run the test suites.
