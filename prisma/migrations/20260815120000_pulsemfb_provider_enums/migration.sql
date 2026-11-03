-- Pulse MFB, as both a virtual-account issuer and a payout provider.
--
-- Alone in its own migration on purpose, for the same reason the PayVessel one
-- is: Postgres refuses to *use* an enum value in the same transaction that adds
-- it. Any later migration that wants 'PULSEMFB' as a column DEFAULT — or any
-- backfill that writes it — needs this to have committed first.
ALTER TYPE "BankAccountProvider" ADD VALUE IF NOT EXISTS 'PULSEMFB';
ALTER TYPE "PayoutProviderName" ADD VALUE IF NOT EXISTS 'PULSEMFB';
