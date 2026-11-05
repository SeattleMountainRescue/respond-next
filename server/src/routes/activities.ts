import { Hono } from 'hono';

import type { ActivityType } from '@shared/types/activity';

import { authorizeApiRead, integrationCanRead, type IntegrationPrincipal } from '../integrationAuth';
import { getServices } from '../services';

export const activitiesRoutes = new Hono();

async function activitiesList(activityType: ActivityType, integration: IntegrationPrincipal | null) {
  const list = (await (await getServices()).stateManager.getAllActivities())
    .filter((a) => a.isMission === (activityType === 'missions'))
    .filter((a) => !integration || integrationCanRead(integration, a))
    .sort((a, b) => (a.startTime > b.startTime ? 1 : a.startTime < b.startTime ? -1 : 0));
  return { status: 'ok', data: list };
}

activitiesRoutes.get('/v1/missions', async (c) => {
  const integration = await authorizeApiRead(c, 'activities:read');
  return c.json(await activitiesList('missions', integration));
});

activitiesRoutes.get('/v1/events', async (c) => {
  const integration = await authorizeApiRead(c, 'activities:read');
  return c.json(await activitiesList('events', integration));
});

activitiesRoutes.get('/v1/activities/:activityId', async (c) => {
  const integration = await authorizeApiRead(c, 'activities:read');
  const activity = (await (await getServices()).stateManager.getAllActivities()).find((a) => a.id === c.req.param('activityId'));
  if (!activity || (integration && !integrationCanRead(integration, activity))) return c.json({ status: 'not found' }, 404);
  return c.json({ status: 'ok', data: activity });
});
