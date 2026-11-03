/**
 * Deterministic environment for end-to-end tests.
 *
 * Set before any module is imported so `validateEnv` sees a complete, valid
 * configuration. Values are fixed rather than read from a developer's `.env` so
 * that a local override cannot change what CI asserts.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_FORMAT = 'json';
process.env.DATABASE_URL ??= 'postgresql://wabot:wabot@localhost:5432/wabot_test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-000000';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-00000';
process.env.CORS_ORIGINS ??= 'http://localhost:3000';
// Payments: a deterministic secret so webhook signature tests are reproducible.
process.env.PAYMENT_PROVIDER ??= 'paystack';
process.env.PAYSTACK_SECRET_KEY ??= 'sk_test_e2e_secret_value_0000';
// WhatsApp: deterministic secrets so signature and handshake tests reproduce.
process.env.META_APP_SECRET ??= 'e2e-meta-app-secret';
process.env.META_WEBHOOK_VERIFY_TOKEN ??= 'e2e-meta-verify-token';
process.env.METRICS_ENABLED = 'false';
process.env.TRACING_ENABLED = 'false';
