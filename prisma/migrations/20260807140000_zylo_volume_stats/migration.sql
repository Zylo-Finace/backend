-- Internal USDC/XLM volume + transfer counters (not exposed in product UI)
CREATE TABLE IF NOT EXISTS "zylo_ramp_volume_stats" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "usdc_volume" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "xlm_volume" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "usdc_transfers" INTEGER NOT NULL DEFAULT 0,
    "xlm_transfers" INTEGER NOT NULL DEFAULT 0,
    "transfer_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zylo_ramp_volume_stats_pkey" PRIMARY KEY ("id")
);

INSERT INTO "zylo_ramp_volume_stats" ("id", "usdc_volume", "xlm_volume", "usdc_transfers", "xlm_transfers", "transfer_count", "updated_at")
VALUES (1, 0, 0, 0, 0, 0, NOW())
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "zylo_ramp_volume_events" (
    "id" SERIAL NOT NULL,
    "dedupe_key" VARCHAR(160) NOT NULL,
    "asset" VARCHAR(8) NOT NULL,
    "amount" DECIMAL(24,6) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zylo_ramp_volume_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "zylo_ramp_volume_events_dedupe_key_key" ON "zylo_ramp_volume_events"("dedupe_key");
CREATE INDEX IF NOT EXISTS "zylo_ramp_volume_events_asset_idx" ON "zylo_ramp_volume_events"("asset");
CREATE INDEX IF NOT EXISTS "zylo_ramp_volume_events_kind_idx" ON "zylo_ramp_volume_events"("kind");
