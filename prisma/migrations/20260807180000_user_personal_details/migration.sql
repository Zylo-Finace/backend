-- Personal details on the user record, populated automatically when a customer
-- clears KYC tier 1.
--
-- These duplicate what `kyc_identity_records` holds, deliberately: that table is
-- the *evidence* (one row per registry, immutable enough to answer a dispute),
-- and these are the *current profile* — read on every receipt, statement and
-- account-creation call, on paths that have no business joining a KYC table.
--
-- `address` is the exception: neither the BVN nor the NIN enhanced response
-- carries one, so it stays null until a customer or an operator supplies it.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "firstName" VARCHAR(80),
    ADD COLUMN IF NOT EXISTS "middleName" VARCHAR(80),
    ADD COLUMN IF NOT EXISTS "lastName" VARCHAR(80),
    ADD COLUMN IF NOT EXISTS "gender" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "dateOfBirth" DATE,
    ADD COLUMN IF NOT EXISTS "address" VARCHAR(255);
