import { Alert, Button, List, ListItem, ListItemText, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApi, type IntegrationKeyScope, type IntegrationKeyView, type IssuedIntegrationKey } from './api';
import { useAuth } from './auth';
import { useDialogs } from './dialogs';
import { ToolbarPage } from './ToolbarPage';

const date = (value: string) => new Date(value).toLocaleString();

export function ApiKeys() {
  const api = useApi();
  const { session } = useAuth();
  const { confirm } = useDialogs();
  const canIssue = session?.class === 'member' && !session.personRef.startsWith('adhoc:');
  const [keys, setKeys] = useState<IntegrationKeyView[]>();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<IntegrationKeyScope>('read');
  const [webhookTarget, setWebhookTarget] = useState('');
  const [issued, setIssued] = useState<IssuedIntegrationKey>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (action: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);
  const load = useCallback(async () => setKeys(await api.integrationKeys()), [api]);
  useEffect(() => {
    document.title = 'API keys';
    void act(load);
  }, [act, load]);

  const issue = (event: FormEvent) => {
    event.preventDefault();
    if (!canIssue || busy || issued || !name.trim()) return;
    void act(async () => {
      const target = webhookTarget.trim();
      setIssued(await api.issueIntegrationKey({ name: name.trim(), scope, ...(target && { webhookTarget: target }) }));
      setName('');
      setScope('read');
      setWebhookTarget('');
      await load();
    });
  };
  const revoke = (key: IntegrationKeyView) => act(async () => {
    if (!(await confirm({ prompt: `Revoke the API key ${key.name}?`, destructive: true, label: 'Revoke' }))) return;
    await api.revokeIntegrationKey(key.id);
    await load();
  });

  return (
    <ToolbarPage>
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography variant="h4" component="h1">API keys</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {!keys && (error
            ? <Button onClick={() => void act(load)}>Retry</Button>
            : <Typography>Loading API keys…</Typography>)}
          {keys?.length === 0 && <Typography>No API keys.</Typography>}
          {!!keys?.length && (
            <List disablePadding>
              {keys.map((key) => (
                <ListItem key={key.id} disableGutters sx={{ gap: 2 }}>
                  <ListItemText primary={key.name} secondary={[
                    key.scope,
                    `Created ${date(key.createdAt)}`,
                    key.lastUsedAt ? `Last used ${date(key.lastUsedAt)}` : 'Never used',
                    key.revokedAt && `Revoked ${date(key.revokedAt)}`,
                    key.webhookTarget && `Webhook: ${key.webhookTarget}`,
                  ].filter(Boolean).join(' · ')} />
                  {!key.revokedAt && <Button disabled={busy} onClick={() => void revoke(key)}>Revoke</Button>}
                </ListItem>
              ))}
            </List>
          )}
          {issued ? (
            <>
              <Alert severity="info">Copy these credentials now. Respond won’t show them again.</Alert>
              <TextField label="API token" value={issued.token} slotProps={{ input: { readOnly: true } }} />
              {issued.signingSecret && <TextField label="Webhook signing secret" value={issued.signingSecret} slotProps={{ input: { readOnly: true } }} />}
              <Button onClick={() => setIssued(undefined)}>Hide credentials</Button>
            </>
          ) : keys && (canIssue ? (
            <Stack component="form" spacing={2} onSubmit={issue}>
              <TextField label="Key name" required value={name} onChange={(e) => setName(e.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} />
              <TextField select label="Scope" value={scope} onChange={(e) => setScope(e.target.value as IntegrationKeyScope)}>
                <MenuItem value="read">Read only</MenuItem>
                <MenuItem value="write">Read and write</MenuItem>
              </TextField>
              <TextField label="Approved webhook target (optional)" helperText="Enter the ID of a webhook target already configured for this site." value={webhookTarget} onChange={(e) => setWebhookTarget(e.target.value)} />
              <Button type="submit" variant="contained" disabled={busy || !name.trim()}>Issue key</Button>
            </Stack>
          ) : <Alert severity="info">Only signed-in directory members can issue API keys.</Alert>)}
        </Stack>
      </Paper>
    </ToolbarPage>
  );
}
