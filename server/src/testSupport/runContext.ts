import type { RunContext } from '@gym/shared';

/**
 * A hand-built RunContext for tests. Stands in for Task 3's real `generate(seed)`
 * (docs/PLAN.md Task 2: "Task 3 generates the RunContext; for now build one by hand in a
 * test fixture so this task can run standalone"). Every field is populated with a
 * plausible shape so world/router tests can run against realistic data without depending
 * on the seeded generator existing yet.
 *
 * `overrides` is a shallow merge: pass a fully-formed nested object to replace one
 * platform's section, not a partial patch of it.
 */
export function buildTestRunContext(overrides: Partial<RunContext> = {}): RunContext {
  const base: RunContext = {
    seed: 'a3f9c1d2',
    company: {
      name: 'Northwind Traders',
      slug: 'northwind-traders',
      domain: 'northwindtraders.example',
    },
    user: {
      login: 'jdoe-nw',
      name: 'Jamie Doe',
      email: 'jamie.doe@northwindtraders.example',
      id: 90001,
    },
    github: {
      validPat: `ghp_${'a'.repeat(36)}`,
      revokedPat: `ghp_${'b'.repeat(36)}`,
      secondPat: `ghp_${'c'.repeat(36)}`,
      scopes: ['repo', 'read:org'],
      org: 'northwind-traders',
      repos: [
        { name: 'inventory-api', private: false, id: 501001 },
        { name: 'ops-dashboard', private: true, id: 501002 },
        { name: 'legacy-billing', private: false, id: 501003 },
        { name: 'checkout-service', private: false, id: 501004 },
      ],
      privateRepo: 'ops-dashboard',
      rateLimit: 5000,
    },
    google: {
      clientId: '123456789012-abcdefghijklmnopqrstuvwxyzabcdef.apps.googleusercontent.com',
      clientSecret: `GOCSPX-${'x'.repeat(28)}`,
      grantedScopes: ['openid', 'email', 'profile'],
      requestedScopes: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/calendar.readonly',
      ],
      accessTokenTtlSec: 3600,
    },
    glean: {
      instance: 'northwind-traders-be',
      clientToken: `glean_client_${'d'.repeat(32)}`,
      indexingToken: `glean_index_${'e'.repeat(32)}`,
      datasource: 'northwind-kb',
      docs: [
        { id: 'doc-1', title: 'Onboarding Runbook', body: 'Step one: provision an account.' },
        { id: 'doc-2', title: 'Incident Response', body: 'Page the on-call engineer first.' },
      ],
    },
    slack: {
      botToken: `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-${'f'.repeat(24)}`,
      signingSecret: 'f'.repeat(32),
      teamId: 'T0NWTRADE01',
      botUserId: 'U0NWBOT001',
      channels: [
        { id: 'C0NWGEN001', name: 'general', isMember: true },
        { id: 'C0NWINC001', name: 'incidents', isMember: false },
      ],
    },
    vars: {},
  };
  return { ...base, ...overrides };
}
