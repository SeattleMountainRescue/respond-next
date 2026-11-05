import { randomUUID } from 'node:crypto';

import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';

import { ActivityCommands, type Command, ParticipantCommands } from '@shared/commands';
import { type Activity, defaultEarlySigninWindow, isResponding, OrganizationStatus, ParticipantStatus } from '@shared/types/activity';
import { createNewLocation } from '@shared/types/location';
import type { MemberInfo } from '@shared/types/member';

import { integrationCanRead, integrationError, type IntegrationPrincipal, requireIntegration } from '../integrationAuth';
import { executeIntegrationWrite } from '../integrationRequests';
import { getServices } from '../services';

export const integrationRoutes = new Hono();
const smallBody = bodyLimit({
  maxSize: 16384,
  onError: () => {
    throw integrationError(413, 'body_too_large', 'The request body must be no larger than 16 KiB.');
  },
});

integrationRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error('Integration API request failed', c.req.method, c.req.routePath);
  return c.json({ status: 'error', code: 'service_unavailable', message: 'The integration request failed. Check Respond availability before trying again.' }, 503);
});

async function objectBody(c: Context, fields: string[]): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw integrationError(400, 'invalid_body', 'Supply a JSON object.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
    throw integrationError(400, 'invalid_body', 'Supply a JSON object containing only the documented fields.');
  }
  return Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
}

function ownParticipantActivity(activities: readonly Activity[], principal: IntegrationPrincipal, activityId: string, participantId: string): Activity {
  const activity = activities.find((a) => a.id === activityId && integrationCanRead(principal, a));
  if (!activity) throw integrationError(404, 'not_found', 'Activity not found.');
  if (activity.endTime) throw integrationError(409, 'activity_closed', 'This activity is closed. No participant changes were made.');
  const person = activity.participants[participantId];
  if (person && person.organizationId !== principal.organization.id) throw integrationError(403, 'different_organization', 'This participant belongs to another organization.');
  return activity;
}

async function ownMember(principal: IntegrationPrincipal, participantId: string): Promise<MemberInfo> {
  const provider = (await getServices()).memberProviders.get(principal.organization.memberProvider.provider);
  if (!provider?.getOrganizationMember) throw integrationError(503, 'provider_unavailable', 'Organization-scoped member lookup is unavailable.');
  const member = await provider.getOrganizationMember(principal.organization.id, participantId);
  if (!member || member.id !== participantId || !member.given_name?.trim() || !member.family_name?.trim()) {
    throw integrationError(404, 'member_not_found', 'The member was not found in your organization with a complete name. Check the Respond member ID.');
  }
  return member;
}

integrationRoutes.get('/v1/integration', async (c) => {
  const principal = await requireIntegration(c);
  const canCreate = principal.permissions.includes('activities:create');
  return c.json({
    status: 'ok',
    data: {
      organizationId: principal.organization.id,
      permissions: principal.permissions,
      canCreateMissions: canCreate && principal.organization.canCreateMissions,
      canCreateEvents: canCreate && principal.organization.canCreateEvents,
    },
  });
});

integrationRoutes.put('/v1/activities/:activityId/participants/:participantId/status', smallBody, async (c) => {
  const principal = await requireIntegration(c, 'participants:write');
  const body = await objectBody(c, ['status', 'time']);
  const { status, time } = body;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 7 || (time !== undefined && (!timestamp(time) || time > Date.now() + 300000))) {
    throw integrationError(400, 'invalid_status', 'Supply a status code from 0 to 7 and, optionally, a positive epoch-millisecond time no more than five minutes in the future.');
  }
  const activityId = c.req.param('activityId');
  const participantId = c.req.param('participantId');
  let resolvedMember: MemberInfo | undefined;
  const receipt = await executeIntegrationWrite(
    c,
    principal,
    body,
    activityId,
    async (activities) => {
      const activity = ownParticipantActivity(activities, principal, activityId, participantId);
      const person = activity.participants[participantId];
      const when = time ?? Date.now();
      if (person && (!person.timeline[0] || when < person.timeline[0].time))
        throw integrationError(409, 'stale_status', 'The status time precedes the latest recorded status. Refresh the activity before making a new change.');
      const current = person?.timeline[0]?.status;
      const standbyOnly = activity.startTime - (activity.earlySignInWindow ?? defaultEarlySigninWindow) > Date.now() || (activity.forceStandbyOnly && !(current !== undefined && isResponding(current)));
      if (standbyOnly && status !== ParticipantStatus.Standby && status !== ParticipantStatus.NotResponding && status !== ParticipantStatus.SignedOut) {
        throw integrationError(409, 'standby_only', 'This activity currently accepts standby responses only.');
      }
      // The shared reducer can sign this person out of another activity. Do not let that cross an organization boundary.
      if (
        status !== ParticipantStatus.SignedIn &&
        activities.some((a) => a.id !== activityId && a.participants[participantId]?.organizationId !== principal.organization.id && a.participants[participantId]?.timeline[0]?.status === ParticipantStatus.SignedIn)
      ) {
        throw integrationError(409, 'organization_conflict', 'This member is responding for another organization. Resolve that response in Respond first.');
      }
      const member = person ? { given_name: person.firstname, family_name: person.lastname } : resolvedMember;
      if (!member) throw integrationError(409, 'activity_changed', 'The participant changed while this request was prepared. Refresh the activity and try again.');
      const commands: Command[] = [];
      if (!activity.organizations[principal.organization.id]) {
        commands.push(
          ActivityCommands.AppendOrganizationTimeline(activityId, principal.organization, { time: when, status: status === ParticipantStatus.Standby ? OrganizationStatus.Standby : OrganizationStatus.Responding }),
        );
      }
      commands.push(ParticipantCommands.UpdateParticipant(activityId, participantId, member.given_name, member.family_name, principal.organization.id, when, status, person?.miles, person?.eta));
      return commands;
    },
    async () => {
      const activities = await (await getServices()).stateManager.getAllActivities();
      const activity = ownParticipantActivity(activities, principal, activityId, participantId);
      if (!activity.participants[participantId]) resolvedMember = await ownMember(principal, participantId);
    },
  );
  return c.json({ status: 'ok', data: receipt });
});

for (const field of ['eta', 'miles'] as const) {
  integrationRoutes.put(`/v1/activities/:activityId/participants/:participantId/${field}`, smallBody, async (c) => {
    const principal = await requireIntegration(c, 'participants:write');
    const body = await objectBody(c, [field]);
    const value = body[field];
    if (value !== null && typeof value !== 'number') throw integrationError(400, 'invalid_value', `Supply ${field} as a number, or null to clear it.`);
    if (value !== null && (field === 'eta' ? !timestamp(value) || value < Date.now() - 300000 : typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw integrationError(
        400,
        'invalid_value',
        field === 'eta' ? 'Supply eta as null to clear it, or epoch milliseconds no more than five minutes in the past.' : 'Supply miles as a nonnegative finite number, or null to clear it.',
      );
    }
    const activityId = c.req.param('activityId');
    const participantId = c.req.param('participantId');
    const receipt = await executeIntegrationWrite(c, principal, body, activityId, async (activities) => {
      const activity = ownParticipantActivity(activities, principal, activityId, participantId);
      if (!activity.participants[participantId]) throw integrationError(404, 'participant_not_found', "Record this member's status before changing ETA or mileage.");
      return [field === 'eta' ? ParticipantCommands.UpdateParticipantEta(activityId, participantId, value) : ParticipantCommands.UpdateParticipantMiles(activityId, participantId, value)];
    });
    return c.json({ status: 'ok', data: receipt });
  });
}

for (const kind of ['missions', 'events'] as const) {
  integrationRoutes.post(`/v1/${kind}`, smallBody, async (c) => {
    const principal = await requireIntegration(c, 'activities:create');
    const body = await objectBody(c, ['title', 'startTime', 'idNumber', 'description', 'mapId']);
    const { title, startTime, idNumber = '', description = '', mapId = '' } = body;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 500 ||
      !timestamp(startTime) ||
      typeof idNumber !== 'string' ||
      idNumber.length > 100 ||
      typeof description !== 'string' ||
      description.length > 10000 ||
      typeof mapId !== 'string' ||
      mapId.length > 2048
    ) {
      throw integrationError(400, 'invalid_activity', 'Supply a nonblank title, a positive epoch-millisecond startTime, and optional bounded text fields idNumber, description and mapId.');
    }
    const isMission = kind === 'missions';
    const receipt = await executeIntegrationWrite(c, principal, body, randomUUID(), async (activities, request) => {
      if (!(isMission ? principal.organization.canCreateMissions : principal.organization.canCreateEvents))
        throw integrationError(403, 'creation_not_allowed', 'Your organization is not permitted to create this activity type.');
      if (activities.some((a) => a.id === request.activityId)) throw integrationError(409, 'activity_exists', 'The activity ID already exists.');
      return [
        ActivityCommands.UpdateActivity({
          id: request.activityId,
          title: title.trim(),
          startTime,
          idNumber,
          description,
          mapId,
          ownerOrgId: principal.organization.id,
          isMission,
          asMission: false,
          location: createNewLocation(),
        }),
        ActivityCommands.AppendOrganizationTimeline(request.activityId, principal.organization, { time: Date.now(), status: OrganizationStatus.Responding }),
      ];
    });
    return c.json({ status: 'ok', data: receipt }, 201);
  });
}
