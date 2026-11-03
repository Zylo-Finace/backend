-- =============================================================================
--  Phase 3 — payments: constraints and indexes Prisma cannot express.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Webhook events
-- -----------------------------------------------------------------------------

-- A processed event must record when. Catches a code path that marks an event
-- done without stamping it, which would make replay analysis impossible.
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_processed_has_timestamp"
  CHECK ("status" NOT IN ('PROCESSED', 'IGNORED') OR "processedAt" IS NOT NULL);

-- The retry sweep looks only at failures. A partial index keeps that scan
-- constant-cost as the table grows into the millions.
CREATE INDEX "webhook_events_retryable_idx"
  ON "webhook_events" ("provider", "receivedAt")
  WHERE "status" = 'FAILED';

-- Unattributed events are an operational alarm: money may have arrived for an
-- account we do not recognise. Small set, queried by humans during triage.
CREATE INDEX "webhook_events_unattributed_idx"
  ON "webhook_events" ("receivedAt")
  WHERE "tenantId" IS NULL;

-- -----------------------------------------------------------------------------
--  Ledger
-- -----------------------------------------------------------------------------

-- A funding entry must carry the provider's reference; without it a credit
-- cannot be traced back to a settlement line during reconciliation.
ALTER TABLE "wallet_ledger_entries"
  ADD CONSTRAINT "ledger_topup_has_provider_reference"
  CHECK ("type" <> 'TOPUP' OR "providerReference" IS NOT NULL);

-- The statement query: one wallet, newest first, only completed movements.
-- Mirrors the ORDER BY in WalletController.statement so the planner can walk
-- the index instead of sorting.
CREATE INDEX "ledger_statement_idx"
  ON "wallet_ledger_entries" ("walletId", "createdAt" DESC, "id" DESC)
  WHERE "status" = 'COMPLETED';

-- -----------------------------------------------------------------------------
--  Bank accounts
-- -----------------------------------------------------------------------------

-- Inbound transfers are matched by destination NUBAN. Only live accounts are
-- candidates, and this lookup sits on the critical path of every funding event.
CREATE INDEX "bank_accounts_active_nuban_idx"
  ON "bank_accounts" ("accountNumber")
  WHERE "deletedAt" IS NULL AND "isActive" = true;
