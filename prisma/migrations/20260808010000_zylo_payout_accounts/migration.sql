-- Saved NGN payout accounts for Zylo Sell USDC (default used on next sell).
CREATE TABLE IF NOT EXISTS "zylo_ramp_payout_accounts" (
    "id" SERIAL NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "bank_name" VARCHAR(128) NOT NULL,
    "bank_code" VARCHAR(16) NOT NULL,
    "account_number" VARCHAR(16) NOT NULL,
    "account_name" VARCHAR(160) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zylo_ramp_payout_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "zylo_ramp_payout_accounts_phone_bank_code_account_number_key"
  ON "zylo_ramp_payout_accounts"("phone", "bank_code", "account_number");

CREATE INDEX IF NOT EXISTS "zylo_ramp_payout_accounts_phone_is_default_idx"
  ON "zylo_ramp_payout_accounts"("phone", "is_default");
