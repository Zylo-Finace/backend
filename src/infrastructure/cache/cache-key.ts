/**
 * Redis key construction.
 *
 * Every key is built here so that:
 *  - the environment prefix is always applied (one Redis can host dev + CI safely);
 *  - tenant-owned keys always embed the tenant id, making a cross-tenant cache hit
 *    impossible even if a caller passes the wrong argument;
 *  - key layout is greppable in one place when we need to reason about memory.
 *
 * Convention: `<prefix>:<namespace>:<tenantId>:<...parts>`
 */
export const enum CacheNamespace {
  Tenant = 'tenant',
  User = 'user',
  Session = 'session',
  ApiKey = 'apikey',
  Permissions = 'perms',
  RateLimit = 'rl',
  Idempotency = 'idem',
  Lock = 'lock',
  Template = 'tmpl',
  Conversation = 'conv',
  Contact = 'contact',
  WhatsAppToken = 'watoken',
  /** Payout provider reference data — the supported bank list. */
  Bank = 'bank',
  /** Bill-payment reference data — catalogues and the upstream float balance. */
  Bill = 'bill',
}

export class CacheKey {
  constructor(private readonly prefix: string) {}

  /** Platform-scoped key — no tenant component. Use sparingly. */
  global(namespace: CacheNamespace, ...parts: (string | number)[]): string {
    return [this.prefix, namespace, ...parts.map(String)].join(':');
  }

  /** Tenant-scoped key. The tenant id is structurally part of the key. */
  tenant(tenantId: string, namespace: CacheNamespace, ...parts: (string | number)[]): string {
    return [this.prefix, namespace, tenantId, ...parts.map(String)].join(':');
  }

  /**
   * Pattern for bulk invalidation.
   *
   * Callers must use `SCAN`, never `KEYS` — `KEYS` is O(n) over the entire keyspace
   * and blocks the single-threaded Redis server, stalling every other tenant.
   */
  tenantPattern(tenantId: string, namespace: CacheNamespace): string {
    return `${this.prefix}:${namespace}:${tenantId}:*`;
  }
}
