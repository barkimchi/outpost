import { randomBytes } from 'node:crypto';
import type { RunContext } from '@gym/shared';

/**
 * Per-run generation (docs/SPEC.md hard constraint 6, section 9, section 12; the task-3
 * brief's central requirement). Every activation mints a fresh seed and this file turns
 * that seed into every concrete value a scenario template reads: company, user, tokens,
 * repos, channels, docs, and the small `vars` bag. Two activations of the same scenario
 * must differ in every credential, name, and ticket detail, and a token that solved run 1
 * must fail in run 2. `generate()` is the only place that guarantee is built.
 *
 * `generate(seed)` is a PURE function of `seed`: the same seed always reproduces the exact
 * same RunContext, via a seeded PRNG (mulberry32, seeded from an FNV-1a hash of the seed
 * string) implemented inline below, no dependency. No `Math.random()` anywhere in this
 * file. `mintSeed()` is the one place fresh entropy enters the system, using
 * `node:crypto`'s `randomBytes` (not `Math.random`) specifically so a captured seed can
 * always replay the exact run it produced for debugging.
 */

// --- Seeded PRNG -----------------------------------------------------------------------

/** FNV-1a 32-bit hash. Deterministic, dependency-free, good enough to seed mulberry32
 *  from an arbitrary seed string. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashSeedToUint32(seed: string): number {
  return fnv1a(seed);
}

/** mulberry32: a small, fast, well-known 32-bit PRNG. Returns a generator function
 *  producing floats in [0, 1). */
export function mulberry32(seedInt: number): () => number {
  let a = seedInt >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh entropy source for choosing a NEW seed each activation. Deliberately not part of
 *  `generate()`'s deterministic chain: `node:crypto.randomBytes`, never `Math.random`. */
export function mintSeed(): string {
  return randomBytes(4).toString('hex');
}

class Rng {
  private readonly next: () => number;

  constructor(seedInt: number) {
    this.next = mulberry32(seedInt);
  }

  float(): number {
    return this.next();
  }

  /** Inclusive on both ends. */
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.float() * (maxInclusive - minInclusive + 1));
  }

  bool(pTrue = 0.5): boolean {
    return this.float() < pTrue;
  }

  pick<T>(arr: readonly T[]): T {
    const item = arr[this.int(0, arr.length - 1)];
    if (item === undefined) throw new Error('Rng.pick called on an empty array');
    return item;
  }

  /** Picks `n` distinct items (order of the source array, then shuffled by removal), or
   *  fewer if the array is smaller than `n`. */
  pickN<T>(arr: readonly T[], n: number): T[] {
    const pool = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && pool.length > 0; i++) {
      const idx = this.int(0, pool.length - 1);
      out.push(pool[idx] as T);
      pool.splice(idx, 1);
    }
    return out;
  }

  token(length: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }

  hex(length: number): string {
    return this.token(length, '0123456789abcdef');
  }

  digits(length: number): string {
    return this.token(length, '0123456789');
  }
}

// --- Name pools --------------------------------------------------------------------------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

interface CompanyPick {
  name: string;
  /** Short lowercase word used to build the .example domain. */
  domainWord: string;
}

// Fictional companies only, .example TLD (RFC 2606) throughout: never a real company or
// domain, and never always "Acme" (docs/SPEC.md hard constraint 6).
const COMPANIES: CompanyPick[] = [
  { name: 'Northwind Traders', domainWord: 'northwindtraders' },
  { name: 'Bluepeak Robotics', domainWord: 'bluepeakrobotics' },
  { name: 'Cascade Freight', domainWord: 'cascadefreight' },
  { name: 'Ironclad Logistics', domainWord: 'ironcladlogistics' },
  { name: 'Solstice Analytics', domainWord: 'solsticeanalytics' },
  { name: 'Harborlight Health', domainWord: 'harborlighthealth' },
  { name: 'Vertex Materials', domainWord: 'vertexmaterials' },
  { name: 'Meridian Foods', domainWord: 'meridianfoods' },
  { name: 'Anchor Point Insurance', domainWord: 'anchorpointins' },
  { name: 'Fernwood Systems', domainWord: 'fernwoodsystems' },
  { name: 'Copperline Manufacturing', domainWord: 'copperlinemfg' },
  { name: 'Wavecrest Media', domainWord: 'wavecrestmedia' },
  { name: 'Granite Peak Construction', domainWord: 'granitepeakco' },
  { name: 'Amberfield Retail', domainWord: 'amberfieldretail' },
  { name: 'Silverton Energy', domainWord: 'silvertonenergy' },
  { name: 'Redshift Aerospace', domainWord: 'redshiftaero' },
  { name: 'Palmwood Hospitality', domainWord: 'palmwoodhospitality' },
  { name: 'Stonebridge Capital', domainWord: 'stonebridgecapital' },
];

const FIRST_NAMES = [
  'Jamie', 'Alex', 'Morgan', 'Taylor', 'Jordan', 'Casey', 'Riley', 'Sam', 'Drew', 'Reese',
  'Avery', 'Quinn', 'Rowan', 'Skyler', 'Dakota', 'Elliot', 'Harper', 'Finley',
];

const LAST_NAMES = [
  'Doe', 'Chen', 'Patel', 'Nguyen', 'Garcia', 'Kim', 'Rossi', 'Novak', 'Haddad', 'Okafor',
  'Larsen', 'Silva', 'Kowalski', 'Tanaka', 'Ibrahim', 'Petrov', 'Mercer', 'Alvarado',
];

const REPO_NAME_POOL = [
  'inventory-api', 'ops-dashboard', 'legacy-billing', 'checkout-service',
  'notification-worker', 'analytics-pipeline', 'billing-service', 'mobile-app',
  'api-gateway', 'payments-service', 'user-directory', 'reporting-engine',
  'webhook-relay', 'search-indexer', 'fulfillment-api', 'audit-log-service',
  'pricing-engine', 'catalog-service',
];

const CHANNEL_NAME_POOL = [
  'general', 'incidents', 'engineering', 'random', 'alerts', 'deploys', 'support',
  'oncall', 'platform-team', 'releases',
];

const GLEAN_DOC_POOL: Array<{ title: string; body: (company: string) => string }> = [
  { title: 'Onboarding Runbook', body: (co) => `Step one: provision a ${co} account and assign the default workspace role.` },
  { title: 'Incident Response', body: (co) => `Page the on-call engineer first, then update the ${co} status page.` },
  { title: 'VPN Setup Guide', body: (co) => `Install the ${co} VPN client and request access from IT before your first day.` },
  { title: 'Expense Policy', body: (co) => `${co} reimburses travel expenses within 30 days of a submitted receipt.` },
  { title: 'Release Checklist', body: (co) => `Run the ${co} smoke tests before promoting any build to production.` },
];

const SCOPE_EXTRAS = ['workflow', 'gist', 'user:email'];

// Task 6: keys only, resolved to real strings (which need the live PORT) by
// `platforms/google/oauth.ts`. See the `wrongRedirectVariant` comment below.
//
// Fix round: the original sixth variant was `localhost-127`
// (`http://127.0.0.1:<PORT>/_trainer/oauth/callback`). Dropped: docs/SPEC.md hard
// constraint 2 documents 127.0.0.1 as the legitimate fallback base URL for reaching this
// server, so using it as a WRONG decoy in this one exercise contradicted the rest of the
// project's own advice about the same literal host string. `localhost-wrong-port` is a
// real, unrelated-to-anything-else near-miss instead (an adjacent port number, the kind of
// copy-paste slip that happens when a port changes and one reference lags behind).
const WRONG_REDIRECT_VARIANTS = [
  'pstmn-trailing-slash',
  'pstmn-http',
  'pstmn-no-v1',
  'localhost-wrong-port',
  'localhost-trailing-slash',
  'localhost-no-trainer-prefix',
] as const;

const INSUFFICIENT_SCOPE_VARIANTS = ['missing', 'decoy'] as const;

// Task 7, spec hard constraint 7a: t4-token-type hands over BOTH of the run's two real
// Glean tokens, neutrally labeled "Token 1"/"Token 2" (same convention as tier 2's GitHub
// scenarios), and which one is listed first has to vary independently of which one is
// actually valid for the search endpoint (the client token, always) or every run would
// list them in the same clientToken-then-indexingToken order and "Token 1 always works"
// would become exactly the memorizable positional shortcut hard constraint 7a exists to
// prevent (the same defect `t2-github.ts`'s header comment documents finding, live, in an
// earlier round of this project).
const GLEAN_TOKEN_ORDER_VARIANTS = ['client-first', 'indexing-first'] as const;

// Task 7: t4-malformed-body randomizes WHICH of this mock's two required search-body
// fields (`query`, real-required per Glean's own docs; `pageSize`, this mock's own added
// requirement, see platforms/glean/router.ts) is missing from the broken request shown in
// the ticket, so the fix is never "always add the same field back."
const GLEAN_MALFORMED_FIELD_VARIANTS = ['query', 'pageSize'] as const;

// Task 6 fix round: t3-token-expiry's access-token TTL used to be a single hardcoded
// literal (15), identical across every activation and stated verbatim in the ticket text,
// which together handed the learner both the diagnosis and the fix with nothing left to
// find out. Drawn per run instead, from a pool of short-but-different values; the ticket
// no longer states the number at all (see scenarios/t3-google.ts).
const SHORT_ACCESS_TOKEN_TTL_POOL_SEC = [8, 10, 12, 15, 18, 20, 25] as const;

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ghpToken(rng: Rng): string {
  return `ghp_${rng.token(36, BASE62)}`;
}

// --- Generator -----------------------------------------------------------------------

/**
 * Produces one run's complete concrete data from a seed string. Every field in
 * `RunContext` (docs/SPEC.md section 8) is populated from the pools above; scenario
 * definitions read only from the resulting `RunContext`, never a literal.
 */
export function generate(seed: string): RunContext {
  const rng = new Rng(hashSeedToUint32(seed));

  const companyPick = rng.pick(COMPANIES);
  const companySlug = slugify(companyPick.name);
  const companyDomain = `${companyPick.domainWord}.example`;

  const firstName = rng.pick(FIRST_NAMES);
  const lastName = rng.pick(LAST_NAMES);
  const login = `${firstName[0]}${lastName}`.toLowerCase();
  const userEmail = `${firstName}.${lastName}`.toLowerCase() + `@${companyDomain}`;
  const userId = rng.int(10_000, 999_999);

  const repoCount = rng.int(4, 6);
  const repoNames = rng.pickN(REPO_NAME_POOL, repoCount);
  const privateIndex = rng.int(0, repoNames.length - 1);
  const repos = repoNames.map((name, i) => ({
    name,
    private: i === privateIndex,
    id: rng.int(100_000, 999_999),
  }));
  const privateRepoEntry = repos[privateIndex];
  if (!privateRepoEntry) throw new Error('generate(): repo list was unexpectedly empty');
  const privateRepo = privateRepoEntry.name;

  const extraScopeCount = rng.int(0, 2);
  const extraScopes = rng.pickN(SCOPE_EXTRAS, extraScopeCount);
  // "notifications" is a guaranteed baseline scope, not an optional extra (fix round 2):
  // t2-missing-scope's fault needs to be able to reliably strip it from exactly the
  // broken token, the same way it relies on "repo" and "read:org" always being present
  // to strip. If it were only sometimes drawn from SCOPE_EXTRAS, both candidate tokens
  // could end up already lacking it, breaking the scenario (no valid fix that run).
  const scopes = Array.from(new Set(['repo', 'read:org', 'notifications', ...extraScopes]));

  const validPat = ghpToken(rng);
  const revokedPat = ghpToken(rng);
  const secondPat = ghpToken(rng);

  const targetIndex = rng.int(0, repos.length - 1);
  const targetRepoEntry = repos[targetIndex];
  if (!targetRepoEntry) throw new Error('generate(): repo list was unexpectedly empty');
  const pageSize = rng.pick([1, 2]);

  // Fix round: which of the two candidate GitHub tokens (validPat vs secondPat) a
  // Tier-2 scenario cripples with its fault. Originally every t2-* scenario always
  // crippled validPat and always held secondPat back as the untouched fallback, and
  // always listed them in that same order in the ticket. That made the SHAPE of the fix
  // memorizable ("the second one listed always works") even though the underlying token
  // strings differed every run: eight live activations of t2-revoked-pat all had the
  // fix in the same slot. This is drawn from the same seeded rng as everything else, so
  // it varies per run and a captured seed still reproduces it.
  const brokenCredentialSlot: 'valid' | 'second' = rng.bool(0.5) ? 'valid' : 'second';

  // Second fix round: WHICH scope goes missing, not only which token (spec hard
  // constraint 7a names this as its own dimension). t2-missing-scope draws between two
  // real, distinct scope-gated 403 endpoints: GET /orgs/:org/repos (needs read:org) and
  // GET /notifications (needs notifications), so the specific missing scope varies too,
  // not just which of the two tokens is missing it.
  const missingScopeVariant: 'org' | 'notifications' = rng.bool(0.5) ? 'org' : 'notifications';

  // Task 6, spec hard constraint 7a ("randomize ... which redirect URI is wrong"):
  // t3-redirect-mismatch's ticket shows the OAuth helper's CURRENT (wrong) callback URL
  // as one of six near-miss decoys, each a plausible copy-paste mistake against one of
  // the two genuinely registered URIs (trailing slash, http instead of https, a dropped
  // path segment, 127.0.0.1 instead of localhost, ...). Resolved to an actual string by
  // `platforms/google/oauth.ts`'s `resolveWrongRedirectUri()`, which needs the live PORT
  // and so cannot live in this file (generate.ts stays config-free and pure).
  const wrongRedirectVariant = rng.pick(WRONG_REDIRECT_VARIANTS);

  // Task 6: t3-insufficient-scope's ticket shows the OAuth helper's CURRENT (insufficient)
  // scope configuration two different ways so the fix is never "always add the same
  // missing scope to a list that already looks complete": either the calendar scope is
  // simply absent, or a real, distinct, calendar-adjacent Google scope
  // (calendar.events, which does not cover reading the calendar list) is present in its
  // place, plausible enough to read as "probably fine" without a careful diff.
  const insufficientScopeVariant = rng.pick(INSUFFICIENT_SCOPE_VARIANTS);

  // Task 6 fix round (spec review finding 6): which short TTL t3-token-expiry's `setup`
  // overrides World.google.accessTokenTtlSec to, so "15 seconds" is never a fixed,
  // memorizable constant across every activation.
  const shortAccessTokenTtlSec = rng.pick(SHORT_ACCESS_TOKEN_TTL_POOL_SEC);

  const channelNames = rng.pickN(CHANNEL_NAME_POOL, rng.int(3, 5));
  const channels = channelNames.map((name) => ({
    id: `C${rng.token(9, UPPER_ALNUM)}`,
    name,
    isMember: rng.bool(0.5),
  }));

  // Task 7: which channel t5-envelope-trap targets (forced to isMember:false by that
  // scenario's own state fault, regardless of what the draw above happened to assign),
  // and the two Glean-search 7a draws described above.
  const slackTargetChannelIndex = rng.int(0, channels.length - 1);
  const gleanTokenOrder = rng.pick(GLEAN_TOKEN_ORDER_VARIANTS);
  const gleanMalformedField = rng.pick(GLEAN_MALFORMED_FIELD_VARIANTS);

  const docCount = rng.int(2, 3);
  const docPicks = rng.pickN(GLEAN_DOC_POOL, docCount);
  const docs = docPicks.map((pick, i) => ({
    id: `doc-${i + 1}`,
    title: pick.title,
    body: pick.body(companyPick.name),
  }));

  const clientId = `${rng.digits(12)}-${rng.token(32, LOWER_ALNUM)}.apps.googleusercontent.com`;
  const clientSecret = `GOCSPX-${rng.token(28, BASE62)}`;

  const companyDomainFirstWord = companySlug.split('-')[0] ?? companySlug;

  return {
    seed,
    company: { name: companyPick.name, slug: companySlug, domain: companyDomain },
    user: { login, name: `${firstName} ${lastName}`, email: userEmail, id: userId },
    github: {
      validPat,
      revokedPat,
      secondPat,
      scopes,
      org: companySlug,
      repos,
      privateRepo,
      rateLimit: 5000,
    },
    google: {
      clientId,
      clientSecret,
      grantedScopes: [...GOOGLE_SCOPES],
      requestedScopes: [...GOOGLE_SCOPES],
      accessTokenTtlSec: 3600,
    },
    glean: {
      instance: `${companyDomainFirstWord}-be`,
      // Fix round (task-7 review, finding 3, constraint 7c extended: "candidates a
      // learner must distinguish have to be indistinguishable by inspection"). These used
      // to be `glean_client_<32>` / `glean_index_<32>`: the whole point of t4-token-type
      // is that the learner must MAKE A REQUEST and read what comes back to tell the two
      // apart, but a literal "client"/"index" word in the credential itself printed the
      // answer straight into the ticket, on every single seed, no matter how the display
      // ORDER was randomized (hard constraint 7a's positional draw was real but bought
      // nothing once identity was readable without moving anything). Both now mint from
      // the identical opaque shape (same prefix, same length, same alphabet); the tokens
      // still differ, since they are drawn from the same RNG stream at different points,
      // but nothing about either STRING names which is which.
      clientToken: `glean_${rng.token(40, LOWER_ALNUM)}`,
      indexingToken: `glean_${rng.token(40, LOWER_ALNUM)}`,
      datasource: `${companyDomainFirstWord}-kb`,
      docs,
    },
    slack: {
      botToken: `xoxb-${rng.digits(12)}-${rng.digits(12)}-${rng.token(24, LOWER_ALNUM)}`,
      signingSecret: rng.hex(32),
      teamId: `T${rng.token(10, UPPER_ALNUM)}`,
      botUserId: `U${rng.token(10, UPPER_ALNUM)}`,
      channels,
    },
    vars: {
      pageSize: String(pageSize),
      targetRepo: targetRepoEntry.name,
      brokenCredentialSlot,
      missingScopeVariant,
      wrongRedirectVariant,
      insufficientScopeVariant,
      shortAccessTokenTtlSec: String(shortAccessTokenTtlSec),
      slackTargetChannelIndex: String(slackTargetChannelIndex),
      gleanTokenOrder,
      gleanMalformedField,
    },
  };
}
