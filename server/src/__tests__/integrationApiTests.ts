import { createHash, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { vi } from 'vitest';

import { ActivityCommands, ParticipantCommands } from '@shared/commands';
import { serviceAuthor, type StampedEvent } from '@shared/events';
import type { Activity } from '@shared/types/activity';
import { MemberProviderType } from '@shared/types/data/MemberProviderType';
import type { OrganizationDoc } from '@shared/types/data/organizationDoc';

const mocks = vi.hoisted(() => ({ getServices: vi.fn(), getAuth: vi.fn() }));
vi.mock('../services', () => ({ getServices: mocks.getServices }));
vi.mock('../auth', () => ({ getAuthFromContext: mocks.getAuth, userFromAuth: (auth: unknown) => auth }));

type StateManagerCtor = typeof import('../stateManager').StateManager;
let mongod: MongoMemoryServer;
let mongoPromise: typeof import('../mongodb').default;
let StateManager: StateManagerCtor;
let D4HMembersProvider: typeof import('../memberProviders/d4hMembersProvider').default;
let sm: InstanceType<StateManagerCtor>;
let app: Hono;
const broadcasts: StampedEvent[][] = [];
const token = `test-integration.${'a'.repeat(48)}`;
const permissions = ['activities:read', 'members:read', 'participants:write', 'activities:create'];
const member = { id: '101', name: 'Example, Member', given_name: 'Member', family_name: 'Example', groups: [], email: 'not-returned@example.invalid' };
const scopedLookup = vi.fn(async (_org: string, id: string) => (id === member.id ? member : undefined));
const memberSearch = vi.fn(async () => [member]);

function organization(id: string): OrganizationDoc {
  return {
    id,
    title: `Synthetic organization ${id}`,
    domain: `${id}.example.invalid`,
    brand: { primary: '#000000' },
    memberProvider: { provider: MemberProviderType.D4H, token: 'test-team:test-token', moreEmailsField: 'Secondary Email' },
    canCreateMissions: true,
    canCreateEvents: true,
    partners: id === '6' ? [{ id: '2', title: 'Synthetic partner', canCreateMissions: true, canCreateEvents: true }] : [],
  };
}

function configure(allowed = permissions) {
  process.env.INTEGRATION_API_KEYS = JSON.stringify([{ id: 'test-integration', sha256: createHash('sha256').update(token).digest('hex'), organizationId: '6', permissions: allowed }]);
}

function request(path: string, method = 'GET', body?: unknown, key: string = randomUUID(), credential: string | null = token) {
  return app.request(path, {
    method,
    headers: { ...(credential === null ? {} : { 'x-api-key': credential }), 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function dataOf<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  expect(body).toHaveProperty('data');
  return (body as { data: T }).data;
}

interface Receipt {
  commandId: string;
  activityId: string;
}

async function seed(id: string, ownerOrgId: string, isMission = true, endTime?: number) {
  await sm.handleCommand({ ...ActivityCommands.UpdateActivity({ id, title: 'Synthetic activity', ownerOrgId, isMission, startTime: Date.now() - 86400000, endTime }), id: randomUUID() }, serviceAuthor('test'));
}

async function persisted(id: string) {
  return (await mongoPromise).db().collection<Activity>('activities').findOne({ id });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  mongoPromise = (await import('../mongodb')).default;
  StateManager = (await import('../stateManager')).StateManager;
  D4HMembersProvider = (await import('../memberProviders/d4hMembersProvider')).default;
  const { activitiesRoutes } = await import('../routes/activities');
  const { organizationsRoutes } = await import('../routes/organizations');
  const { integrationRoutes } = await import('../routes/integration');
  app = new Hono().route('/', activitiesRoutes).route('/', organizationsRoutes).route('/', integrationRoutes);
}, 120000);

beforeEach(async () => {
  const db = (await mongoPromise).db();
  await Promise.all(['activities', 'events', 'organizations', 'integrationRequests'].map((name) => db.collection(name).deleteMany({})));
  await db.collection<OrganizationDoc>('organizations').insertMany([organization('6'), organization('2'), organization('9')]);
  sm = new StateManager([]);
  broadcasts.length = 0;
  sm.addClient({ broadcastEvent: (events) => broadcasts.push(events) });
  mocks.getServices.mockResolvedValue({ stateManager: sm, memberProviders: { get: () => ({ getOrganizationMember: scopedLookup, searchMembers: memberSearch }) } });
  mocks.getAuth.mockResolvedValue(undefined);
  scopedLookup.mockClear();
  configure();
  await seed('own', '6');
  await seed('shared', '2');
  await seed('outside', '9');
});

afterAll(async () => {
  delete process.env.INTEGRATION_API_KEYS;
  if (mongoPromise) await (await mongoPromise).close();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('integration reads and credentials', () => {
  it('scopes existing list/detail routes, preserves closed history and returns no-store', async () => {
    await seed('history', '6', true, Date.now() - 1000);
    await seed('training', '6', false);
    const response = await request('/v1/missions');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await dataOf<Activity[]>(response)).map((a) => a.id).sort()).toEqual(['history', 'own', 'shared']);
    expect((await dataOf<Activity[]>(await request('/v1/events'))).map((a) => a.id)).toEqual(['training']);
    expect((await request('/v1/activities/outside')).status).toBe(404);
    expect((await request('/v1/activities/missing')).status).toBe(404);
  });

  it('includes an activity with an explicitly participating in-scope organization', async () => {
    await sm.handleCommand({ ...ActivityCommands.AppendOrganizationTimeline('outside', organization('6'), { time: Date.now(), status: 4 }), id: randomUUID() }, serviceAuthor('test'));
    expect((await request('/v1/activities/outside')).status).toBe(200);
  });

  it('keeps browser reads unchanged and does not fall back to their cookie for a bad key', async () => {
    mocks.getAuth.mockResolvedValue({ userId: 'cookie-user' });
    expect(await dataOf<Activity[]>(await request('/v1/missions', 'GET', undefined, randomUUID(), null))).toHaveLength(3);
    expect((await request('/v1/missions', 'GET', undefined, randomUUID(), 'invalid')).status).toBe(401);
    expect((await request('/v1/missions', 'GET', undefined, randomUUID(), '')).status).toBe(401);
  });

  it('refuses missing, revoked, invalid and insufficient credentials', async () => {
    expect((await request('/v1/missions', 'GET', undefined, randomUUID(), null)).status).toBe(401);
    expect((await request('/v1/missions', 'GET', undefined, randomUUID(), `${token}wrong`)).status).toBe(401);
    configure(['members:read']);
    expect((await request('/v1/missions')).status).toBe(403);
    delete process.env.INTEGRATION_API_KEYS;
    expect((await request('/v1/missions')).status).toBe(401);
  });

  it('fails closed for malformed configuration without returning credentials', async () => {
    process.env.INTEGRATION_API_KEYS = '{"broken":true}';
    const response = await request('/v1/missions');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('broken');
  });

  it('looks up own members before their first response without exposing contact data', async () => {
    const response = await request('/v1/organizations/6/members/101');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 200, data: { id: '101', name: member.name, given_name: member.given_name, family_name: member.family_name } });
    expect(scopedLookup).toHaveBeenCalledWith('6', '101');
    expect((await request('/v1/organizations/2/members/101')).status).toBe(404);
    expect((await request('/v1/organizations/6/members/unknown')).status).toBe(404);
    const search = await dataOf<unknown[]>(await request('/v1/organizations/6/members?query=Example'));
    expect(search[0]).not.toHaveProperty('email');
  });
});

describe('integration writes through the real command pipeline', () => {
  it('persists and broadcasts a first response with authoritative identity and an audit receipt', async () => {
    const response = await request('/v1/activities/shared/participants/101/status', 'PUT', { status: 3 });
    expect(response.status).toBe(200);
    const receipt = await dataOf<Receipt>(response);
    const row = await persisted('shared');
    expect(row?.participants['101']).toMatchObject({ firstname: 'Member', lastname: 'Example', organizationId: '6', timeline: [{ status: 3 }] });
    expect(row?.organizations['6']).toMatchObject({ id: '6' });
    const events = await (await mongoPromise).db().collection('events').find({ 'meta.commandId': receipt.commandId }).toArray();
    expect(events.map((e) => e.type)).toEqual(['evt/activity/orgAppended', 'evt/participant/updated']);
    expect(events.every((e) => e.meta.author.id === 'integration:6:test-integration')).toBe(true);
    expect(broadcasts.flat().some((e) => e.meta.commandId === receipt.commandId)).toBe(true);
    const restarted = new StateManager([]);
    await restarted.start();
    expect((await restarted.getAllActivities()).find((a) => a.id === 'shared')?.participants['101'].timeline[0].status).toBe(3);
  });

  it('updates and clears ETA/mileage independently without changing the status timeline', async () => {
    await request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 });
    const before = (await persisted('own'))?.participants['101'].timeline;
    const eta = Date.now() + 600000;
    for (const [field, value] of [
      ['eta', eta],
      ['miles', 12.5],
      ['eta', null],
      ['miles', null],
    ] as const) {
      expect((await request(`/v1/activities/own/participants/101/${field}`, 'PUT', { [field]: value })).status).toBe(200);
      expect((await persisted('own'))?.participants['101'][field]).toBe(value ?? undefined);
    }
    expect((await persisted('own'))?.participants['101'].timeline).toEqual(before);
  });

  it('does not duplicate a write on replay, including after a process restart', async () => {
    const key = randomUUID();
    const path = '/v1/activities/own/participants/101/status';
    const first = await (await request(path, 'PUT', { status: 3 }, key)).json();
    const count = await (await mongoPromise).db().collection('events').countDocuments();
    sm = new StateManager([]);
    await sm.start();
    mocks.getServices.mockResolvedValue({ stateManager: sm });
    const replay = await request(path, 'PUT', { status: 3 }, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(await (await mongoPromise).db().collection('events').countDocuments()).toBe(count);
    expect((await request(path, 'PUT', { status: 4 }, key)).status).toBe(409);
  });

  it('refuses another organization, invisible or closed activities, and unknown identities before dispatch', async () => {
    await sm.handleCommand({ ...ParticipantCommands.UpdateParticipant('shared', 'foreign', 'Other', 'Member', '2', Date.now(), 3), id: randomUUID() }, serviceAuthor('test'));
    await seed('closed', '6', true, Date.now());
    const before = await (await mongoPromise).db().collection('events').countDocuments();
    for (const [activity, person, status] of [
      ['shared', 'foreign', 403],
      ['outside', '101', 404],
      ['closed', '101', 409],
      ['own', 'unknown', 404],
    ] as const) {
      expect((await request(`/v1/activities/${activity}/participants/${person}/status`, 'PUT', { status: 3 })).status).toBe(status);
    }
    expect(await (await mongoPromise).db().collection('events').countDocuments()).toBe(before);
  });

  it('enforces explicit write permission and idempotency keys', async () => {
    const path = '/v1/activities/own/participants/101/status';
    configure(['activities:read']);
    expect((await request(path, 'PUT', { status: 3 })).status).toBe(403);
    configure();
    expect((await request(path, 'PUT', { status: 3 }, '')).status).toBe(400);
    expect((await request('/v1/activities/own/participants/101/eta', 'PUT', { eta: null })).status).toBe(404);
  });

  it.each([{ status: 8 }, { status: '3' }, { status: 3, time: Date.now() + 86400000 }, { status: 3, organizationId: '9' }, null, []])('rejects invalid status body %j', async (body) => {
    expect((await request('/v1/activities/own/participants/101/status', 'PUT', body)).status).toBe(400);
  });

  it.each([
    ['eta', -1],
    ['eta', Date.now() - 86400000],
    ['eta', 'later'],
    ['miles', -1],
    ['miles', '12'],
  ])('rejects invalid %s value %j', async (field, value) => {
    expect((await request(`/v1/activities/own/participants/101/${field}`, 'PUT', { [field]: value })).status).toBe(400);
  });

  it('checks status freshness and standby-only restrictions', async () => {
    await request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 });
    expect((await request('/v1/activities/own/participants/101/status', 'PUT', { status: 4, time: 1 })).status).toBe(409);
    await sm.handleCommand({ ...ActivityCommands.UpdateActivity({ id: 'own', forceStandbyOnly: true }), id: randomUUID() }, serviceAuthor('test'));
    await sm.handleCommand({ ...ActivityCommands.UpdateActivity({ id: 'own', startTime: Date.now() + 86400000 }), id: randomUUID() }, serviceAuthor('test'));
    expect((await request('/v1/activities/own/participants/101/status', 'PUT', { status: 5 })).status).toBe(409);
    expect((await request('/v1/activities/own/participants/101/status', 'PUT', { status: 2 })).status).toBe(200);
  });

  it('returns an explicit unconfirmed outcome after a dispatch failure and blocks automatic replay', async () => {
    const path = '/v1/activities/own/participants/101/status';
    const key = randomUUID();
    vi.spyOn(sm, 'handleCheckedCommands').mockImplementationOnce(async (build) => {
      await build(await sm.getAllActivities());
      throw new Error('simulated lost persistence acknowledgement');
    });
    const first = await request(path, 'PUT', { status: 3 }, key);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: 'write_unconfirmed' });
    const repeat = await request(path, 'PUT', { status: 3 }, key);
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ code: 'write_unconfirmed' });
  });

  it('rechecks activity state after an already queued close', async () => {
    const close = sm.handleCommand({ ...ActivityCommands.CompleteActivity('own', Date.now()), id: randomUUID() }, serviceAuthor('test'));
    const response = await request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 });
    await close;
    expect(response.status).toBe(409);
    expect((await persisted('own'))?.participants['101']).toBeUndefined();
  });

  it('does not hold the shared command queue during directory lookup and rechecks after it', async () => {
    let release!: (value: typeof member) => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    scopedLookup.mockImplementationOnce(async () => {
      started();
      return new Promise<typeof member>((resolve) => {
        release = resolve;
      });
    });
    const pending = request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 });
    await lookupStarted;
    await sm.handleCommand({ ...ActivityCommands.CompleteActivity('own', Date.now()), id: randomUUID() }, serviceAuthor('test'));
    release(member);
    expect((await pending).status).toBe(409);
    expect((await persisted('own'))?.participants['101']).toBeUndefined();
  });

  it('dispatches only once for concurrent requests with the same idempotency key', async () => {
    const key = randomUUID();
    const responses = await Promise.all([request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 }, key), request('/v1/activities/own/participants/101/status', 'PUT', { status: 3 }, key)]);
    expect(responses.some((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect((await persisted('own'))?.participants['101'].timeline).toHaveLength(1);
    expect(await (await mongoPromise).db().collection('events').countDocuments({ type: 'evt/participant/updated' })).toBe(1);
  });

  it('prevents a status write from indirectly signing out another organization', async () => {
    await sm.handleCommand({ ...ParticipantCommands.UpdateParticipant('outside', '101', 'Member', 'Example', '9', Date.now(), 3), id: randomUUID() }, serviceAuthor('test'));
    const response = await request('/v1/activities/own/participants/101/status', 'PUT', { status: 5 });
    expect(response.status).toBe(409);
    expect((await persisted('outside'))?.participants['101'].timeline).toHaveLength(1);
  });
});

describe('D4H organization-scoped member lookup', () => {
  it('addresses the authenticated team and validates the returned member ID without returning contact details', async () => {
    vi.stubEnv('DEV_NETWORK_DISABLED', '');
    const fetch = vi.fn(async () => Response.json({ id: 101, name: 'Example, Member', email: { value: 'private@example.invalid' } }));
    vi.stubGlobal('fetch', fetch);
    const provider = new D4HMembersProvider();
    const result = await provider.getOrganizationMember('6', '101');
    expect(fetch).toHaveBeenCalledWith('https://api.team-manager.us.d4h.com/v3/team/test-team/members/101', { headers: { Authorization: 'Bearer test-token' } });
    expect(result).toMatchObject({ id: '101', given_name: 'Member', family_name: 'Example' });
    expect(result?.email).toBeUndefined();
  });

  it('distinguishes a missing member from an upstream failure or invalid identity', async () => {
    vi.stubEnv('DEV_NETWORK_DISABLED', '');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: 202, name: 'Other, Member' }));
    vi.stubGlobal('fetch', fetch);
    const provider = new D4HMembersProvider();
    expect(await provider.getOrganizationMember('6', '101')).toBeUndefined();
    await expect(provider.getOrganizationMember('6', '101')).rejects.toThrow('HTTP 503');
    await expect(provider.getOrganizationMember('6', '101')).rejects.toThrow('invalid identity');
  });

  it('honors the no-external-network development switch', async () => {
    vi.stubEnv('DEV_NETWORK_DISABLED', '1');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(new D4HMembersProvider().getOrganizationMember('6', '101')).rejects.toThrow('network access is disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('permission-gated activity creation', () => {
  it.each(['missions', 'events'])('creates %s once, under the authenticated organization, with restart-safe replay', async (kind) => {
    const key = randomUUID();
    const body = { title: 'Synthetic new activity', startTime: Date.now(), idNumber: 'TEST-123' };
    const response = await request(`/v1/${kind}`, 'POST', body, key);
    expect(response.status).toBe(201);
    const result = await dataOf<Receipt>(response);
    const row = await persisted(result.activityId);
    expect(row).toMatchObject({ ownerOrgId: '6', isMission: kind === 'missions', title: body.title, idNumber: 'TEST-123' });
    expect(row?.organizations['6']).toMatchObject({ id: '6' });
    sm = new StateManager([]);
    await sm.start();
    mocks.getServices.mockResolvedValue({ stateManager: sm });
    expect(await dataOf<Receipt>(await request(`/v1/${kind}`, 'POST', body, key))).toEqual(result);
    expect(await (await mongoPromise).db().collection('activities').countDocuments({ title: body.title })).toBe(1);
  });

  it('reports capabilities and refuses creation without both key and organization permission', async () => {
    configure(['activities:read']);
    expect(await dataOf<{ canCreateMissions: boolean }>(await request('/v1/integration'))).toMatchObject({ canCreateMissions: false });
    expect((await request('/v1/missions', 'POST', { title: 'Test', startTime: Date.now() })).status).toBe(403);
    configure();
    await (
      await mongoPromise
    )
      .db()
      .collection('organizations')
      .updateOne({ id: '6' }, { $set: { canCreateMissions: false } });
    expect((await request('/v1/missions', 'POST', { title: 'Test', startTime: Date.now() })).status).toBe(403);
    expect((await request('/v1/events', 'POST', { title: 'Test', startTime: Date.now(), ownerOrgId: '2' })).status).toBe(400);
  });
});
