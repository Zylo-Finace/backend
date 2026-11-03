-- AlterTable
ALTER TABLE "zylo_ramp_users" ADD COLUMN IF NOT EXISTS "zylo_wallet_legacy" VARCHAR(72);
