import { createHash, randomUUID } from 'node:crypto';

import type { Context } from 'hono';
import { MongoServerError } from 'mongodb';

import type { Command } from '@shared/commands';
import { serviceAuthor } from '@shared/events';
import type { Activity } from '@shared/types/activity';

import { integrationError, type IntegrationPrincipal } from './integrationAuth';
import mongoPromise from './mongodb';
import { getServices } from './services';

interface WriteReceipt {
  commandId: string;
  activityId: string;
}

interface IntegrationRequest {
  _id: string;
  fingerprint: string;
  receipt: WriteReceipt;
  completed: boolean;
}

export async function executeIntegrationWrite(
  c: Context,
  principal: IntegrationPrincipal,
  body: Record<string, unknown>,
  activityId: string,
  build: (activities: readonly Activity[], receipt: WriteReceipt) => Promise<Command[]>,
  prepare?: () => Promise<void>,
): Promise<WriteReceipt> {
  const key = c.req.header('Idempotency-Key');
  if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw integrationError(400, 'invalid_idempotency_key', 'Supply an Idempotency-Key of 16 to 128 letters, digits, underscores or hyphens.');
  const requests = (await mongoPromise).db().collection<IntegrationRequest>('integrationRequests');
  const _id = createHash('sha256').update(`${principal.keyId}\0${principal.organization.id}\0${key}`).digest('hex');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([c.req.method, c.req.path, body]))
    .digest('hex');
  const receipt = { commandId: randomUUID(), activityId };
  try {
    await requests.insertOne({ _id, fingerprint, receipt, completed: false });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const previous = await requests.findOne({ _id });
    if (!previous || previous.fingerprint !== fingerprint) throw integrationError(409, 'idempotency_conflict', 'This Idempotency-Key was already used for a different request.');
    if (previous.completed) return previous.receipt;
    throw integrationError(
      409,
      'write_unconfirmed',
      `This request is pending or its outcome is unconfirmed. Inspect activity ${previous.receipt.activityId} and command ${previous.receipt.commandId}; do not retry with a new key.`,
    );
  }

  let dispatchStarted = false;
  try {
    const services = await getServices();
    await prepare?.();
    await services.stateManager.handleCheckedCommands(
      async (activities) => {
        const commands = await build(activities, receipt);
        dispatchStarted = true;
        return commands.map((command) => ({ ...command, id: receipt.commandId }));
      },
      serviceAuthor(`integration:${principal.organization.id}:${principal.keyId}`),
    );
    const result = await requests.updateOne({ _id, completed: false }, { $set: { completed: true } });
    if (result.modifiedCount !== 1) throw new Error('Integration receipt was not saved');
    return receipt;
  } catch (error) {
    if (!dispatchStarted) {
      await requests.deleteOne({ _id, completed: false });
      throw error;
    }
    console.error('Integration command outcome is unconfirmed', receipt.commandId);
    throw integrationError(503, 'write_unconfirmed', `The write outcome could not be confirmed. Inspect activity ${receipt.activityId} and command ${receipt.commandId}; do not retry with a new key.`);
  }
}
