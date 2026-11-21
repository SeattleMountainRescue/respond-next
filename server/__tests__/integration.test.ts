import { createHash, createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { ACTIVITY_ARCHIVE_ID, SYSTEM_VIEWER, activitySummary, participantIdFor } from '@sync/domain';
import { MapView, recKey } from '@sync/core';
import { Hub, PostgresStorage } from '@sync/server';
import { activityRegistry, siteActivityProjector } from '@sync/domain';
import { CRT, activityArgs } from '../../packages/domain/__tests__/helpers';
import { integrationKeys } from '../src/integration';
import { CRT_HOST, testApp, testSeed } from './helpers';
import { OrganizationStore } from '../src/organizations';
import { MemberProviders } from '../src/memberProviders';
import { SecretBox } from '../src/secrets';
import { createSyncApp } from '../src/app';
import { MemorySessionStore } from '../src/sessions';
import { deliverIntegrationWebhooks, webhookTargets } from '../src/integrationWebhooks';

const TOKEN = 'test-client.fixture-only';
const READ_TOKEN = 'read-client.fixture-only';
const MEMBER_TOKEN = 'member-client.fixture-only';
const RMR = { id: 'org-rmr', title: 'Ridgeline Mountain Rescue', rosterName: 'RMR' };
const path = '/api/integration/v1/activities/mission';
const BO = participantIdFor('kcsara:3');
const ROWAN = participantIdFor('kcsara:5');

async function setup(ownerOrgId = CRT.id) {
  const keys = integrationKeys(JSON.stringify([{
    id: 'test-client', organizationId: CRT.id, personRef: 'kcsara:1', sha256: createHash('sha256').update(TOKEN).digest('hex'),
    permissions: ['read', 'participants:write', 'assignments:write', 'unit-status:write', 'activities:write'],
  }, {
    id: 'read-client', organizationId: CRT.id, personRef: 'kcsara:3', sha256: createHash('sha256').update(READ_TOKEN).digest('hex'), permissions: ['read'],
  }, {
    id: 'member-client', organizationId: CRT.id, personRef: 'kcsara:3', sha256: createHash('sha256').update(MEMBER_TOKEN).digest('hex'),
  }]));
  const seed = testSeed();
  seed.organizations.find((org) => org.id === CRT.id)!.memberTiers.Field = 'manage';
  const { app, hub } = testApp({ integrationKeys: keys, organizations: OrganizationStore.memory(seed) });
  const now = Date.now() - 10_000;
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [
    { name: 'createActivity', args: activityArgs({ ownerOrgId, startTime: now }) },
    { name: 'addParticipant', args: { personRef: 'kcsara:3', firstname: 'Bo', lastname: 'Okafor', unit: CRT, status: 'responding', at: now } },
    { name: 'addParticipant', args: { personRef: 'kcsara:5', firstname: 'Rowan', lastname: 'Pike', unit: RMR, status: 'responding', at: now } },
    { name: 'createTeam', args: { id: 'team-one', name: 'Team One' } },
  ]);
  const put = (body: object, key = 'fixture-request-0001', token = TOKEN) => app.request(`${path}/changes`, {
    method: 'POST',
    headers: { host: CRT_HOST, 'x-api-key': token, 'idempotency-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const version = async () => (await hub.read('mission', SYSTEM_VIEWER)).version;
  return { app, hub, put, version };
}

  it('revalidates detail and distinguishes removal only for visible activities', async () => {
    const { app, hub, put, version } = await setup();
    const request = (etag?: string) => app.request(path, { headers: { host: CRT_HOST, 'x-api-key': READ_TOKEN, ...(etag && { 'if-none-match': etag }) } });
    const first = await request();
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    expect((await request(`W/${etag}`)).status).toBe(304);
    const change = { type: 'mileage', expectedVersion: await version(), participantId: BO, miles: 5 };
    expect((await put(change, undefined, READ_TOKEN)).status).toBe(403);
    expect((await put(change)).status).toBe(200);
    const changed = await request(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    const at = Date.now();
    await hub.pushAsSystem('mission', SYSTEM_VIEWER, [{ name: 'removeActivity', args: { at } }]);
    const removed = await request(changed.headers.get('etag') ?? '');
    expect(removed.status).toBe(410);
    expect(await removed.json()).toEqual({ error: 'gone', removedAt: at });
  });

  it('returns stable summary versions and filters open activities', async () => {
    const { app, hub } = await setup();
    await hub.pushAsSystem('mission', SYSTEM_VIEWER, [{ name: 'updateActivity', args: { externalRef: 'fixture-ref' } }]);
    const { records } = await hub.read('mission', SYSTEM_VIEWER);
    const summary = activitySummary(new MapView(new Map(records.map((r) => [recKey(r), r]))), 'mission');
    await hub.pushAsSystem(ACTIVITY_ARCHIVE_ID, SYSTEM_VIEWER, [{ name: 'setActivitySummary', args: { id: 'mission', summary: { ...summary, changedAt: 1000 } } }]);
    const list = (query: string) => app.request(`/api/integration/v1/activities?${query}`, { headers: { host: CRT_HOST, 'x-api-key': READ_TOKEN } });
    const open = await (await list('open=true')).json();
    expect(open).toMatchObject({ data: [{ id: 'mission', version: expect.any(Number) }] });
    expect(await (await list('open=true')).json()).toEqual(open);
    expect(await (await list('open=false')).json()).toEqual({ data: [] });
    expect(await (await list('externalRef=fixture-ref&since=999')).json()).toEqual(open);
    expect(await (await list('externalRef=fixture-ref&since=1000')).json()).toEqual({ data: [] });
  });
it('binds API keys to their site and hides contact and management fields', async () => {
  const { app, hub } = await setup();
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [{ name: 'updateTeam', args: { id: 'team-one', notes: 'Internal notes' } }]);
  const request = (host: string, token: string) => app.request(path, { headers: { host, 'x-api-key': token } });
  expect((await request('rmr.localhost', TOKEN)).status).toBe(401);
  expect((await request(CRT_HOST, 'test-client.invalid')).status).toBe(401);
  const response = await request(CRT_HOST, TOKEN);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { records } = await response.json();
  expect(records).toContainEqual(expect.objectContaining({ type: 'team', id: 'team-one', name: 'Team One' }));
  expect(records.find((r: { type: string }) => r.type === 'team')).not.toHaveProperty('notes');
  expect(records).not.toContainEqual(expect.objectContaining({ type: 'contact' }));
});

it('serializes competing writes, replays a committed result, and rejects key reuse with different input', async () => {
  const { put, version, hub } = await setup();
  const expectedVersion = await version();
  const write = { type: 'mileage', expectedVersion, participantId: BO, miles: 0 };
  const [first, duplicate] = await Promise.all([put(write), put(write)]);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ version: expectedVersion + 1 });
  expect(await duplicate.json()).toEqual({ version: expectedVersion + 1 });
  expect(await version()).toBe(expectedVersion + 1);
  expect((await put({ ...write, miles: 8 })).status).toBe(409);
  expect(await (await put({ ...write, miles: 8 }, 'fixture-request-0002')).json()).toMatchObject({ error: 'stale_version' });
  expect((await hub.read('mission', SYSTEM_VIEWER)).records).toContainEqual(expect.objectContaining({ id: BO, miles: 0 }));
});

it('allows assignments on shared missions but not partner participants or shared unit management', async () => {
  const { put, version, hub } = await setup(RMR.id);
  const expectedVersion = await version();
  expect((await put({ type: 'assignment', expectedVersion, participantId: ROWAN, teamId: 'team-one' })).status).toBe(404);
  expect((await put({ type: 'unit-status', expectedVersion, status: 'stoodDown' })).status).toBe(403);
  expect((await put({ type: 'assignment', expectedVersion, participantId: BO, teamId: 'team-one' })).status).toBe(200);
  expect((await hub.read('mission', SYSTEM_VIEWER)).records).toContainEqual(expect.objectContaining({ type: 'assignment', participantId: BO, target: { kind: 'team', id: 'team-one' } }));
});

it('requires a scoped directory match for first status and applies own-unit status through Respond', async () => {
  const { put, version, hub } = await setup();
  const expectedVersion = await version();
  const first = { type: 'first-status', expectedVersion, status: 'responding' };
  expect((await put({ ...first, personRef: 'kcsara:5' })).status).toBe(404);
  const added = await put({ ...first, personRef: 'kcsara:1' });
  expect(added.status).toBe(200);
  const status = await put({ type: 'unit-status', expectedVersion: await version(), status: 'stoodDown' }, 'fixture-request-0002');
  expect(status.status).toBe(200);
  const { records } = await hub.read('mission', SYSTEM_VIEWER);
  expect(records).toContainEqual(expect.objectContaining({ type: 'participant', personRef: 'kcsara:1', firstname: 'Avery' }));
  expect(records).toContainEqual(expect.objectContaining({ type: 'unitStatus', unitId: CRT.id, status: 'stoodDown' }));
  const afterStandDown = await version();
  const reactivation = await put({ ...first, expectedVersion: afterStandDown, personRef: 'kcsara:2', status: 'standby' }, 'fixture-request-0003');
  expect(reactivation.status).toBe(409);
  expect(await reactivation.json()).toMatchObject({ error: 'unit_out' });
  expect(await version()).toBe(afterStandDown);
});

it('rejects implausible input without committing or reserving the request key', async () => {
  const { put, version } = await setup();
  const expectedVersion = await version();
  for (const [change, error] of [
    [{ type: 'first-status', personRef: 'kcsara:1', status: 'responding', at: 1 }, 'status_before_window'],
    [{ type: 'eta', participantId: BO, eta: Date.now() + 8 * 86_400_000 }, 'eta_too_far'],
    [{ type: 'mileage', participantId: BO, miles: 2001 }, 'mileage_too_high'],
  ] as const) {
    const response = await put({ ...change, expectedVersion });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  }
  expect(await version()).toBe(expectedVersion);
  expect((await put({ type: 'mileage', expectedVersion, participantId: BO, miles: 2000 })).status).toBe(200);
});

it('uses the bound member’s tier when creating a mission and safely replays event creation', async () => {
  const { app } = await setup();
  const create = (kind: 'mission' | 'other', token = MEMBER_TOKEN) => app.request('/api/integration/v1/activities', {
    method: 'POST',
    headers: { host: CRT_HOST, 'x-api-key': token, 'idempotency-key': 'fixture-create-0001', 'content-type': 'application/json' },
    body: JSON.stringify({ args: activityArgs({ kind, ownerOrgId: CRT.id }) }),
  });
  expect((await create('mission')).status).toBe(403);
  const event = await create('other');
  expect(event.status).toBe(201);
  expect(await (await create('other')).json()).toEqual(await event.json());
  expect((await create('mission', TOKEN)).status).toBe(201);
});

it('commits a native change batch once and rolls back all changes if one is rejected', async () => {
  const { put, version, hub } = await setup();
  const expectedVersion = await version();
  const mileage = { name: 'setMiles', args: { participantId: BO, miles: 5 } };
  expect((await put({ expectedVersion, operations: [mileage, { name: 'setEta', args: { participantId: 'missing', eta: null } }] })).status).toBe(404);
  expect(await version()).toBe(expectedVersion);
  const changes = { expectedVersion, operations: [mileage, { name: 'updateActivity', args: { title: 'New title' } }] };
  expect(await (await put(changes)).json()).toEqual({ version: expectedVersion + 1 });
  expect(await (await put(changes)).json()).toEqual({ version: expectedVersion + 1 });
  expect((await hub.read('mission', SYSTEM_VIEWER)).records).toContainEqual(expect.objectContaining({ id: BO, miles: 5 }));
});

it('accepts unrelated activity changes with a participant version but rejects a changed participant', async () => {
  const { put, hub } = await setup();
  const before = await hub.read('mission', SYSTEM_VIEWER);
  const expectedParticipantVersion = before.records.find((r) => r.type === 'participant' && r.id === BO)!.version;
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [{ name: 'setMiles', args: { participantId: ROWAN, miles: 10 } }]);
  const batch = { participantId: BO, expectedParticipantVersion, operations: [{ name: 'setMiles', args: { participantId: BO, miles: 15 } }] };
  expect((await put(batch)).status).toBe(200);
  const stale = await put(batch, 'fixture-request-0002');
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'stale_version' });
});

it.skipIf(!process.env.TEST_DATABASE_URL)('issues, signs, and revokes organization keys against PostgreSQL', async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new pg.Client({ connectionString: base.toString() });
  const database = `integration_test_${randomUUID().replaceAll('-', '')}`;
  await admin.connect();
  let storage: PostgresStorage | undefined;
  let organizations: OrganizationStore | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    base.pathname = `/${database}`;
    storage = await PostgresStorage.connect(base.toString());
    organizations = await OrganizationStore.connect(base.toString(), { secrets: SecretBox.ephemeral() });
    await organizations.importSeed(testSeed());
    const members = new MemberProviders(organizations);
    const hub = new Hub({ storage, registry: activityRegistry, projector: siteActivityProjector(organizations.seesActivity), now: Date.now });
    const targets = webhookTargets(JSON.stringify({ review: { organizationId: CRT.id, url: 'https://example.test/receive' } }));
    const { app } = createSyncApp(hub, { organizations, members, sessions: new MemorySessionStore(), webhookTargets: targets, devSignIn: true });
    const signIn = await app.request('/api/auth/dev', {
      method: 'POST', headers: { host: CRT_HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'harper.okonkwo@crt.example.org', class: 'member' }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const ownerPath = `/api/admin/organizations/${CRT.id}/integration-keys`;
    const headers = { host: CRT_HOST, cookie, 'content-type': 'application/json' };
    expect((await app.request(`/api/admin/organizations/${RMR.id}/integration-keys`, { headers })).status).toBe(403);
    const issue = await app.request(ownerPath, { method: 'POST', headers, body: JSON.stringify({ name: 'Review', personRef: 'kcsara:1', webhookTarget: 'review' }) });
    expect(issue.status).toBe(201);
    const key = await issue.json() as { id: string; token: string; signingSecret: string };
    const read = () => app.request('/api/integration/v1/activities', { headers: { host: CRT_HOST, 'x-api-key': key.token } });
    expect((await read()).status).toBe(200);
    const listed = await (await app.request(ownerPath, { headers })).json();
    expect(listed).toMatchObject({ keys: [{ id: key.id, lastUsedAt: expect.any(String) }] });
    expect(JSON.stringify(listed)).not.toContain(key.signingSecret);
    expect(JSON.stringify(listed)).not.toContain(key.token);
    await hub.pushAsSystem('mission', SYSTEM_VIEWER, [{ name: 'createActivity', args: activityArgs({ ownerOrgId: CRT.id }) }]);
    const deliveries: RequestInit[] = [];
    const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) deliveries.push(init);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await deliverIntegrationWebhooks(organizations, members, hub, targets, send);
    expect(deliveries).toHaveLength(1);
    const deliveryHeaders = new Headers(deliveries[0]?.headers);
    const body = String(deliveries[0]?.body);
    expect(JSON.parse(body)).toMatchObject({ activityId: 'mission', version: 1, changedAt: expect.any(Number) });
    expect(deliveryHeaders.get('x-respond-signature')).toBe(createHmac('sha256', key.signingSecret).update(`${deliveryHeaders.get('x-respond-timestamp')}.${body}`).digest('hex'));
    expect((await app.request(`${ownerPath}/${key.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await read()).status).toBe(401);
  } finally {
    await storage?.close();
    await organizations?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}, 20_000);
