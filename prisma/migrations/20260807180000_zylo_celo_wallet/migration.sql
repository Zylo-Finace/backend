-- AlterTable
ALTER TABLE "zylo_ramp_users" ADD COLUMN IF NOT EXISTS "celo_wallet" VARCHAR(42);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "zylo_ramp_users_celo_wallet_key" ON "zylo_ramp_users"("celo_wallet");

-- AlterTable
ALTER TABLE "zylo_ramp_bank_sends" ADD COLUMN IF NOT EXISTS "chain" VARCHAR(16) NOT NULL DEFAULT 'stellar';
ALTER TABLE "zylo_ramp_bank_sends" ADD COLUMN IF NOT EXISTS "celo_tx_hash" VARCHAR(66);
