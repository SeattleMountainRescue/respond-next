/**
 * The organizations, their member and sign-in providers, and the site admins. Every request looks up its site by
 * hostname, so they're held in memory; with Postgres, changes are written through and survive
 * restarts. A seed file is imported with `npm run seed` (seed.ts), not at startup. Providers' client
 * secrets are stored encrypted (see secrets.ts).
 */
import pg from 'pg';
import { INTEGRATION_WEBHOOK_SCHEMA } from '@sync/server';
import type { z } from 'zod';
import {
  MemberProviderConfig,
  Organization,
  OrganizationSeed,
  ORG_ADMIN_FIELDS,
  SignInProviderConfig,
  type Brand,
  type MemberProviderView,
  type SignInProviderView,
  type OrganizationPartner,
  type SeesActivity,
  type SiteConfig,
  type SiteUnit,
} from '@sync/domain';
import { SecretBox } from './secrets';

const DEFAULT_BRAND: Brand = { primary: 'rgb(200, 100, 100)' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id   text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS member_providers (
  id   text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sign_in_providers (
  id   text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS site_admins (
  email text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS integration_keys (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  person_ref text NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_keys_org ON integration_keys (organization_id);
${INTEGRATION_WEBHOOK_SCHEMA}
-- Kept the seed's history when the seed was applied at startup.
DROP TABLE IF EXISTS seeded;`;

/** `host` from a request: the hostname, lowercased, without the port. */
export const hostnameOf = (host: string | undefined): string => (host ?? '').replace(/:\d+$/, '').toLowerCase();

export type SaveResult<T = Organization> = { ok: true; saved: T } | { ok: false; status: 400 | 403 | 404; error: string };

export interface StoreOptions {
  /** Site admins from the environment (SITE_ADMINS), beside those stored. */
  envAdmins?: string[];
  /** Encrypts providers' secrets. In memory, a key for the process is made if none is given. */
  secrets?: SecretBox;
}

interface WebhookJob {
  keyId: string;
  activityId: string;
  version: string;
  changedAt: string;
  attempts: number;
  targetId: string;
  signingSecret: string;
  organizationId: string;
  personRef: string;
}

const UPSERT_ORGANIZATION = 'INSERT INTO organizations (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data';

const ONLY_SITE_ADMINS = { ok: false, status: 403, error: 'Only site admins can do that' } as const;

type AnyProvider = { id: string; kind: string; clientSecret?: string };

/**
 * One kind of provider (member or sign-in), as stored: client secrets encrypted, never sent back.
 * Saved without a secret, a provider keeps the one it had.
 */
class ProviderSet<T extends AnyProvider> {
  readonly stored = new Map<string, T>();

  constructor(
    readonly table: string,
    /** For messages: "member provider". */
    readonly what: string,
    readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    /** Whether a provider of this kind has a client secret. */
    private readonly hasSecret: (p: T) => boolean,
    private readonly secrets: SecretBox,
  ) {}

  get upsert(): string {
    return `INSERT INTO ${this.table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
  }

  views(): (Omit<T, 'clientSecret'> & { hasClientSecret?: boolean })[] {
    return [...this.stored.values()].sort((a, b) => a.id.localeCompare(b.id)).map((p) => (this.hasSecret(p) ? { ...withoutSecret(p), hasClientSecret: !!p.clientSecret } : p));
  }

  /** With its secret decrypted. `version` is the same object until the provider is changed. */
  config(id: string): { config: T; version: object } | undefined {
    const stored = this.stored.get(id);
    if (!stored) return undefined;
    return { config: stored.clientSecret ? { ...stored, clientSecret: this.secrets.decrypt(stored.clientSecret) } : stored, version: stored };
  }

  seal(p: T): T {
    return this.hasSecret(p) && p.clientSecret ? { ...p, clientSecret: this.secrets.encrypt(p.clientSecret) } : p;
  }

  /** What to store in place of the provider with its id: without a secret, it keeps the stored one. */
  toStore(p: T): T {
    const existing = this.stored.get(p.id);
    return this.hasSecret(p) && !p.clientSecret && existing?.kind === p.kind ? { ...p, clientSecret: existing.clientSecret } : this.seal(p);
  }
}

export class OrganizationStore {
  private readonly orgs = new Map<string, Organization>();
  private readonly providers: ProviderSet<MemberProviderConfig>;
  private readonly signIns: ProviderSet<SignInProviderConfig>;
  private storedAdmins = new Set<string>();
  private readonly envAdmins: Set<string>;

  private constructor(
    private readonly pool: pg.Pool | undefined,
    private readonly secrets: SecretBox,
    envAdmins: string[],
  ) {
    this.envAdmins = new Set(envAdmins.map((e) => e.trim().toLowerCase()).filter(Boolean));
    this.providers = new ProviderSet('member_providers', 'member provider', MemberProviderConfig, (p) => p.kind === 'cedar', secrets);
    this.signIns = new ProviderSet('sign_in_providers', 'sign-in provider', SignInProviderConfig, () => true, secrets);
  }

  /** In memory (tests, or no DATABASE_URL), starting from the seed. */
  static memory(seed: OrganizationSeed = OrganizationSeed.parse({}), options: StoreOptions = {}): OrganizationStore {
    const store = new OrganizationStore(undefined, options.secrets?.ready ? options.secrets : SecretBox.ephemeral(), options.envAdmins ?? []);
    for (const p of seed.memberProviders) store.providers.stored.set(p.id, store.providers.seal(p));
    for (const p of seed.signInProviders) store.signIns.stored.set(p.id, store.signIns.seal(p));
    for (const o of seed.organizations) store.orgs.set(o.id, o);
    store.storedAdmins = new Set(seed.siteAdmins);
    store.check();
    return store;
  }

  get managesIntegrationKeys(): boolean {
    return this.pool !== undefined;
  }

  async integrationKey(id: string, organizationId: string) {
    const result = await this.pool?.query<{ id: string; sha256: string; personRef: string; organizationId: string }>(
      `SELECT id, sha256, person_ref AS "personRef", organization_id AS "organizationId"
       FROM integration_keys WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`, [id, organizationId],
    );
    return result?.rows[0];
  }

  async listIntegrationKeys(organizationId: string) {
    const result = await this.pool?.query(
      `SELECT id, name, person_ref AS "personRef", created_by AS "createdBy", created_at AS "createdAt",
              last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
       FROM integration_keys WHERE organization_id = $1 ORDER BY created_at DESC`, [organizationId],
    );
    return result?.rows;
  }

  get canSignIntegrationWebhooks(): boolean {
    return this.managesIntegrationKeys && this.secrets.ready;
  }

  async createIntegrationKey(key: { id: string; organizationId: string; sha256: string; personRef: string; name: string; createdBy: string },
    webhook?: { targetId: string; secret: string }) {
    if (!this.pool) throw new Error('Integration key management requires PostgreSQL');
    await this.transaction(async (db) => {
      await db.query(
        'INSERT INTO integration_keys (id, organization_id, sha256, person_ref, name, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [key.id, key.organizationId, key.sha256, key.personRef, key.name, key.createdBy],
      );
      if (webhook) await db.query(
        'INSERT INTO integration_webhooks (key_id, target_id, signing_secret) VALUES ($1, $2, $3)',
        [key.id, webhook.targetId, this.secrets.encrypt(webhook.secret)],
      );
    });
  }

  async markIntegrationKeyUsed(id: string, organizationId: string) {
    await this.pool?.query(
      `UPDATE integration_keys SET last_used_at = now()
       WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
         AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, [id, organizationId],
    );
  }

  async revokeIntegrationKey(id: string, organizationId: string) {
    if (!this.pool) return false;
    let revoked = false;
    await this.transaction(async (db) => {
      const result = await db.query(
        'UPDATE integration_keys SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL',
        [id, organizationId],
      );
      if (result.rowCount !== 1) return;
      await db.query('DELETE FROM integration_webhooks WHERE key_id = $1', [id]);
      revoked = true;
    });
    return revoked;
  }

  openWebhookSecret(sealed: string): string {
    return this.secrets.decrypt(sealed);
  }

  async claimWebhookJobs(): Promise<WebhookJob[]> {
    if (!this.pool) throw new Error('Integration webhooks require PostgreSQL');
    const { rows } = await this.pool.query<WebhookJob>(`
      WITH ready AS (
        SELECT j.key_id, j.activity_id, j.version FROM integration_webhook_jobs j
        WHERE j.ready_at <= now()
        ORDER BY j.ready_at LIMIT 16 FOR UPDATE SKIP LOCKED
      )
      UPDATE integration_webhook_jobs j SET attempts = j.attempts + 1, ready_at = now() + interval '1 minute'
      FROM ready r, integration_webhooks h, integration_keys k
      WHERE (j.key_id, j.activity_id, j.version) = (r.key_id, r.activity_id, r.version)
        AND j.ready_at <= now() AND h.key_id = j.key_id AND k.id = j.key_id AND k.revoked_at IS NULL
      RETURNING j.key_id AS "keyId", j.activity_id AS "activityId", j.version, j.changed_at AS "changedAt", j.attempts,
                h.target_id AS "targetId", h.signing_secret AS "signingSecret", k.organization_id AS "organizationId", k.person_ref AS "personRef"
    `);
    return rows;
  }

  async finishWebhookJob(job: WebhookJob) {
    await this.pool?.query(
      'DELETE FROM integration_webhook_jobs WHERE key_id = $1 AND activity_id = $2 AND version = $3 AND attempts = $4',
      [job.keyId, job.activityId, job.version, job.attempts],
    );
  }

  async retryWebhookJob(job: WebhookJob) {
    const delay = Math.min(3600, 2 ** Math.min(job.attempts, 12));
    await this.pool?.query(
      `UPDATE integration_webhook_jobs SET ready_at = now() + ($5 * interval '1 second')
       WHERE key_id = $1 AND activity_id = $2 AND version = $3 AND attempts = $4`,
      [job.keyId, job.activityId, job.version, job.attempts, delay],
    );
  }

  static async connect(url: string, options: StoreOptions = {}): Promise<OrganizationStore> {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    const store = new OrganizationStore(pool, options.secrets ?? new SecretBox(undefined), options.envAdmins ?? []);
    const load = async <T extends AnyProvider>(set: ProviderSet<T>) => {
      for (const { data } of (await pool.query<{ data: unknown }>(`SELECT data FROM ${set.table}`)).rows) {
        const provider = set.schema.parse(data);
        set.stored.set(provider.id, provider);
      }
    };
    await load(store.providers);
    await load(store.signIns);
    for (const { data } of (await pool.query<{ data: unknown }>('SELECT data FROM organizations')).rows) {
      // Stored rows from before a field was added get its default.
      const org = Organization.parse(data);
      store.orgs.set(org.id, org);
    }
    store.storedAdmins = new Set((await pool.query<{ email: string }>('SELECT email FROM site_admins')).rows.map((r) => r.email));
    store.check();
    return store;
  }

  close(): Promise<void> {
    return this.pool?.end() ?? Promise.resolve();
  }

  /**
   * Adds a seed's providers, organizations and site admins. Each provider and organization replaces
   * any stored one with its id, except that a provider without a secret keeps the stored secret; nothing else is changed or removed. Throws, having written nothing, unless the
   * result hangs together.
   */
  async importSeed(seed: OrganizationSeed): Promise<void> {
    const providers = new Map(this.providers.stored);
    for (const p of seed.memberProviders) providers.set(p.id, this.providers.toStore(p));
    const signIns = new Map(this.signIns.stored);
    for (const p of seed.signInProviders) signIns.set(p.id, this.signIns.toStore(p));
    const orgs = new Map(this.orgs);
    for (const o of seed.organizations) orgs.set(o.id, o);
    const problem = problems(orgs, providers, signIns)[0];
    if (problem) throw new Error(`organizations: ${problem}`);
    await this.transaction(async (client) => {
      for (const p of seed.memberProviders) await client.query(this.providers.upsert, [p.id, providers.get(p.id)]);
      for (const p of seed.signInProviders) await client.query(this.signIns.upsert, [p.id, signIns.get(p.id)]);
      for (const o of seed.organizations) await client.query(UPSERT_ORGANIZATION, [o.id, o]);
      for (const e of seed.siteAdmins) await client.query('INSERT INTO site_admins (email) VALUES ($1) ON CONFLICT DO NOTHING', [e]);
    });
    for (const [id, p] of providers) this.providers.stored.set(id, p);
    for (const [id, p] of signIns) this.signIns.stored.set(id, p);
    for (const [id, o] of orgs) this.orgs.set(id, o);
    for (const e of seed.siteAdmins) this.storedAdmins.add(e);
  }

  get(id: string): Organization | undefined {
    return this.orgs.get(id);
  }

  all(): Organization[] {
    return [...this.orgs.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** The member providers, without their secrets. */
  memberProviders(): MemberProviderView[] {
    return this.providers.views() as MemberProviderView[];
  }

  /**
   * A member provider with its secret decrypted, for building its directory. `version` is the same
   * object until the provider is changed, so callers can keep what they build from it.
   */
  memberProvider(id: string): { config: MemberProviderConfig; version: object } | undefined {
    return this.providers.config(id);
  }

  /** The organizations that name each member provider as theirs. */
  providerUsers(): Record<string, string[]> {
    return this.usersOf(this.providers, 'memberProvider');
  }

  /** Site admins only. A cedar provider saved without a secret keeps the one it had. */
  saveProvider(input: unknown, email: string | undefined): Promise<SaveResult<MemberProviderView>> {
    return this.saveIn(this.providers, input, email) as Promise<SaveResult<MemberProviderView>>;
  }

  /** Site admins only; not while an organization uses it. */
  removeProvider(id: string, email: string | undefined): Promise<SaveResult<null>> {
    return this.removeFrom(this.providers, 'memberProvider', id, email);
  }

  /** The sign-in providers, without their secrets. */
  signInProviders(): SignInProviderView[] {
    return this.signIns.views() as SignInProviderView[];
  }

  /** A sign-in provider with its secret decrypted; `version` as for `memberProvider`. */
  signInProvider(id: string): { config: SignInProviderConfig; version: object } | undefined {
    return this.signIns.config(id);
  }

  /** The organizations that name each sign-in provider as theirs. */
  signInProviderUsers(): Record<string, string[]> {
    return this.usersOf(this.signIns, 'signInProvider');
  }

  /** Site admins only. Saved without a secret, it keeps the one it had. */
  saveSignInProvider(input: unknown, email: string | undefined): Promise<SaveResult<SignInProviderView>> {
    return this.saveIn(this.signIns, input, email) as Promise<SaveResult<SignInProviderView>>;
  }

  /** Site admins only; not while an organization uses it. */
  removeSignInProvider(id: string, email: string | undefined): Promise<SaveResult<null>> {
    return this.removeFrom(this.signIns, 'signInProvider', id, email);
  }

  private usersOf<T extends AnyProvider>(set: ProviderSet<T>, field: 'memberProvider' | 'signInProvider'): Record<string, string[]> {
    const used: Record<string, string[]> = Object.fromEntries([...set.stored.keys()].map((id) => [id, []]));
    for (const o of this.all()) {
      const id = o[field];
      if (id) (used[id] ??= []).push(o.id);
    }
    return used;
  }

  private async saveIn<T extends AnyProvider>(set: ProviderSet<T>, input: unknown, email: string | undefined): Promise<SaveResult<unknown>> {
    if (!this.isSiteAdmin(email)) return ONLY_SITE_ADMINS;
    const parsed = set.schema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error, set.what);
    let stored: T;
    try {
      stored = set.toStore(parsed.data);
    } catch (err) {
      return { ok: false, status: 400, error: (err as Error).message };
    }
    await this.pool?.query(set.upsert, [stored.id, stored]);
    set.stored.set(stored.id, stored);
    return { ok: true, saved: set.views().find((p) => p.id === stored.id)! };
  }

  private async removeFrom<T extends AnyProvider>(set: ProviderSet<T>, field: 'memberProvider' | 'signInProvider', id: string, email: string | undefined): Promise<SaveResult<null>> {
    if (!this.isSiteAdmin(email)) return ONLY_SITE_ADMINS;
    if (!set.stored.has(id)) return { ok: false, status: 404, error: `No such ${set.what}` };
    const users = this.usersOf(set, field)[id] ?? [];
    if (users.length) return { ok: false, status: 400, error: `${id} is in use by ${users.join(', ')}` };
    await this.pool?.query(`DELETE FROM ${set.table} WHERE id = $1`, [id]);
    set.stored.delete(id);
    return { ok: true, saved: null };
  }

  /** Runs `work` in a transaction; in memory, does nothing. */
  private async transaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The site an incoming request is for, by its Host header. */
  forHost(host: string | undefined): Organization | undefined {
    const name = hostnameOf(host);
    return this.all().find((o) => o.hostnames.includes(name));
  }

  /** The organization whose people use this email's domain. */
  forEmail(email: string): Organization | undefined {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    return this.all().find((o) => o.emailDomains.includes(domain));
  }

  /** The organization, then its parent, and so on up. */
  lineage(id: string): Organization[] {
    const line: Organization[] = [];
    for (let org = this.orgs.get(id); org && !line.includes(org); org = org.parentId ? this.orgs.get(org.parentId) : undefined) line.push(org);
    return line;
  }

  /** The member provider an organization uses: its own, or its nearest ancestor's. */
  providerOf(id: string): string | undefined {
    return this.lineage(id).find((o) => o.memberProvider)?.memberProvider ?? undefined;
  }

  /** The sign-in provider an organization's site uses: its own, or its nearest ancestor's. */
  signInProviderOf(id: string): string | undefined {
    return this.lineage(id).find((o) => o.signInProvider)?.signInProvider ?? undefined;
  }

  /**
   * An organization's partners: its own, then its ancestors', nearest first. Its own entry for a
   * partner (or the nearer ancestor's) decides what it may create for that partner.
   */
  partnersOf(id: string): OrganizationPartner[] {
    const found = new Map<string, OrganizationPartner>();
    for (const o of this.lineage(id)) for (const p of o.partners) if (p.id !== id && !found.has(p.id)) found.set(p.id, p);
    return [...found.values()];
  }

  /**
   * The units an organization operates with, and so may invite: everything else under its top-level organization (that
   * one included), then its partners, by short title.
   */
  operationalUnitsOf(id: string): Organization[] {
    const root = this.lineage(id).at(-1);
    const tree = this.all().filter((o) => o.id !== id && !!root && this.lineage(o.id).includes(root));
    const partners = this.partnersOf(id).flatMap((p) => this.orgs.get(p.id) ?? []);
    const found = new Map([...tree, ...partners].filter((o) => o.id !== id).map((o) => [o.id, o]));
    return [...found.values()].sort((a, b) => a.shortTitle.localeCompare(b.shortTitle));
  }

  /** The owners whose activities an organization sees without being on them: itself and those above it, and their partners. */
  ownersSeenBy(id: string): string[] {
    return [...this.lineage(id).map((o) => o.id), ...this.partnersOf(id).map((p) => p.id)];
  }

  /**
   * Whether a site sees an activity, a mission or any other: one it's on, or one owned by it, an
   * organization above it, or a partner of either.
   */
  readonly seesActivity: SeesActivity = (siteId, activity) => activity.unitIds.includes(siteId) || this.ownersSeenBy(siteId).includes(activity.ownerOrgId);

  brandOf(id: string): Brand {
    return this.lineage(id).find((o) => o.brand)?.brand ?? DEFAULT_BRAND;
  }

  /** What `/api/bootstrap` gives a site's clients. */
  siteConfig(org: Organization, options: { devSignIn: boolean; googleSignIn?: boolean; buildId: string }): SiteConfig {
    const unit = (o: Organization, can: { canCreateMissions: boolean; canCreateEvents: boolean }): SiteUnit => ({
      id: o.id,
      title: o.title,
      shortTitle: o.shortTitle,
      canCreateMissions: can.canCreateMissions,
      canCreateEvents: can.canCreateEvents,
    });
    const partners = this.partnersOf(org.id).flatMap((p) => {
      const partner = this.orgs.get(p.id);
      return partner ? [unit(partner, p)] : [];
    });
    const brand = this.brandOf(org.id);
    return {
      organization: { ...unit(org, org), partners },
      operational: this.operationalUnitsOf(org.id).map((o) => ({ id: o.id, title: o.title, shortTitle: o.shortTitle, seesOwners: this.ownersSeenBy(o.id) })),
      theme: { primary: brand.primary, primaryDark: brand.primaryDark },
      devSignIn: options.devSignIn,
      googleSignIn: options.googleSignIn ?? false,
      buildId: options.buildId,
    };
  }

  isSiteAdmin(email: string | undefined): boolean {
    const e = email?.toLowerCase();
    return !!e && (this.envAdmins.has(e) || this.storedAdmins.has(e));
  }

  /** Site admins may edit every organization; an organization's admins, it and those under it. */
  canEdit(email: string | undefined, id: string): boolean {
    const e = email?.toLowerCase();
    return !!e && (this.isSiteAdmin(e) || this.lineage(id).some((o) => o.admins.includes(e)));
  }

  editableBy(email: string | undefined): Organization[] {
    return this.all().filter((o) => this.canEdit(email, o.id));
  }

  isAdmin(email: string | undefined): boolean {
    return this.editableBy(email).length > 0;
  }

  siteAdmins(): { fromEnvironment: string[]; stored: string[] } {
    return { fromEnvironment: [...this.envAdmins].sort(), stored: [...this.storedAdmins].sort() };
  }

  async setSiteAdmins(emails: string[]): Promise<void> {
    const next = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    await this.transaction(async (client) => {
      await client.query('DELETE FROM site_admins');
      for (const e of next) await client.query('INSERT INTO site_admins (email) VALUES ($1)', [e]);
    });
    this.storedAdmins = next;
  }

  /**
   * Adds or changes an organization for `email`. Site admins may change anything. An organization's
   * admins may change its settings (ORG_ADMIN_FIELDS), but not create organizations or move them.
   */
  async save(input: unknown, email: string | undefined): Promise<SaveResult> {
    const parsed = Organization.safeParse(input);
    if (!parsed.success) return invalid(parsed.error, 'organization');
    let org = parsed.data;
    const existing = this.orgs.get(org.id);
    // The admin page doesn't edit it.
    if (org.legacyId === undefined && existing?.legacyId !== undefined) org = { ...org, legacyId: existing.legacyId };
    if (!this.isSiteAdmin(email)) {
      if (!existing || !this.canEdit(email, org.id)) return ONLY_SITE_ADMINS;
      org = { ...existing, ...Object.fromEntries(ORG_ADMIN_FIELDS.map((f) => [f, org[f]])) };
    }
    const next = new Map(this.orgs).set(org.id, org);
    const problem = problems(next, this.providers.stored, this.signIns.stored)[0];
    if (problem) return { ok: false, status: 400, error: problem };
    await this.pool?.query(UPSERT_ORGANIZATION, [org.id, org]);
    this.orgs.set(org.id, org);
    return { ok: true, saved: org };
  }

  /** Site admins only; not while another organization is under it or partners with it. */
  async remove(id: string, email: string | undefined): Promise<SaveResult<null>> {
    if (!this.isSiteAdmin(email)) return ONLY_SITE_ADMINS;
    if (!this.orgs.has(id)) return { ok: false, status: 404, error: 'No such organization' };
    const next = new Map(this.orgs);
    next.delete(id);
    const problem = problems(next, this.providers.stored, this.signIns.stored)[0];
    if (problem) return { ok: false, status: 400, error: problem };
    await this.transaction(async (db) => {
      await db.query('DELETE FROM integration_webhooks WHERE key_id IN (SELECT id FROM integration_keys WHERE organization_id = $1)', [id]);
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    });
    this.orgs.delete(id);
    return { ok: true, saved: null };
  }

  /** Startup: what was loaded must hang together. */
  private check(): void {
    const problem = problems(this.orgs, this.providers.stored, this.signIns.stored)[0];
    if (problem) throw new Error(`organizations: ${problem}`);
  }
}

function withoutSecret<T extends { clientSecret?: string }>(p: T): Omit<T, 'clientSecret'> {
  const { clientSecret: _, ...rest } = p;
  return rest;
}

function invalid(error: { issues: { path: PropertyKey[]; message: string }[] }, what: string): { ok: false; status: 400; error: string } {
  const issue = error.issues[0];
  return { ok: false, status: 400, error: issue ? `${issue.path.join('.') || what}: ${issue.message}` : `Invalid ${what}` };
}

/** What's wrong with a set of organizations as a whole: unknown references, cycles, shared hostnames. */
export function problems(orgs: Map<string, Organization>, providers: ReadonlyMap<string, unknown>, signIns: ReadonlyMap<string, unknown> = new Map()): string[] {
  const found: string[] = [];
  const claimed = (what: string, pick: (o: Organization) => string[]) => {
    const owner = new Map<string, string>();
    for (const o of orgs.values()) {
      for (const name of pick(o)) {
        const other = owner.get(name);
        if (other && other !== o.id) found.push(`${what} ${name} belongs to both ${other} and ${o.id}`);
        owner.set(name, o.id);
      }
    }
  };
  claimed('hostname', (o) => o.hostnames);
  claimed('email domain', (o) => o.emailDomains);
  for (const o of orgs.values()) {
    if (o.parentId && !orgs.has(o.parentId)) found.push(`${o.id}'s parent ${o.parentId} doesn't exist`);
    if (o.memberProvider && !providers.has(o.memberProvider)) found.push(`${o.id}'s member provider ${o.memberProvider} doesn't exist`);
    if (o.signInProvider && !signIns.has(o.signInProvider)) found.push(`${o.id}'s sign-in provider ${o.signInProvider} doesn't exist`);
    for (const p of o.partners) {
      if (p.id === o.id) found.push(`${o.id} can't partner with itself`);
      else if (!orgs.has(p.id)) found.push(`${o.id}'s partner ${p.id} doesn't exist`);
    }
    const seen = new Set<string>();
    for (let at: Organization | undefined = o; at?.parentId; at = orgs.get(at.parentId)) {
      if (seen.has(at.id)) {
        found.push(`${o.id} is its own ancestor`);
        break;
      }
      seen.add(at.id);
    }
  }
  return found;
}
