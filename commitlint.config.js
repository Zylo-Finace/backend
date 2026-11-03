/**
 * Conventional Commits.
 *
 * The payoff is not tidy history for its own sake: `type` and `scope` drive
 * automated changelog generation and semantic version bumps, and a `fix:` prefix
 * is what makes "which release introduced this?" answerable in seconds.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'core',
        'config',
        'auth',
        'tenant',
        'db',
        'cache',
        'queue',
        'whatsapp',
        'contacts',
        'conversations',
        'campaigns',
        'automation',
        'ai',
        'billing',
        'storage',
        'realtime',
        'observability',
        'security',
        'ci',
        'docker',
        'deps',
        'docs',
        'test',
      ],
    ],
    'body-max-line-length': [1, 'always', 100],
  },
};
