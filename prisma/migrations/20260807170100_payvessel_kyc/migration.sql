-- PayVessel virtual accounts (static + dynamic) and the KYC structure that gates
-- them.

-- CreateEnum
CREATE TYPE "VirtualAccountType" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "OnrampAccountStatus" AS ENUM ('AWAITING_PAYMENT', 'PAID', 'FULFILLED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KycLevel" AS ENUM ('TIER_0', 'TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycIdentifierType" AS ENUM ('BVN', 'NIN');

-- CreateEnum
CREATE TYPE "KycCheckMode" AS ENUM ('BASIC', 'ENHANCED');

-- CreateEnum
CREATE TYPE "KycCheckStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCH', 'NOT_FOUND', 'FAILED');

-- CreateEnum
CREATE TYPE "KycProviderName" AS ENUM ('PAYVESSEL', 'MANUAL');

-- AlterTable
-- Existing rows are all permanent funding accounts, so STATIC is correct for the
-- backfill as well as the default.
ALTER TABLE "bank_accounts"
    ADD COLUMN IF NOT EXISTS "accountType" "VirtualAccountType" NOT NULL DEFAULT 'STATIC';

-- CreateTable
CREATE TABLE "onramp_virtual_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "userId" UUID,
    "phoneE164" VARCHAR(20),
    "provider" "BankAccountProvider" NOT NULL DEFAULT 'PAYVESSEL',
    "reference" VARCHAR(128) NOT NULL,
    "bankName" VARCHAR(120) NOT NULL,
    "bankCode" VARCHAR(16) NOT NULL,
    "accountName" VARCHAR(160) NOT NULL,
    "accountNumber" VARCHAR(20) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
    "expectedAmountKobo" BIGINT NOT NULL,
    "paidAmountKobo" BIGINT,
    "status" "OnrampAccountStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "orderRef" VARCHAR(64),
    "paymentReference" VARCHAR(128),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onramp_virtual_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onramp_virtual_accounts_provider_reference_key" ON "onramp_virtual_accounts"("provider", "reference");
CREATE INDEX "onramp_virtual_accounts_accountNumber_status_idx" ON "onramp_virtual_accounts"("accountNumber", "status");
CREATE INDEX "onramp_virtual_accounts_phoneE164_status_idx" ON "onramp_virtual_accounts"("phoneE164", "status");
CREATE INDEX "onramp_virtual_accounts_status_expiresAt_idx" ON "onramp_virtual_accounts"("status", "expiresAt");
CREATE INDEX "onramp_virtual_accounts_orderRef_idx" ON "onramp_virtual_accounts"("orderRef");

-- AddForeignKey
ALTER TABLE "onramp_virtual_accounts"
    ADD CONSTRAINT "onramp_virtual_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "kyc_profiles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "level" "KycLevel" NOT NULL DEFAULT 'TIER_0',
    "status" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "bvnEncrypted" VARCHAR(512),
    "bvnHash" VARCHAR(64),
    "bvnLast4" VARCHAR(4),
    "bvnVerifiedAt" TIMESTAMP(3),
    "ninEncrypted" VARCHAR(512),
    "ninHash" VARCHAR(64),
    "ninLast4" VARCHAR(4),
    "ninVerifiedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(512),
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_userId_key" ON "kyc_profiles"("userId");
CREATE INDEX "kyc_profiles_tenantId_bvnHash_idx" ON "kyc_profiles"("tenantId", "bvnHash");
CREATE INDEX "kyc_profiles_tenantId_ninHash_idx" ON "kyc_profiles"("tenantId", "ninHash");
CREATE INDEX "kyc_profiles_tenantId_level_status_idx" ON "kyc_profiles"("tenantId", "level", "status");

-- AddForeignKey
ALTER TABLE "kyc_profiles"
    ADD CONSTRAINT "kyc_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "profileId" UUID,
    "provider" "KycProviderName" NOT NULL DEFAULT 'PAYVESSEL',
    "identifierType" "KycIdentifierType" NOT NULL,
    "mode" "KycCheckMode" NOT NULL,
    "status" "KycCheckStatus" NOT NULL DEFAULT 'PENDING',
    "identifierLast4" VARCHAR(4),
    "nameMatchPercent" INTEGER,
    "matchResult" JSONB,
    "response" JSONB,
    "error" VARCHAR(1024),
    "charged" BOOLEAN NOT NULL DEFAULT false,
    "chargedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "requestedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_verifications_tenantId_userId_createdAt_idx" ON "kyc_verifications"("tenantId", "userId", "createdAt" DESC);
CREATE INDEX "kyc_verifications_tenantId_status_createdAt_idx" ON "kyc_verifications"("tenantId", "status", "createdAt" DESC);
CREATE INDEX "kyc_verifications_profileId_idx" ON "kyc_verifications"("profileId");

-- AddForeignKey
ALTER TABLE "kyc_verifications"
    ADD CONSTRAINT "kyc_verifications_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kyc_verifications"
    ADD CONSTRAINT "kyc_verifications_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "kyc_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
-- The identity a registry holds against one identifier. Two rows per fully
-- verified customer (BVN + NIN), kept apart so tier 2 can compare them.
CREATE TABLE "kyc_identity_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "source" "KycIdentifierType" NOT NULL,
    "identifierLast4" VARCHAR(4),
    "firstName" VARCHAR(80),
    "middleName" VARCHAR(80),
    "lastName" VARCHAR(80),
    "nameOnCard" VARCHAR(160),
    "gender" VARCHAR(16),
    "dateOfBirth" DATE,
    "phoneNumber" VARCHAR(20),
    "phoneNumber2" VARCHAR(20),
    "nameMatchPercent" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_identity_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One current snapshot per registry, replaced on re-verification.
CREATE UNIQUE INDEX "kyc_identity_records_profileId_source_key" ON "kyc_identity_records"("profileId", "source");
CREATE INDEX "kyc_identity_records_tenantId_userId_idx" ON "kyc_identity_records"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "kyc_identity_records"
    ADD CONSTRAINT "kyc_identity_records_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kyc_identity_records"
    ADD CONSTRAINT "kyc_identity_records_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "kyc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A BVN or NIN must never be reachable through a plain equality scan on a
-- readable column. The digest is what we index; the number itself only ever
-- lands in "bvnEncrypted"/"ninEncrypted" as an AES-256-GCM envelope.
COMMENT ON COLUMN "kyc_profiles"."bvnEncrypted" IS 'AES-256-GCM envelope. Decrypt only to call a provider.';
COMMENT ON COLUMN "kyc_profiles"."ninEncrypted" IS 'AES-256-GCM envelope. Decrypt only to call a provider.';
