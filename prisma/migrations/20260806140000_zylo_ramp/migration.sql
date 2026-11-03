-- =============================================================================
--  Zylo WhatsApp USDC ↔ NGN ramp tables (platform-level, not tenant-scoped)
-- =============================================================================

CREATE TABLE "zylo_ramp_users" (
    "id" SERIAL NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "wallet" VARCHAR(64),
    "stellar_wallet" VARCHAR(64),
    "bank_name" VARCHAR(64),
    "bank_account" VARCHAR(32),
    "account_name" VARCHAR(128),
    "username" VARCHAR(64),
    "email" VARCHAR(160),
    "pin_hash" VARCHAR(100),
    "pin_setup_hash" VARCHAR(100),
    "onboarding_step" VARCHAR(32),
    "onboarded_at" TIMESTAMP(3),
    "whatsapp_name" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zylo_ramp_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zylo_ramp_users_phone_key" ON "zylo_ramp_users"("phone");

CREATE TABLE "zylo_ramp_orders" (
    "id" SERIAL NOT NULL,
    "ref" VARCHAR(32) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "amount_usdc" DECIMAL(18,6) NOT NULL,
    "amount_ngn" INTEGER NOT NULL,
    "rate" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "deposit_address" VARCHAR(64),
    "wallet" VARCHAR(64),
    "chain" VARCHAR(16) NOT NULL DEFAULT 'celo',
    "payout_bank_name" VARCHAR(64),
    "payout_bank_account" VARCHAR(32),
    "payout_account_name" VARCHAR(128),
    "tx_hash" VARCHAR(66),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zylo_ramp_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zylo_ramp_orders_ref_key" ON "zylo_ramp_orders"("ref");
CREATE INDEX "zylo_ramp_orders_phone_idx" ON "zylo_ramp_orders"("phone");
CREATE INDEX "zylo_ramp_orders_status_idx" ON "zylo_ramp_orders"("status");
