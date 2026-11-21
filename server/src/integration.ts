import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { HIDDEN_VIEW, Rejection, type ReadView } from '@sync/core';
import {
  ACTIVITY_ARCHIVE_ID, PARTICIPANT_STATUSES, UNIT_STATUSES, activityProjector, currentAssignment,
  currentParticipantStatus, currentUnitStatus, findParticipantByPersonRef, getActivity,
  isStandbyOnly, STANDBY_ONLY_STATUSES,
  type ActivityViewer, type MemberInfo, type Organization, type TeamRec,
} from '@sync/domain';
import type { Hub } from '@sync/server';
import type { MemberProviders } from './memberProviders';

const Key = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  organizationId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  permissions: z.array(z.enum(['read', 'participants:write', 'assignments:write', 'unit-status:write'])),
}).strict();
type Key = z.infer<typeof Key>;
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const id = z.string().min(1).max(200).refine((value) => !value.startsWith('$'));
const at = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const expectedVersion = at;
const status = z.enum(PARTICIPANT_STATUSES).exclude(['unknown']);
const Change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), expectedVersion, participantId: id, status, at: at.optional() }).strict(),
  z.object({ type: z.literal('first-status'), expectedVersion, personRef: id, status, at: at.optional() }).strict(),
  z.object({ type: z.literal('eta'), expectedVersion, participantId: id, eta: at.nullable() }).strict(),
  z.object({ type: z.literal('mileage'), expectedVersion, participantId: id, miles: z.number().finite().nonnegative().nullable() }).strict(),
  z.object({ type: z.literal('assignment'), expectedVersion, participantId: id, teamId: id.nullable() }).strict(),
  z.object({ type: z.literal('unit-status'), expectedVersion, status: z.enum(UNIT_STATUSES).exclude(['unknown']) }).strict(),
]);
type Change = z.infer<typeof Change>;
const permission = {
  status: 'participants:write', 'first-status': 'participants:write', eta: 'participants:write',
  mileage: 'participants:write', assignment: 'assignments:write', 'unit-status': 'unit-status:write',
} as const;
const readTypes = new Set(['activity', 'activityUnit', 'unitStatus', 'participant', 'participantStatus', 'assignment', 'team', 'teamStatus']);

export function integrationKeys(raw: string | undefined): ReadonlyMap<string, Key> {
  if (!raw) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('INTEGRATION_API_KEYS must be a JSON array');
  }
  const parsed = z.array(Key).safeParse(value);
  if (!parsed.success) throw new Error('Invalid INTEGRATION_API_KEYS configuration');
  const keys = new Map(parsed.data.map((key) => [key.id, key]));
  if (keys.size !== parsed.data.length) throw new Error('INTEGRATION_API_KEYS contains duplicate IDs');
  return keys;
}

function prepare(change: Change, site: Organization, view: ReadView, now: number, member?: MemberInfo | null) {
  const activity = getActivity(view);
  if (!activity || activity.removedAt !== null) throw new Rejection('not_found', "That activity isn't here");
  if (activity.closed) throw new Rejection('closed', 'That activity is closed');
  const unit = { id: site.id, title: site.title, rosterName: site.shortTitle };
  if (change.type === 'unit-status') {
    if (activity.kind !== 'mission' || activity.ownerOrgId !== site.id) throw new Rejection('forbidden', 'Only your own missions allow unit status changes');
    const previous = currentUnitStatus(view, site.id);
    if (previous && previous.at > now) throw new Rejection('stale_time', 'The current unit status has a later time');
    return { name: 'setUnitStatus', args: { unit, status: change.status, at: now } };
  }
  if (change.type === 'first-status') {
    const time = change.at ?? now;
    if (isStandbyOnly(activity, 'unknown', time) && !STANDBY_ONLY_STATUSES.has(change.status)) throw new Rejection('standby_only', 'This activity is standby only for now');
    if (member === undefined) throw new Rejection('member_lookup');
    if (!member) throw new Rejection('not_found', "That member isn't in your unit's directory");
    if (findParticipantByPersonRef(view, member.personRef)) throw new Rejection('participant_exists', 'Use the existing participant ID');
    return { name: 'addParticipant', args: { personRef: member.personRef, firstname: member.given_name, lastname: member.family_name, unit, status: change.status, at: time } };
  }
  const { participantId } = change;
  const previous = currentParticipantStatus(view, participantId);
  if (previous?.unitId !== site.id) throw new Rejection('not_found', "That participant isn't responding under your unit");
  switch (change.type) {
    case 'status': {
      const time = change.at ?? now;
      if (time <= previous.at) throw new Rejection('stale_time', 'Use a time after the last participant status');
      if (isStandbyOnly(activity, previous.status, time) && !STANDBY_ONLY_STATUSES.has(change.status)) throw new Rejection('standby_only', 'This activity is standby only for now');
      return { name: 'setParticipantStatus', args: { participantId, status: change.status, unit, at: time } };
    }
    case 'eta':
      if (change.eta !== null && change.eta < now - 5 * 60_000) throw new Rejection('bad_args', 'ETA is in the past');
      return { name: 'setEta', args: { participantId, eta: change.eta } };
    case 'mileage':
      return { name: 'setMiles', args: { participantId, miles: change.miles } };
    case 'assignment': {
      if (activity.kind !== 'mission') throw new Rejection('forbidden', 'This API only assigns participants on missions');
      const assignment = currentAssignment(view, participantId);
      if ((assignment && assignment.at >= now) || previous.at > now) throw new Rejection('stale_time', 'The current assignment or status has a later time');
      const from = assignment?.target;
      if (from && from.kind !== 'team') throw new Rejection('forbidden', 'This API cannot move a participant out of a non-team assignment');
      if (from?.id !== change.teamId && from && view.get<TeamRec>('team', from.id)?.leaderParticipantId === participantId) {
        throw new Rejection('forbidden', 'A mission manager must reassign the team leader first');
      }
      return { name: 'assign', args: { participantId, target: change.teamId === null ? null : { kind: 'team', id: change.teamId }, at: now } };
    }
  }
}

export function integrationRoutes(hub: Hub, keys: ReturnType<typeof integrationKeys>, members?: MemberProviders) {
  const routes = new Hono<{ Variables: { site: Organization; key: Key } }>();
  const viewer = (key: Key, tier: ActivityViewer['tier']): ActivityViewer => ({
    userId: `integration:${key.id}`, name: key.id, tier, class: 'member', siteId: key.organizationId,
  });
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!keys.size) return c.json({ error: 'not_found' }, 404);
    const token = c.req.header('x-api-key');
    const tokenId = token?.split('.', 1)[0];
    const key = token && token.length <= 256 && tokenId ? keys.get(tokenId) : undefined;
    if (!token || !key || key.organizationId !== c.get('site').id ||
      !timingSafeEqual(Buffer.from(key.sha256, 'hex'), Buffer.from(sha256(token), 'hex'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('key', key);
    await next();
  });
  routes.get('/activities', async (c) => {
    const key = c.get('key');
    if (!key.permissions.includes('read')) return c.json({ error: 'forbidden' }, 403);
    const { records } = await hub.read(ACTIVITY_ARCHIVE_ID, viewer(key, 'respond'));
    return c.json({ data: records.filter((r) => r.type === 'activitySummary').map(({ version: _, ...summary }) => summary) });
  });
  routes.get('/activities/:id', async (c) => {
    const key = c.get('key');
    if (!key.permissions.includes('read')) return c.json({ error: 'forbidden' }, 403);
    const activityId = c.req.param('id');
    if (!id.safeParse(activityId).success) return c.json({ error: 'not_found' }, 404);
    const result = await hub.read(activityId, viewer(key, 'respond'));
    if (!result.version || result.view === HIDDEN_VIEW || !result.records.some((r) => r.type === 'activity' && r.removedAt === null)) {
      return c.json({ error: 'not_found' }, 404);
    }
    const records = result.records.flatMap((r) => {
      if (!readTypes.has(r.type)) return [];
      const projected = result.view === 'manage' ? activityProjector.project('respond:member', r) : r;
      return projected ? [projected] : [];
    });
    return c.json({ activityId, version: result.version, records });
  });
  routes.post('/activities/:id/changes', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) }), async (c) => {
    const key = c.get('key');
    const site = c.get('site');
    const activityId = c.req.param('id');
    if (!id.safeParse(activityId).success) return c.json({ error: 'not_found' }, 404);
    const requestKey = c.req.header('idempotency-key');
    if (!requestKey || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) return c.json({ error: 'invalid_idempotency_key' }, 400);
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'expected_json' }, 415);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = Change.safeParse(body);
    if (!parsed.success) return c.json({ error: 'bad_args', message: parsed.error.issues[0]?.message }, 400);
    const change = parsed.data;
    if (!key.permissions.includes(permission[change.type])) return c.json({ error: 'forbidden' }, 403);
    const principal = viewer(key, 'manage');
    const requestId = sha256(JSON.stringify([site.id, key.id, requestKey]));
    const fingerprint = sha256(JSON.stringify(change));
    const submit = (member?: MemberInfo | null) => hub.submitIntegration(activityId, {
      viewer: principal, requestId, fingerprint, expectedVersion: change.expectedVersion,
      prepare: (view, now) => prepare(change, site, view, now, member),
    });
    let result = await submit();
    if (change.type === 'first-status' && 'reason' in result && result.reason === 'member_lookup') {
      if (!members) return c.json({ error: 'directory_unavailable' }, 503);
      let member: MemberInfo | undefined;
      try {
        member = await members.lookupInOrganization(site.id, change.personRef);
      } catch (err) {
        console.error('integration: member lookup failed', err);
        return c.json({ error: 'directory_unavailable' }, 502);
      }
      result = await submit(member ?? null);
    }
    if ('version' in result) return c.json(result);
    const { reason, message } = result;
    return c.json({ error: reason, message }, reason === 'not_found' ? 404 : reason === 'forbidden' ? 403 : reason === 'bad_args' ? 400 : 409);
  });
  return routes;
}
