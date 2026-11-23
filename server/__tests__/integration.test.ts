import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it, onTestFinished, vi } from 'vitest';
import { MapView, MutationRegistry, recKey } from '@sync/core';
import {
  ACTIVITY_ARCHIVE_ID, OrganizationSeed, SYSTEM_VIEWER, activityMutations, activityRegistry,
  activitySummary, participantIdFor, siteActivityProjector,
} from '@sync/domain';
import { Hub, PostgresStorage } from '@sync/server';
import { CRT, RMR, activityArgs } from '../../packages/domain/__tests__/helpers';
import { createSyncApp } from '../src/app';
import { PostgresGrantStore } from '../src/grants';
import { deliverIntegrationWebhooks, webhookTargets } from '../src/integrationWebhooks';
import { MemberProviders } from '../src/memberProviders';
import { OrganizationStore } from '../src/organizations';
import { SecretBox } from '../src/secrets';
import { MemorySessionStore } from '../src/sessions';
import { CRT_HOST, testSeed } from './helpers';

const activities = '/api/integration/v1/activities';
const personalKeys = '/api/integration-keys';
const adminKeys = `/api/admin/organizations/${CRT.id}/integration-keys`;
const BO = participantIdFor('kcsara:3');
const ROWAN = participantIdFor('kcsara:5');
const AVERY_EMAIL = 'avery.lindqvist@crt.example.org';
const BO_EMAIL = 'bo.okafor@crt.example.org';
const ROWAN_EMAIL = 'rowan.pike@rmr.example.org';
const HARPER_EMAIL = 'harper.okonkwo@crt.example.org';
const CROSS_SITE = { id: 'org-cross', host: 'cross.localhost', email: 'drew.morgan@cross.example.org' };
const STORED_RMR = { ...RMR, title: 'Ridgeline Field Unit', rosterName: 'RFU' };
const pgTest = (name: string, test: () => Promise<void>) => it.skipIf(!process.env.TEST_DATABASE_URL)(name, test, 20_000);

function seed() {
  const base = testSeed();
  base.organizations.find((org) => org.id === CRT.id)!.memberTiers.Field = 'manage';
  base.organizations.find((org) => org.id === CRT.id)!.partners.push({ id: CROSS_SITE.id, canCreateMissions: false, canCreateEvents: false });
  base.organizations.find((org) => org.id === RMR.id)!.admins.push(ROWAN_EMAIL);
  return OrganizationSeed.parse({
    ...base,
    memberProviders: [...base.memberProviders, {
      id: 'cross', kind: 'fixture', units: { CROSS: { emailDomain: 'cross.example.org', members: [['Drew', 'Morgan', 'Lead']] } },
    }],
    organizations: [...base.organizations, {
      id: CROSS_SITE.id, title: 'Cross Valley Rescue', shortTitle: 'Cross',
      hostnames: [CROSS_SITE.host], emailDomains: ['cross.example.org'], memberProvider: 'cross',
      providerUnit: 'CROSS', memberTiers: { Lead: 'manage' },
    }],
  });
}

type IssuedKey = { id: string; token: string; signingSecret?: string };
type SignIn = { class?: 'member' | 'external'; name?: string; personRef?: string };

async function setup(registry: MutationRegistry = activityRegistry) {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new pg.Client({ connectionString: base.toString() });
  const database = `integration_test_${randomUUID().replaceAll('-', '')}`;
  let storage: PostgresStorage | undefined;
  let orgStore: OrganizationStore | undefined;
  let grantStore: PostgresGrantStore | undefined;
  await admin.connect();
  onTestFinished(async () => {
    try {
      await Promise.all([storage?.close(), orgStore?.close(), grantStore?.close()]);
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE ${database}`);
  base.pathname = `/${database}`;
  storage = await PostgresStorage.connect(base.toString());
  const organizations = orgStore = await OrganizationStore.connect(base.toString(), { secrets: SecretBox.ephemeral() });
  const grants = grantStore = await PostgresGrantStore.connect(base.toString());
  await organizations.importSeed(seed());
  const members = new MemberProviders(organizations);
  const hub = new Hub({ storage, registry, projector: siteActivityProjector(organizations.seesActivity), now: Date.now });
  const targets = webhookTargets(JSON.stringify({ review: { organizationId: CRT.id, url: 'https://example.test/receive' } }));
  const { app } = createSyncApp(hub, { organizations, members, grants, sessions: new MemorySessionStore(), webhookTargets: targets, devSignIn: true });

  async function signIn(email = AVERY_EMAIL, host = CRT_HOST, input: SignIn = {}) {
    const signed = await app.request('/api/auth/dev', {
      method: 'POST', headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ email, class: 'member', ...input }),
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get('set-cookie')!.split(';')[0]!;
    return (path: string, method = 'GET', body?: object) => app.request(path, {
      method, headers: { host, cookie, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function issue(session: Awaited<ReturnType<typeof signIn>>, scope: 'read' | 'write' = 'write', webhookTarget?: string) {
    const response = await session(personalKeys, 'POST', { name: 'Review', scope, webhookTarget });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return await response.json() as IssuedKey;
  }
  async function key(email = AVERY_EMAIL, scope: 'read' | 'write' = 'write') {
    return issue(await signIn(email), scope);
  }
  function api(token: string, host = CRT_HOST) {
    const post = (path: string, body: object | string, key = 'fixture-request-0001') => app.request(path, {
      method: 'POST',
      headers: { host, 'x-api-key': token, 'idempotency-key': key, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const get = (path: string, headers?: Record<string, string>) => app.request(path, { headers: { host, 'x-api-key': token, ...headers } });
    return {
      get,
      post,
      detail: (id = 'mission', headers?: Record<string, string>) => get(`${activities}/${id}`, headers),
      create: (args: object, requestKey?: string) => post(activities, { args }, requestKey),
      change: (body: object, requestKey?: string, id = 'mission') => post(`${activities}/${id}/changes`, body, requestKey),
    };
  }
  const read = (id = 'mission') => hub.read(id, SYSTEM_VIEWER);
  const version = async (id?: string) => (await read(id)).version;
  async function mission(id = 'mission', ownerOrgId = CRT.id) {
    const at = Date.now() - 10_000;
    await hub.pushAsSystem(id, SYSTEM_VIEWER, [
      { name: 'createActivity', args: activityArgs({ ownerOrgId, startTime: at }) },
      { name: 'addParticipant', args: { personRef: 'kcsara:3', firstname: 'Bo', lastname: 'Okafor', unit: CRT, status: 'responding', at } },
      { name: 'addParticipant', args: { personRef: 'kcsara:5', firstname: 'Rowan', lastname: 'Pike', unit: STORED_RMR, status: 'responding', at } },
      { name: 'createTeam', args: { id: 'team-one', name: 'Team One' } },
      { name: 'updateTeam', args: { id: 'team-one', notes: 'Internal notes' } },
    ]);
    expect((await read(id)).records).toContainEqual(expect.objectContaining({ type: 'team', notes: 'Internal notes' }));
  }
  return { api, signIn, issue, key, hub, read, version, mission, grants, organizations, members, targets };
}

const op = (name: string, args: object) => ({ name, args });
const miles = (value: number) => op('setMiles', { participantId: BO, miles: value });
const batch = (expectedVersion: number, ...operations: ReturnType<typeof op>[]) => ({ expectedVersion, operations });
const createArgs = (kind: 'mission' | 'training', ownerOrgId = CRT.id) => activityArgs({ kind, ownerOrgId });

async function error(response: Response, status: number, code: string, message?: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: code, ...(message && { message }) });
}

pgTest('T1: read keys can list and read detail but cannot use either write endpoint', async () => {
  const { api, key, mission, version } = await setup();
  await mission();
  const client = api((await key(BO_EMAIL, 'read')).token);
  expect((await client.get(activities)).status).toBe(200);
  expect((await client.detail()).status).toBe(200);
  await error(await client.create(createArgs('training')), 403, 'forbidden_scope');
  await error(await client.change(batch(await version(), miles(5))), 403, 'forbidden_scope');
});

pgTest('T2: the domain refuses mission creation by a responder but allows training and replays creation', async () => {
  const { api, key } = await setup();
  const client = api((await key(BO_EMAIL)).token);
  await error(await client.create(createArgs('mission')), 403, 'forbidden', 'Only a manager can create a mission');
  const training = await client.create(createArgs('training'));
  expect(training.status).toBe(201);
  const replay = await client.create(createArgs('training'));
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(await training.json());
});

pgTest('T3: personal issuance binds the caller and does not expose secrets in lists', async () => {
  const { api, signIn, issue } = await setup();
  const owner = await signIn(BO_EMAIL);
  const admin = await signIn(HARPER_EMAIL);
  expect((await owner(personalKeys, 'POST', { name: 'Review', scope: 'read', personRef: 'kcsara:1' })).status).toBe(400);
  expect((await admin(adminKeys, 'POST', { name: 'Review', scope: 'read' })).status).toBe(404);
  const key = await issue(owner, 'read', 'review');
  expect(key.signingSecret).toEqual(expect.any(String));
  expect((await api(key.token).get(activities)).status).toBe(200);
  const personal = await owner(personalKeys);
  expect(personal.headers.get('cache-control')).toBe('no-store');
  const personalList = await personal.json();
  expect(personalList).toMatchObject({ keys: [{ id: key.id, name: 'Review', scope: 'read' }] });
  expect(await (await admin(personalKeys)).json()).toEqual({ keys: [] });
  const listed = await (await admin(adminKeys)).json();
  expect(listed).toMatchObject({ keys: [{ id: key.id, personRef: 'kcsara:3', scope: 'read', lastUsedAt: expect.any(String) }] });
  for (const list of [personalList, listed]) {
    expect(JSON.stringify(list)).not.toContain(key.token);
    expect(JSON.stringify(list)).not.toContain(key.signingSecret!);
  }
  const invalidToken = key.token.slice(0, -1) + (key.token.endsWith('0') ? '1' : '0');
  await error(await api(invalidToken).get(activities), 401, 'unauthorized');
});

pgTest('T4: only the owner or an authorized organization admin can revoke a key', async () => {
  const { api, signIn, issue } = await setup();
  const owner = await signIn(BO_EMAIL);
  const key = await issue(owner);
  const otherMember = await signIn();
  const unrelatedAdmin = await signIn(ROWAN_EMAIL, 'rmr.localhost');
  const admin = await signIn(HARPER_EMAIL);
  expect((await unrelatedAdmin(`/api/admin/organizations/${RMR.id}/integration-keys`)).status).toBe(200);
  expect((await otherMember(`${personalKeys}/${key.id}`, 'DELETE')).status).toBe(404);
  expect((await unrelatedAdmin(`${adminKeys}/${key.id}`, 'DELETE')).status).toBe(403);
  expect((await admin(`${adminKeys}/${key.id}`, 'DELETE')).status).toBe(200);
  await error(await api(key.token).get(activities), 401, 'unauthorized');
});

pgTest('T5 and T6b: a member from a different provider keeps their session tier and receives a signed webhook', async () => {
  const { api, signIn, issue, organizations, members, hub, targets } = await setup();
  const session = await signIn(CROSS_SITE.email);
  expect(await (await session('/api/auth/session')).json()).toMatchObject({ session: { personRef: 'cross:1', tier: 'manage' } });
  const key = await issue(session, 'write', 'review');
  const client = api(key.token);
  const created = await client.create(createArgs('mission'));
  expect(created.status).toBe(201);
  const { activityId, version } = await created.json();
  expect((await client.detail(activityId)).status).toBe(200);
  await error(await api(key.token, CROSS_SITE.host).detail(activityId), 401, 'unauthorized');
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  await deliverIntegrationWebhooks(organizations, members, hub, targets, send);
  expect(send).toHaveBeenCalledTimes(1);
  const [, init] = send.mock.calls[0]!;
  const headers = new Headers(init?.headers);
  const body = String(init?.body);
  expect(JSON.parse(body)).toMatchObject({ activityId, version, changedAt: expect.any(Number) });
  expect(headers.get('x-respond-signature')).toBe(createHmac('sha256', key.signingSecret!).update(`${headers.get('x-respond-timestamp')}.${body}`).digest('hex'));
});

pgTest('T6 and T8: mission projections use current per-activity grants and stop on personal revocation', async () => {
  const { api, signIn, issue, mission, grants } = await setup();
  await mission();
  await mission('other-mission');
  await grants.set('kcsara:3', 'mission', { tier: 'manage', grantedBy: 'kcsara:1', grantedAt: Date.now() });
  const owner = await signIn(BO_EMAIL);
  const key = await issue(owner);
  const client = api(key.token);
  async function team(id?: string) {
    const response = await client.detail(id);
    expect(response.status).toBe(200);
    const { records } = await response.json();
    const result = records.find((r: { type: string }) => r.type === 'team');
    expect(result).toMatchObject({ id: 'team-one', name: 'Team One' });
    return result;
  }
  expect(await team()).toHaveProperty('notes', 'Internal notes');
  expect(await team('other-mission')).not.toHaveProperty('notes');
  await grants.remove('kcsara:3', 'mission');
  expect(await team()).not.toHaveProperty('notes');
  const revoked = await owner(`${personalKeys}/${key.id}`, 'DELETE');
  expect(revoked.status).toBe(200);
  expect(revoked.headers.get('cache-control')).toBe('no-store');
  await error(await client.detail(), 401, 'unauthorized');
});

pgTest('T6c: external and adhoc sessions cannot issue keys; a missing directory member is rejected', async () => {
  const { signIn } = await setup();
  const external = await signIn(BO_EMAIL, CRT_HOST, { class: 'external' });
  const adhoc = await signIn('visitor@example.org', CRT_HOST, { name: 'Visitor' });
  const missing = await signIn('missing@example.org', CRT_HOST, { name: 'Missing', personRef: 'kcsara:999' });
  const body = { name: 'Review', scope: 'read' };
  await error(await external(personalKeys, 'POST', body), 403, 'not_eligible');
  await error(await adhoc(personalKeys, 'POST', body), 403, 'not_eligible');
  expect((await missing(personalKeys, 'POST', body)).status).toBe(400);
});

pgTest('T7: directory lookup errors return 503 and identify only the key id', async () => {
  const { api, key, members } = await setup();
  const issued = await key();
  const failed = vi.spyOn(members, 'lookup').mockRejectedValue(new Error('Directory unavailable'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await error(await api(issued.token).get(activities), 503, 'directory_unavailable');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.join(' ')).toContain(issued.id);
    expect(log.mock.calls[0]?.join(' ')).not.toContain(issued.token);
  } finally {
    failed.mockRestore();
    log.mockRestore();
  }
});

pgTest('T9: owner choices use the effective kind and owner of each edit and preserve foreign owners', async () => {
  const { api, key, mission, version, read } = await setup();
  const client = api((await key()).token);
  const partner = await client.create(createArgs('mission', RMR.id));
  expect(partner.status).toBe(201);
  const created = await partner.json();
  expect((await read(created.activityId)).records).toContainEqual(expect.objectContaining({ type: 'activity', ownerOrgId: RMR.id }));
  await error(await client.create(createArgs('mission', CROSS_SITE.id), 'fixture-create-0002'), 400, 'owner_not_allowed');
  expect((await client.change(batch(created.version, op('updateActivity', { ownerOrgId: RMR.id, kind: 'mission', title: 'Partner mission' })),
    'fixture-update-0001', created.activityId)).status).toBe(200);
  await mission();
  const expectedVersion = await version();
  const kind = op('updateActivity', { kind: 'training' });
  const owner = op('updateActivity', { ownerOrgId: RMR.id });
  await error(await client.change(batch(expectedVersion, kind, owner)), 400, 'owner_not_allowed');
  await error(await client.change(batch(expectedVersion, owner, kind), 'fixture-request-0002'), 400, 'owner_not_allowed');
  expect(await version()).toBe(expectedVersion);
  await mission('foreign', 'org-not-in-directory');
  const edit = await client.change(batch(await version('foreign'), op('updateActivity', { title: 'Foreign mission edited' })), 'fixture-update-0002', 'foreign');
  expect(edit.status).toBe(200);
  expect((await read('foreign')).records).toContainEqual(expect.objectContaining({ type: 'activity', ownerOrgId: 'org-not-in-directory', title: 'Foreign mission edited' }));
});

pgTest('T10: participant status preserves an existing unit and rejects caller-supplied units', async () => {
  const { api, key, mission, version, read } = await setup();
  await mission();
  const client = api((await key()).token);
  const at = Date.now();
  const update = (args: object) => op('setParticipantStatus', { participantId: ROWAN, status: 'staging', at, ...args });
  const expectedVersion = await version();
  await error(await client.change(batch(expectedVersion, update({ unit: { ...RMR, title: 'Fake unit' } }))), 400, 'bad_args');
  await error(await client.change(batch(expectedVersion, update({ unitId: 'unknown-unit' }))), 400, 'unknown_unit');
  expect((await client.change(batch(expectedVersion, update({ unitId: RMR.id })))).status).toBe(200);
  const { records } = await read();
  expect(records).toContainEqual(expect.objectContaining({ type: 'activityUnit', ...STORED_RMR }));
  expect(records).toContainEqual(expect.objectContaining({ type: 'participantStatus', participantId: ROWAN, unitId: RMR.id, status: 'staging' }));
});

pgTest('T11: responders on a mission may change their own status but not someone else’s', async () => {
  const { api, key, mission, version, read } = await setup();
  await mission();
  const client = api((await key(BO_EMAIL)).token);
  const at = Date.now();
  const update = (participantId: string) => op('setParticipantStatus', { participantId, status: 'staging', at });
  const expectedVersion = await version();
  await error(await client.change(batch(expectedVersion, update(ROWAN))), 403, 'forbidden', 'You can only change your own entry');
  expect((await client.change(batch(expectedVersion, update(BO)))).status).toBe(200);
  expect((await read()).records).toContainEqual(expect.objectContaining({ type: 'participantStatus', participantId: BO, unitId: CRT.id, status: 'staging' }));
});

pgTest('T11b: managers can invite an operational unit that is not a partner', async () => {
  const { api, key, mission, version, read } = await setup();
  await mission();
  const client = api((await key()).token);
  const invite = await client.change(batch(await version(), op('setUnitStatus', { unitId: 'org-cvsc', status: 'invited', at: Date.now() })));
  expect(invite.status).toBe(200);
  expect((await read()).records).toContainEqual(expect.objectContaining({ type: 'unitStatus', unitId: 'org-cvsc', status: 'invited' }));
});

pgTest('lists only visible summaries, including partner-owned activities with a matching external reference', async () => {
  const { api, key, hub, mission, read } = await setup();
  await mission('mission', RMR.id);
  for (const [id, owner, closed, add] of [
    ['mission', RMR.id, false, false],
    ['closed', CRT.id, true, true],
    ['hidden', 'org-hidden', false, true],
  ] as const) {
    if (add) await hub.pushAsSystem(id, SYSTEM_VIEWER, [op('createActivity', createArgs('mission', owner))]);
    await hub.pushAsSystem(id, SYSTEM_VIEWER, [op('updateActivity', { externalRef: 'fixture-ref' })]);
    if (closed) await hub.pushAsSystem(id, SYSTEM_VIEWER, [op('closeActivity', { at: Date.now() })]);
    const { records } = await read(id);
    const summary = activitySummary(new MapView(new Map(records.map((r) => [recKey(r), r]))), id);
    await hub.pushAsSystem(ACTIVITY_ARCHIVE_ID, SYSTEM_VIEWER, [op('setActivitySummary', { id, summary })]);
  }
  const client = api((await key(BO_EMAIL, 'read')).token);
  const list = async (query: string) => (await client.get(`${activities}?externalRef=fixture-ref${query}`)).json();
  expect((await list('')).data.map((r: { id: string }) => r.id).sort()).toEqual(['closed', 'mission']);
  expect(await list('&open=true')).toMatchObject({ data: [{ id: 'mission', ownerOrgId: RMR.id }] });
  expect(await list('&open=false')).toMatchObject({ data: [{ id: 'closed' }] });
  expect(await (await client.get(`${activities}?externalRef=missing`)).json()).toEqual({ data: [] });
});

pgTest('revalidates detail and returns gone only to a site that can see the removed activity', async () => {
  const { api, key, issue, signIn, hub, mission, version } = await setup();
  await mission();
  const reader = api((await key(BO_EMAIL, 'read')).token);
  const writer = api((await key()).token);
  const outsider = api((await issue(await signIn(CROSS_SITE.email, CROSS_SITE.host), 'read')).token, CROSS_SITE.host);
  const first = await reader.detail();
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('no-store');
  const etag = first.headers.get('etag')!;
  expect(etag).toBeTruthy();
  expect((await reader.detail('mission', { 'if-none-match': `W/${etag}` })).status).toBe(304);
  expect((await writer.change(batch(await version(), miles(5)))).status).toBe(200);
  const changed = await reader.detail('mission', { 'if-none-match': etag });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('etag')).not.toBe(etag);
  const at = Date.now();
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [op('removeActivity', { at })]);
  const removed = await reader.detail('mission', { 'if-none-match': changed.headers.get('etag')! });
  expect(removed.status).toBe(410);
  expect(await removed.json()).toEqual({ error: 'gone', removedAt: at });
  await error(await outsider.detail(), 404, 'not_found');
});

pgTest('serializes duplicate writes, replays before stale checks, and rejects conflicting idempotency reuse', async () => {
  const { api, key, mission, version, read } = await setup();
  await mission();
  const client = api((await key()).token);
  const expectedVersion = await version();
  const write = batch(expectedVersion, miles(0));
  const [first, duplicate] = await Promise.all([client.change(write), client.change(write)]);
  for (const response of [first, duplicate]) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: expectedVersion + 1 });
  }
  await error(await client.change(batch(expectedVersion, miles(8))), 409, 'idempotency_conflict');
  await error(await client.change(batch(expectedVersion, miles(8)), 'fixture-request-0002'), 409, 'stale_version');
  expect(await version()).toBe(expectedVersion + 1);
  expect((await read()).records).toContainEqual(expect.objectContaining({ id: BO, miles: 0 }));
});

pgTest('a native batch rolls back on rejection and commits successful operations in one version', async () => {
  const { api, key, mission, version, read } = await setup();
  await mission();
  const client = api((await key()).token);
  const expectedVersion = await version();
  await error(await client.change(batch(expectedVersion, miles(5), op('setEta', { participantId: 'missing', eta: null }))), 404, 'not_found');
  expect(await version()).toBe(expectedVersion);
  expect((await read()).records).toContainEqual(expect.objectContaining({ id: BO, miles: null }));
  const at = Date.now();
  const changes = batch(expectedVersion,
    miles(5),
    op('addParticipant', { personRef: 'kcsara:1', firstname: 'Avery', lastname: 'Lindqvist', status: 'responding', at }),
    op('assign', { participantId: ROWAN, target: { kind: 'team', id: 'team-one' }, at }));
  expect(await (await client.change(changes)).json()).toEqual({ version: expectedVersion + 1 });
  const { records } = await read();
  expect(records).toContainEqual(expect.objectContaining({ id: BO, miles: 5 }));
  expect(records).toContainEqual(expect.objectContaining({ type: 'participantStatus', participantId: participantIdFor('kcsara:1'), unitId: CRT.id, status: 'responding' }));
  expect(records).toContainEqual(expect.objectContaining({ type: 'assignment', participantId: ROWAN, target: { kind: 'team', id: 'team-one' } }));
});

pgTest('T17: an unexpected domain mutation failure becomes a 500', async () => {
  const throwingMiles = { ...activityMutations.setMiles, run() { throw new Error('Test mutation failure'); } };
  const registry = new MutationRegistry([...Object.values(activityMutations).filter((def) => def.name !== 'setMiles'), throwingMiles]);
  const { api, key, mission, version } = await setup(registry);
  await mission();
  const client = api((await key()).token);
  const expectedVersion = await version();
  await error(await client.change(batch(expectedVersion, miles(5))), 500, 'internal');
  expect(await version()).toBe(expectedVersion);
});

pgTest('T18: both POST routes reject malformed JSON and changes require a native batch', async () => {
  const { api, key, mission } = await setup();
  await mission();
  const client = api((await key()).token);
  await error(await client.post(activities, '{'), 400, 'invalid_json');
  await error(await client.post(`${activities}/mission/changes`, '{'), 400, 'invalid_json');
  const invalidBatch = await client.change({ expectedVersion: 1, operations: [{ name: 'closeActivity', args: {} }] });
  expect(invalidBatch.status).toBe(400);
  expect(await invalidBatch.json()).toMatchObject({ error: 'bad_args', message: expect.any(String) });
});

pgTest('T19: a participant precondition distinguishes unknown participants from stale versions', async () => {
  const { api, key, mission, hub, read } = await setup();
  await mission();
  const client = api((await key()).token);
  const expectedParticipantVersion = (await read()).records.find((r) => r.type === 'participant' && r.id === BO)!.version;
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [op('setMiles', { participantId: ROWAN, miles: 10 })]);
  const change = { participantId: BO, expectedParticipantVersion, operations: [miles(15)] };
  expect((await client.change(change)).status).toBe(200);
  await error(await client.change(change, 'fixture-request-0002'), 409, 'stale_version');
  await error(await client.change({
    ...change, participantId: 'missing', operations: [op('setMiles', { participantId: 'missing', miles: 1 })],
  }, 'fixture-request-0003'), 404, 'not_found');
});
