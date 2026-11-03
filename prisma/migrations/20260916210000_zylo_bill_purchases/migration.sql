-- WhatsApp airtime / data / electricity / cable / betting audit + volume source.
CREATE TABLE "zylo_ramp_bill_purchases" (
    "id" SERIAL NOT NULL,
    "ref" VARCHAR(64) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "vertical" VARCHAR(32) NOT NULL,
    "amount_ngn" INTEGER NOT NULL,
    "amount_usdc" DECIMAL(18,6) NOT NULL,
    "rate" INTEGER NOT NULL,
    "product_label" VARCHAR(160),
    "customer_id" VARCHAR(64),
    "customer_name" VARCHAR(160),
    "status" VARCHAR(32) NOT NULL,
    "chain" VARCHAR(16) NOT NULL DEFAULT 'stellar',
    "stellar_tx_hash" VARCHAR(128),
    "celo_tx_hash" VARCHAR(66),
    "provider_reference" VARCHAR(128),
    "failure_reason" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zylo_ramp_bill_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zylo_ramp_bill_purchases_ref_key" ON "zylo_ramp_bill_purchases"("ref");
CREATE INDEX "zylo_ramp_bill_purchases_phone_idx" ON "zylo_ramp_bill_purchases"("phone");
CREATE INDEX "zylo_ramp_bill_purchases_vertical_idx" ON "zylo_ramp_bill_purchases"("vertical");
CREATE INDEX "zylo_ramp_bill_purchases_status_idx" ON "zylo_ramp_bill_purchases"("status");
CREATE INDEX "zylo_ramp_bill_purchases_created_at_idx" ON "zylo_ramp_bill_purchases"("created_at");
