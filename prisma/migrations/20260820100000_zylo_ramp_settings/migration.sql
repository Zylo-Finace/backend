-- Admin-editable ramp rates / order limits (singleton row id=1)
CREATE TABLE IF NOT EXISTS "zylo_ramp_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "sell_rate_ngn" INTEGER NOT NULL,
    "buy_rate_ngn" INTEGER NOT NULL,
    "max_order_usdc" DECIMAL(18,6) NOT NULL,
    "min_bank_send_ngn" INTEGER NOT NULL,
    "max_bank_send_ngn" INTEGER NOT NULL,
    "sell_fee_ngn" INTEGER NOT NULL DEFAULT 0,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zylo_ramp_settings_pkey" PRIMARY KEY ("id")
);

-- Seed from typical env defaults; admin dashboard can overwrite without redeploy.
INSERT INTO "zylo_ramp_settings" (
    "id",
    "sell_rate_ngn",
    "buy_rate_ngn",
    "max_order_usdc",
    "min_bank_send_ngn",
    "max_bank_send_ngn",
    "sell_fee_ngn",
    "updated_at",
    "created_at"
)
VALUES (1, 1550, 1600, 1, 100, 500000, 0, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
