import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { HIDDEN_VIEW } from '@sync/core';
import type { ActivityViewer } from '@sync/domain';
import type { Hub } from '@sync/server';
import type { MemberProviders } from './memberProviders';
import type { OrganizationStore } from './organizations';

const Target = z.object({
  organizationId: z.string().min(1),
  url: z.string().url().refine((input) => {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
}).strict();

export function webhookTargets(raw?: string) {
  if (!raw) return new Map<string, z.infer<typeof Target>>();
  try {
    return new Map(Object.entries(z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), Target).parse(JSON.parse(raw))));
  } catch {
    throw new Error('Invalid INTEGRATION_WEBHOOK_TARGETS configuration');
  }
}

export const webhookSignature = (secret: string, timestamp: string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

export async function deliverIntegrationWebhooks(
  organizations: OrganizationStore, members: MemberProviders, hub: Hub, targets: ReturnType<typeof webhookTargets>,
  send: typeof fetch = fetch,
) {
  const jobs = await organizations.claimWebhookJobs();
  await Promise.all(jobs.map(async (job) => {
    try {
      const target = targets.get(job.targetId);
      if (!target || target.organizationId !== job.organizationId) throw new Error('Webhook target is not configured for the organization');
      const member = await members.accessInOrganization(job.organizationId, job.personRef);
      if (member) {
        const viewer: ActivityViewer = {
          userId: member.member.personRef, siteId: job.organizationId, tier: member.tier, class: 'member',
        };
        const current = await hub.read(job.activityId, viewer);
        if (current.version > 0 && current.view !== HIDDEN_VIEW && await organizations.integrationKey(job.keyId, job.organizationId)) {
          const body = JSON.stringify({ activityId: job.activityId, version: Number(job.version), changedAt: Number(job.changedAt) });
          const timestamp = String(Math.floor(Date.now() / 1000));
          const response = await send(target.url, {
            method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: {
              'Content-Type': 'application/json',
              'X-Respond-Timestamp': timestamp,
              'X-Respond-Signature': webhookSignature(organizations.openWebhookSecret(job.signingSecret), timestamp, body),
            },
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error(`Webhook receiver returned HTTP ${response.status}`);
        }
      }
      await organizations.finishWebhookJob(job);
    } catch (err) {
      console.error('integration webhook: delivery failed', job.keyId, job.activityId, err instanceof Error ? err.message : 'Unknown error');
      await organizations.retryWebhookJob(job);
    }
  }));
}
