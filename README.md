# WhatsApp Business Platform

Multi-tenant WhatsApp Business messaging platform built on the Meta WhatsApp Cloud
API — the class of product occupied by Interakt, Wati, Respond.io and SleekFlow.

Built as a **modular monolith** with explicit seams for a later service split.
Design reasoning, including rejected alternatives, lives in

---

## Status

**Phase 1** — foundation, core kernel, multi-tenancy primitives.
**Phase 2** — authentication, wallets and funding accounts.
**Phase 3** — payment provider integration, funding webhooks, money movement.
**Phase 4** — Meta WhatsApp Cloud API: inbound webhook, sending, conversations.

**Phase 5** _(in progress)_ — RBAC and the admin panel are delivered; number
onboarding, template sync and the messaging API remain.
**Phase 6** — contacts and the queue backbone.

Scope and sequencing reasoning is in [Roadmap](#roadmap).

| Delivered         |                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------- |
| Configuration     | Fail-fast env validation, typed config tree, production guardrails                      |
| Request context   | `AsyncLocalStorage` propagation of tenant, user, request/correlation id                 |
| Tenancy           | Prisma extension enforcing isolation on every query; header/subdomain resolution        |
| Errors            | Stable `ErrorCode` catalogue, single `AppException`, pluggable translators              |
| Customer auth     | Phone (E.164) + PIN, Argon2id, lockout, weak-PIN rejection, enumeration resistance      |
| Admin auth        | Email + password, separate credential path and route guard                              |
| Sessions          | Access/refresh split secrets, rotation, family revocation on reuse detection            |
| Wallets           | One ₦ wallet per customer, integer kobo, append-only double-entry ledger                |
| Money movement    | `SELECT … FOR UPDATE` locking, three-layer idempotency, overdraft protection            |
| Payments          | Provider abstraction + Paystack adapter, virtual account provisioning                   |
| Webhooks          | HMAC-SHA512 verification over raw bytes, event store, dedupe, replay                    |
| WhatsApp inbound  | Meta handshake, HMAC-SHA256 over raw bytes, per-item failure isolation, `wamid` dedupe  |
| WhatsApp outbound | Text and template sends, 24h service window enforced pre-flight, client idempotency     |
| Conversations     | Thread per (business number, contact), delivery-status tracking, encrypted tokens       |
| RBAC              | Compile-time permission catalogue, deny-wins resolution, wildcards, escalation guards   |
| Admin panel       | Dashboard, workspace, members, roles, teams, invitations, API keys, sessions, customers |
| Audit trail       | Append-only, field-level diffs, key-fragment redaction, non-blocking writes             |
| Caching           | Redis client, key namespacing, fail-open cache, distributed locks                       |
| Observability     | Pino structured logs with redaction, Prometheus metrics, OpenTelemetry                  |
| HTTP              | Response envelope, validation, versioning, timeouts, security headers                   |
| Health            | Separate liveness / readiness / detail probes                                           |
| DevOps            | Multi-stage Dockerfile, Compose stack, nginx, GitHub Actions                            |
| Tests             | 355 unit + 95 e2e, all green                                                            |

Not yet built: outbound transfers/withdrawals, contacts, campaigns, automation,
AI, queues and realtime.

> **Phase 4 is complete but dormant.** `WhatsAppPhoneNumber` and
> `MessageTemplate` are read-only across the codebase — nothing writes either
> table yet, so in a real deployment `resolveNumber()` always raises
> `WHATSAPP_NUMBER_NOT_REGISTERED`, `sendTemplate()` cannot find a template, and
> every verified inbound webhook resolves to `unroutable`. The suites pass
> because they seed those rows directly. Phase 5 closes this.

### Funding flow

```
customer transfers to their NUBAN
        │
        ▼
provider POSTs /api/v1/webhooks/paystack
        │  HMAC-SHA512 over the RAW bytes — verified before parsing
        ▼
webhook_events row written (dedupe on provider event id)
        │
        ▼
destination account → userId + tenantId   (unscoped lookup, system context)
        │
        ▼
WalletService.credit()  ── SELECT … FOR UPDATE on the wallet row
        │                   ledger entry + balance update, one transaction
        ▼
balance updated, statement entry visible
```

Every step is idempotent. A redelivered webhook resolves to the existing ledger
entry and changes nothing. A _failure_ returns non-2xx on purpose — the provider's
retry is the recovery mechanism, and returning 200 on failure would strand the
customer's money.

### Inbound message flow

```
customer sends a WhatsApp message
        │
        ▼
Meta POSTs /api/v1/webhooks/whatsapp
        │  HMAC-SHA256 over the RAW bytes — verified before parsing
        ▼
phone_number_id → our registered number → tenantId   (unscoped, system context)
        │
        ▼
message stored, keyed on wamid   (@@unique([tenantId, wamid]) — redelivery is a no-op)
        │
        ▼
conversation.lastInboundAt bumped → the 24-hour service window reopens
```

Meta redelivers the **entire batch** on any non-2xx, so a single malformed
message is logged and counted rather than failing the request — otherwise the
messages that already stored would be resent, and repeated failures make Meta
disable the subscription outright.

### The 24-hour service window

Free-form messages are permitted only within 24 hours of the customer's last
inbound message; outside it, only an approved template may be sent. This is
checked **before** calling Meta, not by reacting to their rejection: a refused
send still costs a round trip and counts against rate limits, and repeated policy
violations degrade the number's quality rating, throttling throughput for every
customer on it.

### Permissions

Permission slugs are a **compile-time catalogue** in `src/core/authorization`,
not database rows. They change only when code changes, and a static list makes
`@RequirePermissions('members:writ')` a build error rather than a route nobody
can reach. The database stores only which slugs a role grants.

```
role.permissions  ─┐
membership.extra  ─┼─→ resolve ─→ effective grant ─→ guard decision
membership.denied ─┘                                  (denials always win)
```

Three rules carry most of the weight:

- **Denials beat everything**, including `*`. Otherwise "an administrator who
  must not move money" requires cloning a role, and clones drift.
- **Wildcards expand at check time**, never at save time. A permission added in
  a later release is covered by an existing `*` instead of silently escaping it.
- **You cannot grant what you do not hold.** Without that check, `roles:write`
  is equivalent to `*` — write `wallets:adjust` into a role, assign it to
  yourself. The same rule guards invitations and API keys.

> **Roles are not seeded yet.** `AccessService.seedSystemRoles` creates
> `owner`/`admin`/`agent`/`analyst` for a workspace, but nothing calls it —
> there is no tenant provisioning path in the codebase at all (tenants are
> created out of band today, and there is no signup flow). Until one exists, a
> brand-new workspace has no roles, so no membership can reference one, and
> every guarded admin route answers `ROLE_REQUIRED`. Seeding must be wired into
> whatever creates a tenant; the same call is safe to run against an existing
> workspace, since it skips duplicates.

The panel is scoped to the caller's own workspace. There is deliberately no
`:tenantId` parameter anywhere in it: a platform-operator console spanning
tenants needs `runAsSystem` to bypass the Prisma tenant extension, and putting
that route here would make one missing guard the difference between a workspace
administrator and a platform administrator.

### Money representation

All amounts are **integer kobo** (`BigInt`), never floats. `₦1,500.50` is `150050`.
The `Money` value object in `src/core/money` is the only sanctioned way to construct
or combine an amount, and money crosses the wire as a string — never a JS number.

## Roadmap

### Phase 5 — onboarding, management API, RBAC

Makes phase 4 reachable. Today the WhatsApp module has no HTTP surface except
Meta's webhook, and no way to register the rows every code path reads from.

| Deliverable         |                                                                                         |     |
| ------------------- | --------------------------------------------------------------------------------------- | --- |
| RBAC enforcement    | Permission catalogue, role→permission resolution, guard on every tenant-facing route    | ✅  |
| Admin panel         | Dashboard, workspace, members, roles, teams, invitations, API keys, sessions, customers | ✅  |
| Audit trail         | Append-only writes behind every mutation, plus the read API the panel filters on        | ✅  |
| Number registration | Register `phone_number_id` + WABA id, verify against Meta, encrypt the access token     |     |
| Number lifecycle    | Connection status transitions, default-number selection, disconnect                     |     |
| Template sync       | Pull templates from the Graph API; persist name, language, variable count, status       |     |
| Messaging API       | Send text and template, quote a message, client idempotency key                         |     |
| Conversation API    | List threads, fetch a thread with cursor pagination, unread and window state            |     |

The delivered half needed **no migration** — `Role`, `Membership`, `Team`,
`TeamMember`, `Invitation`, `ApiKey` and `AuditLog` were already in the schema
and had zero references in `src/`. Phase 5 wired up what phase 1 had modelled.

Templates are **synced, not authored** — Meta owns approval, so the local row is
a cache of their decision. `bodyVariableCount` must be derived from the body
text during sync, or `sendTemplate`'s parameter-mismatch check
(`messaging.service.ts:138`) validates against a number nobody set.

RBAC landed first because it is the floor the rest of the phase stands on.
Registering an access token and sending on a customer's behalf are precisely the
operations that need permission checks, and retrofitting guards across a
finished controller set is strictly worse than writing them alongside — the
remaining routes get `@RequirePermissions` from their first commit.

### Phase 6 — contacts and the queue backbone

| Deliverable       |                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- |
| Contacts          | New `Contact` model, phone identity, attributes, tags, import                       |
| Conversation link | Attach threads to contacts, backfilling from `contactPhoneE164`                     |
| Queue backbone    | BullMQ workers, retry and backoff policy, dead-letter handling, queue depth metrics |
| Async send path   | Move outbound sends behind a queue so throughput survives Meta's rate limits        |

Contacts are a **schema addition**, not a wiring job: `Conversation` currently
keys on `contactPhoneE164` directly, with no contact entity behind it.

Both land before campaigns because a campaign is a contact segment plus a bulk
send, and a bulk send that runs in the request path will hit
`WHATSAPP_RATE_LIMITED` and lose the remainder of the batch. Redis already runs
with `maxmemory-policy noeviction` for exactly this reason.

**Phase 7+**, unscoped: campaigns, automation, AI, realtime, outbound
transfers/withdrawals.

---

## Quick start

```bash
# 1. Configuration
cp .env.example .env
# Generate real secrets — the app refuses to start in staging/production with placeholders.
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)" >> .env
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)" >> .env

# 2. Infrastructure
docker compose up -d

# 3. Dependencies and database
npm ci
npx prisma generate
npx prisma migrate dev

# 4. Run
npm run start:dev
```

| URL                             |                                  |
| ------------------------------- | -------------------------------- |
| `http://localhost:3000/api/v1`  | API root                         |
| `http://localhost:3000/docs`    | Swagger UI (non-production only) |
| `http://localhost:3000/health`  | Health detail                    |
| `http://localhost:3000/metrics` | Prometheus metrics               |

---

## Commands

```bash
npm run start:dev        # watch mode
npm run build            # compile to dist/
npm run start:prod       # run the compiled output

npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run format           # Prettier write

npm test                 # unit tests
npm run test:cov         # unit tests with coverage
npm run test:e2e         # end-to-end tests

npx prisma migrate dev   # create and apply a migration
npx prisma studio        # browse the database
```

---

## Layout

```
src/
├── config/            Env validation and the typed config tree
├── core/              Framework-agnostic kernel — imports nothing below it
│   ├── authorization/ Permission catalogue and grant resolution
│   ├── constants/     Header names and shared literals
│   ├── context/       AsyncLocalStorage request context
│   ├── decorators/    @SkipResponseEnvelope, @RequestTimeout
│   ├── dto/           Response envelope, pagination
│   ├── errors/        ErrorCode catalogue, AppException, translator registry
│   ├── filters/       Global exception filter
│   ├── interceptors/  Envelope, timeout
│   ├── money/         Integer-kobo value object
│   └── utils/         Cursor codec, E.164 phone normalisation
├── infrastructure/    Adapters to the outside world
│   ├── cache/         Redis client, key namespacing, cache service
│   ├── database/      Prisma service, tenancy + soft-delete extensions
│   └── observability/ Logging, metrics, tracing
├── modules/           Feature modules
│   ├── admin/         Back-office panel, one folder per screen
│   ├── auth/          Customer and admin authentication, sessions
│   ├── payments/      Provider abstraction, Paystack adapter, funding webhooks
│   ├── tenancy/       Tenant resolution from header or subdomain
│   ├── wallet/        Balances, double-entry ledger, money movement
│   └── whatsapp/      Cloud API client, inbound webhook, sending, conversations
├── bootstrap/         App configuration shared by main.ts and e2e tests
└── main.ts

prisma/schema.prisma   Data model
test/                  End-to-end suites
docker/nginx/          Reverse proxy configuration
docs/ARCHITECTURE.md   Decisions and trade-offs
```

Dependency direction is enforced by convention and reviewed in PRs:
`core ← infrastructure ← modules`. `core` never imports the others.

---

## API conventions

Every response uses the same envelope:

```jsonc
// Success
{ "success": true, "data": { }, "meta": { }, "requestId": "…", "timestamp": "…" }

// Failure
{
  "success": false,
  "error": { "code": "RESOURCE_NOT_FOUND", "message": "…", "details": { }, "retryable": false },
  "requestId": "…",
  "timestamp": "…"
}
```

- **Branch on `error.code`**, never on the HTTP status or the message text. Codes
  are append-only; messages may be reworded at any time.
- `retryable` says whether replaying the identical request may succeed.
- List endpoints use cursor pagination — pass `meta.nextCursor` back as `cursor`.
- Mutating endpoints accept an `Idempotency-Key` header.
- Quote `requestId` in a support ticket; it maps to the server trace.

---

## Notes for operators

- `/metrics` and `/docs` must not be publicly reachable. The supplied nginx
  configuration restricts both to private networks.
- `TRUST_PROXY_HOPS` must match the number of proxies in front of the app.
  Setting it too high lets clients forge `X-Forwarded-For` and evade rate limits;
  too low and every client appears to share the proxy's IP.
- Total database connections are `DB_POOL_SIZE × processes`. Keep the product
  below Postgres' `max_connections`, or add PgBouncer in transaction mode.
- Redis runs with `maxmemory-policy noeviction` on purpose: queue state lives
  there, and silently evicting a key would lose queued messages.
- `SHUTDOWN_TIMEOUT_MS` must be lower than the orchestrator's termination grace
  period, or pods are killed mid-drain.
- `META_APP_SECRET` is the WhatsApp webhook's only authentication. Rotating it in
  the Meta dashboard without updating the app makes every delivery fail
  signature verification, and Meta disables the subscription after repeated
  failures. Deploy the new value first, then rotate.
- WhatsApp access tokens are encrypted at rest with `ENCRYPTION_KEY`. Changing
  that key without re-encrypting makes every registered number unable to send.

---

## Local Docker permissions

If `docker compose up` reports a permission error on `/var/run/docker.sock`, add
yourself to the `docker` group once:

```bash
sudo usermod -aG docker "$USER"   # then log out and back in
```
