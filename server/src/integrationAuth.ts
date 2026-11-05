import { createHash, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Activity } from '@shared/types/activity';
import type { OrganizationDoc } from '@shared/types/data/organizationDoc';

import { getAuthFromContext, userFromAuth } from './auth';
import { getOrganizationById } from './mongodb';

export const integrationPermissions = ['activities:read', 'members:read', 'participants:write', 'activities:create'] as const;
export type IntegrationPermission = (typeof integrationPermissions)[number];

interface IntegrationKey {
  id: string;
  sha256: string;
  organizationId: string;
  permissions: IntegrationPermission[];
}

export interface IntegrationPrincipal {
  keyId: string;
  organization: OrganizationDoc;
  permissions: IntegrationPermission[];
}

export function integrationError(status: 400 | 401 | 403 | 404 | 409 | 413 | 503, code: string, message: string): HTTPException {
  return new HTTPException(status, { res: Response.json({ status: 'error', code, message }, { status }) });
}

function configuredKeys(): IntegrationKey[] {
  const raw = process.env.INTEGRATION_API_KEYS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw integrationError(503, 'configuration_error', 'Integration credentials are not configured correctly. Contact the Respond administrator.');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (key): key is IntegrationKey =>
        key !== null &&
        typeof key === 'object' &&
        typeof key.id === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(key.id) &&
        typeof key.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(key.sha256) &&
        typeof key.organizationId === 'string' &&
        key.organizationId.length > 0 &&
        Array.isArray(key.permissions) &&
        key.permissions.every((p: unknown) => integrationPermissions.some((allowed) => allowed === p)),
    ) ||
    new Set(parsed.map((key) => key.id)).size !== parsed.length
  ) {
    throw integrationError(503, 'configuration_error', 'Integration credentials are not configured correctly. Contact the Respond administrator.');
  }
  return parsed;
}

export async function requireIntegration(c: Context, permission?: IntegrationPermission): Promise<IntegrationPrincipal> {
  const token = c.req.header('x-api-key');
  const key = token && configuredKeys().find((candidate) => candidate.id === token.split('.')[0]);
  if (!token || token.length > 512 || !key || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(key.sha256, 'hex'))) {
    throw integrationError(401, 'not_authenticated', 'A valid integration API key is required.');
  }
  if (permission && !key.permissions.includes(permission)) {
    throw integrationError(403, 'permission_denied', 'This integration key does not allow this operation.');
  }
  const organization = await getOrganizationById(key.organizationId);
  if (!organization) throw integrationError(403, 'unknown_organization', 'The integration organization is not configured. Contact the Respond administrator.');
  c.header('Cache-Control', 'no-store');
  return { keyId: key.id, organization, permissions: key.permissions };
}

/** An explicit API key never falls back to the browser's broader cookie permissions. */
export async function authorizeApiRead(c: Context, permission: IntegrationPermission): Promise<IntegrationPrincipal | null> {
  if (c.req.header('x-api-key') !== undefined) return requireIntegration(c, permission);
  if (!userFromAuth(await getAuthFromContext(c))) throw integrationError(401, 'not_authenticated', 'Sign in or supply an integration API key.');
  return null;
}

export function integrationCanRead(principal: IntegrationPrincipal, activity: Activity): boolean {
  const ids = new Set([principal.organization.id, ...(principal.organization.partners?.map((p) => p.id) ?? [])]);
  return ids.has(activity.ownerOrgId) || Object.keys(activity.organizations).some((id) => ids.has(id));
}

export function requireOwnOrganization(principal: IntegrationPrincipal, organizationId: string): void {
  if (principal.organization.id !== organizationId) throw integrationError(404, 'not_found', 'Organization not found.');
}
