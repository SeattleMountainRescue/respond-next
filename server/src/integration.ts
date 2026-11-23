import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { HIDDEN_VIEW, Rejection, type ReadView } from '@sync/core';
import { ACTIVITY_ARCHIVE_ID, ACTIVITY_KINDS, getActivity, ownerOptions, type ActivitySummaryRec, type ActivityUnitRec, type Organization } from '@sync/domain';
import type { Hub } from '@sync/server';
import type { OrganizationStore } from './organizations';
import type { SessionData } from './sessions';
import { refreshSession, viewerOf, viewerOn, type People } from './signIn';

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const fingerprint = (value: unknown) => sha256(JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry,
));
export const NewIntegrationKey = z.object({
  name: z.string().trim().min(1).max(100), scope: z.enum(['read', 'write']),
  webhookTarget: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).optional(),
}).strict();
export function newIntegrationCredential() {
  const id = `key-${randomBytes(16).toString('hex')}`;
  const token = `${id}.${randomBytes(32).toString('hex')}`;
  return { id, token, sha256: sha256(token), signingSecret: randomBytes(32).toString('hex') };
}

export async function integrationSession(people: People, key: { organizationId: string; personRef: string }): Promise<SessionData | undefined> {
  const found = await people.members?.lookup(key.personRef);
  if (!found) return undefined;
  return refreshSession(people, {
    userId: key.personRef, personRef: key.personRef, name: found.member.name, email: found.member.email ?? '',
    class: 'member', orgId: key.organizationId, tier: found.tier,
  }, found.tier);
}

const id = z.string().min(1).max(200).refine((value) => !value.startsWith('$'));
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const activityArgs = z.object({ kind: z.enum(ACTIVITY_KINDS).optional(), ownerOrgId: z.string().optional() }).passthrough();
const operation = z.object({
  name: z.enum(['updateActivity', 'addParticipant', 'setParticipantStatus', 'setEta', 'setMiles', 'assign', 'setUnitStatus']),
  args: z.object({}).passthrough(),
}).strict();
const participantBatch = z.object({
  participantId: id, expectedParticipantVersion: version,
  operations: z.array(z.object({ name: z.enum(['setEta', 'setMiles']), args: z.object({ participantId: id }).passthrough() }).strict()).min(1).max(50),
}).strict().refine((batch) => batch.operations.every(({ args }) => args.participantId === batch.participantId));
const nativeBatch = z.union([z.object({ expectedVersion: version, operations: z.array(operation).min(1).max(50) }).strict(), participantBatch]);
const create = z.object({ args: activityArgs.required({ kind: true }) }).strict();

function choices(orgs: OrganizationStore, site: Organization, view: ReadView) {
  const config = orgs.siteConfig(site, { devSignIn: false, buildId: 'integration' });
  const ownAndPartners = [config.organization, ...config.organization.partners];
  const stored = getActivity(view);
  let currentOwner = stored?.ownerOrgId;
  let currentKind = stored?.kind;
  const addedUnits = new Map<string, { id: string; title: string; rosterName: string | null }>();
  return (name: string, args: Record<string, unknown>) => {
    if (name === 'createActivity' || name === 'updateActivity') {
      const parsed = activityArgs.safeParse(args);
      if (!parsed.success) throw new Rejection('bad_args', parsed.error.issues[0]?.message);
      const owner = parsed.data.ownerOrgId ?? currentOwner ?? site.id;
      const kind = parsed.data.kind ?? currentKind;
      if (name === 'createActivity' || owner !== currentOwner || kind !== currentKind) {
        const keepForeignOwner = owner === stored?.ownerOrgId && !ownAndPartners.some((unit) => unit.id === owner);
        if (!keepForeignOwner && !ownerOptions(config.organization, kind === 'mission').some((unit) => unit.id === owner)) {
          throw new Rejection('owner_not_allowed', 'Select an eligible owner for this activity type');
        }
      }
      currentOwner = owner;
      currentKind = kind;
      return { name, args: name === 'createActivity' ? { ...args, ownerOrgId: owner } : args };
    }
    if (name !== 'addParticipant' && name !== 'setParticipantStatus' && name !== 'setUnitStatus') return { name, args };
    if ('unit' in args) throw new Rejection('bad_args', 'Send unitId rather than unit');
    const { unitId = site.id, ...rest } = args;
    if (typeof unitId !== 'string') throw new Rejection('bad_args', 'unitId must be a string');
    const existing = view.get<ActivityUnitRec>('activityUnit', unitId) ?? addedUnits.get(unitId);
    const option = ownAndPartners.find((unit) => unit.id === unitId) ??
      (name === 'setUnitStatus' ? config.operational.find((unit) => unit.id === unitId) : undefined);
    if (!existing && !option) throw new Rejection('unknown_unit', 'Select a unit offered by Respond for this activity');
    const unit = existing ? { id: existing.id, title: existing.title, rosterName: existing.rosterName }
      : { id: option!.id, title: option!.title, rosterName: option!.shortTitle };
    addedUnits.set(unitId, unit);
    return { name, args: { ...rest, unit } };
  };
}

type Key = NonNullable<Awaited<ReturnType<OrganizationStore['integrationKey']>>>;
type Env = { Variables: { site: Organization; key: Key; session: SessionData } };
async function writeInput(c: Context<Env>) {
  if (c.get('key').scope !== 'write') return { response: c.json({ error: 'forbidden_scope' }, 403) };
  const requestKey = c.req.header('idempotency-key');
  if (!requestKey || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) return { response: c.json({ error: 'invalid_idempotency_key' }, 400) };
  if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return { response: c.json({ error: 'expected_json' }, 415) };
  try {
    return { requestKey, body: await c.req.json<unknown>() };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { response: c.json({ error: 'invalid_json' }, 400) };
  }
}

export function integrationRoutes(hub: Hub, orgs: OrganizationStore, people: People) {
  const routes = new Hono<Env>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!orgs.managesIntegrationKeys) return c.json({ error: 'not_found' }, 404);
    const token = c.req.header('x-api-key');
    const match = token?.match(/^(key-[0-9a-f]{32})\.[0-9a-f]{64}$/);
    const key = match?.[1] ? await orgs.integrationKey(match[1], c.get('site').id) : undefined;
    if (!token || !key || !timingSafeEqual(Buffer.from(key.sha256, 'hex'), Buffer.from(sha256(token), 'hex'))) return c.json({ error: 'unauthorized' }, 401);
    let session: SessionData | undefined;
    try {
      session = await integrationSession(people, key);
    } catch {
      console.error('integration: member access unavailable for key', key.id);
      return c.json({ error: 'directory_unavailable' }, 503);
    }
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    await orgs.markIntegrationKeyUsed(key.id, key.organizationId);
    c.set('key', key);
    c.set('session', session);
    await next();
  });
  routes.get('/activities', async (c) => {
    const open = c.req.query('open');
    if (open !== undefined && open !== 'true' && open !== 'false') return c.json({ error: 'bad_args', message: 'open must be true or false' }, 400);
    const externalRef = c.req.query('externalRef');
    const { records } = await hub.read(ACTIVITY_ARCHIVE_ID, viewerOf(c.get('session')));
    const summaries = records.filter((r): r is ActivitySummaryRec => r.type === 'activitySummary');
    return c.json({ data: summaries.filter((r) => (open === undefined || r.activity.closed === (open === 'false')) &&
      (externalRef === undefined || r.externalRef === externalRef)) });
  });
  routes.get('/activities/:id', async (c) => {
    const activityId = c.req.param('id');
    if (!id.safeParse(activityId).success) return c.json({ error: 'not_found' }, 404);
    const result = await hub.read(activityId, viewerOn(c.get('session'), activityId));
    const activity = result.records.find((r) => r.type === 'activity');
    if (!result.version || result.view === HIDDEN_VIEW || !activity) return c.json({ error: 'not_found' }, 404);
    if (typeof activity.removedAt === 'number') return c.json({ error: 'gone', removedAt: activity.removedAt }, 410);
    const data = { activityId, version: result.version, records: result.records };
    const etag = `"${sha256(JSON.stringify(data))}"`;
    c.header('ETag', etag);
    if (c.req.header('if-none-match')?.split(',').some((tag) => ['*', etag].includes(tag.trim().replace(/^W\//, '')))) return c.body(null, 304);
    return c.json(data);
  });
  const limited = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) });
  routes.post('/activities', limited, async (c) => {
    const input = await writeInput(c);
    if ('response' in input) return input.response;
    const parsed = create.safeParse(input.body);
    if (!parsed.success) return c.json({ error: 'bad_args', message: parsed.error.issues[0]?.message }, 400);
    const site = c.get('site');
    const requestId = fingerprint(['create', site.id, c.get('key').id, input.requestKey]);
    const activityId = `integration-${requestId}`;
    const result = await hub.submitIntegration(activityId, {
      viewer: viewerOf(c.get('session')), requestId, fingerprint: fingerprint(parsed.data.args), expectedVersion: 0, create: true,
      prepare: (view) => choices(orgs, site, view)('createActivity', parsed.data.args),
    });
    if ('version' in result) return c.json({ activityId, version: result.version }, 201);
    return c.json({ error: result.reason, message: result.message }, resultStatus(result.reason));
  });
  routes.post('/activities/:id/changes', limited, async (c) => {
    const input = await writeInput(c);
    if ('response' in input) return input.response;
    const activityId = c.req.param('id');
    if (!id.safeParse(activityId).success) return c.json({ error: 'not_found' }, 404);
    const parsed = nativeBatch.safeParse(input.body);
    if (!parsed.success) return c.json({ error: 'bad_args', message: parsed.error.issues[0]?.message }, 400);
    const batch = parsed.data;
    const site = c.get('site');
    const result = await hub.submitIntegration(activityId, {
      viewer: viewerOn(c.get('session'), activityId), requestId: fingerprint([site.id, c.get('key').id, input.requestKey]),
      fingerprint: fingerprint(batch), expectedVersion: 'expectedVersion' in batch ? batch.expectedVersion : undefined,
      prepare: (view) => {
        if ('expectedParticipantVersion' in batch) {
          const participant = view.get('participant', batch.participantId);
          if (!participant) throw new Rejection('not_found', 'That participant is no longer on this activity');
          if (participant.version !== batch.expectedParticipantVersion) throw new Rejection('stale_version', 'Read the participant before retrying');
        }
        const normalize = choices(orgs, site, view);
        return batch.operations.map(({ name, args }) => normalize(name, args));
      },
    });
    if ('version' in result) return c.json(result);
    return c.json({ error: result.reason, message: result.message }, resultStatus(result.reason));
  });
  return routes;
}

function resultStatus(reason: string) {
  if (reason === 'internal') return 500;
  if (reason === 'not_found' || reason === 'no_activity') return 404;
  if (reason === 'forbidden' || reason === 'forbidden_scope') return 403;
  if (['bad_args', 'invalid_json', 'owner_not_allowed', 'unknown_unit'].includes(reason)) return 400;
  return 409;
}
