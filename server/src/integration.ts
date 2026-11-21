import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { HIDDEN_VIEW, Rejection, type ReadView } from '@sync/core';
import {
  ACTIVITY_ARCHIVE_ID, ACTIVITY_KINDS, PARTICIPANT_STATUSES, UNIT_STATUSES, activityProjector, currentAssignment,
  currentParticipantStatus, currentUnitStatus, findParticipantByPersonRef, getActivity,
  isStandbyOnly, isUnitOut, STANDBY_ONLY_STATUSES, unitStatusAfterSignIn,
  type ActivitySummaryRec, type ActivityViewer, type MemberInfo, type Organization, type ParticipantStatus, type TeamRec,
} from '@sync/domain';
import type { Hub } from '@sync/server';
import type { GrantStore } from './grants';
import type { MemberProviders } from './memberProviders';
import type { OrganizationStore } from './organizations';
import { access, tierOn } from './signIn';

const Key = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  organizationId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  personRef: z.string().regex(/^[a-z0-9-]+:\S+$/),
  permissions: z.array(z.enum(['read', 'participants:write', 'assignments:write', 'unit-status:write', 'activities:write'])).optional(),
}).strict();
type Key = z.infer<typeof Key>;
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
export const NewIntegrationKey = z.object({
  name: z.string().trim().min(1).max(100), personRef: Key.shape.personRef,
  webhookTarget: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).optional(),
}).strict();
export function newIntegrationCredential() {
  const id = `key-${randomBytes(16).toString('hex')}`;
  const token = `${id}.${randomBytes(32).toString('hex')}`;
  return { id, token, sha256: sha256(token), signingSecret: randomBytes(32).toString('hex') };
}
const fingerprintOf = (value: unknown) => sha256(JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry,
));
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
const ActivityAction = z.object({
  name: z.enum(['createActivity', 'updateActivity']),
  args: z.object({ kind: z.enum(ACTIVITY_KINDS).optional(), ownerOrgId: z.string().optional() }).passthrough(),
}).strict();
const NativeAction = z.union([
  ActivityAction,
  z.object({
    name: z.enum(['addParticipant', 'setParticipantStatus', 'setEta', 'setMiles', 'assign', 'setUnitStatus']),
    args: z.object({}).passthrough(),
  }).strict(),
]);
const operations = z.array(NativeAction).min(1).max(50);
const ParticipantBatch = z.object({
  participantId: id,
  expectedParticipantVersion: expectedVersion,
  operations: z.array(z.object({
    name: z.enum(['setEta', 'setMiles']),
    args: z.object({ participantId: id }).passthrough(),
  }).strict()).min(1).max(50),
}).strict().refine((batch) => batch.operations.every(({ args }) => args.participantId === batch.participantId));
const NativeBatch = z.union([z.object({ expectedVersion, operations }).strict(), ParticipantBatch]);
const Create = z.object({ args: ActivityAction.shape.args }).strict();
const nativePermission = {
  addParticipant: 'participants:write', setParticipantStatus: 'participants:write',
  setEta: 'participants:write', setMiles: 'participants:write', assign: 'assignments:write',
  setUnitStatus: 'unit-status:write', createActivity: 'activities:write', updateActivity: 'activities:write',
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
  const checkStatus = (time: number, next: ParticipantStatus, previous: ParticipantStatus) => {
    if (time < activity.startTime - Math.max(activity.earlySignInWindow ?? 0, 5 * 60_000)) {
      throw new Rejection('status_before_window', 'The status time is before the activity sign-in window');
    }
    const unitStatus = currentUnitStatus(view, site.id)?.status;
    if (unitStatus && isUnitOut(unitStatus) && unitStatusAfterSignIn(unitStatus, next)) {
      throw new Rejection('unit_out', 'Change the unit status before signing in participants');
    }
    if (isStandbyOnly(activity, previous, time) && !STANDBY_ONLY_STATUSES.has(next)) {
      throw new Rejection('standby_only', 'This activity is standby only for now');
    }
  };
  if (change.type === 'unit-status') {
    if (activity.kind !== 'mission' || activity.ownerOrgId !== site.id) throw new Rejection('forbidden', 'Only your own missions allow unit status changes');
    const previous = currentUnitStatus(view, site.id);
    if (previous && previous.at > now) throw new Rejection('stale_time', 'The current unit status has a later time');
    return { name: 'setUnitStatus', args: { unit, status: change.status, at: now } };
  }
  if (change.type === 'first-status') {
    const time = change.at ?? now;
    checkStatus(time, change.status, 'unknown');
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
      checkStatus(time, change.status, previous.status);
      return { name: 'setParticipantStatus', args: { participantId, status: change.status, unit, at: time } };
    }
    case 'eta':
      if (change.eta !== null && change.eta < now - 5 * 60_000) throw new Rejection('bad_args', 'ETA is in the past');
      if (change.eta !== null && change.eta > now + 7 * 24 * 60 * 60_000) throw new Rejection('eta_too_far', 'ETA cannot be more than seven days ahead');
      return { name: 'setEta', args: { participantId, eta: change.eta } };
    case 'mileage':
      if (change.miles !== null && change.miles > 2_000) throw new Rejection('mileage_too_high', 'Mileage cannot exceed 2,000 miles');
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

export function integrationRoutes(hub: Hub, keys: ReturnType<typeof integrationKeys>, organizations: OrganizationStore, members?: MemberProviders, grants?: GrantStore) {
  const routes = new Hono<{ Variables: { site: Organization; key: Key; memberViewer: ActivityViewer; memberAccess: Awaited<ReturnType<typeof access>> } }>();
  const allows = (key: Key, requested: NonNullable<Key['permissions']>[number]) => key.permissions?.includes(requested) ?? true;
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!keys.size && !organizations.managesIntegrationKeys) return c.json({ error: 'not_found' }, 404);
    const token = c.req.header('x-api-key');
    const tokenId = token?.split('.', 1)[0];
    const configured = tokenId ? keys.get(tokenId) : undefined;
    const managed = !configured && token && token.length <= 256 && tokenId && Key.shape.id.safeParse(tokenId).success
      ? await organizations.integrationKey(tokenId, c.get('site').id) : undefined;
    const key = configured ?? managed;
    if (!token || token.length > 256 || !key || key.organizationId !== c.get('site').id ||
      !timingSafeEqual(Buffer.from(key.sha256, 'hex'), Buffer.from(sha256(token), 'hex'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!members) return c.json({ error: 'directory_unavailable' }, 503);
    const found = await members.accessInOrganization(key.organizationId, key.personRef);
    if (!found) return c.json({ error: 'unauthorized' }, 401);
    const memberAccess = await access({ grants }, found.member.personRef, found.tier);
    if (managed) await organizations.markIntegrationKeyUsed(managed.id, key.organizationId);
    c.set('memberAccess', memberAccess);
    c.set('memberViewer', { userId: found.member.personRef, personRef: found.member.personRef, name: found.member.name, tier: memberAccess.tier, class: 'member', siteId: key.organizationId });
    c.set('key', key);
    await next();
  });
  routes.get('/activities', async (c) => {
    const key = c.get('key');
    if (!allows(key, 'read')) return c.json({ error: 'forbidden' }, 403);
    const open = c.req.query('open');
    if (open !== undefined && open !== 'true' && open !== 'false') return c.json({ error: 'bad_args', message: 'open must be true or false' }, 400);
    const since = c.req.query('since');
    const externalRef = c.req.query('externalRef');
    if (since !== undefined && (!/^\d+$/.test(since) || !Number.isSafeInteger(Number(since)))) return c.json({ error: 'bad_args', message: 'since must be an epoch timestamp in milliseconds' }, 400);
    const { records } = await hub.read(ACTIVITY_ARCHIVE_ID, c.get('memberViewer'));
    const summaries = records.filter((r): r is ActivitySummaryRec => r.type === 'activitySummary');
    return c.json({ data: summaries.filter((r) =>
      (open === undefined || r.activity.closed === (open === 'false')) &&
      (since === undefined || (r.changedAt !== undefined && r.changedAt > Number(since))) &&
      (externalRef === undefined || (r.ownerOrgId === key.organizationId && r.externalRef === externalRef)),
    ) });
  });
  routes.get('/activities/:id', async (c) => {
    const key = c.get('key');
    if (!allows(key, 'read')) return c.json({ error: 'forbidden' }, 403);
    const activityId = c.req.param('id');
    if (!id.safeParse(activityId).success) return c.json({ error: 'not_found' }, 404);
    const result = await hub.read(activityId, c.get('memberViewer'));
    const activity = result.records.find((r) => r.type === 'activity');
    if (!result.version || result.view === HIDDEN_VIEW || !activity) return c.json({ error: 'not_found' }, 404);
    if (typeof activity.removedAt === 'number') return c.json({ error: 'gone', removedAt: activity.removedAt }, 410);
    const [tier] = result.view.split('@', 1);
    const records = result.records.flatMap((r) => {
      if (!readTypes.has(r.type)) return [];
      const projected = tier === 'manage' ? activityProjector.project('respond:member', r) : r;
      if (projected?.type === 'participantStatus') {
        const { cause: _, ...status } = projected;
        return [status];
      }
      return projected ? [projected] : [];
    });
    const data = { activityId, version: result.version, records };
    const etag = `"${sha256(JSON.stringify(data))}"`;
    c.header('ETag', etag);
    const matches = c.req.header('if-none-match')?.split(',').some((tag) => {
      const candidate = tag.trim().replace(/^W\//, '');
      return candidate === '*' || candidate === etag;
    });
    if (matches) return c.body(null, 304);
    return c.json(data);
  });
  const limited = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) });
  routes.post('/activities', limited, async (c) => {
    const key = c.get('key');
    const site = c.get('site');
    if (!allows(key, 'activities:write')) return c.json({ error: 'forbidden' }, 403);
    const requestKey = c.req.header('idempotency-key');
    if (!requestKey || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) return c.json({ error: 'invalid_idempotency_key' }, 400);
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'expected_json' }, 415);
    const parsed = Create.safeParse(await c.req.json().catch((err: unknown) => {
      if (!(err instanceof SyntaxError)) throw err;
      return undefined;
    }));
    if (!parsed.success) return c.json({ error: 'bad_args' }, 400);
    const args = parsed.data.args;
    const requestId = sha256(JSON.stringify(['create', site.id, key.id, requestKey]));
    const activityId = `integration-${requestId}`;
    const result = await hub.submitIntegration(activityId, {
      viewer: c.get('memberViewer'), requestId, fingerprint: fingerprintOf(args), expectedVersion: 0, create: true,
      prepare: () => {
        if (args.ownerOrgId !== undefined && args.ownerOrgId !== site.id) throw new Rejection('forbidden', 'Only this site can own a created activity');
        if (args.kind === 'mission' ? !site.canCreateMissions : !site.canCreateEvents) throw new Rejection('forbidden', 'This site cannot create that type of activity');
        return { name: 'createActivity', args: { ...args, ownerOrgId: site.id } };
      },
    });
    if ('version' in result) return c.json({ activityId, version: result.version }, 201);
    return c.json({ error: result.reason, message: result.message }, resultStatus(result.reason));
  });
  routes.post('/activities/:id/changes', limited, async (c) => {
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
    const principal = { ...c.get('memberViewer'), tier: tierOn(c.get('memberAccess'), activityId) };
    const requestId = sha256(JSON.stringify([site.id, key.id, requestKey]));
    if (!parsed.success) {
      const native = NativeBatch.safeParse(body);
      if (native.success) {
        const batch = native.data;
        const { operations } = batch;
        if (operations.some(({ name }) => name === 'createActivity' || !allows(key, nativePermission[name]))) return c.json({ error: 'forbidden' }, 403);
        const result = await hub.submitIntegration(activityId, {
          viewer: principal, requestId, fingerprint: fingerprintOf(batch),
          expectedVersion: 'expectedVersion' in batch ? batch.expectedVersion : undefined,
          prepare: (view, now) => {
            if ('expectedParticipantVersion' in batch &&
              view.get('participant', batch.participantId)?.version !== batch.expectedParticipantVersion) {
              throw new Rejection('stale_version', 'Read the participant before retrying');
            }
            return operations.map(({ name, args }) => {
              if (name === 'updateActivity' && 'ownerOrgId' in args) throw new Rejection('forbidden', 'Activity ownership cannot be changed here');
              if (name === 'setEta' && typeof args.eta === 'number' && args.eta > now + 7 * 86_400_000) {
                throw new Rejection('eta_too_far', 'ETA cannot be more than seven days ahead');
              }
              if (name === 'setMiles' && typeof args.miles === 'number' && args.miles > 2_000) {
                throw new Rejection('mileage_too_high', 'Mileage cannot exceed 2,000 miles');
              }
              const activity = getActivity(view);
              if (activity && (name === 'setParticipantStatus' || name === 'addParticipant') &&
                typeof args.at === 'number' && args.at < activity.startTime - Math.max(activity.earlySignInWindow ?? 0, 5 * 60_000)) {
                throw new Rejection('status_before_window', 'The status time is before the activity sign-in window');
              }
              return { name, args };
            });
          },
        });
        if ('version' in result) return c.json(result);
        return c.json({ error: result.reason, message: result.message }, resultStatus(result.reason));
      }
    }
    if (!parsed.success) return c.json({ error: 'bad_args', message: parsed.error.issues[0]?.message }, 400);
    const change = parsed.data;
    if (!allows(key, permission[change.type])) return c.json({ error: 'forbidden' }, 403);
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
    return c.json({ error: reason, message }, resultStatus(reason));
  });
  return routes;
}

function resultStatus(reason: string) {
  if (reason === 'internal') return 500;
  if (reason === 'not_found') return 404;
  if (reason === 'forbidden') return 403;
  if (['bad_args', 'status_before_window', 'eta_too_far', 'mileage_too_high'].includes(reason)) return 400;
  return 409;
}
