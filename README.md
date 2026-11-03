# BANJEE — Backend API + WhatsApp Bot

The NestJS service that powers **BANJEE** (product codename: **Zylo**) — a Stellar-first USDC ↔ Naira wallet accessible on web and WhatsApp. This repo is the server of record: it owns custody orchestration, rates, KYC, PIN policy, bills routing, payouts, and the WhatsApp conversational finance bot.

> Live: **https://www.usebanjee.com** · API: `https://zylo-production.up.railway.app/api/v1`
> **Full product + architecture doc (spans all three repos): [`PRODUCT.md`](PRODUCT.md)**
> Sister repos: [`Zylo-Finace/frontend`](https://github.com/Zylo-Finace/frontend) · [`Zylo-Finace/contract`](https://github.com/Zylo-Finace/contract)

---

## What BANJEE does

BANJEE is a consumer wallet for Nigerian users. One account, one PIN, two channels (web + WhatsApp), one set of limits and rates. Users can:

- Receive and spend **USDC on Stellar** using per-user on-chain deposit addresses (classic `G…` accounts today; Soroban `C…` wallets opt-in via the sister `contract` repo).
- Fund in **Naira** via a dedicated NUBAN virtual account and convert to USDC at a rate locked at review.
- Sell USDC back to Naira and pay out to any Nigerian bank.
- Pay bills — airtime, data, electricity, TV — straight from a Naira or USDC balance.
- Chat with a WhatsApp bot that understands intents like "send 50 usdc to +234…", "sell 20 usdc", "buy 2k data for mtn 0803…", gated by the same PIN as the web app.

This backend is the system of record and the brain. The web frontend has no chain, payments-provider, or custody keys — everything flows through here.

### Where this repo fits

```
 ┌──────────────┐        ┌────────────────────┐        ┌───────────────────┐
 │ Web frontend │ ─HTTP► │  Backend API       │ ─SDK─► │ Stellar network   │
 │              │        │  (this repo)       │        │ classic + Soroban │
 └──────────────┘        │  + WhatsApp bot    │        └───────────────────┘
                         │  + NGN rails       │ ─────► FalconPay / PayVessel / PulseMFB
 ┌──────────────┐        │                    │ ─────► Paystack (legacy)
 │  WhatsApp    │ ─HTTP► │                    │ ─────► SMEPlug / ClubKonnect (bills)
 │  (Meta API)  │        │                    │
 └──────────────┘        └────────────────────┘
                                    │
                                    ├── Postgres (system of record)
                                    └── Redis   (cache, queues, locks)
```

---

## Feature surface

| Area | Capability |
|------|------------|
| **Custody** | Stellar classic (`G…`) accounts via `stellar-sdk`, deposit watchers with cursor recovery, trustline ensure, idempotent vault spends. Optional Soroban (`C…`) via sister repo. |
| **On-ramp** | NGN → virtual NUBAN → auto-credit; provider adapters for FalconPay, PayVessel, PulseMFB, Paystack. |
| **Off-ramp** | USDC → NGN payout to any Nigerian bank; server quote + rate lock + PIN + idempotency. |
| **P2P transfers** | USDC on Stellar to `G…` address or BANJEE username. |
| **Bills** | Airtime, data, electricity, TV via SMEPlug / ClubKonnect / PulseMFB with fallback routing and auto-refund on terminal provider failure. |
| **KYC** | Tiered caps (Bronze → Legend), PayVessel provider, admin queue, matching heuristics. |
| **Auth** | Phone + PIN (Argon2id, lockout, weak-PIN reject), access/refresh split, session family revocation on reuse detection. |
| **WhatsApp bot** | Meta Cloud API webhook, intent parser, Flow-based PIN, 24h service-window enforcement, `wamid` dedupe, template sync. |
| **Admin panel** | Dashboard, members, roles, teams, invitations, API keys, sessions, customers, audit trail — RBAC with deny-wins resolution. |
| **Observability** | Pino NDJSON with redaction, Prometheus metrics, OpenTelemetry traces; `requestId` as the join key. |
| **Multi-tenant** | Row-level `tenantId` enforced by a Prisma client extension (fails closed, rejects cross-tenant queries). |

---

## Architecture

**Modular monolith**, deployed as one process, structured so any feature module can be lifted into its own service without touching the others.

```
core  ←  infrastructure  ←  modules
```

- `core` is framework glue and domain primitives: errors, context, pagination, DTO envelope, `Money`. Imports nothing from below.
- `infrastructure` implements ports (Prisma, Redis, observability, security). Imports `core` only.
- `modules` are features. They may import `core` + `infrastructure` but **never another module's internals** — cross-module communication is through published service interfaces or domain events.

The layering is the escape hatch: if a module later outgrows the monolith, the queue-based seams (BullMQ over Redis) mean moving it to another process is a deployment change, not a redesign.

Full decision log with rejected alternatives: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Multi-tenancy

Shared database, shared schema, row-level `tenantId`. Isolation is enforced by a Prisma client extension (`src/infrastructure/database/extensions/tenant-scope.extension.ts`) that:

- derives the tenant-scoped model set from DMMF, so a new model added later is protected the moment it declares `tenantId`;
- injects the tenant into every read `where` and every write payload;
- **rejects** a query that names a different tenant rather than silently rewriting it;
- refuses to run when no tenant is in context (fails closed).

Known gaps, documented rather than hidden: `$queryRaw` bypasses the extension, nested creates must pass `tenantId` explicitly, Postgres RLS is the planned second layer.

### Money representation

All amounts are **integer kobo** (`BigInt`), never floats. `₦1,500.50` is `150050`. The `Money` value object in `src/core/money` is the only sanctioned way to construct or combine an amount, and money crosses the wire as a string, never a JS number.

---

## Flows (worth reading before changing anything)

### Naira funding flow

```
customer transfers to their NUBAN
        │
        ▼
provider POSTs /api/v1/webhooks/{paystack|falconpay|payvessel|pulsemfb}
        │  HMAC verified over the RAW bytes before parsing
        ▼
webhook_events row written (dedupe on provider event id)
        │
        ▼
destination account → userId + tenantId  (unscoped lookup, system context)
        │
        ▼
WalletService.credit()  ── SELECT … FOR UPDATE on the wallet row
        │                   ledger entry + balance update in one transaction
        ▼
balance updated, statement entry visible, WhatsApp/web notified
```

Every step is idempotent. A redelivered webhook resolves to the existing ledger entry and changes nothing. A *failure* returns non-2xx on purpose — the provider's retry is the recovery mechanism; returning 200 on failure would strand the customer's money.

### USDC deposit flow (Stellar classic)

```
customer sends USDC to their Stellar G… deposit address
        │
        ▼
ramp.stellar-watcher polls Horizon (cursor persisted in DB)
        │
        ▼
tx_notify_dedupe on (ledger, tx hash, op index)
        │
        ▼
credit USDC balance; emit deposit event; notify via WhatsApp + web socket
```

### Sell USDC → NGN

```
user opens Sell screen  →  server quote (rate + fee locked)
                       │
                       ▼
user enters PIN  →  POST /ramp-portal/sells (Idempotency-Key)
                       │
                       ▼
debit USDC (SELECT…FOR UPDATE)  →  credit NGN  →  payout to bank
                       │
                       ▼
poll payout provider; on terminal failure, auto-refund USDC
```

### WhatsApp inbound flow

```
customer sends a WhatsApp message
        │
        ▼
Meta POSTs /api/v1/webhooks/whatsapp
        │  HMAC-SHA256 over the RAW bytes — verified before parsing
        ▼
phone_number_id → registered number → tenantId  (unscoped, system context)
        │
        ▼
message stored, keyed on wamid  (@@unique([tenantId, wamid]) — redelivery is a no-op)
        │
        ▼
conversation.lastInboundAt bumped → 24h service window reopens
        │
        ▼
intent parser routes to ramp commands (send, sell, buy, bills, balance, …)
```

Meta redelivers the **entire batch** on any non-2xx, so a single malformed message is logged and counted rather than failing the request — otherwise the messages that already stored would be resent, and repeated failures make Meta disable the subscription outright.

### 24-hour service window

Free-form messages are permitted only within 24 hours of the customer's last inbound message; outside it, only an approved template may be sent. This is checked **before** calling Meta, not by reacting to their rejection: a refused send still costs a round trip, counts against rate limits, and repeated policy violations degrade the number's quality rating and throttle throughput for every customer on it.

### Permissions (RBAC)

Permission slugs are a **compile-time catalogue** in `src/core/authorization`, not database rows. They change only when code changes, and a static list makes `@RequirePermissions('members:writ')` a build error rather than a route nobody can reach.

```
role.permissions  ─┐
membership.extra  ─┼─→ resolve ─→ effective grant ─→ guard decision
membership.denied ─┘                                  (denials always win)
```

Three rules carry most of the weight:

- **Denials beat everything**, including `*`. Otherwise "an administrator who must not move money" needs a cloned role, and clones drift.
- **Wildcards expand at check time**, never at save time. A permission added in a later release is covered by an existing `*` instead of silently escaping it.
- **You cannot grant what you do not hold.** Without that, `roles:write` is equivalent to `*` — write `wallets:adjust` into a role, assign it to yourself. The same rule guards invitations and API keys.

The panel is scoped to the caller's own workspace. A platform-operator console spanning tenants needs `runAsSystem` to bypass the Prisma tenant extension and is deliberately not exposed here.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node ≥ 22 |
| Framework | NestJS 11 |
| DB | PostgreSQL via Prisma |
| Cache / queues / locks | Redis |
| Auth | JWT (access + refresh), Argon2id PINs, encrypted session store |
| Chain | `stellar-sdk` (classic), `@stellar/stellar-sdk-contract` (Soroban) |
| Messaging | Meta WhatsApp Cloud API |
| Payments / payouts | FalconPay, PayVessel, PulseMFB, Paystack (legacy) |
| Bills | SMEPlug, ClubKonnect, PulseMFB VAS |
| KYC | PayVessel |
| Observability | Pino + Prometheus + OpenTelemetry |
| HTTP | Response envelope, Zod validation, URI versioning, security headers |
| Dev | ESLint 9, Prettier, Husky + lint-staged, commitlint |
| Deploy | Docker multi-stage, Railway (Nginx reverse proxy for ops endpoints) |

---

## Prerequisites

- Node ≥ 22
- Docker + Docker Compose (for Postgres + Redis)
- A WhatsApp Business account + Meta app + `META_APP_SECRET` (for live WhatsApp flows — optional for local dev)

---

## Quick start

```bash
# 1. Configuration
cp .env.example .env
# Generate real secrets — the app refuses to start in staging/production with placeholders.
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"   >> .env
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"  >> .env
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)" >> .env

# 2. Infrastructure (Postgres + Redis)
docker compose up -d

# 3. Dependencies + database
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

### Scripts

```bash
npm run start:dev        # watch mode
npm run build            # compile to dist/
npm run start:prod       # run the compiled output

npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run format           # Prettier write

npm test                 # unit tests (Jest)
npm run test:cov         # unit tests + coverage
npm run test:e2e         # end-to-end suite

npx prisma migrate dev   # create + apply a migration
npx prisma studio        # browse the database
```

---

## Project layout

```
src/
├── config/            Env validation (fail-fast) and the typed config tree
├── core/              Framework-agnostic kernel — imports nothing below it
│   ├── authorization/ Permission catalogue + grant resolution
│   ├── constants/     Header names + shared literals
│   ├── context/       AsyncLocalStorage request context
│   ├── decorators/    @SkipResponseEnvelope, @RequestTimeout, @Public
│   ├── dto/           Response envelope, pagination
│   ├── errors/        ErrorCode catalogue, AppException, translator registry
│   ├── filters/       Global exception filter
│   ├── interceptors/  Envelope + timeout
│   ├── money/         Integer-kobo value object
│   └── utils/         Cursor codec, E.164 phone normalisation
│
├── infrastructure/    Adapters to the outside world
│   ├── cache/         Redis client, key namespacing, cache service, distributed locks
│   ├── database/      Prisma service, tenancy + soft-delete extensions, exception translator
│   ├── observability/ Pino logger, Prometheus metrics, OpenTelemetry tracing
│   └── security/      Crypto + hashing services
│
├── modules/           Feature modules
│   ├── admin/         Back-office — dashboard, workspace, members, roles, teams, invitations, API keys, sessions, customers, audit
│   ├── auth/          Customer + admin auth, tokens, guards
│   ├── bills/         Airtime / data / electricity / TV — SMEPlug, ClubKonnect, PulseMFB-VAS, FalconPay-bills, routed fallback
│   ├── health/        liveness / readiness / detail probes
│   ├── kyc/           Tiers, matching, PayVessel adapter, admin queue
│   ├── payments/      Provider abstraction, funding, payouts — FalconPay, PayVessel, PulseMFB, Paystack
│   ├── profile/       User profile
│   ├── ramp/          The money-movement core: Stellar wallets + watchers, portal controller, rates, bills, bank sends, receipts, statements, Celo (opt-in), WhatsApp integration
│   ├── rewards/       Referrals + reward rules
│   ├── tenancy/       Tenant resolution (header / subdomain)
│   ├── wallet/        Balances + double-entry ledger
│   └── whatsapp/      Cloud API client, inbound webhook, send service, template sync, conversations
│
├── bootstrap/         App configuration shared by main.ts and e2e tests
├── app.module.ts
└── main.ts
```

Supporting:

```
prisma/schema.prisma   Data model + 20+ migrations
test/                  End-to-end suites (auth, http pipeline, webhook, whatsapp, admin, probe)
flows/                 WhatsApp Meta Flow JSON (onboard, PIN confirm)
docker/nginx/          Reverse-proxy config (restricts /metrics + /docs to private networks)
docs/ARCHITECTURE.md   Decisions and trade-offs
scripts/               Deploy helpers (Railway start script)
```

### Module map — where to look for what

| You want to change… | Start in |
|---------------------|----------|
| How a Naira deposit lands | `src/modules/payments/*-webhook.controller.ts` → `funding.service.ts` → `wallet/wallet.service.ts` |
| How a USDC send is signed | `src/modules/ramp/ramp.stellar-wallet.ts`, `ramp.stellar-classic.ts` |
| USDC deposit detection | `src/modules/ramp/ramp.stellar-watcher.ts` (+ `ramp.celo-watcher.ts` for Celo opt-in) |
| Sell USDC → NGN pipeline | `src/modules/ramp/ramp-portal.service.ts` + `payments/payout.service.ts` |
| A new bills provider | `src/modules/bills/<provider>.provider.ts` + `routed-bills.provider.ts` for fallback |
| WhatsApp intent parsing | `src/modules/ramp/ramp.intent.ts`, `ramp.commands.ts`, `ramp.bank-parse.ts` |
| Rate curves + spreads | `src/modules/ramp/ramp-rates.service.ts`, `ramp-rates.admin.controller.ts` |
| KYC tier limits | `src/modules/kyc/kyc.tiers.ts` |
| A new permission | `src/core/authorization/permission.enum.ts` (compile-time) |
| Admin RBAC enforcement | `src/modules/admin/access/*` |

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

- **Branch on `error.code`**, never on HTTP status or message text. Codes are append-only; messages may be reworded.
- `retryable` says whether replaying the identical request may succeed.
- List endpoints use cursor pagination — pass `meta.nextCursor` back as `cursor`.
- Mutating endpoints accept an `Idempotency-Key` header. Three-layer idempotency: request key, provider dedupe, ledger uniqueness.
- Quote `requestId` in a support ticket; it maps directly to the server trace.
- URI versioning (`/api/v1/...`) — visible in logs, CDN rules and bug reports.

---

## Testing

```bash
npm test                 # unit tests
npm run test:cov         # with coverage
npm run test:e2e         # end-to-end (uses the e2e Jest config, --runInBand)
```

E2E suites live in `test/` and use `test/setup-env.ts` to seed a disposable database. There are 350+ unit tests and 90+ e2e covering: auth, http pipeline, webhook signature + replay, WhatsApp parsing + sending, admin RBAC, probe.

---

## Deployment

Production runs on **Railway** with the multi-stage [`Dockerfile`](Dockerfile). The accompanying `docker/nginx/nginx.conf` restricts `/metrics` and `/docs` to private networks.

Steps for a fresh deploy:

1. Provision Postgres + Redis addons.
2. Set the env from `.env.example` — generate real `ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`; the app refuses to start in staging/production with placeholders.
3. `prisma migrate deploy` runs on release via `scripts/railway-start.sh`.
4. Allowlist the deployed frontend origin in `CORS_ORIGINS`.
5. Configure the Meta WhatsApp webhook to `https://<your-host>/api/v1/webhooks/whatsapp` and set `META_APP_SECRET` **before** rotating in the Meta dashboard — rotating first causes every delivery to fail signature verification, and Meta disables the subscription after repeated failures.

---

## Operator notes

- `/metrics` and `/docs` must not be publicly reachable. The supplied Nginx config restricts both to private networks.
- `TRUST_PROXY_HOPS` must match the number of proxies in front of the app. Too high lets clients forge `X-Forwarded-For` and evade rate limits; too low and every client appears to share the proxy's IP.
- Total database connections are `DB_POOL_SIZE × processes`. Keep the product below Postgres' `max_connections`, or add PgBouncer in transaction mode.
- Redis runs with `maxmemory-policy noeviction` on purpose: queue state lives there, and silently evicting a key would lose queued messages.
- `SHUTDOWN_TIMEOUT_MS` must be lower than the orchestrator's termination grace period, or pods are killed mid-drain.
- WhatsApp access tokens are encrypted at rest with `ENCRYPTION_KEY`. Changing that key without re-encrypting disables every registered number.

### Local Docker permissions

If `docker compose up` reports a permission error on `/var/run/docker.sock`:

```bash
sudo usermod -aG docker "$USER"   # then log out and back in
```

---

## Contributing

Issues are scoped per repo and labeled (`backend`, `good-first-issue`, `test`, `docs`, `stellar`, …). Each issue states acceptance criteria and links the files involved.

1. Fork, branch from `main`.
2. Make the change — add or update unit + e2e coverage.
3. `npm run lint && npm run typecheck && npm test && npm run test:e2e` must pass.
4. Open a PR; link the issue.
5. Secrets never go in commits — only `.env.example` ships.

PRs that touch money paths (`ramp/`, `payments/`, `bills/`, `wallet/`) require a second reviewer and must include test fixtures for both the happy path and the provider-failure path.

---

## Related documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — decisions with rejected alternatives
- [Frontend](https://github.com/Zylo-Finace/frontend) — web wallet
- [Contracts](https://github.com/Zylo-Finace/contract) — Soroban `ZyloFactory` + `ZyloWallet`

## License

UNLICENSED — all rights reserved. Contact the maintainers for commercial use.
