# Architecture

> Decisions and their reasoning. Where a choice was contested, the rejected option
> and the reason it lost are recorded — a decision without its alternatives is
> impossible to revisit intelligently later.

## 1. Shape of the system

A **modular monolith**, deployed as one process, structured so that any feature
module can be lifted into its own service without touching the others.

Why not microservices now: at zero customers, service boundaries are guesses.
Getting them wrong costs a distributed refactor, whereas getting a module boundary
wrong costs a file move. The queue-based seams (BullMQ) mean the eventual split is
mechanical: a worker already consumes jobs over Redis, so moving it to another
process is a deployment change, not a redesign.

The rule that preserves this option:

```
core  ←  infrastructure  ←  modules
```

- `core` imports nothing from the other two. It is framework glue and domain
  primitives: errors, context, pagination, DTO envelopes.
- `infrastructure` implements ports (database, cache, storage, queues) and may
  import `core`.
- `modules` are features. They may import both. **A module never imports another
  module's internals** — cross-module communication goes through a published
  service interface or a domain event.

An import from `infrastructure` into `modules` is the tripwire: if it ever
appears, the layering has been violated and extraction is no longer free.

## 2. Multi-tenancy

### Isolation model: shared database, shared schema, row-level `tenantId`

| Option                   | Isolation                 | Why not                                                                                     |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| Database per tenant      | Strongest                 | 10k databases × connection pools ⇒ unmanageable; migrations take days                       |
| Schema per tenant        | Strong                    | 10k schemas × ~40 tables = 400k tables; `pg_dump`, planner and migrations all degrade badly |
| **Row-level `tenantId`** | **Adequate, if enforced** | **Chosen**                                                                                  |

Row-level isolation is only as good as its enforcement, and "remember to add
`where: { tenantId }`" is not enforcement. So the filter is applied by a **Prisma
client extension** (`infrastructure/database/extensions/tenant-scope.extension.ts`)
that:

- derives the set of tenant-scoped models from the DMMF, so a model added later is
  protected the moment it declares `tenantId`;
- injects the tenant into the `where` of every read and write, and into every
  `create` payload;
- **rejects** a query that names a different tenant rather than silently rewriting
  it — an explicit mismatch is a bug or an attack, and both deserve an error;
- refuses to run at all when no tenant is in context (fails closed).

Known gaps, deliberately documented rather than hidden:

1. `$queryRaw` bypasses the extension. Raw SQL must filter by tenant by hand.
2. Nested writes are not rewritten; nested creates must pass `tenantId` explicitly.
3. Postgres RLS is the planned second layer. The extension is the first, not the only.

### Tenant resolution

The tenant is established once, early, and stored in an `AsyncLocalStorage`
context (`core/context/request-context.ts`) rather than threaded through every
function signature.

Why ALS rather than Nest's `Scope.REQUEST`: request-scoped providers force Nest to
rebuild the injector subtree per request, which costs throughput and silently
infects every provider that touches a scoped one. ALS keeps every provider a
singleton — and it also works inside BullMQ workers and Socket.IO handlers, where
there is no Nest request at all. The same `RequestContext.run()` wraps a job as
wraps a request, so tenant scoping is identical in both.

## 3. Error handling

One exception type (`AppException`) carrying one stable code (`ErrorCode`).

The contract with clients is: **branch on `error.code`**, never on the HTTP status
or the message. Codes are append-only; messages are free to change. `retryable` is
part of the payload so an SDK can implement backoff without maintaining its own
status-code table.

Infrastructure errors are converted by translators registered with
`ExceptionTranslatorRegistry`. That indirection exists so `core` never imports
Prisma: the database module teaches the filter about `P2002`, the storage module
will teach it about S3, and the filter itself never changes. (NestJS has no
multi-provider mechanism, so registration is imperative at module init.)

In production, 5xx messages are replaced with a fixed sentence — a Prisma or driver
message can carry table names, column names, even a connection URI. The detail
stays in the logs, joined to the response by `requestId`.

## 4. Observability

Three signals, each with a specific job:

- **Logs** (Pino, NDJSON): what happened, with `requestId`, `correlationId`,
  `tenantId`, `userId` on every line. The redaction list is a security control —
  WhatsApp tokens and API keys transit this service, and a log aggregator is a
  softer target than the database.
- **Metrics** (Prometheus): rates and latency distributions. **`tenantId` is never
  a label.** With 10k tenants a single labelled histogram is millions of time
  series, enough to take down the scraper. Per-tenant numbers come from the
  database, not the metrics registry.
- **Traces** (OpenTelemetry): causality across the HTTP → queue → Meta API chain.
  Started before any other import in `main.ts`, because auto-instrumentation
  patches modules as they load — start it late and you get a running SDK with
  empty traces.

`requestId` is the join key across all three, and it is returned in every response
so a customer can quote one field and support can find the exact trace.

## 5. Health checks

Three endpoints, deliberately not one:

| Endpoint        | Question               | Failure means                          |
| --------------- | ---------------------- | -------------------------------------- |
| `/health/live`  | Is the process wedged? | Restart me                             |
| `/health/ready` | Can I serve traffic?   | Take me out of the LB, keep me running |
| `/health`       | Detail for humans      | Nothing automatic                      |

Conflating liveness with dependency checks is a classic self-inflicted outage: a
30-second database blip makes Kubernetes kill _every_ pod simultaneously, and the
cold-start storm turns a recoverable incident into a long one.

## 6. API contract

- **Envelope on every response.** Costs a little nesting, buys one parse path in
  every SDK, a home for pagination metadata, and `requestId` on every response.
- **URI versioning** (`/api/v1/...`). Visible in logs, CDN rules and bug reports.
  Header versioning hides the version exactly where you need it during an incident.
- **Cursor pagination by default.** `OFFSET n` makes Postgres walk and discard `n`
  rows, and concurrent inserts shift every later page, so clients silently skip
  records. Offset paging remains available, capped, for admin screens that need
  "page 7 of 40".
- **Validation rejects unknown properties** rather than stripping them. A client
  sending `isAdmin: true` gets a 422 instead of believing it was applied.

## 7. Data model conventions

- **UUIDv7 primary keys.** Time-ordered, so inserts stay at the right edge of the
  B-tree instead of scattering random pages the way UUIDv4 does. Matters most on
  the high-volume tables (messages, events) added in later phases.
- **`tenantId` leads every composite index.** Postgres can only use a composite
  index for a predicate on its leading column, and every query filters by tenant.
- **Soft delete filters reads only.** Rewriting `delete` into an `update` makes
  `delete()` a lie: cascades never fire, and children are orphaned. Reads are
  filtered automatically; soft deletion is explicit.
- **Audit columns everywhere**; `version` for optimistic locking on contended rows.

## 8. Failure policy

| Dependency     | Policy                               | Reasoning                                                                                                                                                                     |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres       | Fail the request                     | It is the system of record; wrong data is worse than no answer                                                                                                                |
| Redis (cache)  | **Fail open** — treat as a miss      | A cache is an optimisation. Its loss should mean a slower service, not an outage. Errors are logged and counted, so the degradation is visible                                |
| Redis (locks)  | Fail honestly                        | A lock that "succeeds" when Redis is down is worse than no lock. Exactly-once guarantees are backed by a unique constraint in Postgres; the lock is an optimisation over that |
| Meta Cloud API | Retry with backoff + circuit breaker | Their rate limits and outages are routine, not exceptional                                                                                                                    |

## 9. What is deliberately deferred

Named here so the omissions read as decisions rather than oversights:

- **Postgres RLS** — second isolation layer, after the extension is proven.
- **PgBouncer** — unnecessary below ~20 app processes; the connection maths is in
  `prisma.service.ts`.
- **Audit-log partitioning** — the DDL is written but only pays off at volume;
  retention becomes `DROP PARTITION` instead of a multi-hour `DELETE`.
- **Read replicas** — Prisma supports a read-replica extension; add it when read
  load justifies the replication-lag complexity.
- **Cache stampede protection on every read** — locking every read costs more than
  the duplicated work for a single indexed query. `withLock` exists for the
  genuinely expensive loaders.
