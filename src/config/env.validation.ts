import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

/** Providers that can send money *out* to a third-party Nigerian bank account. */
export enum PayoutProvider {
  FalconPay = 'falconpay',
  /**
   * Pulse MFB. Debits a float we hold with them rather than settling per
   * transaction, so it is configured as the *fallback* behind FalconPay
   * (`PAYOUT_FALLBACK_PROVIDER`) rather than as a primary.
   */
  PulseMfb = 'pulsemfb',
  /** No integration — payouts are executed by an operator out of band. */
  Manual = 'manual',
}

/** Payment providers that can issue Nigerian dedicated virtual accounts. */
export enum PaymentProvider {
  Paystack = 'paystack',
  PayVessel = 'payvessel',
  /**
   * Pulse MFB. Issues sub-accounts of our own account (every NUBAN carries our
   * business prefix) rather than partner-bank NUBANs, so inbound funds land in
   * our balance with them instead of settling from a partner.
   */
  PulseMfb = 'pulsemfb',
  Flutterwave = 'flutterwave',
  Monnify = 'monnify',
  /** No integration — accounts are entered by an operator. */
  Manual = 'manual',
}

/** Providers that can verify a Nigerian BVN or NIN against the registry. */
export enum KycProvider {
  PayVessel = 'payvessel',
  /** No integration — every verification call fails closed. */
  Disabled = 'disabled',
}

/**
 * The KYC ladder, mirrored from the `KycLevel` Prisma enum.
 *
 * Duplicated rather than imported because env validation runs before the Prisma
 * client is loaded, and a config layer that cannot be validated without a
 * generated database client is a config layer that breaks `--help`.
 */
export enum KycTier {
  Tier0 = 'tier_0',
  Tier1 = 'tier_1',
  Tier2 = 'tier_2',
  Tier3 = 'tier_3',
}

/** Providers that can deliver airtime, data, electricity, cable TV and betting top-ups. */
export enum BillsProvider {
  /**
   * All five verticals, paid from the same FalconPay wallet as transfers, with a
   * per-purchase discount. The default.
   */
  FalconPay = 'falconpay',
  ClubKonnect = 'clubkonnect',
  /**
   * Airtime and data only, and cheaper at both.
   *
   * Cannot stand alone: electricity, cable TV and betting have no SMEPlug
   * equivalent, so selecting this requires a fallback provider behind it. That
   * pairing is checked at boot.
   */
  SmePlug = 'smeplug',
  /**
   * Airtime and data only, billed against our Pulse MFB float.
   *
   * Like SMEPlug it cannot stand alone — it sells none of electricity, cable TV
   * or betting — so it is only ever selectable as a *fallback tier*
   * (`BILLS_VAS_FALLBACK_PROVIDER`), never as `BILLS_PROVIDER`.
   */
  PulseMfb = 'pulsemfb',
  /** No integration — every bill-payment call fails closed. */
  Disabled = 'disabled',
}

export enum LogFormat {
  Pretty = 'pretty',
  Json = 'json',
}

/**
 * Env vars arrive as strings. These transformers normalise them *before* validation
 * so that `@IsInt()` / `@IsBoolean()` are meaningful rather than always failing.
 */
const ToInt = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  });

const ToBool = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const normalised = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
    if (['false', '0', 'no', 'off'].includes(normalised)) return false;
    return value;
  });

const ToFloat = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : value;
  });

/** Duration strings accepted by JWT / ms: `15m`, `30d`, `3600s`, `12h`. */
const DURATION_PATTERN = /^\d+(ms|s|m|h|d|w|y)$/;

/**
 * The single source of truth for every environment variable the process reads.
 *
 * Validation runs once, synchronously, at boot. A misconfigured deployment fails
 * immediately and loudly at startup instead of throwing on first use in production.
 */
export class EnvironmentVariables {
  // -- Application ----------------------------------------------------------
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @ToInt()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  APP_URL: string = 'http://localhost:3000';

  @IsString()
  @MinLength(1)
  APP_NAME: string = 'wabot-platform';

  @IsString()
  @IsOptional()
  CORS_ORIGINS?: string;

  @ToInt()
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 1;

  @IsString()
  BODY_LIMIT: string = '2mb';

  @ToInt()
  @IsInt()
  @Min(0)
  SHUTDOWN_TIMEOUT_MS: number = 15_000;

  // -- Database -------------------------------------------------------------
  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @ToInt()
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_SIZE: number = 15;

  @ToInt()
  @IsInt()
  @Min(1)
  DB_POOL_TIMEOUT_SECONDS: number = 10;

  @ToInt()
  @IsInt()
  @Min(0)
  DB_STATEMENT_TIMEOUT_MS: number = 15_000;

  @ToBool()
  @IsBoolean()
  DB_LOG_QUERIES: boolean = false;

  @ToInt()
  @IsInt()
  @Min(0)
  DB_SLOW_QUERY_MS: number = 300;

  // -- Redis ----------------------------------------------------------------
  @IsString()
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must be a redis:// or rediss:// URL' })
  REDIS_URL!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9_:-]+$/, {
    message: 'REDIS_KEY_PREFIX must contain only [a-zA-Z0-9_:-]',
  })
  REDIS_KEY_PREFIX: string = 'wabot';

  @ToBool()
  @IsBoolean()
  REDIS_TLS: boolean = false;

  // -- Security -------------------------------------------------------------
  /** Base64-encoded 32-byte key for AES-256-GCM. Length is re-checked by the crypto service. */
  @IsString()
  @MinLength(32)
  ENCRYPTION_KEY!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET!: string;

  @Matches(DURATION_PATTERN, { message: 'JWT_ACCESS_TTL must look like "15m", "3600s", "1h"' })
  JWT_ACCESS_TTL: string = '15m';

  @Matches(DURATION_PATTERN, { message: 'JWT_REFRESH_TTL must look like "30d", "720h"' })
  JWT_REFRESH_TTL: string = '30d';

  @IsString()
  JWT_ISSUER: string = 'wabot-platform';

  /** Comma-separated E.164 / local phones allowed to use `/auth/admin/login`. */
  @IsString()
  @IsOptional()
  ADMIN_PHONES?: string;

  // -- Rate limiting --------------------------------------------------------
  @ToInt()
  @IsInt()
  @Min(1)
  RATE_LIMIT_TTL_SECONDS: number = 60;

  @ToInt()
  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX: number = 600;

  // -- Payments -------------------------------------------------------------
  @IsEnum(PaymentProvider)
  PAYMENT_PROVIDER: PaymentProvider = PaymentProvider.Paystack;

  @IsString()
  @IsOptional()
  PAYSTACK_SECRET_KEY?: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  PAYSTACK_BASE_URL: string = 'https://api.paystack.co';

  @IsString()
  PAYSTACK_PREFERRED_BANK: string = 'wema-bank';

  @ToInt()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  PAYMENT_HTTP_TIMEOUT_MS: number = 10_000;

  @ToInt()
  @IsInt()
  @Min(0)
  WEBHOOK_MAX_AGE_SECONDS: number = 300;

  // -- PayVessel (virtual accounts + identity verification) -------------------
  // PayVessel issues both permanent (STATIC) and single-use (DYNAMIC) NUBANs and
  // verifies BVN/NIN. The two live behind different base paths — collections on
  // the root host, KYC under `/kyc` — so they are configured separately even
  // though one credential pair authenticates both.

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  PAYVESSEL_BASE_URL: string = 'https://api.payvessel.com';

  /** KYC endpoints are served from a distinct prefix on the same host. */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  PAYVESSEL_KYC_BASE_URL: string = 'https://api.payvessel.com/kyc';

  /** Sent as the `api-key` header. Production keys start `PVKEY-`. */
  @IsString()
  @IsOptional()
  PAYVESSEL_API_KEY?: string;

  /**
   * Sent as the `api-secret` header *and* used as the HMAC-SHA512 key that signs
   * inbound webhooks. PayVessel uses one secret for both directions, so rolling
   * it invalidates in-flight webhook deliveries as well as API access.
   */
  @IsString()
  @IsOptional()
  PAYVESSEL_API_SECRET?: string;

  /** Merchant business id; required in the body of every account call. */
  @IsString()
  @IsOptional()
  PAYVESSEL_BUSINESS_ID?: string;

  /**
   * Partner banks to request a permanent account from, most-preferred first.
   * `999991` PalmPay, `120001` 9 Payment Service Bank, `090175` Rubies MFB.
   * More than one is allowed and useful: the customer gets a choice of NUBAN,
   * and a bank that is down for provisioning does not block the others.
   */
  @IsString()
  PAYVESSEL_STATIC_BANK_CODES: string = '999991,120001';

  /**
   * Partner bank for single-use accounts. Only Rubies MFB (`090175`) and 9PSB
   * (`120001`) support DYNAMIC issuance, and exactly one code is sent per
   * request because the customer is shown exactly one account to pay into.
   */
  @IsString()
  PAYVESSEL_DYNAMIC_BANK_CODE: string = '120001';

  /**
   * How long a single-use account is advertised for. Kept comfortably below
   * PayVessel's own expiry so we stop showing an account before *they* start
   * refunding senders — a customer who pays a just-expired account gets their
   * money back days later and no crypto, which reads as theft.
   */
  @ToInt()
  @IsInt()
  @Min(5)
  @Max(1_440)
  PAYVESSEL_DYNAMIC_ACCOUNT_TTL_MINUTES: number = 30;

  /** Comma-separated source addresses PayVessel delivers webhooks from. */
  @IsString()
  PAYVESSEL_WEBHOOK_IPS: string = '3.255.23.38,162.246.254.36';

  /**
   * Whether a webhook from an unlisted address is rejected.
   *
   * Defaults on. Turn it off only when a tunnel or proxy rewrites the source
   * address in a way `X-Forwarded-For` cannot recover — the HMAC still
   * authenticates the payload, the allowlist is defence in depth.
   */
  @ToBool()
  @IsBoolean()
  PAYVESSEL_WEBHOOK_ENFORCE_IPS: boolean = true;

  // -- KYC --------------------------------------------------------------------

  /**
   * Defaults to `disabled`, matching how the other optional integrations
   * behave: a business that has not signed up with a verification provider
   * should not be prevented from booting. Every verification call then fails
   * closed with a clear message, which is the only safe reading of "no
   * provider" — a KYC integration that silently approves is worse than none.
   */
  @IsEnum(KycProvider)
  KYC_PROVIDER: KycProvider = KycProvider.Disabled;

  /**
   * The level a customer must reach before we will ask a partner bank for a
   * permanent account. TIER_2 (BVN *and* NIN) is the default because a static
   * NUBAN is a durable, transferable claim on a bank and one identifier is a
   * thin basis for issuing one.
   */
  @IsEnum(KycTier)
  KYC_STATIC_ACCOUNT_MIN_TIER: KycTier = KycTier.Tier2;

  /**
   * Name-similarity floor, 0–100, for a BASIC check to count as a match.
   *
   * Not 100: registries hold names inconsistently (middle names dropped,
   * hyphens, transliteration), so an exact-match rule rejects large numbers of
   * legitimate customers. Not 50 either — that lets unrelated people through.
   */
  @ToInt()
  @IsInt()
  @Min(0)
  @Max(100)
  KYC_NAME_MATCH_MIN_PERCENT: number = 70;

  /**
   * Name-similarity floor, 0–100, for the tier-2 NIN ↔ BVN comparison.
   *
   * Higher than the basic-check floor above, and measuring something different:
   * this compares two *government registries* to each other rather than a
   * customer's typing to one of them. Both sides are authoritative, so genuine
   * disagreement is narrower and the bar can be raised — and it should be,
   * because clearing it is what unlocks a permanent bank account.
   */
  @ToInt()
  @IsInt()
  @Min(0)
  @Max(100)
  KYC_CROSS_MATCH_NAME_MIN_PERCENT: number = 80;

  /**
   * Failed verification attempts allowed per customer per rolling day.
   *
   * A real control, not hygiene. Tier 1 tells the customer whether a supplied
   * date of birth matches a supplied BVN — repeat that freely and it becomes an
   * oracle for guessing somebody else's date of birth one attempt at a time.
   * Each attempt also costs a provider charge.
   */
  @ToInt()
  @IsInt()
  @Min(1)
  KYC_MAX_FAILED_ATTEMPTS_PER_DAY: number = 5;

  /**
   * Whether one BVN or NIN may appear on more than one customer profile.
   *
   * Off by default. One identifier across many accounts is the standard shape of
   * bonus farming and of mule networks, and it is far cheaper to block at
   * submission than to unwind afterwards.
   */
  @ToBool()
  @IsBoolean()
  KYC_ALLOW_DUPLICATE_IDENTIFIERS: boolean = false;

  // -- Payouts (FalconPay) --------------------------------------------------
  // Outward transfers are a separate integration from the inbound provider
  // above: FalconPay moves money *out* to third-party NUBANs, Paystack issues
  // the dedicated accounts money comes *in* to. They are configured
  // independently so either can be swapped without touching the other.
  @IsEnum(PayoutProvider)
  PAYOUT_PROVIDER: PayoutProvider = PayoutProvider.FalconPay;

  /**
   * Who re-places a transfer the primary could not accept.
   *
   * `manual` (the default) means no fallback: a refused transfer fails, as it
   * did before this setting existed.
   *
   * Failover on this path is far narrower than on bills, and deliberately so. A
   * NIP transfer is irreversible, so a second attempt is only ever made when the
   * primary has *definitely* not queued the first — a timeout is not that, and
   * never triggers one. See `RoutedPayoutProvider` for the full rule.
   */
  @IsEnum(PayoutProvider)
  PAYOUT_FALLBACK_PROVIDER: PayoutProvider = PayoutProvider.Manual;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  FALCONPAY_API_URL: string = 'https://payment.falconpay.ng/v1';

  /** `stripe_dummy_live_…` (or `stripe_dummy_test_…` against the sandbox). Sent as `x-api-key`. */
  @IsString()
  @IsOptional()
  FALCONPAY_SECRET_KEY?: string;

  /** Not used for server-to-server calls; retained for dashboard parity. */
  @IsString()
  @IsOptional()
  FALCONPAY_PUBLIC_KEY?: string;

  /**
   * `whsec_live_…`, issued once when the webhook is registered. Distinct from
   * the API key: it signs inbound payloads, it does not authenticate outbound
   * calls, and rolling one must not invalidate the other.
   */
  @IsString()
  @IsOptional()
  FALCONPAY_WEBHOOK_SECRET?: string;

  /** Where FalconPay posts status updates. Registered with them, not read by us. */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @IsOptional()
  FALCONPAY_WEBHOOK_URL?: string;

  /**
   * The `sender_name` on every transfer — what the recipient sees on their bank
   * statement. Required by the API on each request, but it is a property of the
   * business, not of the payout, so it is configured once here.
   */
  @IsString()
  @MinLength(2)
  FALCONPAY_SENDER_NAME: string = 'BANJEE';

  /**
   * Largest single payout, in whole naira. A ceiling that is *ours* rather than
   * the provider's: it caps the blast radius of a compromised customer session
   * or a unit bug that inflates an amount by 100×.
   */
  @ToInt()
  @IsInt()
  @Min(1)
  PAYOUT_MAX_AMOUNT_NAIRA: number = 1_000_000;

  /** Smallest single payout, in whole naira. Below this, fees dominate. */
  @ToInt()
  @IsInt()
  @Min(1)
  PAYOUT_MIN_AMOUNT_NAIRA: number = 100;

  // -- Bill payments ----------------------------------------------------------
  // A third, independent leg: it neither issues funding accounts nor sends money
  // to bank accounts — it delivers value (airtime, data, units, subscriptions)
  // against a prepaid float. FalconPay reuses the FALCONPAY_* credentials above.
  @IsEnum(BillsProvider)
  BILLS_PROVIDER: BillsProvider = BillsProvider.FalconPay;

  /**
   * ClubKonnect serves the same API from `clubkonnect.com` and its original
   * `nellobytesystems.com` host. The latter is what every documented endpoint
   * uses, so it is the default.
   */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  CLUBKONNECT_BASE_URL: string = 'https://www.nellobytesystems.com';

  /** Account UserID, e.g. `CK123456`. Sent as a query parameter on every call. */
  @IsString()
  @IsOptional()
  CLUBKONNECT_USER_ID?: string;

  /**
   * API key from the ClubKonnect dashboard.
   *
   * Note this travels in the **query string**, not a header — that is the
   * provider's design, not a choice available to us. It is why request URLs are
   * redacted before they reach a log line.
   */
  @IsString()
  @IsOptional()
  CLUBKONNECT_API_KEY?: string;

  /** Where ClubKonnect posts order status transitions. Registered per request. */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @IsOptional()
  CLUBKONNECT_CALLBACK_URL?: string;

  /**
   * Generous by web-request standards because these calls sit in front of mobile
   * networks and disco billing systems, which are genuinely slow. Too short a
   * deadline manufactures unknown outcomes: we abandon a request the provider
   * went on to fulfil.
   */
  @ToInt()
  @IsInt()
  @Min(5_000)
  @Max(120_000)
  CLUBKONNECT_HTTP_TIMEOUT_MS: number = 30_000;

  /**
   * Float kept in reserve, in whole naira. Orders are refused once they would
   * eat into it, leaving headroom for in-flight orders whose cost has not yet
   * been deducted upstream.
   */
  @ToInt()
  @IsInt()
  @Min(0)
  CLUBKONNECT_FLOAT_RESERVE_NAIRA: number = 0;

  /**
   * How long a float-balance reading may be reused, in seconds.
   *
   * Short on purpose: this figure gates spending. Zero disables caching and
   * reads the live balance before every order.
   */
  @ToInt()
  @IsInt()
  @Min(0)
  @Max(300)
  CLUBKONNECT_BALANCE_CACHE_SECONDS: number = 15;

  /** Catalogue TTL, in seconds. Plans and package prices change on the order of days. */
  @ToInt()
  @IsInt()
  @Min(0)
  CLUBKONNECT_CATALOGUE_CACHE_SECONDS: number = 3_600;

  // -- SMEPlug (airtime + data) ---------------------------------------------
  // Leads on the two high-volume verticals when `BILLS_PROVIDER=smeplug`, with
  // the provider below serving everything else and catching its failures.

  /**
   * Who serves an order the leading provider cannot.
   *
   * Not optional in practice when `BILLS_PROVIDER=smeplug`: SMEPlug sells no
   * electricity, cable TV or betting, so without this three of five verticals
   * have no provider at all. Checked at boot.
   */
  @IsEnum(BillsProvider)
  BILLS_FALLBACK_PROVIDER: BillsProvider = BillsProvider.ClubKonnect;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  SMEPLUG_BASE_URL: string = 'https://smeplug.ng/api/v1';

  /** Sent as `Authorization: Bearer …` on every call. */
  @IsString()
  @IsOptional()
  SMEPLUG_SECRET_KEY?: string;

  /**
   * A secret of *ours*, embedded in the webhook path we register with SMEPlug.
   *
   * SMEPlug does not sign its webhooks — there is no HMAC, no timestamp and no
   * shared secret in the payload — so an unguessable URL is the only
   * authentication available. Treated as a credential accordingly: long, random,
   * and rotated by re-registering the URL.
   */
  @IsString()
  @IsOptional()
  SMEPLUG_WEBHOOK_SECRET?: string;

  /**
   * The last airtime/data tier, tried after both SMEPlug and ClubKonnect.
   *
   * `disabled` (the default) leaves the existing two-provider chain exactly as
   * it was. Only `pulsemfb` is accepted here — the other values name providers
   * already in the chain, and putting one behind itself is a configuration
   * mistake that would silently double every failed order's latency.
   */
  @IsEnum(BillsProvider)
  BILLS_VAS_FALLBACK_PROVIDER: BillsProvider = BillsProvider.Disabled;

  // -- Pulse MFB ------------------------------------------------------------
  //
  // Off unless PULSEMFB_ENABLED=true. Leftover Railway keys / fallback=pulsemfb
  // must not take down FalconPay or WhatsApp.

  /**
   * Master switch. Default off. Set true only when Pulse keys and debit
   * accounts are actually populated and you want it in the payout/VAS chain.
   */
  @ToBool()
  @IsBoolean()
  PULSEMFB_ENABLED: boolean = false;

  /**
   * Their `http://test-api.pulsemfb.com` sandbox is plain HTTP, which is why
   * `http` is permitted here at all. `validateEnv` refuses to boot production
   * against a non-HTTPS URL — a signed request over HTTP still exposes the
   * account numbers and customer names in its body.
   */
  @ValidateIf((o: EnvironmentVariables) => o.PULSEMFB_ENABLED)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  PULSEMFB_BASE_URL: string = 'https://api.pulsemfb.com';

  /** Sent as `x-public-key`. Identifies the API client; not a secret. */
  @IsString()
  @IsOptional()
  PULSEMFB_PUBLIC_KEY?: string;

  /**
   * The HMAC key behind `x-signature`. **Never sent on the wire.**
   *
   * Shown exactly once, when the API client is created. Rotating it is a
   * dashboard operation (`POST /api-clients/:id/rotate-keys`) that leaves the
   * previous key valid for a grace period, so a rotation does not need a deploy.
   */
  @IsString()
  @IsOptional()
  PULSEMFB_PRIVATE_KEY?: string;

  /**
   * Optional `x-api-key`, sent alongside the signature headers when present.
   *
   * Their documentation describes signature auth, but several endpoints in the
   * published collection are exercised with a bare `x-api-key` instead. Sending
   * both when we hold both costs nothing and means a tenant provisioned under
   * either scheme works without a code change.
   */
  @IsString()
  @IsOptional()
  PULSEMFB_API_KEY?: string;

  /** Keys `X-Webhook-Signature`. Regenerated whenever the webhook URL changes. */
  @IsString()
  @IsOptional()
  PULSEMFB_WEBHOOK_SECRET?: string;

  @ToInt()
  @IsInt()
  @Min(1_000)
  @Max(120_000)
  PULSEMFB_HTTP_TIMEOUT_MS: number = 30_000;

  /**
   * How long a signed request stays valid upstream, in seconds.
   *
   * Pulse rejects anything older than five minutes to blunt replay. Mirrored
   * here so a badly-skewed clock is diagnosed as skew at boot rather than as a
   * blanket 401 in production.
   */
  @ToInt()
  @IsInt()
  @Min(30)
  @Max(300)
  PULSEMFB_SIGNATURE_TTL_SECONDS: number = 300;

  /**
   * The NIP code customers see for accounts we issue here.
   *
   * Pulse's create-account response names no bank, because from their side the
   * answer is always "us" — but our `VirtualAccount` has to tell a customer
   * where to send money, so it is supplied from config.
   */
  @ValidateIf((o: EnvironmentVariables) => o.PULSEMFB_ENABLED)
  @Matches(/^\d{3,6}$/, { message: 'PULSEMFB_BANK_CODE must be a 3-6 digit NIP code' })
  PULSEMFB_BANK_CODE: string = '090713';

  @IsString()
  PULSEMFB_BANK_NAME: string = 'Pulse MFB';

  /**
   * The account outward transfers are debited from — our float with Pulse.
   *
   * Required when Pulse is in the payout chain. There is no default and no
   * inference: guessing which of a business's accounts to drain is not something
   * this config layer will do.
   */
  @ValidateIf((o: EnvironmentVariables) => o.PULSEMFB_ENABLED)
  @Matches(/^\d{10}$/, { message: 'PULSEMFB_DEBIT_ACCOUNT_NUMBER must be a 10-digit NUBAN' })
  @IsOptional()
  PULSEMFB_DEBIT_ACCOUNT_NUMBER?: string;

  /**
   * The account id airtime and data purchases are debited from.
   *
   * Distinct from the NUBAN above because their VAS endpoints identify the
   * source by internal id (`debit_account_id`) while their transfer endpoint
   * identifies it by account number. Same account, two spellings.
   */
  @IsString()
  @IsOptional()
  PULSEMFB_DEBIT_ACCOUNT_ID?: string;

  // -- WhatsApp -------------------------------------------------------------
  @IsString()
  @IsOptional()
  META_APP_SECRET?: string;

  @IsString()
  @IsOptional()
  META_WEBHOOK_VERIFY_TOKEN?: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  META_GRAPH_BASE_URL: string = 'https://graph.facebook.com';

  @Matches(/^v\d+\.\d+$/, { message: 'META_GRAPH_VERSION must look like "v21.0"' })
  META_GRAPH_VERSION: string = 'v21.0';

  @ToInt()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  WHATSAPP_HTTP_TIMEOUT_MS: number = 15_000;

  @ToInt()
  @IsInt()
  @Min(1)
  @Max(24)
  WHATSAPP_SERVICE_WINDOW_HOURS: number = 24;

  // -- Observability --------------------------------------------------------
  @IsEnum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL: string = 'info';

  @IsEnum(LogFormat)
  LOG_FORMAT: LogFormat = LogFormat.Json;

  @ToBool()
  @IsBoolean()
  METRICS_ENABLED: boolean = true;

  @ToBool()
  @IsBoolean()
  TRACING_ENABLED: boolean = false;

  @IsString()
  @IsOptional()
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  @IsString()
  OTEL_SERVICE_NAME: string = 'wabot-api';

  @ToFloat()
  @Min(0)
  @Max(1)
  OTEL_SAMPLE_RATIO: number = 0.1;
}

/** Secrets that must never carry their placeholder value outside development. */
const PLACEHOLDER_GUARDED_KEYS = [
  'ENCRYPTION_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const satisfies readonly (keyof EnvironmentVariables)[];

/**
 * Railway (and most hosts) materialise unset keys as `""`. An empty string is
 * not a valid int/url/enum, and it also hides the class default because the
 * key is present. Treat blank values as omitted so numeric defaults apply.
 */
function omitBlankEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Validates `process.env` against {@link EnvironmentVariables}.
 *
 * @throws Error with every violation aggregated into one message — one restart shows
 *         the operator *all* the problems, not just the first.
 */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, omitBlankEnv(raw), {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
    forbidUnknownValues: true,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join('; ');
        return `  - ${error.property}: ${constraints || 'invalid value'}`;
      })
      .sort()
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  // Pulse stays inert unless explicitly switched on. Railway leftover
  // PAYOUT_FALLBACK_PROVIDER=pulsemfb / empty keys must not block listen().
  disablePulseUnlessEnabled(config);

  if (config.NODE_ENV === NodeEnv.Production || config.NODE_ENV === NodeEnv.Staging) {
    const unsafe = PLACEHOLDER_GUARDED_KEYS.filter((key) =>
      String(config[key]).toUpperCase().includes('CHANGE_ME'),
    );
    if (unsafe.length > 0) {
      throw new Error(
        `Refusing to boot in ${config.NODE_ENV}: placeholder secrets detected for ${unsafe.join(', ')}. ` +
          'Generate real values with `openssl rand -base64 32`.',
      );
    }
    if (!config.CORS_ORIGINS) {
      throw new Error(
        `Refusing to boot in ${config.NODE_ENV}: CORS_ORIGINS must be an explicit allowlist.`,
      );
    }

    // Without an app secret, webhook signature verification cannot run — and the
    // WhatsApp webhook has no other authentication.
    if (!config.META_APP_SECRET || config.META_APP_SECRET.includes('CHANGE_ME')) {
      throw new Error(
        `Refusing to boot in ${config.NODE_ENV}: META_APP_SECRET is required to verify WhatsApp webhooks.`,
      );
    }
    if (
      !config.META_WEBHOOK_VERIFY_TOKEN ||
      config.META_WEBHOOK_VERIFY_TOKEN.includes('CHANGE_ME')
    ) {
      throw new Error(
        `Refusing to boot in ${config.NODE_ENV}: META_WEBHOOK_VERIFY_TOKEN is required.`,
      );
    }

    // A configured provider with no key fails at the first customer registration,
    // which is the worst possible moment to discover it.
    if (config.PAYMENT_PROVIDER === PaymentProvider.Paystack) {
      if (!config.PAYSTACK_SECRET_KEY || config.PAYSTACK_SECRET_KEY.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack.`,
        );
      }
      if (config.PAYSTACK_SECRET_KEY.startsWith('stripe_dummy_test_')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYSTACK_SECRET_KEY is a test key. ` +
            'Real customer funds would settle against a sandbox.',
        );
      }
    }

    if (config.PAYMENT_PROVIDER === PaymentProvider.PayVessel) {
      for (const key of [
        'PAYVESSEL_API_KEY',
        'PAYVESSEL_API_SECRET',
        'PAYVESSEL_BUSINESS_ID',
      ] as const) {
        if (!config[key] || config[key].includes('CHANGE_ME')) {
          throw new Error(
            `Refusing to boot in ${config.NODE_ENV}: ${key} is required when PAYMENT_PROVIDER=payvessel.`,
          );
        }
      }
      // The sandbox settles against nothing. A customer who transfers real money
      // to a sandbox-issued NUBAN has sent it into a void we cannot recover from.
      if (config.PAYVESSEL_BASE_URL.includes('sandbox.')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYVESSEL_BASE_URL points at the sandbox. ` +
            'Customers would be shown account numbers that receive no real money.',
        );
      }
      // Without the allowlist there is still the HMAC, but silently dropping a
      // layer of defence in production should be a decision, not a typo.
      if (!config.PAYVESSEL_WEBHOOK_ENFORCE_IPS) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYVESSEL_WEBHOOK_ENFORCE_IPS=false disables the ` +
            'webhook source allowlist. Set PAYVESSEL_WEBHOOK_IPS to your proxy-visible addresses instead.',
        );
      }
      // PayVessel's partner banks will not issue a permanent account without a
      // verified BVN or NIN, and verification is what produces one. Disabled,
      // the two combine into a system that boots cleanly and silently issues no
      // funding accounts at all — discovered by a customer, not by us.
      if (config.KYC_PROVIDER === KycProvider.Disabled) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYMENT_PROVIDER=payvessel needs KYC_PROVIDER set, ` +
            'because a permanent virtual account cannot be issued without a verified BVN or NIN.',
        );
      }
    }

    if (config.KYC_PROVIDER === KycProvider.PayVessel) {
      if (!config.PAYVESSEL_API_KEY || !config.PAYVESSEL_API_SECRET) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PAYVESSEL_API_KEY and PAYVESSEL_API_SECRET are ` +
            'required when KYC_PROVIDER=payvessel.',
        );
      }
    }

    // Same reasoning for the outward leg. The failure mode is worse here: an
    // unconfigured payout provider is discovered when a customer has already
    // been told their withdrawal is on its way.
    if (config.PAYOUT_PROVIDER === PayoutProvider.FalconPay) {
      if (!config.FALCONPAY_SECRET_KEY || config.FALCONPAY_SECRET_KEY.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_SECRET_KEY is required when PAYOUT_PROVIDER=falconpay.`,
        );
      }
      if (config.FALCONPAY_SECRET_KEY.startsWith('stripe_dummy_test_')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_SECRET_KEY is a test key. ` +
            'Withdrawals would be acknowledged but no money would move.',
        );
      }
      // Without this, every inbound status update fails verification and no
      // payout ever reaches a terminal state — holds would accumulate forever.
      if (
        !config.FALCONPAY_WEBHOOK_SECRET ||
        config.FALCONPAY_WEBHOOK_SECRET.includes('CHANGE_ME')
      ) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_WEBHOOK_SECRET is required to verify payout status webhooks.`,
        );
      }
    }

    // FalconPay bills share the transfer credentials, but are checked on their
    // own: a deployment can buy bills from FalconPay while paying out elsewhere.
    // A live webhook is a precondition of /bills/pay on their side, so the
    // secret is required here too.
    if (config.BILLS_PROVIDER === BillsProvider.FalconPay) {
      if (!config.FALCONPAY_SECRET_KEY || config.FALCONPAY_SECRET_KEY.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_SECRET_KEY is required when BILLS_PROVIDER=falconpay.`,
        );
      }
      if (config.FALCONPAY_SECRET_KEY.startsWith('stripe_dummy_test_')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_SECRET_KEY is a test key. ` +
            'FalconPay refuses bill payments from test keys.',
        );
      }
      if (
        !config.FALCONPAY_WEBHOOK_SECRET ||
        config.FALCONPAY_WEBHOOK_SECRET.includes('CHANGE_ME')
      ) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: FALCONPAY_WEBHOOK_SECRET is required when BILLS_PROVIDER=falconpay.`,
        );
      }
    }

    if (config.BILLS_PROVIDER === BillsProvider.SmePlug) {
      if (!config.SMEPLUG_SECRET_KEY || config.SMEPLUG_SECRET_KEY.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: SMEPLUG_SECRET_KEY is required when BILLS_PROVIDER=smeplug.`,
        );
      }
      // SMEPlug sells airtime and data and nothing else. Alone, three of five
      // verticals would have no provider — discovered by the first customer who
      // tries to buy electricity.
      if (config.BILLS_FALLBACK_PROVIDER !== BillsProvider.ClubKonnect) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: BILLS_PROVIDER=smeplug needs ` +
            'BILLS_FALLBACK_PROVIDER=clubkonnect — SMEPlug sells no electricity, cable TV or betting.',
        );
      }
      // SMEPlug does not sign its webhooks, so the secret path segment is the
      // only thing standing between a stranger and a forged "success".
      if (!config.SMEPLUG_WEBHOOK_SECRET || config.SMEPLUG_WEBHOOK_SECRET.length < 24) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: SMEPLUG_WEBHOOK_SECRET must be at least 24 ` +
            'characters. SMEPlug does not sign webhooks, so the secret URL is the only authentication.',
        );
      }
    }

    // Bill payments fail closed without credentials, so an unconfigured
    // integration is discovered the first time a customer buys airtime. Catch it
    // at boot instead. Also required when ClubKonnect is only the fallback: that
    // is still the provider for three verticals.
    if (
      config.BILLS_PROVIDER === BillsProvider.ClubKonnect ||
      (config.BILLS_PROVIDER === BillsProvider.SmePlug &&
        config.BILLS_FALLBACK_PROVIDER === BillsProvider.ClubKonnect)
    ) {
      if (!config.CLUBKONNECT_USER_ID || config.CLUBKONNECT_USER_ID.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: CLUBKONNECT_USER_ID is required when BILLS_PROVIDER=clubkonnect.`,
        );
      }
      if (!config.CLUBKONNECT_API_KEY || config.CLUBKONNECT_API_KEY.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: CLUBKONNECT_API_KEY is required when BILLS_PROVIDER=clubkonnect.`,
        );
      }
      // Without a callback URL, orders that complete asynchronously are only
      // ever discovered by polling, and a delivered order can sit unrecorded.
      if (!config.CLUBKONNECT_CALLBACK_URL) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: CLUBKONNECT_CALLBACK_URL is required to receive order status updates.`,
        );
      }
    }

    if (config.PAYOUT_MIN_AMOUNT_NAIRA > config.PAYOUT_MAX_AMOUNT_NAIRA) {
      throw new Error(
        `Refusing to boot in ${config.NODE_ENV}: PAYOUT_MIN_AMOUNT_NAIRA exceeds PAYOUT_MAX_AMOUNT_NAIRA — no payout could ever be valid.`,
      );
    }

    if (usesPulseMfb(config)) {
      // Signature auth needs both halves. One without the other produces a 401
      // on every call, which reads like an outage and sends the on-call engineer
      // to the wrong place entirely.
      if (!config.PULSEMFB_PUBLIC_KEY || !config.PULSEMFB_PRIVATE_KEY) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PULSEMFB_PUBLIC_KEY and PULSEMFB_PRIVATE_KEY are ` +
            'both required when Pulse MFB is configured for accounts, payouts or VAS.',
        );
      }
      // A signed request still carries account numbers and customer names in
      // cleartext over plain HTTP.
      if (!config.PULSEMFB_BASE_URL.startsWith('https://')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PULSEMFB_BASE_URL must be HTTPS. ` +
            'The http://test-api.pulsemfb.com sandbox is for development only.',
        );
      }
      // Their webhooks are the only notification of a completed transfer or a
      // delivered bundle; unverifiable ones have to be rejected, which would
      // mean nothing ever reaches a terminal state.
      if (!config.PULSEMFB_WEBHOOK_SECRET || config.PULSEMFB_WEBHOOK_SECRET.includes('CHANGE_ME')) {
        throw new Error(
          `Refusing to boot in ${config.NODE_ENV}: PULSEMFB_WEBHOOK_SECRET is required to verify Pulse MFB webhooks.`,
        );
      }
    }

    // Transfers name the account they debit. Without it every payout Pulse is
    // asked to serve is rejected upstream — and it would only be asked once
    // FalconPay had already refused, which is the worst moment to find out.
    if (usesPulseMfb(config)) {
      if (
        config.PAYOUT_PROVIDER === PayoutProvider.PulseMfb ||
        config.PAYOUT_FALLBACK_PROVIDER === PayoutProvider.PulseMfb
      ) {
        if (!config.PULSEMFB_DEBIT_ACCOUNT_NUMBER) {
          throw new Error(
            `Refusing to boot in ${config.NODE_ENV}: PULSEMFB_DEBIT_ACCOUNT_NUMBER is required when ` +
              'Pulse MFB is in the payout chain — transfers must name the float they debit.',
          );
        }
      }

      if (config.BILLS_VAS_FALLBACK_PROVIDER === BillsProvider.PulseMfb) {
        if (!config.PULSEMFB_DEBIT_ACCOUNT_ID) {
          throw new Error(
            `Refusing to boot in ${config.NODE_ENV}: PULSEMFB_DEBIT_ACCOUNT_ID is required when ` +
              'BILLS_VAS_FALLBACK_PROVIDER=pulsemfb — airtime and data must name the float they debit.',
          );
        }
      }
    }
  }

  // -- Structural checks, enforced in every environment ---------------------
  //
  // These describe combinations that cannot work anywhere, not merely ones that
  // are unsafe in production, so they are outside the block above. A developer
  // who mis-wires the chain locally should be told immediately rather than on
  // the day it reaches staging.

  // Pulse MFB sells airtime and data only, exactly like SMEPlug. As
  // `BILLS_PROVIDER` it would leave three of five verticals unserved.
  if (config.BILLS_PROVIDER === BillsProvider.PulseMfb) {
    throw new Error(
      'BILLS_PROVIDER=pulsemfb is not supported: Pulse MFB sells no electricity, cable TV or ' +
        'betting. Set BILLS_VAS_FALLBACK_PROVIDER=pulsemfb to put it behind the existing chain.',
    );
  }

  // The VAS fallback is a *third* tier. Naming a provider already in the chain
  // would have it retry itself — the same refusal, twice the latency.
  if (
    config.BILLS_VAS_FALLBACK_PROVIDER !== BillsProvider.Disabled &&
    config.BILLS_VAS_FALLBACK_PROVIDER !== BillsProvider.PulseMfb
  ) {
    throw new Error(
      `BILLS_VAS_FALLBACK_PROVIDER="${config.BILLS_VAS_FALLBACK_PROVIDER}" is not supported: it is the ` +
        'last airtime/data tier, and only "pulsemfb" (or "disabled") sits behind the existing chain.',
    );
  }

  // A provider cannot be its own fallback: the second attempt would repeat the
  // first against the same upstream and fail identically.
  if (
    config.PAYOUT_FALLBACK_PROVIDER !== PayoutProvider.Manual &&
    config.PAYOUT_FALLBACK_PROVIDER === config.PAYOUT_PROVIDER
  ) {
    throw new Error(
      `PAYOUT_FALLBACK_PROVIDER="${config.PAYOUT_FALLBACK_PROVIDER}" is the same as PAYOUT_PROVIDER. ` +
        'Set it to a different provider, or to "manual" to disable failover.',
    );
  }

  return config;
}

/** Strip Pulse from every role unless `PULSEMFB_ENABLED` is true. */
function disablePulseUnlessEnabled(config: EnvironmentVariables): void {
  if (config.PULSEMFB_ENABLED) return;

  if (config.PAYMENT_PROVIDER === PaymentProvider.PulseMfb) {
    config.PAYMENT_PROVIDER = PaymentProvider.Paystack;
  }
  if (config.PAYOUT_PROVIDER === PayoutProvider.PulseMfb) {
    config.PAYOUT_PROVIDER = PayoutProvider.FalconPay;
  }
  if (config.PAYOUT_FALLBACK_PROVIDER === PayoutProvider.PulseMfb) {
    config.PAYOUT_FALLBACK_PROVIDER = PayoutProvider.Manual;
  }
  if (config.BILLS_VAS_FALLBACK_PROVIDER === BillsProvider.PulseMfb) {
    config.BILLS_VAS_FALLBACK_PROVIDER = BillsProvider.Disabled;
  }
}

/** Whether Pulse MFB is wired into any of the three roles it can serve. */
function usesPulseMfb(config: EnvironmentVariables): boolean {
  return (
    config.PAYMENT_PROVIDER === PaymentProvider.PulseMfb ||
    config.PAYOUT_PROVIDER === PayoutProvider.PulseMfb ||
    config.PAYOUT_FALLBACK_PROVIDER === PayoutProvider.PulseMfb ||
    config.BILLS_VAS_FALLBACK_PROVIDER === BillsProvider.PulseMfb
  );
}
