import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage } from '@sync/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrganizationStore } from '../src/organizations';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://sync:sync@localhost:5433/sync';
const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
const available = await admin.query('SELECT 1').then(() => true, () => false);
await admin.end();

describe.skipIf(!available)('PostgreSQL webhook queue', () => {
  let name: string;
  let url: string;
  let maintenance: pg.Pool;
  let db: pg.Pool | undefined;
  let storage: PostgresStorage | undefined;
  let organizations: OrganizationStore | undefined;

  beforeEach(async () => {
    name = `sync_test_webhook_${randomBytes(6).toString('hex')}`;
    maintenance = new pg.Pool({ connectionString: databaseUrl });
    await maintenance.query(`CREATE DATABASE ${name}`);
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${name}`;
    url = testUrl.toString();
    db = new pg.Pool({ connectionString: url });
    storage = await PostgresStorage.connect(url);
    organizations = await OrganizationStore.connect(url);
    await db.query(`
      INSERT INTO organizations (id, data) VALUES ('org', '{}');
      INSERT INTO integration_keys (id, organization_id, sha256, person_ref, name, created_by, scope)
        VALUES ('key', 'org', 'test', 'directory:1', 'Test key', 'directory:1', 'read');
      INSERT INTO integration_webhooks (key_id, target_id, signing_secret) VALUES ('key', 'target', 'test');
    `);
  });

  afterEach(async () => {
    try {
      await Promise.all([organizations?.close(), storage?.close(), db?.end()]);
      await maintenance.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await maintenance.end();
      organizations = storage = db = undefined;
    }
  });

  const commit = (version: number, receivedAt = version) => storage!.commit('activity', {
    fromVersion: version - 1,
    version,
    records: [],
    lastMutationIds: {},
    log: [{
      activityId: 'activity', version, clientId: 'client', mutationId: version, userId: 'actor',
      name: 'updateActivity', v: 1, args: {}, clientTime: 0, receivedAt, outcome: 'applied', effects: [],
    }],
  });

  const jobs = async () => (await db!.query<{ version: string; changed_at: string; attempts: number; ready_at: Date }>(
    'SELECT version, changed_at, attempts, ready_at FROM integration_webhook_jobs',
  )).rows;

  it('coalesces fifty commits into one job and finishes the latest version', async () => {
    for (let version = 1; version <= 50; version++) await commit(version, 100 - version);
    expect(await jobs()).toMatchObject([{ version: '50', changed_at: '99', attempts: 0 }]);
    const claims = await organizations!.claimWebhookJobs();
    expect(claims).toMatchObject([{ version: '50', attempts: 1 }]);
    await organizations!.finishWebhookJob(claims[0]!);
    expect(await jobs()).toEqual([]);
  });

  it('keeps the lease during a new commit and releases the newer version on finish', async () => {
    await commit(1);
    const [claim] = await organizations!.claimWebhookJobs();
    const [leased] = await jobs();
    await commit(2);
    expect(await jobs()).toEqual([{ ...leased, version: '2', changed_at: '2' }]);
    expect(await organizations!.claimWebhookJobs()).toEqual([]);

    await organizations!.finishWebhookJob(claim!);
    const next = await organizations!.claimWebhookJobs();
    expect(next).toMatchObject([{ version: '2', attempts: 1 }]);
    await organizations!.finishWebhookJob(next[0]!);
    expect(await jobs()).toEqual([]);
  });

  it('backs off the newer version without growing the queue and clears it on revocation', async () => {
    const databaseTime = async () => (await db!.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!.time.getTime();
    await commit(1);
    const [claim] = await organizations!.claimWebhookJobs();
    await commit(2);
    const before = await databaseTime();
    await organizations!.retryWebhookJob(claim!);
    const after = await databaseTime();
    const [retried] = await jobs();
    expect(retried).toMatchObject({ version: '2', attempts: 1 });
    expect(retried!.ready_at.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(retried!.ready_at.getTime()).toBeLessThanOrEqual(after + 2_000);

    for (let version = 3; version <= 100; version++) await commit(version);
    expect(await jobs()).toEqual([{ ...retried, version: '100', changed_at: '100' }]);
    expect(await organizations!.revokeIntegrationKey('key', 'org')).toBe(true);
    expect(await jobs()).toEqual([]);
    await commit(101);
    expect(await jobs()).toEqual([]);
  });

  it('upgrades a legacy outbox without dropping the latest version or clearing backoff', async () => {
    await db!.query(`
      ALTER TABLE integration_webhook_jobs DROP CONSTRAINT integration_webhook_jobs_pkey,
        ADD PRIMARY KEY (key_id, activity_id, version);
      INSERT INTO integration_webhook_jobs (key_id, activity_id, version, changed_at, attempts, ready_at) VALUES
        ('key', 'activity', 1, 20, 4, '2030-01-01T00:00:00Z'),
        ('key', 'activity', 2, 19, 0, '2029-01-01T00:00:00Z');
    `);
    await storage!.close();
    storage = undefined;
    storage = await PostgresStorage.connect(url);
    expect(await jobs()).toEqual([{ version: '2', changed_at: '20', attempts: 4, ready_at: new Date('2030-01-01T00:00:00Z') }]);
    await commit(1);
    expect(await jobs()).toEqual([{ version: '2', changed_at: '20', attempts: 4, ready_at: new Date('2030-01-01T00:00:00Z') }]);
  });
});
