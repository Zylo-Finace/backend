# BANJEE — Product Documentation

> **BANJEE** (product codename: **Zylo**) — a Stellar-first USDC ↔ Naira consumer wallet, accessible on both the web and WhatsApp.
>
> Live: **https://www.usebanjee.com** · API: `https://zylo-production.up.railway.app/api/v1`
>
> This document is the canonical product + architecture reference. It spans the three public repos under the [Zylo-Finace](https://github.com/Zylo-Finace) GitHub org:
>
> - **Frontend** · https://github.com/Zylo-Finace/frontend
> - **Backend** · https://github.com/Zylo-Finace/backend
> - **Contracts** · https://github.com/Zylo-Finace/contract

---

## Table of contents

1. [What BANJEE is](#1-what-banjee-is)
2. [Who it's for](#2-who-its-for)
3. [Product surface](#3-product-surface)
4. [System architecture](#4-system-architecture)
5. [Repo-by-repo breakdown](#5-repo-by-repo-breakdown)
   - [5.1 Frontend](#51-frontend--zylo-finaceefrontend)
   - [5.2 Backend](#52-backend--zylo-finaceebackend)
   - [5.3 Contracts](#53-contracts--zylo-finaceeontract)
6. [End-to-end flows](#6-end-to-end-flows)
   - [6.1 Onboarding](#61-onboarding)
   - [6.2 NGN → USDC on-ramp](#62-ngn--usdc-on-ramp)
   - [6.3 USDC deposit (external)](#63-usdc-deposit-external)
   - [6.4 Send USDC](#64-send-usdc)
   - [6.5 Sell USDC → NGN payout](#65-sell-usdc--ngn-payout)
   - [6.6 Pay bills](#66-pay-bills)
   - [6.7 WhatsApp conversational flow](#67-whatsapp-conversational-flow)
7. [Security model](#7-security-model)
8. [Stellar integration](#8-stellar-integration)
9. [Naira rails](#9-naira-rails)
10. [Data model](#10-data-model)
11. [Observability + reliability](#11-observability--reliability)
12. [Roadmap](#12-roadmap)
13. [How to contribute across the three repos](#13-how-to-contribute-across-the-three-repos)
14. [Glossary](#14-glossary)

---

## 1. What BANJEE is

BANJEE is a consumer wallet designed for Nigerian users who want a frictionless way to hold, send, receive, and spend **USDC on Stellar** while still being able to move freely in and out of **Nigerian Naira**.

**The problem.** Moving money between USDC and NGN in Nigeria today looks like this: open a P2P exchange, find a counterparty, trust them, wait, hope. Even for users who understand the mechanics, it's slow, error-prone and intimidating. For a non-technical user it's a non-starter — they end up back on cash or on apps that take custody of their dollars without ever touching the chain.

**The solution.** One account, one PIN, two channels (web + WhatsApp), one set of limits and rates. A user signs up with their phone, gets a dedicated NUBAN for Naira deposits and a dedicated Stellar address for USDC deposits, and from there everything — convert, send, sell, pay — is one tap or one chat command. Rates are locked at review, idempotency is handled by the server, and all money movement is traceable end-to-end with a request id a support agent can quote.

**The thesis.** Stellar is the right chain for a Naira ↔ stablecoin product: USDC is live on Stellar, fees are cents, finality is seconds, and Soroban (Stellar's smart-contract layer) lets us give each user a deterministic on-chain wallet contract with daily caps and a programmable sweep path to a Naira vault. BANJEE is building the consumer surface and the custody orchestration that turns those primitives into a real product for Nigerian users.

---

## 2. Who it's for

- **Primary: Nigerian retail users** who want to hold or receive USDC but transact in NGN day-to-day (airtime, data, electricity, bank transfers). They arrive via WhatsApp (familiar), graduate to the web app when they want the full surface.
- **Secondary: freelancers and remote workers** paid in USDC on Stellar who need a reliable, fast off-ramp to NGN.
- **Tertiary: ops and admin users** inside BANJEE — KYC reviewers, finance, support — served by the same backend through the admin panel.

Explicitly **not** targeting: traders, DeFi power users, institutional custody. Those need different primitives.

---

## 3. Product surface

### 3.1 Web app (`https://www.usebanjee.com`)

Mobile-first Next.js PWA. Four tabs — **Home**, **Wallets**, **Activity**, **Account** — with task flows (Send, Receive, Buy & Sell, Airtime & Data, Rates) that hide the tab bar for focus.

| Action | What the user does | Underlying backend |
|--------|--------------------|---------------------|
| Create account | Phone (E.164) + 4-digit PIN | `POST /auth/customer/register` |
| Log in | Phone + PIN | `POST /auth/customer/login` |
| See balances | Opens Home | `GET /ramp-portal/wallets`, `/wallet/balance` |
| Receive NGN | Shows funding NUBAN | `GET /wallet/funding-account` |
| Receive USDC | Shows Stellar address + QR | `GET /ramp-portal/wallets` |
| Send USDC on-chain | Recipient → review → PIN | `POST /ramp-portal/transfers/usdc` |
| Send NGN to bank (from NGN) | Bank picker → account resolve → review → PIN | `POST /payouts` |
| Send NGN to bank (from USDC) | Quote → review → PIN | `POST /ramp-portal/bank-sends` |
| Sell USDC → NGN | Rate locked at review → PIN | `POST /ramp-portal/sells` |
| Pay airtime / data | Operator → plan → PIN | `POST /ramp-portal/airtime`, `/data` |
| Pay utility bill | Provider → service → PIN | `POST /ramp-portal/bills` |
| View activity | Infinite feed | `GET /ramp-portal/activity` |
| Statement export | CSV / PDF | `GET /ramp-portal/statement` |

### 3.2 WhatsApp bot

Served by the same backend through Meta's WhatsApp Cloud API, via the BANJEE number (currently `+234 806 033 2714`). The bot understands intents like:

- `balance` — show both balances
- `send 50 usdc to +2348012345678`
- `sell 20 usdc`
- `buy 2k data for mtn 08030000000`
- `pay 5k light account 1234567890`
- `rate` — current USDC/NGN marks

PIN entry uses a Meta Flow (interactive form) so the PIN never travels in plain WhatsApp messages. The 24-hour service window is enforced before calling Meta — repeated policy violations degrade the number's quality rating for every customer on it.

### 3.3 Admin panel (`/(admin)` routes)

Internal ops surface: users, KYC queue, transactions, providers, rates, disputes, dispensing, analytics, settings, float. Gated behind an admin session with RBAC permissions enforced server-side (compile-time permission catalogue, deny-wins resolution).

---

## 4. System architecture

Three repos, one product. Split by layer, not by feature, so contributors can pick the surface they want to work on without pulling the whole monorepo.

```
 ┌──────────────────┐   ┌─────────────────────┐   ┌────────────────────────┐
 │  Frontend         │   │  Backend             │   │  Stellar network      │
 │  Next.js PWA      │   │  NestJS API          │   │  ┌──────────────────┐ │
 │                   │──►│  + WhatsApp bot      │──►│  │ classic G… accts │ │
 │  (web + admin)    │   │  + NGN rails         │   │  │ (custodial today)│ │
 └──────────────────┘   │                      │   │  └──────────────────┘ │
                        │  stellar-sdk         │   │  ┌──────────────────┐ │
 ┌──────────────────┐   │  stellar-sdk-contract│   │  │ Soroban C… wallets│ │
 │  WhatsApp         │──►│                      │──►│  │ ZyloFactory       │ │
 │  (Meta Cloud API) │   │                      │   │  │ ZyloWallet        │ │
 └──────────────────┘   │                      │   │  └──────────────────┘ │
                        │                      │   └────────────────────────┘
                        │                      │           │
                        │                      │           ▼
                        │                      │   Naira vault (off-ramp sweep)
                        │                      │
                        │                      │──► FalconPay / PayVessel / PulseMFB  (NGN rails)
                        │                      │──► Paystack                           (legacy)
                        │                      │──► SMEPlug / ClubKonnect / PulseMFB-VAS (bills)
                        │                      │──► PayVessel                          (KYC)
                        │                      │──► Meta WhatsApp Cloud API            (messaging)
                        │                      │
                        │                      │──► Postgres  (system of record)
                        │                      │──► Redis     (cache, queues, locks)
                        └──────────────────────┘
```

**Data direction**: Frontend / WhatsApp → Backend API → Stellar (classic + Soroban) + NGN rails. The frontend has no chain, payment-provider, or custody keys. All sensitive logic — rates, PIN, custody, idempotency — lives in the backend. The contracts give users deterministic on-chain custody with programmable guardrails.

Why split into three repos:

- **Scope**: issues are naturally per-layer (UI vs API vs Soroban). A contributor who knows React can pick a frontend issue without understanding Stellar; a contributor who knows Rust can pick a contract issue without understanding Next.js.
- **Blast radius**: a repo-wide change (dependency bump, lint config, CI rework) is small and local.
- **Access**: different humans own different layers; GitHub teams map cleanly.
- **Reviewability**: for Wave reviewers, each repo is a complete, standalone artifact that tells a coherent story.

---

## 5. Repo-by-repo breakdown

### 5.1 Frontend — [`Zylo-Finace/frontend`](https://github.com/Zylo-Finace/frontend)

The Next.js 16 PWA at `usebanjee.com`. Browser-only; no chain code, no provider keys.

| | |
|--|--|
| Framework | Next.js 16 App Router, React 19 |
| Styling | Tailwind v4 |
| State | TanStack Query 5 + Zustand 5 |
| Forms | React Hook Form + Zod |
| Realtime | socket.io-client |
| Testing | Vitest + Testing Library + jsdom |
| Deploy | Vercel |

Top-level structure:

```
src/
├── app/           App Router — (admin), (auth), (user), marketing, legal
├── components/    admin / auth / shared / site / ui / user (incl. flows/)
├── hooks/         use-api, use-online, use-sign-out
├── lib/           api-client, idempotency, format, validation, quotes, …
├── store/         auth (Zustand)
└── types/
```

**Key patterns**:

- Single `fetch` wrapper in `src/lib/api-client.ts` that adds the tenant header, auth cookies, envelope parsing, and `error.code`-based branching.
- `newIdempotencyKey()` (`src/lib/idempotency.ts`) called once per review screen, reused on retry — a double-tap or flaky network never sends twice.
- Flows in `src/components/user/flows/` are the choreography: pick → quote → review → PIN → status.

### 5.2 Backend — [`Zylo-Finace/backend`](https://github.com/Zylo-Finace/backend)

The NestJS 11 API and WhatsApp bot. System of record for customers, balances, rates, KYC, PIN, limits, and all money movement.

| | |
|--|--|
| Runtime | Node ≥ 22 |
| Framework | NestJS 11 |
| DB | PostgreSQL via Prisma (20+ migrations) |
| Cache / queues / locks | Redis |
| Chain | `stellar-sdk` (classic), Soroban contract client |
| Messaging | Meta WhatsApp Cloud API |
| Observability | Pino + Prometheus + OpenTelemetry |
| Deploy | Docker multi-stage on Railway |

Shape: **modular monolith** with strict layering —

```
core  ←  infrastructure  ←  modules
```

- `core` is framework glue and domain primitives (errors, context, pagination, envelope, `Money`). Imports nothing below.
- `infrastructure` implements ports (Prisma, Redis, observability, security). Imports `core` only.
- `modules` are features. May import `core` + `infrastructure` but **never another module's internals** — cross-module communication through published service interfaces or domain events.

Feature modules:

| Module | Purpose |
|--------|---------|
| `admin/` | Back-office — dashboard, workspace, members, roles, teams, invitations, API keys, sessions, customers, audit |
| `auth/` | Customer + admin auth, tokens, guards |
| `bills/` | Airtime / data / electricity / TV — SMEPlug, ClubKonnect, PulseMFB-VAS, FalconPay-bills, routed fallback |
| `health/` | Liveness / readiness / detail probes |
| `kyc/` | Tiers, matching heuristics, PayVessel adapter, admin queue |
| `payments/` | Provider abstraction, funding + payouts — FalconPay, PayVessel, PulseMFB, Paystack |
| `profile/` | User profile |
| `ramp/` | The money-movement core — Stellar wallets + watchers, portal controller, rates, bills, bank sends, receipts, statements, WhatsApp integration |
| `rewards/` | Referrals + reward rules |
| `tenancy/` | Tenant resolution (header / subdomain) |
| `wallet/` | Balances + double-entry ledger |
| `whatsapp/` | Cloud API client, inbound webhook, send service, template sync, conversations |

**Key invariants**:

- **Multi-tenant row-level isolation**: enforced by a Prisma client extension that derives tenant-scoped models from DMMF, injects `tenantId` into every read + write, rejects cross-tenant queries, and fails closed when no tenant is in context.
- **Integer kobo money**: all amounts are `BigInt` kobo, never floats. `₦1,500.50` is `150050`. The `Money` value object in `src/core/money` is the only sanctioned way to construct or combine amounts. Money crosses the wire as a string.
- **Three-layer idempotency**: request key (`Idempotency-Key` header) → provider dedupe → ledger uniqueness.
- **Envelope on every response** — `{ success, data, meta, requestId, timestamp }` or `{ success, error.code, error.message, error.details, error.retryable, requestId, timestamp }`. Clients branch on `error.code`, never on HTTP status or message text.

### 5.3 Contracts — [`Zylo-Finace/contract`](https://github.com/Zylo-Finace/contract)

Soroban workspace. Two contracts give each user a deterministic on-chain Stellar deposit wallet with programmable spend caps and a Naira-vault sweep path.

| Crate | Role |
|-------|------|
| `wallet/` | **`ZyloWallet`** — the per-user contract. Holds SAC balances (USDC, native XLM SAC), authorises transfers, supports an operator spend path and (optionally) a linked Stellar owner key. Can sweep to the configured Naira vault. Enforces a rolling daily spend cap. |
| `factory/` | **`ZyloFactory`** — upgradable registry. Stores the current `ZyloWallet` Wasm hash, deploys one wallet per `user_id`, and (as admin) can push config changes down to deployed wallets. |

**Principals**:

| Principal | Can do |
|-----------|--------|
| **Admin** (factory only) | Upgrade factory, set wallet Wasm hash, push defaults, push config to deployed wallets |
| **Operator** (backend) | Call `register`, spend via `transfer(spender=operator, …)` after off-chain PIN check |
| **Owner** (optional, linked via `link_owner`) | Spend from their wallet with their Stellar key |
| **Withdrawal Authority** | Approve `send_to_naira_vault` off-ramp sweeps |
| **Naira Vault** | Passive receiver of swept tokens for fiat settlement |

**user_id convention**: `SHA-256(phone_e164)`, passed as `Bytes`. This makes `register(user_id)` idempotent across backend restarts and migrations — same user, same contract address, forever.

**Why Soroban in addition to classic `G…`**: it lets every user's deposit address be a contract that *itself* enforces the daily cap on-chain, makes linked self-custody a one-call operation (`link_owner`), and lets the Naira vault sweep be a verifiable on-chain transfer rather than a backend accounting step.

---

## 6. End-to-end flows

Each flow below crosses two or three layers. Diagrams show request direction.

### 6.1 Onboarding

```
Frontend                Backend                              Stellar
────────                ───────                              ───────
/register    ──POST──►  auth/customer/register
(phone+PIN)             │
                        ├── Argon2id hash PIN
                        ├── create User + Membership
                        ├── provision NUBAN via FalconPay
                        └── provision Stellar deposit:
                              ├── classic G… via stellar-sdk
                              └── (optional) Soroban:            factory.register(sha256(phone))
                                                             ──► returns C… wallet address
```

Result: the user has a phone-linked account, a 4-digit transaction PIN (Argon2id, lockout, weak-PIN rejection), a NUBAN for NGN deposits, and a Stellar address for USDC deposits.

### 6.2 NGN → USDC on-ramp

```
User transfers NGN to their NUBAN via any bank
                    │
                    ▼
Provider (FalconPay/PayVessel/PulseMFB/Paystack)
        POST /api/v1/webhooks/<provider>
                    │ HMAC verified over RAW bytes BEFORE parsing
                    ▼
webhook_events row (dedupe on provider event id)
                    │
                    ▼
destination account → userId + tenantId (unscoped lookup, system context)
                    │
                    ▼
WalletService.credit()  ─ SELECT … FOR UPDATE on wallet row
                          ledger entry + balance update, one transaction
                    │
                    ▼
If the user chose auto-convert: ramp-portal.service.sellNgnToUsdc()
                    │ rate locked
                    ▼
NGN debit + USDC credit (same double-entry ledger)
                    │
                    ▼
WhatsApp + web push notification
```

Idempotency: every step. A redelivered webhook resolves to the existing ledger entry and changes nothing. Failures return non-2xx on purpose — the provider's retry is the recovery mechanism.

### 6.3 USDC deposit (external)

```
Sender transfers USDC to the user's Stellar address (G… or C…)
                    │
                    ▼
Backend watcher (ramp.stellar-watcher / ramp.stellar-classic)
   polls Horizon with a persisted cursor
                    │
                    ▼
tx_notify_dedupe on (ledger, tx hash, op index)
                    │
                    ▼
credit USDC balance; emit deposit event; notify via WhatsApp + web socket
```

### 6.4 Send USDC

```
Frontend / WhatsApp            Backend                           Stellar
─────────────────              ───────                           ───────
Recipient entered     ─────►   resolve recipient
                               (BANJEE user, Stellar addr, or federated)
                                   │
Review screen          ◄────       quote + fee
                                   │
PIN entered           ─────►   POST /ramp-portal/transfers/usdc
                               (Idempotency-Key, PIN)
                                   │
                                   ├── verify PIN (Argon2id)
                                   ├── check KYC tier limits
                                   ├── SELECT … FOR UPDATE on wallet row
                                   ├── debit ledger
                                   └── sign + submit tx                      ──►  classic submitTx
                                                                             ──►  or Soroban transfer()
                                   │
Status polling        ◄────        transaction hash + status
```

### 6.5 Sell USDC → NGN payout

```
Review   : user picks amount, server returns locked rate + fee
PIN      : POST /ramp-portal/sells  {amount, bank, acct, idempotency key, PIN}
Server   :
  ├── verify PIN
  ├── debit USDC  (SELECT … FOR UPDATE)
  ├── credit NGN
  ├── call payout provider (FalconPay primary, others as fallback)
  └── poll for terminal status
On success  : receipt generated; user notified
On failure  : auto-refund USDC back to the user's wallet; receipt notes the refund
```

### 6.6 Pay bills

```
User picks operator + plan (airtime / data / electricity / TV / cable)
       │
       ▼
Backend quotes the bill (price in NGN)
       │
       ▼
User enters PIN  ─► POST /ramp-portal/bills (or /airtime, /data)
       │
       ▼
Routed provider dispatch:
       SMEPlug  →  ClubKonnect  →  PulseMFB-VAS   (fallback chain)
       │
       ▼
Provider webhook confirms; receipt stored; user notified
On terminal failure: NGN refunded, user notified
```

### 6.7 WhatsApp conversational flow

```
Customer sends a WhatsApp message
       │
       ▼
Meta POSTs /api/v1/webhooks/whatsapp
       │  HMAC-SHA256 over the RAW bytes — verified before parsing
       ▼
phone_number_id → registered BANJEE number → tenantId (unscoped, system context)
       │
       ▼
message stored, keyed on wamid (@@unique([tenantId, wamid]) — redelivery is a no-op)
       │
       ▼
conversation.lastInboundAt bumped → 24-hour service window reopens
       │
       ▼
Intent parser  (ramp.intent.ts)  →  ramp commands  (ramp.commands.ts)
       │
       ▼
Mutating command (send / sell / buy / pay) → Meta Flow for PIN entry
       │
       ▼
Same backend services as the web app (one PIN, one limit set, one rate book)
```

The 24-hour service window is checked **before** calling Meta, not by reacting to their rejection: a refused send still costs a round trip and counts against rate limits, and repeated policy violations degrade the number's quality rating, throttling throughput for every customer on it.

---

## 7. Security model

**Authentication**

- Customer: phone (E.164) + 4-digit PIN. Argon2id, lockout after N bad attempts, weak-PIN rejection, enumeration-resistant error responses.
- Admin: email + password (separate credential path and route guard from customers).
- Sessions: access/refresh JWTs with split secrets; refresh rotation; **family revocation on reuse detection** (if a refresh token is used twice, the entire family is invalidated).

**Authorisation**

- Compile-time permission catalogue in `src/core/authorization`. Slugs change only when code changes; `@RequirePermissions('members:writ')` is a build error, not a route nobody can reach.
- Three rules: **denials beat everything**, including `*`; wildcards expand at check time; you cannot grant what you do not hold.

**PIN & money movement**

- PIN is required on every mutating money POST. It never travels over WhatsApp text — Meta Flows are used instead.
- Every mutating call requires an `Idempotency-Key` header.
- Three-layer idempotency: request key, provider dedupe, ledger uniqueness.
- Wallet updates use `SELECT … FOR UPDATE` with append-only double-entry ledger.
- KYC tiers cap daily + monthly throughput (Bronze → Legend).

**Custody**

- Classic Stellar `G…` accounts: signer keys encrypted at rest with `ENCRYPTION_KEY`.
- Soroban `C…` wallets: operator key held by the backend (same encryption); daily cap enforced **on-chain** by `ZyloWallet`.
- `link_owner` turns a custodial wallet into a hybrid one — operator + owner can both spend. If operator-free self-custody is desired, operator is rotated to a null address via the factory.

**Webhook integrity**

- Paystack-family: HMAC-SHA512 over raw bytes, verified before parsing.
- Meta WhatsApp: HMAC-SHA256 over raw bytes, verified before parsing.
- `webhook_events` table dedupes on provider event id — redelivery is a no-op.

**Secret hygiene**

- `.env`, `.env.local`, `.env.deploy`, `.env.mainnet` are ignored and never committed. Only `.env.example` ships.
- GitHub secret scanning is on; placeholder test fixtures avoid Stripe-style patterns to prevent false positives.

**Operational**

- `/metrics` and `/docs` are restricted to private networks by the shipped Nginx config.
- `TRUST_PROXY_HOPS` must match the proxy topology — mis-setting it lets clients forge `X-Forwarded-For` and evade rate limits.
- `META_APP_SECRET` is the WhatsApp webhook's only authentication; rotate in app first, then in Meta.
- `ENCRYPTION_KEY` rotations require re-encrypting all stored secrets before the old key is removed.

---

## 8. Stellar integration

BANJEE runs **two custody models in parallel** and routes users between them. Both are driven from the backend.

### 8.1 Classic `G…` accounts

- Created on registration via `stellar-sdk`.
- Deposit address = the account's public key.
- Signer key encrypted at rest.
- Watcher polls Horizon with a persisted cursor; credits the in-app USDC balance on confirmed inbound USDC payments.
- Send: backend builds + signs a classic payment transaction; submits to Horizon; polls for `successful`.

**Pros**: simple, cheap, well-understood.
**Cons**: daily cap is enforced only by the backend; no on-chain programmability; no clean path to user self-custody without migrating the balance.

### 8.2 Soroban `C…` wallets

- Deployed per user by `ZyloFactory.register(sha256(phone))`.
- The returned contract address is the user's deposit address.
- Spend goes through `ZyloWallet.transfer(spender, token, to, amount)` where `spender` is either the operator (custodial) or the linked owner (self-custody).
- The wallet enforces a **rolling daily cap on-chain**.
- `send_to_naira_vault` sweeps balance to the Naira vault for off-ramp settlement — a verifiable on-chain transfer.

**Pros**: on-chain guardrails, clean self-custody opt-in via `link_owner`, verifiable vault flows.
**Cons**: higher on-chain footprint, more surface area, requires tracking the `WalletWasm` hash upgrade path.

### 8.3 Migration plan (classic → Soroban)

Tracked as issues on both the backend and contract repos:

1. **Shadow-register**: on every new user, also call `factory.register(user_id)` and store the Soroban address alongside the classic one.
2. **Dual-deposit detection**: the backend watches both addresses and credits the same in-app balance; receipts show which rail was used.
3. **Flip send default** to Soroban for new users; existing users keep classic until they opt in.
4. **Sweep + reconcile** via `send_to_naira_vault` once the mainnet Naira vault is live.

---

## 9. Naira rails

BANJEE abstracts over multiple NGN providers behind a single `payments` interface so that outages or price regressions in any one provider don't take the product down.

| Provider | Role |
|----------|------|
| **FalconPay** | Primary: virtual NUBAN provisioning + bank payouts |
| **PayVessel** | Secondary: NUBAN + payouts; also KYC provider |
| **PulseMFB** | Tertiary: NUBAN + payouts + VAS (airtime/data) |
| **Paystack** | Legacy: funding only |
| **SMEPlug** | Primary bills provider (electricity, TV, data, airtime) |
| **ClubKonnect** | Secondary bills provider |
| **PulseMFB-VAS** | Tertiary bills provider |

A `routed-bills.provider.ts` picks the first available provider per bill category and falls back on terminal failure. On a terminal payout failure the NGN is **refunded to the user's wallet**, not stranded.

---

## 10. Data model

Lives in `prisma/schema.prisma` (backend). Key tables:

| Table | Purpose |
|-------|---------|
| `User`, `Membership` | Customer + admin identity, workspace scope |
| `Tenant` | Row-level tenancy anchor; every tenant-scoped row references it |
| `Wallet`, `LedgerEntry` | Per-user NGN + USDC balance; append-only double-entry ledger |
| `FundingAccount` | User's NUBAN (one per provider) |
| `StellarDeposit`, `StellarWallet` | Classic + Soroban deposit addresses, key material (encrypted) |
| `Payout`, `BankSend` | NGN payout attempts with provider status + receipts |
| `Sell`, `UsdcTransfer` | Off-ramp + on-chain transfer records |
| `BillPurchase` | Airtime / data / utility purchases |
| `KycSubmission`, `KycTier` | Verification records + per-tier limits |
| `WebhookEvent` | Provider webhook dedupe + replay |
| `WhatsAppMessage`, `Conversation` | Inbound + outbound WhatsApp messages (keyed on `wamid`) |
| `ApiKey`, `Role`, `Team`, `Invitation`, `AuditLog` | Admin/RBAC primitives |

All money columns are `BigInt` kobo (NGN) or `BigInt` micro-USDC. Never floats, never on the wire as numbers.

---

## 11. Observability + reliability

**Three signals, each with a specific job**:

- **Logs** (Pino, NDJSON): what happened. `requestId`, `correlationId`, `tenantId`, `userId` on every line. Redaction list is a security control — WhatsApp tokens and provider API keys transit this service; a log aggregator is a softer target than the database.
- **Metrics** (Prometheus): rates and latency distributions. **`tenantId` is never a label** — at 10k tenants a single labelled histogram is millions of time series, enough to take down the scraper. Per-tenant numbers come from the DB.
- **Traces** (OpenTelemetry): causality across HTTP → queue → Meta API → Horizon. Started before any other import in `main.ts`, because auto-instrumentation patches modules as they load.

**`requestId` is the join key across all three** — returned in every response so a customer can quote one field and support can find the exact trace.

**Three health endpoints, deliberately not one**:

| Endpoint | Question | Failure means |
|----------|----------|---------------|
| `/health/live` | Is the process wedged? | Restart me |
| `/health/ready` | Can I serve traffic? | Take me out of the LB, keep me running |
| `/health` | Detail for humans | Nothing automatic |

Conflating liveness with dependency checks is a classic self-inflicted outage: a 30-second DB blip would otherwise make Kubernetes kill *every* pod simultaneously.

**Failure policy**:

| Dependency | Policy | Reasoning |
|-----------|--------|-----------|
| Postgres | Fail the request | System of record; wrong data is worse than no answer |
| Redis (cache) | **Fail open** — treat as a miss | A cache is an optimisation; its loss means a slower service, not an outage |
| Redis (locks) | Fail honestly | A lock that "succeeds" when Redis is down is worse than no lock |
| Meta Cloud API | Retry with backoff + circuit breaker | Their rate limits + outages are routine, not exceptional |
| Stellar Horizon | Retry with backoff; the watcher is cursor-based and resumes | |
| NGN provider | Fall back to the next provider; refund on terminal failure | |

---

## 12. Roadmap

Submitted as scoped issues across the three repos on a ~2-week sprint cadence, each labeled (`frontend` / `backend` / `contract` / `good-first-issue` / `docs` / `test` / `stellar`) with acceptance criteria.

### Near-term (Wave sprint cycles)

- **Frontend**: harden PIN-gated send/sell/bills (retry limits, lockout UI, forgot-PIN recovery). USDC send edge cases (missing trustline prompt, memo-required, federated address input). Activity export and per-tx receipt pages. PWA + a11y pass.
- **Backend**: harden Stellar classic custody (watcher cursor recovery, trustline ensure, idempotent vault spends). Improve sell-USDC → NGN reliability (retry/backoff, webhook replay, receipt). Bills fallback matrix + Stellar auto-refund. WhatsApp intent-parser clarity. More e2e tests for ramp.
- **Contract**: clarify admin/operator/owner_link auth with rotation + revoke paths and tests. Integration tests for register → deposit → transfer covering SAC USDC and XLM. Configurable Naira-vault sweep thresholds. Reproducible build guide.

### Medium-term

- Shadow-register all new users on Soroban; begin the classic → Soroban migration described in §8.3.
- On-chain Naira vault sweep on mainnet.
- `link_owner` UX in the web app (QR-sign, manual key paste).
- Open API docs + public client SDK (TypeScript + Dart).

### Longer-term (unscoped)

- Campaigns + templated messaging for merchants (leveraging the existing WhatsApp platform).
- Business accounts (invoicing + bulk payouts).
- Automation / rules (recurring bills, savings goals).

---

## 13. How to contribute across the three repos

1. **Pick a repo** that matches the layer you want to work on (UI → frontend, API/bot → backend, Rust/Soroban → contract).
2. **Pick an issue** labeled `good-first-issue` if you're new. Every issue states acceptance criteria and links the files involved.
3. **Fork, branch from `main`**.
4. **Run the tests** locally — no PR merges without the appropriate suite passing:
   - Frontend: `npm run lint && npm run typecheck && npm test`
   - Backend: `npm run lint && npm run typecheck && npm test && npm run test:e2e`
   - Contract: `stellar contract build && cargo test`
5. **Open a PR** linking the issue. For UI work include screenshots or a short Loom. For money-path work (anywhere in `ramp/`, `payments/`, `bills/`, `wallet/`) include test fixtures for both happy and provider-failure paths.
6. **Secrets never go in commits** — only `.env.example` ships. GitHub secret scanning is on; use placeholders that don't match Stripe/Meta patterns.

PRs that touch cross-repo contracts (API shape, contract entrypoints) must link the matching PRs in the other repos.

---

## 14. Glossary

| Term | Meaning |
|------|---------|
| **BANJEE** | Product brand (the thing the user sees: `usebanjee.com`) |
| **Zylo** | Internal project / contract codename |
| **USDC** | Dollar-pegged stablecoin issued by Circle; live on Stellar |
| **SAC** | Stellar Asset Contract — the Soroban-side representation of a classic Stellar asset |
| **NUBAN** | Nigerian Uniform Bank Account Number — the 10-digit bank account identifier |
| **NGN** | Nigerian Naira |
| **Kobo** | 1/100 of a NGN; BANJEE represents all NGN amounts as integer kobo |
| **PIN** | 4-digit transaction credential. Separate from the admin password. |
| **E.164** | International phone number format (`+234…`) — canonical user id |
| **Operator** | Backend principal that spends from a custodial `ZyloWallet` on the user's behalf after an off-chain PIN check |
| **Owner** | Optional user Stellar key linked to a `ZyloWallet` via `link_owner` — turns the wallet into a self-custody or hybrid wallet |
| **Naira vault** | Address that receives swept USDC balances for off-ramp settlement into NGN |
| **24h service window** | Meta's rule: free-form WhatsApp messages only within 24 hours of the customer's last inbound message; outside it, only approved templates |
| **`wamid`** | Meta's unique WhatsApp message id — used for dedupe on inbound |
| **`requestId`** | Server-generated id returned on every response; the join key across logs, metrics, and traces |
| **Idempotency key** | Client-supplied header on mutating requests; ensures retries never double-send |
| **Modular monolith** | One deployable, strict internal layering, feature-module boundaries ready for later extraction |

---

**Questions? Feedback?** Open an issue in the relevant repo, or reach the maintainers via the WhatsApp handle on https://www.usebanjee.com.
