-- WhatsApp Naira bank sends (USDC → FalconPay)
CREATE TABLE IF NOT EXISTS "zylo_ramp_bank_sends" (
    "id" SERIAL NOT NULL,
    "ref" VARCHAR(64) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "amount_ngn" INTEGER NOT NULL,
    "amount_usdc" DECIMAL(18,6) NOT NULL,
    "rate" INTEGER NOT NULL,
    "bank_code" VARCHAR(16) NOT NULL,
    "bank_name" VARCHAR(120) NOT NULL,
    "account_number" VARCHAR(20) NOT NULL,
    "account_name" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "platform_user_id" UUID,
    "stellar_tx_hash" VARCHAR(128),
    "provider_reference" VARCHAR(128),
    "failure_reason" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "zylo_ramp_bank_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "zylo_ramp_bank_sends_ref_key" ON "zylo_ramp_bank_sends"("ref");
CREATE INDEX IF NOT EXISTS "zylo_ramp_bank_sends_phone_idx" ON "zylo_ramp_bank_sends"("phone");
CREATE INDEX IF NOT EXISTS "zylo_ramp_bank_sends_status_idx" ON "zylo_ramp_bank_sends"("status");
