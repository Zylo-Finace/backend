-- Profile photos, BANJEE Points ledger and referrals.

-- CreateEnum
CREATE TYPE "RewardReason" AS ENUM ('SIGNUP', 'DAILY_CHECK_IN', 'STREAK_BONUS', 'TRANSACTION_MILESTONE', 'REFERRAL_REFERRER', 'REFERRAL_REFEREE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "usernameChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_avatars" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contentType" VARCHAR(32) NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "reward_profiles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "referralCode" VARCHAR(16) NOT NULL,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastCheckInDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_ledger_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" "RewardReason" NOT NULL,
    "points" INTEGER NOT NULL,
    "dedupeKey" VARCHAR(96) NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" VARCHAR(255),
    "signupIp" VARCHAR(45),
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_avatars_tenantId_idx" ON "user_avatars"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_profiles_userId_key" ON "reward_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_profiles_tenantId_referralCode_key" ON "reward_profiles"("tenantId", "referralCode");

-- CreateIndex
CREATE INDEX "reward_ledger_entries_tenantId_userId_createdAt_idx" ON "reward_ledger_entries"("tenantId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reward_ledger_entries_userId_dedupeKey_key" ON "reward_ledger_entries"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "referrals_tenantId_referrerId_createdAt_idx" ON "referrals"("tenantId", "referrerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "referrals_tenantId_status_idx" ON "referrals"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId");

-- AddForeignKey
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_profiles" ADD CONSTRAINT "reward_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_ledger_entries" ADD CONSTRAINT "reward_ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Nobody refers themselves, whatever the application layer does.
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_not_self_check" CHECK ("referrerId" <> "refereeId");
