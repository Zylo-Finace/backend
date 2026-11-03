import { buildAppConfig } from './app.config';
import { LogFormat, NodeEnv, PayoutProvider, validateEnv } from './env.validation';

const VALID_SECRET = 'a'.repeat(48);

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/wabot',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'b'.repeat(44),
  JWT_ACCESS_SECRET: VALID_SECRET,
  JWT_REFRESH_SECRET: VALID_SECRET,
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = validateEnv(baseEnv);

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.DB_POOL_SIZE).toBe(15);
    expect(config.LOG_FORMAT).toBe(LogFormat.Json);
  });

  it('coerces numeric strings, which is how env vars always arrive', () => {
    const config = validateEnv({ ...baseEnv, PORT: '8080', DB_POOL_SIZE: '40' });

    expect(config.PORT).toBe(8080);
    expect(config.DB_POOL_SIZE).toBe(40);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('coerces boolean-ish %s', (raw, expected) => {
    expect(validateEnv({ ...baseEnv, METRICS_ENABLED: raw }).METRICS_ENABLED).toBe(expected);
  });

  it('reports every violation at once rather than one per restart', () => {
    let message = '';
    try {
      validateEnv({ ...baseEnv, PORT: '99999', DB_POOL_SIZE: '-1', JWT_ACCESS_SECRET: 'short' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('PORT');
    expect(message).toContain('DB_POOL_SIZE');
    expect(message).toContain('JWT_ACCESS_SECRET');
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['JWT_ACCESS_TTL', '15 minutes'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects an invalid %s', (key, value) => {
    expect(() => validateEnv({ ...baseEnv, [key]: value })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('requires DATABASE_URL to be present', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = baseEnv;
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  describe('production guardrails', () => {
    const productionEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      PAYSTACK_SECRET_KEY: 'stripe_dummy_live_realkeyvalue0000000000',
      META_APP_SECRET: 'c'.repeat(32),
      META_WEBHOOK_VERIFY_TOKEN: 'd'.repeat(24),
      FALCONPAY_SECRET_KEY: 'stripe_dummy_live_falconrealkey00000000',
      FALCONPAY_WEBHOOK_SECRET: `whsec_live_${'e'.repeat(64)}`,
      CLUBKONNECT_USER_ID: 'CK123456',
      CLUBKONNECT_API_KEY: 'f'.repeat(32),
      CLUBKONNECT_CALLBACK_URL: 'https://api.example.com/webhooks/bills',
    };

    it('refuses to boot with placeholder secrets', () => {
      expect(() =>
        validateEnv({ ...productionEnv, ENCRYPTION_KEY: 'CHANGE_ME_openssl_rand_base64_32' }),
      ).toThrow(/placeholder secrets/);
    });

    it('refuses to boot without an explicit CORS allowlist', () => {
      const { CORS_ORIGINS: _omitted, ...withoutCors } = productionEnv;
      expect(() => validateEnv(withoutCors)).toThrow(/CORS_ORIGINS/);
    });

    it('accepts a correctly configured production environment', () => {
      expect(() => validateEnv(productionEnv)).not.toThrow();
    });

    it('allows placeholders in development, where they are convenient', () => {
      expect(() =>
        validateEnv({ ...baseEnv, ENCRYPTION_KEY: 'CHANGE_ME_openssl_rand_base64_32' }),
      ).not.toThrow();
    });

    it('refuses to boot with a payment provider but no credential', () => {
      // Otherwise the failure surfaces at the first customer registration —
      // the worst possible moment to discover it.
      const { PAYSTACK_SECRET_KEY: _omitted, ...withoutKey } = productionEnv;
      expect(() => validateEnv(withoutKey)).toThrow(/PAYSTACK_SECRET_KEY/);
    });

    it('refuses to boot against a payment sandbox', () => {
      // A test key in production means real customer transfers settle against a
      // sandbox and the money is never credited.
      expect(() =>
        validateEnv({ ...productionEnv, PAYSTACK_SECRET_KEY: 'stripe_dummy_test_abc123' }),
      ).toThrow(/test key/);
    });

    it('allows a test key outside production', () => {
      expect(() =>
        validateEnv({ ...baseEnv, PAYSTACK_SECRET_KEY: 'stripe_dummy_test_abc123' }),
      ).not.toThrow();
    });

    it('refuses to boot with a payout provider but no credential', () => {
      // Otherwise it surfaces when a customer has already been told their
      // withdrawal is on its way.
      const { FALCONPAY_SECRET_KEY: _omitted, ...withoutKey } = productionEnv;
      expect(() => validateEnv(withoutKey)).toThrow(/FALCONPAY_SECRET_KEY/);
    });

    it('refuses to boot against the payout sandbox', () => {
      expect(() =>
        validateEnv({ ...productionEnv, FALCONPAY_SECRET_KEY: 'stripe_dummy_test_abc123' }),
      ).toThrow(/test key/);
    });

    it('refuses to boot without a payout webhook secret', () => {
      // Without it every status update fails verification, no payout ever
      // reaches a terminal state, and holds accumulate forever.
      const { FALCONPAY_WEBHOOK_SECRET: _omitted, ...withoutSecret } = productionEnv;
      expect(() => validateEnv(withoutSecret)).toThrow(/FALCONPAY_WEBHOOK_SECRET/);
    });

    it('refuses to boot with payout bounds that admit no valid amount', () => {
      expect(() =>
        validateEnv({
          ...productionEnv,
          PAYOUT_MIN_AMOUNT_NAIRA: '5000',
          PAYOUT_MAX_AMOUNT_NAIRA: '1000',
        }),
      ).toThrow(/PAYOUT_MIN_AMOUNT_NAIRA/);
    });

    it('allows missing FalconPay credentials when payouts are manual', () => {
      // A business that pays out by hand should not be forced to hold keys for
      // an integration it does not use.
      const {
        FALCONPAY_SECRET_KEY: _key,
        FALCONPAY_WEBHOOK_SECRET: _hook,
        ...rest
      } = productionEnv;
      expect(() =>
        validateEnv({ ...rest, PAYOUT_PROVIDER: 'manual', BILLS_PROVIDER: 'clubkonnect' }),
      ).not.toThrow();
    });

    it.each([['FALCONPAY_SECRET_KEY'], ['FALCONPAY_WEBHOOK_SECRET']])(
      'refuses to boot with FalconPay bills but no %s, even when payouts are manual',
      (key) => {
        const { [key]: _omitted, ...withoutKey } = productionEnv as Record<string, string>;
        expect(() =>
          validateEnv({ ...withoutKey, PAYOUT_PROVIDER: 'manual', BILLS_PROVIDER: 'falconpay' }),
        ).toThrow(new RegExp(key));
      },
    );

    it('refuses to boot FalconPay bills on a test key', () => {
      expect(() =>
        validateEnv({
          ...productionEnv,
          PAYOUT_PROVIDER: 'manual',
          FALCONPAY_SECRET_KEY: 'stripe_dummy_test_falconkey000000000',
        }),
      ).toThrow(/test key/);
    });

    it('needs no ClubKonnect credentials when FalconPay sells bills', () => {
      const {
        CLUBKONNECT_USER_ID: _id,
        CLUBKONNECT_API_KEY: _key,
        CLUBKONNECT_CALLBACK_URL: _url,
        ...rest
      } = productionEnv;
      expect(() => validateEnv(rest)).not.toThrow();
    });

    it.each([['CLUBKONNECT_USER_ID'], ['CLUBKONNECT_API_KEY'], ['CLUBKONNECT_CALLBACK_URL']])(
      'refuses to boot with a bills provider but no %s',
      (key) => {
        // Otherwise it surfaces at the first customer's airtime purchase.
        const { [key]: _omitted, ...withoutKey } = productionEnv as Record<string, string>;
        expect(() => validateEnv({ ...withoutKey, BILLS_PROVIDER: 'clubkonnect' })).toThrow(
          new RegExp(key),
        );
      },
    );

    describe('PayVessel', () => {
      const payvesselEnv = {
        ...productionEnv,
        PAYMENT_PROVIDER: 'payvessel',
        KYC_PROVIDER: 'payvessel',
        PAYVESSEL_API_KEY: 'PVKEY-realkeyvalue0000000000',
        PAYVESSEL_API_SECRET: 'PVSECRET-realsecret0000000000',
        PAYVESSEL_BUSINESS_ID: '061C074E2F91F944B93993B4',
      };

      it('accepts a correctly configured PayVessel environment', () => {
        expect(() => validateEnv(payvesselEnv)).not.toThrow();
      });

      it.each([['PAYVESSEL_API_KEY'], ['PAYVESSEL_API_SECRET'], ['PAYVESSEL_BUSINESS_ID']])(
        'refuses to boot without %s',
        (key) => {
          const { [key]: _omitted, ...withoutKey } = payvesselEnv as Record<string, string>;
          expect(() => validateEnv(withoutKey)).toThrow(new RegExp(key));
        },
      );

      it('refuses to boot against the PayVessel sandbox', () => {
        // Customers would be shown account numbers that receive no real money.
        expect(() =>
          validateEnv({ ...payvesselEnv, PAYVESSEL_BASE_URL: 'https://sandbox.payvessel.com' }),
        ).toThrow(/sandbox/);
      });

      it('refuses to boot with the webhook source allowlist turned off', () => {
        expect(() =>
          validateEnv({ ...payvesselEnv, PAYVESSEL_WEBHOOK_ENFORCE_IPS: 'false' }),
        ).toThrow(/PAYVESSEL_WEBHOOK_ENFORCE_IPS/);
      });

      it('refuses to boot with PayVessel accounts but no verification provider', () => {
        // A permanent account cannot be issued without a verified BVN or NIN, so
        // this pair boots cleanly and then silently issues nothing at all.
        expect(() => validateEnv({ ...payvesselEnv, KYC_PROVIDER: 'disabled' })).toThrow(
          /KYC_PROVIDER/,
        );
      });

      it('requires PayVessel credentials when only KYC uses it', () => {
        // Verification and collections are configured independently: a business
        // can verify with PayVessel while funding through Paystack.
        const { PAYVESSEL_API_SECRET: _omitted, ...withoutSecret } = payvesselEnv;
        expect(() => validateEnv({ ...withoutSecret, PAYMENT_PROVIDER: 'paystack' })).toThrow(
          /PAYVESSEL_API_SECRET/,
        );
      });

      it('needs no PayVessel credentials at all when it is unused', () => {
        // The default. An integration a business has not signed up for must not
        // stop the process from booting.
        expect(() => validateEnv(productionEnv)).not.toThrow();
      });
    });

    describe('SMEPlug', () => {
      const smeplugEnv = {
        ...productionEnv,
        BILLS_PROVIDER: 'smeplug',
        BILLS_FALLBACK_PROVIDER: 'clubkonnect',
        SMEPLUG_SECRET_KEY: 'sk_smeplug_realkey000000',
        SMEPLUG_WEBHOOK_SECRET: 'a'.repeat(48),
      };

      it('accepts a correctly configured SMEPlug environment', () => {
        expect(() => validateEnv(smeplugEnv)).not.toThrow();
      });

      it('refuses to boot without SMEPLUG_SECRET_KEY', () => {
        const { SMEPLUG_SECRET_KEY: _omitted, ...withoutKey } = smeplugEnv;
        expect(() => validateEnv(withoutKey)).toThrow(/SMEPLUG_SECRET_KEY/);
      });

      it('refuses to boot with no fallback provider behind it', () => {
        // SMEPlug sells no electricity, cable TV or betting. Alone, three of five
        // verticals have no provider — found by the first customer, not by us.
        expect(() => validateEnv({ ...smeplugEnv, BILLS_FALLBACK_PROVIDER: 'disabled' })).toThrow(
          /BILLS_FALLBACK_PROVIDER/,
        );
      });

      it.each([
        ['missing', undefined],
        ['too short to be unguessable', 'short-secret'],
      ])('refuses to boot with a webhook secret that is %s', (_label, secret) => {
        // SMEPlug does not sign webhooks, so the secret URL is the only thing
        // between a stranger and a forged "success".
        expect(() => validateEnv({ ...smeplugEnv, SMEPLUG_WEBHOOK_SECRET: secret })).toThrow(
          /SMEPLUG_WEBHOOK_SECRET/,
        );
      });

      it('still requires ClubKonnect credentials, since it serves three verticals', () => {
        const { CLUBKONNECT_API_KEY: _omitted, ...withoutKey } = smeplugEnv;
        expect(() => validateEnv(withoutKey)).toThrow(/CLUBKONNECT_API_KEY/);
      });

      it('needs no SMEPlug credentials when it is unused', () => {
        expect(() => validateEnv(productionEnv)).not.toThrow();
      });
    });

    it('allows missing ClubKonnect credentials when bill payments are disabled', () => {
      const {
        CLUBKONNECT_USER_ID: _id,
        CLUBKONNECT_API_KEY: _key,
        CLUBKONNECT_CALLBACK_URL: _url,
        ...rest
      } = productionEnv;
      expect(() => validateEnv({ ...rest, BILLS_PROVIDER: 'disabled' })).not.toThrow();
    });

    it('refuses to boot without a Meta app secret', () => {
      // Signature verification is the WhatsApp webhook's only authentication;
      // without the secret the endpoint would accept anything.
      const { META_APP_SECRET: _omitted, ...withoutSecret } = productionEnv;
      expect(() => validateEnv(withoutSecret)).toThrow(/META_APP_SECRET/);
    });

    it('refuses to boot with a placeholder Meta app secret', () => {
      expect(() =>
        validateEnv({ ...productionEnv, META_APP_SECRET: 'CHANGE_ME_meta_app_secret' }),
      ).toThrow(/META_APP_SECRET/);
    });

    it('refuses to boot without a webhook verify token', () => {
      // Meta re-runs the GET subscription handshake; failing it silently
      // unsubscribes the number from inbound messages.
      const { META_WEBHOOK_VERIFY_TOKEN: _omitted, ...withoutToken } = productionEnv;
      expect(() => validateEnv(withoutToken)).toThrow(/META_WEBHOOK_VERIFY_TOKEN/);
    });

    it('allows missing Meta credentials outside production', () => {
      expect(() => validateEnv(baseEnv)).not.toThrow();
    });
  });
});

describe('buildAppConfig', () => {
  it('splits and trims the CORS allowlist', () => {
    const config = buildAppConfig(
      validateEnv({ ...baseEnv, CORS_ORIGINS: 'https://a.com, https://b.com ,' }),
    );

    expect(config.app.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('normalises a trailing slash off the app URL', () => {
    const config = buildAppConfig(validateEnv({ ...baseEnv, APP_URL: 'https://api.example.com/' }));
    expect(config.app.url).toBe('https://api.example.com');
  });

  it('derives environment predicates', () => {
    const config = buildAppConfig(validateEnv({ ...baseEnv, NODE_ENV: 'test' }));

    expect(config.app.isTest).toBe(true);
    expect(config.app.isProduction).toBe(false);
  });

  it('freezes the tree so no module can mutate shared config at runtime', () => {
    const config = buildAppConfig(validateEnv(baseEnv));

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.security.jwt)).toBe(true);
  });

  // ===========================================================================
  //  Pulse MFB
  // ===========================================================================

  describe('Pulse MFB', () => {
    const pulseProdEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      PAYSTACK_SECRET_KEY: 'stripe_dummy_live_realkeyvalue0000000000',
      META_APP_SECRET: 'c'.repeat(32),
      META_WEBHOOK_VERIFY_TOKEN: 'd'.repeat(24),
      FALCONPAY_SECRET_KEY: 'stripe_dummy_live_falconrealkey00000000',
      FALCONPAY_WEBHOOK_SECRET: `whsec_live_${'e'.repeat(64)}`,
      CLUBKONNECT_USER_ID: 'CK123456',
      CLUBKONNECT_API_KEY: 'f'.repeat(32),
      CLUBKONNECT_CALLBACK_URL: 'https://api.example.com/webhooks/bills',
      PAYOUT_FALLBACK_PROVIDER: 'pulsemfb',
      PULSEMFB_ENABLED: true,
      PULSEMFB_PUBLIC_KEY: 'pk_live_abc123',
      PULSEMFB_PRIVATE_KEY: 'stripe_dummy_live_xyz789',
      PULSEMFB_WEBHOOK_SECRET: `whsec_live_${'g'.repeat(32)}`,
      PULSEMFB_DEBIT_ACCOUNT_NUMBER: '9990000001',
    };

    it('accepts a complete configuration', () => {
      expect(() => validateEnv(pulseProdEnv)).not.toThrow();
    });

    it('ignores Pulse entirely until PULSEMFB_ENABLED=true', () => {
      const config = validateEnv({
        ...pulseProdEnv,
        PULSEMFB_ENABLED: false,
      });
      expect(config.PAYOUT_FALLBACK_PROVIDER).toBe(PayoutProvider.Manual);
      expect(config.PULSEMFB_ENABLED).toBe(false);
    });

    it('boots production even if Railway set pulsemfb as the payout provider', () => {
      const config = validateEnv({
        ...pulseProdEnv,
        PULSEMFB_ENABLED: false,
        PAYOUT_PROVIDER: 'pulsemfb',
        PAYOUT_FALLBACK_PROVIDER: 'pulsemfb',
      });
      expect(config.PAYOUT_PROVIDER).toBe(PayoutProvider.FalconPay);
      expect(config.PAYOUT_FALLBACK_PROVIDER).toBe(PayoutProvider.Manual);
    });

    it('still refuses a Pulse primary with no keys', () => {
      const { PULSEMFB_PUBLIC_KEY: _removed, ...rest } = pulseProdEnv;
      expect(() =>
        validateEnv({ ...rest, PAYOUT_PROVIDER: 'pulsemfb', PAYOUT_FALLBACK_PROVIDER: 'manual' }),
      ).toThrow(/PULSEMFB_PUBLIC_KEY and PULSEMFB_PRIVATE_KEY/);
    });

    it('refuses a non-HTTPS base URL in production', () => {
      // Their sandbox is plain HTTP, and a signed request still carries account
      // numbers and customer names in cleartext.
      expect(() =>
        validateEnv({ ...pulseProdEnv, PULSEMFB_BASE_URL: 'http://test-api.pulsemfb.com' }),
      ).toThrow(/PULSEMFB_BASE_URL must be HTTPS/);
    });

    it('requires a webhook secret when Pulse is enabled', () => {
      const { PULSEMFB_WEBHOOK_SECRET: _removed, ...rest } = pulseProdEnv;
      expect(() => validateEnv(rest)).toThrow(/PULSEMFB_WEBHOOK_SECRET/);
    });

    it('requires a debit account when Pulse is in the payout chain', () => {
      const { PULSEMFB_DEBIT_ACCOUNT_NUMBER: _removed, ...rest } = pulseProdEnv;
      expect(() => validateEnv(rest)).toThrow(/PULSEMFB_DEBIT_ACCOUNT_NUMBER/);
    });

    it('requires a debit account id when Pulse serves VAS', () => {
      expect(() =>
        validateEnv({ ...pulseProdEnv, BILLS_VAS_FALLBACK_PROVIDER: 'pulsemfb' }),
      ).toThrow(/PULSEMFB_DEBIT_ACCOUNT_ID/);
    });

    it('asks for nothing when Pulse is not configured at all', () => {
      expect(() => validateEnv(baseEnv)).not.toThrow();
    });

    it('coerces Railway string integers', () => {
      const config = validateEnv({
        ...baseEnv,
        PULSEMFB_HTTP_TIMEOUT_MS: '30000',
        PULSEMFB_SIGNATURE_TTL_SECONDS: '120',
      });
      expect(config.PULSEMFB_HTTP_TIMEOUT_MS).toBe(30_000);
      expect(config.PULSEMFB_SIGNATURE_TTL_SECONDS).toBe(120);
    });

    it('treats blank Pulse timeouts as omitted so class defaults apply', () => {
      const config = validateEnv({
        ...baseEnv,
        PULSEMFB_HTTP_TIMEOUT_MS: '',
        PULSEMFB_SIGNATURE_TTL_SECONDS: '  ',
      });
      expect(config.PULSEMFB_HTTP_TIMEOUT_MS).toBe(30_000);
      expect(config.PULSEMFB_SIGNATURE_TTL_SECONDS).toBe(300);
    });

    // -- Structural rules, enforced in every environment ---------------------

    it('refuses BILLS_PROVIDER=pulsemfb, which would leave three verticals unserved', () => {
      expect(() => validateEnv({ ...baseEnv, BILLS_PROVIDER: 'pulsemfb' })).toThrow(
        /BILLS_PROVIDER=pulsemfb is not supported/,
      );
    });

    it('refuses a VAS fallback that is already in the chain', () => {
      expect(() => validateEnv({ ...baseEnv, BILLS_VAS_FALLBACK_PROVIDER: 'clubkonnect' })).toThrow(
        /BILLS_VAS_FALLBACK_PROVIDER/,
      );
    });

    it('refuses a payout provider that is its own fallback', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          PAYOUT_PROVIDER: 'falconpay',
          PAYOUT_FALLBACK_PROVIDER: 'falconpay',
        }),
      ).toThrow(/same as PAYOUT_PROVIDER/);
    });

    it('defaults to no payout failover, preserving the previous behaviour', () => {
      const config = buildAppConfig(validateEnv(baseEnv));
      expect(config.payouts.fallbackProvider).toBe('manual');
      expect(config.bills.vasFallbackProvider).toBe('disabled');
    });
  });
});
