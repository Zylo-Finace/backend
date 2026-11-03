import {
  type BillsProvider,
  type EnvironmentVariables,
  type KycProvider,
  type KycTier,
  type LogFormat,
  NodeEnv,
  type PaymentProvider,
  type PayoutProvider,
} from './env.validation';

/**
 * The application's typed configuration tree.
 *
 * Deliberately *not* accessed through `ConfigService.get('some.string.path')`:
 * stringly-typed lookups return `T | undefined` and silently rot when a key is
 * renamed. This object is injected whole, is `readonly`, and is checked by tsc.
 */
export interface AppConfig {
  readonly app: {
    readonly env: NodeEnv;
    readonly isProduction: boolean;
    readonly isDevelopment: boolean;
    readonly isTest: boolean;
    readonly name: string;
    readonly url: string;
    readonly port: number;
    readonly corsOrigins: string[];
    readonly trustProxyHops: number;
    readonly bodyLimit: string;
    readonly shutdownTimeoutMs: number;
  };
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    readonly poolTimeoutSeconds: number;
    readonly statementTimeoutMs: number;
    readonly logQueries: boolean;
    readonly slowQueryMs: number;
  };
  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
    readonly tls: boolean;
  };
  readonly security: {
    readonly encryptionKey: string;
    readonly jwt: {
      readonly accessSecret: string;
      readonly refreshSecret: string;
      readonly accessTtl: string;
      readonly refreshTtl: string;
      readonly issuer: string;
    };
    readonly rateLimit: {
      readonly ttlSeconds: number;
      readonly max: number;
    };
  };
  readonly payments: {
    readonly provider: PaymentProvider;
    readonly httpTimeoutMs: number;
    readonly webhookMaxAgeSeconds: number;
    readonly paystack: {
      readonly secretKey: string;
      readonly baseUrl: string;
      readonly preferredBank: string;
    };
    readonly payvessel: {
      readonly baseUrl: string;
      readonly kycBaseUrl: string;
      readonly apiKey: string;
      readonly apiSecret: string;
      readonly businessId: string;
      /** Partner bank codes for permanent accounts, most-preferred first. */
      readonly staticBankCodes: string[];
      /** Partner bank code for single-use accounts. */
      readonly dynamicBankCode: string;
      readonly dynamicAccountTtlMinutes: number;
      readonly webhookIps: string[];
      readonly enforceWebhookIps: boolean;
    };
  };
  readonly kyc: {
    readonly provider: KycProvider;
    /** Minimum tier before a permanent (STATIC) account may be requested. */
    readonly staticAccountMinTier: KycTier;
    /** Floor for a provider BASIC check's own name score. */
    readonly nameMatchMinPercent: number;
    /** Floor for the tier-2 NIN ↔ BVN name comparison. */
    readonly crossMatchNameMinPercent: number;
    readonly maxFailedAttemptsPerDay: number;
    readonly allowDuplicateIdentifiers: boolean;
  };
  readonly payouts: {
    readonly provider: PayoutProvider;
    /** Who re-places a transfer the primary definitely did not accept. */
    readonly fallbackProvider: PayoutProvider;
    /** Bounds enforced before a payout is ever sent upstream, in whole naira. */
    readonly minAmountNaira: number;
    readonly maxAmountNaira: number;
    readonly falconpay: {
      readonly baseUrl: string;
      readonly secretKey: string;
      readonly publicKey: string;
      readonly webhookSecret: string;
      readonly webhookUrl: string;
      readonly senderName: string;
    };
  };
  /**
   * Pulse MFB connection settings.
   *
   * Top-level rather than nested under `payments`, `payouts` or `bills` because
   * one API client serves all three: the same host and the same key pair issue
   * accounts, send transfers and sell airtime. Duplicating it under each role
   * would mean three places to rotate a credential and three chances to miss one.
   */
  readonly pulsemfb: {
    readonly baseUrl: string;
    readonly publicKey: string;
    readonly privateKey: string;
    /** Optional `x-api-key`, sent alongside the signature when configured. */
    readonly apiKey: string;
    readonly webhookSecret: string;
    readonly httpTimeoutMs: number;
    readonly signatureTtlSeconds: number;
    /** What customers are told to send money to, for accounts we issue here. */
    readonly bankCode: string;
    readonly bankName: string;
    /** Our float, as transfers name it. */
    readonly debitAccountNumber: string;
    /** The same float, as the VAS endpoints name it. */
    readonly debitAccountId: string;
  };
  readonly bills: {
    readonly provider: BillsProvider;
    /** Who serves an order the leading provider cannot. */
    readonly fallbackProvider: BillsProvider;
    /** The last airtime/data tier, tried after both providers above. */
    readonly vasFallbackProvider: BillsProvider;
    readonly httpTimeoutMs: number;
    /** Held back from the upstream float so in-flight orders keep headroom. */
    readonly floatReserveNaira: number;
    readonly balanceCacheSeconds: number;
    readonly catalogueCacheSeconds: number;
    readonly clubkonnect: {
      readonly baseUrl: string;
      readonly userId: string;
      readonly apiKey: string;
      readonly callbackUrl: string;
    };
    readonly smeplug: {
      readonly baseUrl: string;
      readonly secretKey: string;
      /** Secret path segment on our webhook URL. SMEPlug signs nothing. */
      readonly webhookSecret: string;
    };
  };
  readonly whatsapp: {
    readonly appSecret: string;
    readonly webhookVerifyToken: string;
    readonly graphBaseUrl: string;
    readonly graphVersion: string;
    readonly httpTimeoutMs: number;
    readonly serviceWindowHours: number;
  };
  readonly observability: {
    readonly logLevel: string;
    readonly logFormat: LogFormat;
    readonly metricsEnabled: boolean;
    readonly tracingEnabled: boolean;
    readonly otlpEndpoint?: string;
    readonly serviceName: string;
    readonly sampleRatio: number;
  };
}

/**
 * Projects flat, validated env vars into the nested config tree.
 * Pure function — trivially unit-testable, no `process.env` access inside.
 */
export function buildAppConfig(env: EnvironmentVariables): AppConfig {
  const corsOrigins = csv(env.CORS_ORIGINS);

  return Object.freeze({
    app: Object.freeze({
      env: env.NODE_ENV,
      isProduction: env.NODE_ENV === NodeEnv.Production,
      isDevelopment: env.NODE_ENV === NodeEnv.Development,
      isTest: env.NODE_ENV === NodeEnv.Test,
      name: env.APP_NAME,
      url: env.APP_URL.replace(/\/+$/, ''),
      port: env.PORT,
      corsOrigins,
      trustProxyHops: env.TRUST_PROXY_HOPS,
      bodyLimit: env.BODY_LIMIT,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    }),
    database: Object.freeze({
      url: env.DATABASE_URL,
      poolSize: env.DB_POOL_SIZE,
      poolTimeoutSeconds: env.DB_POOL_TIMEOUT_SECONDS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      logQueries: env.DB_LOG_QUERIES,
      slowQueryMs: env.DB_SLOW_QUERY_MS,
    }),
    redis: Object.freeze({
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
      tls: env.REDIS_TLS,
    }),
    security: Object.freeze({
      encryptionKey: env.ENCRYPTION_KEY,
      jwt: Object.freeze({
        accessSecret: env.JWT_ACCESS_SECRET,
        refreshSecret: env.JWT_REFRESH_SECRET,
        accessTtl: env.JWT_ACCESS_TTL,
        refreshTtl: env.JWT_REFRESH_TTL,
        issuer: env.JWT_ISSUER,
      }),
      rateLimit: Object.freeze({
        ttlSeconds: env.RATE_LIMIT_TTL_SECONDS,
        max: env.RATE_LIMIT_MAX,
      }),
    }),
    payments: Object.freeze({
      provider: env.PAYMENT_PROVIDER,
      httpTimeoutMs: env.PAYMENT_HTTP_TIMEOUT_MS,
      webhookMaxAgeSeconds: env.WEBHOOK_MAX_AGE_SECONDS,
      paystack: Object.freeze({
        secretKey: env.PAYSTACK_SECRET_KEY ?? '',
        baseUrl: env.PAYSTACK_BASE_URL.replace(/\/+$/, ''),
        preferredBank: env.PAYSTACK_PREFERRED_BANK,
      }),
      payvessel: Object.freeze({
        baseUrl: env.PAYVESSEL_BASE_URL.replace(/\/+$/, ''),
        kycBaseUrl: env.PAYVESSEL_KYC_BASE_URL.replace(/\/+$/, ''),
        apiKey: env.PAYVESSEL_API_KEY ?? '',
        apiSecret: env.PAYVESSEL_API_SECRET ?? '',
        businessId: env.PAYVESSEL_BUSINESS_ID ?? '',
        staticBankCodes: Object.freeze(csv(env.PAYVESSEL_STATIC_BANK_CODES)) as string[],
        dynamicBankCode: env.PAYVESSEL_DYNAMIC_BANK_CODE.trim(),
        dynamicAccountTtlMinutes: env.PAYVESSEL_DYNAMIC_ACCOUNT_TTL_MINUTES,
        webhookIps: Object.freeze(csv(env.PAYVESSEL_WEBHOOK_IPS)) as string[],
        enforceWebhookIps: env.PAYVESSEL_WEBHOOK_ENFORCE_IPS,
      }),
    }),
    kyc: Object.freeze({
      provider: env.KYC_PROVIDER,
      staticAccountMinTier: env.KYC_STATIC_ACCOUNT_MIN_TIER,
      nameMatchMinPercent: env.KYC_NAME_MATCH_MIN_PERCENT,
      crossMatchNameMinPercent: env.KYC_CROSS_MATCH_NAME_MIN_PERCENT,
      maxFailedAttemptsPerDay: env.KYC_MAX_FAILED_ATTEMPTS_PER_DAY,
      allowDuplicateIdentifiers: env.KYC_ALLOW_DUPLICATE_IDENTIFIERS,
    }),
    payouts: Object.freeze({
      provider: env.PAYOUT_PROVIDER,
      fallbackProvider: env.PAYOUT_FALLBACK_PROVIDER,
      minAmountNaira: env.PAYOUT_MIN_AMOUNT_NAIRA,
      maxAmountNaira: env.PAYOUT_MAX_AMOUNT_NAIRA,
      falconpay: Object.freeze({
        baseUrl: env.FALCONPAY_API_URL.replace(/\/+$/, ''),
        secretKey: env.FALCONPAY_SECRET_KEY ?? '',
        publicKey: env.FALCONPAY_PUBLIC_KEY ?? '',
        webhookSecret: env.FALCONPAY_WEBHOOK_SECRET ?? '',
        webhookUrl: env.FALCONPAY_WEBHOOK_URL ?? '',
        senderName: env.FALCONPAY_SENDER_NAME,
      }),
    }),
    pulsemfb: Object.freeze({
      baseUrl: env.PULSEMFB_BASE_URL.replace(/\/+$/, ''),
      publicKey: env.PULSEMFB_PUBLIC_KEY ?? '',
      privateKey: env.PULSEMFB_PRIVATE_KEY ?? '',
      apiKey: env.PULSEMFB_API_KEY ?? '',
      webhookSecret: env.PULSEMFB_WEBHOOK_SECRET ?? '',
      httpTimeoutMs: env.PULSEMFB_HTTP_TIMEOUT_MS,
      signatureTtlSeconds: env.PULSEMFB_SIGNATURE_TTL_SECONDS,
      bankCode: env.PULSEMFB_BANK_CODE.trim(),
      bankName: env.PULSEMFB_BANK_NAME.trim(),
      debitAccountNumber: env.PULSEMFB_DEBIT_ACCOUNT_NUMBER ?? '',
      debitAccountId: env.PULSEMFB_DEBIT_ACCOUNT_ID ?? '',
    }),
    bills: Object.freeze({
      provider: env.BILLS_PROVIDER,
      fallbackProvider: env.BILLS_FALLBACK_PROVIDER,
      vasFallbackProvider: env.BILLS_VAS_FALLBACK_PROVIDER,
      httpTimeoutMs: env.CLUBKONNECT_HTTP_TIMEOUT_MS,
      floatReserveNaira: env.CLUBKONNECT_FLOAT_RESERVE_NAIRA,
      balanceCacheSeconds: env.CLUBKONNECT_BALANCE_CACHE_SECONDS,
      catalogueCacheSeconds: env.CLUBKONNECT_CATALOGUE_CACHE_SECONDS,
      clubkonnect: Object.freeze({
        baseUrl: env.CLUBKONNECT_BASE_URL.replace(/\/+$/, ''),
        userId: env.CLUBKONNECT_USER_ID ?? '',
        apiKey: env.CLUBKONNECT_API_KEY ?? '',
        callbackUrl: env.CLUBKONNECT_CALLBACK_URL ?? '',
      }),
      smeplug: Object.freeze({
        baseUrl: env.SMEPLUG_BASE_URL.replace(/\/+$/, ''),
        secretKey: env.SMEPLUG_SECRET_KEY ?? '',
        webhookSecret: env.SMEPLUG_WEBHOOK_SECRET ?? '',
      }),
    }),
    whatsapp: Object.freeze({
      appSecret: env.META_APP_SECRET ?? '',
      webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN ?? '',
      graphBaseUrl: env.META_GRAPH_BASE_URL.replace(/\/+$/, ''),
      graphVersion: env.META_GRAPH_VERSION,
      httpTimeoutMs: env.WHATSAPP_HTTP_TIMEOUT_MS,
      serviceWindowHours: env.WHATSAPP_SERVICE_WINDOW_HOURS,
    }),
    observability: Object.freeze({
      logLevel: env.LOG_LEVEL,
      logFormat: env.LOG_FORMAT,
      metricsEnabled: env.METRICS_ENABLED,
      tracingEnabled: env.TRACING_ENABLED,
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      sampleRatio: env.OTEL_SAMPLE_RATIO,
    }),
  });
}

/** Splits a comma-separated env var into trimmed, non-empty entries. */
function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
