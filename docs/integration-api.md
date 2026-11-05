# Integration API (local revision of upstream PR #162)

This revision targets the current Hono server and command/event pipeline. It is
not deployed and does not change any Basecamp dependency or configuration. The
existing upstream PR branch is deliberately untouched.

## Credentials and authorization

An administrator configures `INTEGRATION_API_KEYS` as a JSON array:

```json
[
  {
    "id": "example-app",
    "sha256": "<64 lowercase hexadecimal characters>",
    "organizationId": "<Respond organization ID>",
    "permissions": ["activities:read", "members:read", "participants:write", "activities:create"]
  }
]
```

Generate a random secret and hash the **entire** `id.secret` token, for example:

```sh
node --input-type=module -e "import {randomBytes,createHash} from 'node:crypto'; const token='example-app.'+randomBytes(32).toString('hex'); console.log('Token:',token); console.log('SHA256:',createHash('sha256').update(token).digest('hex'));"
```

Deliver the token privately and store only its hash in Respond's deployment
configuration. Send the token over HTTPS in `x-api-key`, never in a URL or
browser bundle. The nonsecret ID is used for audit attribution. Rotate the hash
under the same ID to retain idempotency history; removing an entry revokes it.
Absent configuration disables key access; malformed configuration fails closed.
An explicitly supplied invalid key never falls back to browser-cookie access.
No key is enabled in the repository's default configuration.

Permissions are independent. `activities:create` also requires the owning
organization's existing `canCreateMissions` or `canCreateEvents` flag. A key
cannot choose another organization or borrow a partner's creation permissions.
`GET /api/v1/integration` reports the key's organization, permissions and effective
creation flags. API-key responses use `Cache-Control: no-store`.

## Existing read routes

| Method and path                                      | Permission        | Result                                                       |
| ---------------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| `GET /api/v1/missions`                               | `activities:read` | In-scope mission activities                                  |
| `GET /api/v1/events`                                 | `activities:read` | In-scope event activities                                    |
| `GET /api/v1/activities/:activityId`                 | `activities:read` | One complete in-scope activity                               |
| `GET /api/v1/organizations/:orgId/members?query=...` | `members:read`    | Own-organization member search; query length 3-100           |
| `GET /api/v1/organizations/:orgId/members/:memberId` | `members:read`    | Own-organization identity before the first activity response |

These are the existing routes, not a second `/partner/` API. Successful browser
cookie reads retain their existing behavior. Keys are not supported on unrelated
routes, such as member photos, Google login or socket authentication.

Activity scope includes activities owned by the key's organization or a
configured partner, and activities explicitly listing one of those organizations.
An invisible activity returns 404 just like a missing activity. A visible
activity includes **all** its participant timelines and operations fields
(`teams`, `groups`, `places`, `staff`, `comms`), including other units. This is
shared-incident visibility, not access to other units' member directories.
Reads include closed/historical records. Lists currently return the full in-scope
set, sorted by start time; there is no incremental feed or pagination contract.

Member IDs are Respond's provider participant IDs (D4H's numeric member ID
encoded as a string), not a DEM number, Firebase UID, or composite
`organizationId:memberId` login ID. New participant writes resolve the ID through
the owning organization's member provider and take its name from that provider.
The D4H lookup addresses that organization's team explicitly. A provider without
organization-scoped lookup cannot create participants through this API.
Integration directory responses contain names and IDs, not contact details.

## Writes

All writes require `x-api-key`, JSON, and `Idempotency-Key`. Bodies are limited to
16 KiB and unknown fields are rejected.

| Method and path                                            | Permission                     | Body                                      |
| ---------------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| `PUT /api/v1/activities/:id/participants/:memberId/status` | `participants:write`           | `{"status":3,"time":<optional epoch ms>}` |
| `PUT /api/v1/activities/:id/participants/:memberId/eta`    | `participants:write`           | `{"eta":<epoch ms or null>}`              |
| `PUT /api/v1/activities/:id/participants/:memberId/miles`  | `participants:write`           | `{"miles":<nonnegative number or null>}`  |
| `POST /api/v1/missions`                                    | `activities:create` + org flag | Activity creation fields below            |
| `POST /api/v1/events`                                      | `activities:create` + org flag | Activity creation fields below            |

Status codes retain Respond's meanings: 0 Not Responding, 1 In Town, 2 Standby,
3 Responding, 4 Signed Out, 5 Available, 6 Assigned, 7 Demobilized. Basecamp's
adapter must continue sending only the statuses its policy permits. Status times
must be positive integer epoch milliseconds, not older than the participant's
latest entry and not more than five minutes in the future. Omitted time means
server time. The sign-in window and standby-only restriction are enforced.

ETA can be cleared with null; numeric ETA permits five minutes of past-clock
tolerance. Mileage can be cleared with null; zero is a valid explicit value.
ETA/mileage changes never synthesize a status entry or create an unknown member.
Closed activities refuse changes. Writes to another organization's participant
are forbidden, including a status change whose shared reducer would sign that
person out of another organization's response.

Creation requires `title` and `startTime` (epoch ms), and accepts `idNumber`,
`description`, `mapId`. Limits are 500, 100, 10000 and 2048 characters,
respectively. The server supplies the ID, owner, empty location, type and
organization entry. Creation does not edit an existing activity or accept
arbitrary command payloads, participants, staff or lifecycle operations.

### Confirmation, replay and uncertain outcomes

Use an `Idempotency-Key` of 16-128 ASCII letters, digits, underscores or hyphens
(a UUID works). Use the same key and JSON fields on a retry; changing a field
or endpoint with the same key returns 409. Top-level JSON property order is
normalized. The database's unique request ID prevents concurrent requests from
dispatching the same write twice, including after a server restart. Records do
not automatically expire.

Successful updates return 200; creates return 201:

```json
{ "status": "ok", "data": { "commandId": "<audit correlation ID>", "activityId": "<Respond ID>" } }
```

Success is returned only after the normal command pipeline has reduced,
persisted and broadcast the command(s), and the completed receipt is saved.
First responses and creates may use two commands (organization entry and
participant/activity update). They are serialized together, but are **not**
a new cross-command database transaction. A failure can leave partial effects.
No external member-provider lookup runs while holding the command queue.
Authorization and activity-state checks run again inside that queue.

A lost response after completion is safe to retry with the same key: the saved
receipt is returned without dispatching again. Pending or uncertain requests
return `write_unconfirmed` (409 for replay, 503 for a dispatch failure), with
activity/command IDs in the message. **Do not retry with a new key.** Inspect the
activity, matching `events.meta.commandId`, and `integrationRequests` receipt
before an administrator resolves the uncertainty. The API does not claim that a
failed acknowledgement means nothing was written, automatically retry a partial
write, or silently expire its reservation.

## Validation and eventual Basecamp adoption

`npm test -- server/src/__tests__/integrationApiTests.ts` exercises the real
routes, command pipeline, MongoDB persistence and broadcast listener with synthetic
organizations and a fake member provider. MongoDB runs locally through the
repository's existing `mongodb-memory-server` dependency; no Respond, D4H or
Basecamp deployment is contacted.

Basecamp is intentionally unchanged. A future adapter must preserve its source
captures, status/field mapping, call budgets, write gates, durable pending
intents and explicit unconfirmed outcomes. API credentials are server-only.
Adoption requires deploying and validating the API first; this local branch does
not replace the session minter or browser-session connector.
