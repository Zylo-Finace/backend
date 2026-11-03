-- CreateEnum
CREATE TYPE "PayoutProviderName" AS ENUM ('FALCONPAY', 'MANUAL');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW');

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "PayoutProviderName" NOT NULL DEFAULT 'FALCONPAY',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" VARCHAR(128) NOT NULL,
    "providerReference" VARCHAR(128),
    "sessionId" VARCHAR(64),
    "amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
    "bankCode" VARCHAR(16) NOT NULL,
    "bankName" VARCHAR(120) NOT NULL,
    "accountNumber" VARCHAR(20) NOT NULL,
    "accountName" VARCHAR(160) NOT NULL,
    "narration" VARCHAR(255),
    "ledgerEntryId" UUID,
    "failureReason" VARCHAR(512),
    "metadata" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payouts_providerReference_idx" ON "payouts"("providerReference");

-- CreateIndex
CREATE INDEX "payouts_userId_createdAt_idx" ON "payouts"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payouts_tenantId_status_createdAt_idx" ON "payouts"("tenantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_tenantId_reference_key" ON "payouts"("tenantId", "reference");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

