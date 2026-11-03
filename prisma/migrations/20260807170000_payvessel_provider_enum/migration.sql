-- PayVessel as a virtual-account provider.
--
-- Alone in its own migration on purpose: Postgres refuses to *use* an enum value
-- in the same transaction that adds it, and the next migration uses 'PAYVESSEL'
-- as a column DEFAULT. Splitting is the documented workaround.
ALTER TYPE "BankAccountProvider" ADD VALUE IF NOT EXISTS 'PAYVESSEL';
