-- =============================================================================
--  Phase 2 — invariants Prisma's schema language cannot express.
--
--  Everything here is a CHECK constraint or a partial index. They exist because
--  an invariant enforced only by the application is an invariant that a
--  migration script, a psql session, or a future bug will quietly violate — and
--  for money, "quietly violated" means an unreconcilable balance.
--
--  Run order: this migration must follow the generated schema migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Identity: credentials must match the principal type
-- -----------------------------------------------------------------------------

-- A customer is identified by phone and authenticates with a PIN.
ALTER TABLE "users"
  ADD CONSTRAINT "users_customer_requires_phone"
  CHECK ("type" <> 'CUSTOMER' OR "phoneE164" IS NOT NULL);

-- An admin is identified by email and authenticates with a password.
ALTER TABLE "users"
  ADD CONSTRAINT "users_admin_requires_email"
  CHECK ("type" <> 'ADMIN' OR "email" IS NOT NULL);

-- Phone numbers are stored in E.164 and nothing else. This is the constraint
-- that stops an un-normalised `08012345678` from creating a second account for
-- a customer who already exists as `+2348012345678`.
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_is_e164"
  CHECK ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{6,14}$');

-- Emails are stored lowercase so the unique index is meaningful.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_is_lowercase"
  CHECK ("email" IS NULL OR "email" = lower("email"));

ALTER TABLE "users"
  ADD CONSTRAINT "users_username_is_lowercase"
  CHECK ("username" IS NULL OR "username" = lower("username"));

-- -----------------------------------------------------------------------------
--  Money: the constraints that make a wrong balance impossible to persist
-- -----------------------------------------------------------------------------

-- A wallet may never go negative. Every debit path checks this in application
-- code; this is the backstop that turns a logic bug into a failed transaction
-- rather than a customer who owes the platform money.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_non_negative"
  CHECK ("balance" >= 0);

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_locked_balance_non_negative"
  CHECK ("lockedBalance" >= 0);

-- Funds cannot be held that the wallet does not contain.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_locked_within_balance"
  CHECK ("lockedBalance" <= "balance");

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_totals_non_negative"
  CHECK ("totalCredited" >= 0 AND "totalDebited" >= 0);

-- Ledger amounts are always positive; direction carries the sign. A signed
-- amount invites a SUM() that nets credits against debits and reports nonsense.
ALTER TABLE "wallet_ledger_entries"
  ADD CONSTRAINT "ledger_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "wallet_ledger_entries"
  ADD CONSTRAINT "ledger_balances_non_negative"
  CHECK ("balanceBefore" >= 0 AND "balanceAfter" >= 0);

-- The arithmetic must be internally consistent: a completed entry's
-- before/after pair has to agree with its own amount and direction. Any row
-- violating this is corruption, and it is far better to fail the write than to
-- discover it during a month-end reconciliation.
ALTER TABLE "wallet_ledger_entries"
  ADD CONSTRAINT "ledger_arithmetic_consistent"
  CHECK (
    "status" <> 'COMPLETED'
    OR ("direction" = 'CREDIT' AND "balanceAfter" = "balanceBefore" + "amount")
    OR ("direction" = 'DEBIT'  AND "balanceAfter" = "balanceBefore" - "amount")
  );

-- -----------------------------------------------------------------------------
--  Bank accounts
-- -----------------------------------------------------------------------------

-- NUBAN is exactly 10 digits. Stored as text because leading zeros matter.
ALTER TABLE "bank_accounts"
  ADD CONSTRAINT "bank_accounts_nuban_format"
  CHECK ("accountNumber" ~ '^[0-9]{10}$');

-- -----------------------------------------------------------------------------
--  Partial indexes
--
--  Prisma cannot express a WHERE clause on an index. These cover the hot paths
--  where filtering the index itself keeps it small and the planner honest.
-- -----------------------------------------------------------------------------

-- Session validation on every authenticated request touches only live sessions;
-- revoked and expired rows are dead weight in the index.
CREATE INDEX "sessions_active_idx"
  ON "sessions" ("userId", "expiresAt")
  WHERE "revokedAt" IS NULL;

-- The reconciliation job scans for entries stuck in PENDING. Those are a tiny
-- fraction of the table, so a partial index keeps that sweep cheap forever.
CREATE INDEX "ledger_pending_idx"
  ON "wallet_ledger_entries" ("tenantId", "createdAt")
  WHERE "status" = 'PENDING';

-- Login lookups only ever consider live users.
CREATE INDEX "users_active_phone_idx"
  ON "users" ("tenantId", "phoneE164")
  WHERE "deletedAt" IS NULL AND "phoneE164" IS NOT NULL;
