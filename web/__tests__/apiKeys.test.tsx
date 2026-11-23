// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchApi, type IntegrationKeyView, type NewIntegrationKey } from '../src/shell/api';
import { CRT, serverWithActivity, signIn } from './app';

let server: Awaited<ReturnType<typeof serverWithActivity>> | undefined;

afterEach(() => {
  cleanup();
  server?.stop();
  vi.unstubAllGlobals();
});

const personalPath = '/api/integration-keys';
const createdAt = '2026-01-01T00:00:00.000Z';
const revokedAt = '2026-01-02T00:00:00.000Z';
const key = (input: Partial<IntegrationKeyView> = {}): IntegrationKeyView => ({
  id: 'key/1', name: 'Dashboard', scope: 'read', createdAt, lastUsedAt: null, revokedAt: null, webhookTarget: null, ...input,
});

async function openAccountPage(name: string) {
  fireEvent.click(await screen.findByLabelText('account of current user'));
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name }));
}

it('lets a signed-in member issue and revoke personal keys, showing credentials only at issue', async () => {
  const keys: IntegrationKeyView[] = [];
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === personalPath && !init?.method) return Response.json({ keys });
    if (url === personalPath && init?.method === 'POST') {
      const input = JSON.parse(init.body as string) as NewIntegrationKey;
      const id = `key/${keys.length + 1}`;
      keys.push(key({ id, name: input.name, scope: input.scope, webhookTarget: input.webhookTarget ?? null }));
      return Response.json({ id, token: `token-${id}`, ...(input.webhookTarget && { signingSecret: 'test-signing-secret' }) }, { status: 201 });
    }
    if (url === `${personalPath}/key%2F1` && init?.method === 'DELETE') {
      keys[0]!.revokedAt = revokedAt;
      return Response.json({ status: 'ok' });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', http);
  server = await serverWithActivity();
  server.renderApp('/', (api) => ({
    ...api,
    integrationKeys: fetchApi.integrationKeys,
    issueIntegrationKey: fetchApi.issueIntegrationKey,
    revokeIntegrationKey: fetchApi.revokeIntegrationKey,
  }));
  await signIn('Avery Lindqvist', 'kcsara:1');
  await openAccountPage('API keys');
  expect(await screen.findByText('No API keys.')).toBeTruthy();
  expect(window.location.pathname).toBe('/api-keys');

  fireEvent.change(screen.getByLabelText(/^Key name/), { target: { value: ' Dashboard ' } });
  fireEvent.mouseDown(screen.getByLabelText('Scope'));
  fireEvent.click(await screen.findByRole('option', { name: 'Read and write' }));
  fireEvent.change(screen.getByLabelText('Approved webhook target (optional)'), { target: { value: ' dispatch ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));
  expect(await screen.findByDisplayValue('token-key/1')).toBeTruthy();
  expect(screen.getByDisplayValue('test-signing-secret')).toBeTruthy();
  expect(await screen.findByText(/write.*Created.*Never used.*Webhook: dispatch/)).toBeTruthy();
  expect(http).toHaveBeenCalledWith(personalPath, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Dashboard', scope: 'write', webhookTarget: 'dispatch' }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Hide credentials' }));
  expect(screen.queryByDisplayValue('token-key/1')).toBeNull();
  expect(screen.queryByDisplayValue('test-signing-secret')).toBeNull();

  fireEvent.change(screen.getByLabelText(/^Key name/), { target: { value: 'Reports' } });
  fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));
  expect(await screen.findByDisplayValue('token-key/2')).toBeTruthy();
  expect(screen.queryByLabelText('Webhook signing secret')).toBeNull();
  expect(http).toHaveBeenCalledWith(personalPath, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reports', scope: 'read' }),
  });
  fireEvent.click(screen.getByRole('link', { name: 'CRT Check-In' }));
  await openAccountPage('API keys');
  const row = within((await screen.findByText('Dashboard')).closest('li')!);
  expect(screen.queryByDisplayValue('token-key/2')).toBeNull();

  fireEvent.click(row.getByRole('button', { name: 'Revoke' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(http).not.toHaveBeenCalledWith(expect.any(String), { method: 'DELETE' });
  fireEvent.click(row.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
  expect(await row.findByText(/Revoked/)).toBeTruthy();
  expect(row.queryByRole('button', { name: 'Revoke' })).toBeNull();
  expect(http).toHaveBeenCalledWith(`${personalPath}/key%2F1`, { method: 'DELETE' });
});

it('lets organization admins see key owners and scopes and revoke keys, but not issue them', async () => {
  const adminPath = `/api/admin/organizations/${CRT.id}/integration-keys`;
  const adminKey = { ...key({ name: 'Team dashboard', scope: 'write' }), personRef: 'kcsara:1' };
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === adminPath && !init?.method) return Response.json({ keys: [adminKey] });
    if (url === `${adminPath}/key%2F1` && init?.method === 'DELETE') {
      adminKey.revokedAt = revokedAt;
      return Response.json({ status: 'ok' });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', http);
  server = await serverWithActivity();
  server.renderApp('/', (api) => ({
    ...api,
    admin: {
      ...api.admin,
      integrationKeys: fetchApi.admin.integrationKeys,
      revokeIntegrationKey: fetchApi.admin.revokeIntegrationKey,
    },
  }));
  await signIn('Alice Adams', 'kcsara:101', 'manage');
  await openAccountPage('Organizations');
  fireEvent.click(await screen.findByText('Cascade Rescue Team (CRT)'));
  expect(await screen.findByText('kcsara:1 · write · Never used')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Issue key' })).toBeNull();
  expect(screen.queryByLabelText('Directory person reference')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
  expect(await screen.findByText('kcsara:1 · write · Revoked')).toBeTruthy();
  expect(http).toHaveBeenCalledWith(`${adminPath}/key%2F1`, { method: 'DELETE' });
});
