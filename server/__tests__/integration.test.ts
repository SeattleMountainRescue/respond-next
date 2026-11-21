import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SYSTEM_VIEWER, participantIdFor } from '@sync/domain';
import { CRT, activityArgs } from '../../packages/domain/__tests__/helpers';
import { integrationKeys } from '../src/integration';
import { CRT_HOST, testApp } from './helpers';

const TOKEN = 'test-client.fixture-only';
const RMR = { id: 'org-rmr', title: 'Ridgeline Mountain Rescue', rosterName: 'RMR' };
const path = '/api/integration/v1/activities/mission';
const BO = participantIdFor('kcsara:3');
const ROWAN = participantIdFor('kcsara:5');

async function setup(ownerOrgId = CRT.id) {
  const keys = integrationKeys(JSON.stringify([{
    id: 'test-client', organizationId: CRT.id, sha256: createHash('sha256').update(TOKEN).digest('hex'),
    permissions: ['read', 'participants:write', 'assignments:write', 'unit-status:write'],
  }]));
  const { app, hub } = testApp({ integrationKeys: keys });
  const now = Date.now() - 10_000;
  await hub.pushAsSystem('mission', SYSTEM_VIEWER, [
    { name: 'createActivity', args: activityArgs({ ownerOrgId, startTime: now }) },
    { name: 'addParticipant', args: { personRef: 'kcsara:3', firstname: 'Bo', lastname: 'Okafor', unit: CRT, status: 'responding', at: now } },
    { name: 'addParticipant', args: { personRef: 'kcsara:5', firstname: 'Rowan', lastname: 'Pike', unit: RMR, status: 'responding', at: now } },
    { name: 'createTeam', args: { id: 'team-one', name: 'Team One' } },
  ]);
  const put = (body: object, key = 'fixture-request-0001') => app.request(`${path}/changes`, {
    method: 'POST',
    headers: { host: CRT_HOST, 'x-api-key': TOKEN, 'idempotency-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const version = async () => (await hub.read('mission', SYSTEM_VIEWER)).version;
  return { app, hub, put, version };
}

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
});
