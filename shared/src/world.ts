/**
 * The `World` type: all mutable per-run state for all four mock platforms (docs/SPEC.md
 * section 4: "world.ts # World type + resetState() + activeWorld()"; hard constraint 5:
 * "Every mutable counter/token/secret lives in the World and is reset by resetState()").
 * A scenario's `setup: Array<(w: World) => void>` and its faults' `apply(w: World): void`
 * (spec section 7) both mutate this shape.
 *
 * Lives in its own file, separate from scenario.ts, on purpose (Task 2 fix round):
 * scenario.ts is the frozen spec section 8 contract every later task reads without
 * expecting it to move, while `World` itself is expected to grow. Tasks 6 and 7 add a
 * Google authorization-code/refresh-token registry, Slack posted-message history, and
 * Glean index state to this file; none of that is churn scenario.ts should carry.
 *
 * Task 7 additions: `World.glean.indexedDocs` (a runtime registry the indexing endpoints
 * populate, mirroring the shape of `World.google.issuedTokens`: RunContext's own
 * `glean.docs` are the company's PRE-EXISTING searchable content, generated once per run;
 * `indexedDocs` is separate, live state built only by real `POST /indexdocument`/
 * `/indexdocuments` calls during the run) and `World.slack.messages` (seeded, per-channel
 * message history for `conversations.history`'s cursor pagination, generated
 * deterministically from the run's seed by `platforms/world.ts`'s `resetState()`, since
 * `RunContext.slack.channels` per spec section 8's frozen contract carries no message
 * content of its own).
 *
 * World's canonical runtime home is server/src/platforms/world.ts per spec section 4's
 * file tree, but its TYPE has to live here in shared: server already depends on
 * @gym/shared (server/tsconfig.json references ../shared), so a type import in the other
 * direction (shared depending on a server-only module) would be a circular workspace
 * dependency. server/src/platforms/world.ts re-exports `World` from here, so anyone
 * importing "the World type" from the file the spec's file tree names for it still finds
 * it there.
 */

export interface GithubTokenRecord {
  /** false for a revoked or otherwise never-valid token: GET requests 401 immediately. */
  valid: boolean;
  scopes: string[];
  rateLimit: {
    limit: number;
    remaining: number;
    /** Unix seconds. */
    reset: number;
    used: number;
    resource: string;
  };
}

/**
 * One access token the Google OAuth mock has issued. Originally a placeholder (Task 2 fix
 * round) establishing the keyed-by-literal-token-string pattern (mirroring
 * GithubTokenRecord) before Task 6 designed the real fields. Now populated by Task 6's
 * `platforms/google/oauth.ts`.
 */
export interface GoogleIssuedToken {
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
  /**
   * The refresh token minted in the same grant as this access token, if any (Task 6).
   * Lets `POST /google/oauth2/revoke` cascade: real Google's revoke endpoint invalidates
   * the WHOLE grant when handed either half of it, not just the literal token string
   * passed in, so revoking an access token must also revoke its paired refresh token.
   */
  pairedRefreshToken?: string;
}

/**
 * One authorization code the Google OAuth mock has issued (Task 6, docs/SPEC.md section
 * 11: "Codes are single-use, 60s TTL"). `redirectUri` is the exact URI the code was
 * issued against: `POST /oauth2/token`'s `redirect_uri` must match it exactly, or the
 * exchange fails with `redirect_uri_mismatch` rather than `invalid_grant` (real Google's
 * distinction between the two errors, matched here). `used` enforces single-use: a second
 * exchange attempt with the same code, even before it expires, is `invalid_grant`.
 * `clientId` binds the code to the client that requested it (Task 6 fix round: RFC 6749
 * section 4.1.3 and real Google both require the token exchange's `client_id` to match the
 * one the authorization request used; a token exchange presenting a DIFFERENT client_id,
 * even a syntactically valid one, is `invalid_client`, not silently accepted).
 */
export interface GoogleAuthCode {
  redirectUri: string;
  scopes: string[];
  clientId: string;
  /** Unix seconds. */
  expiresAt: number;
  used: boolean;
}

/**
 * One refresh token the Google OAuth mock has issued (Task 6). Refresh tokens are not
 * rotated on use (matching real Google's default behavior): a `grant_type=refresh_token`
 * exchange reuses the same refresh token string and mints a new access token with the
 * SAME scopes this record was issued with. This is exactly why `t3-insufficient-scope`
 * cannot be fixed by refreshing: refreshing never changes `scopes`, only a brand new
 * consent (a fresh authorization code requesting the added scope) can. `clientId` is the
 * same client-binding requirement as `GoogleAuthCode.clientId` above.
 */
export interface GoogleRefreshToken {
  scopes: string[];
  clientId: string;
  revoked: boolean;
}

/**
 * One document the Glean indexing mock has actually received via `POST /indexdocument` or
 * `/indexdocuments` (Task 7), distinct from `World.glean.docs` (the run's PRE-SEEDED,
 * already-searchable company content). Deliberately minimal: no scenario in this task
 * asserts on indexing status beyond "a call to indexdocument/indexdocuments with a valid
 * indexing token and a well-formed document succeeds and the document is retrievable from
 * getdocumentstatus," which is exactly what these fields support.
 */
export interface GleanIndexedDoc {
  id: string;
  datasource: string;
  title?: string;
  /** Unix ms, `Date.now()` at the moment the indexing call was received. */
  indexedAt: number;
}

/** One message in a channel's seeded history (Task 7), oldest-message-last (index 0 is the
 *  newest), matching real Slack's `conversations.history` default ordering. Generated
 *  deterministically from the run's seed, not authored per scenario: `t5-envelope-trap`
 *  reads only the shape (how many exist, which one is oldest), never a literal value. */
export interface SlackMessage {
  /** Slack's own message-id convention: a fractional unix-seconds string, e.g.
   *  "1700000000.000100". Not asserted on by any scenario; present for shape realism. */
  ts: string;
  user: string;
  text: string;
}

export interface World {
  github: {
    user: { login: string; name: string; email: string; id: number };
    org: string;
    repos: Array<{ name: string; private: boolean; id: number }>;
    /** Keyed by the literal token string, since GitHub's rate-limit budget is per-token. */
    tokens: Record<string, GithubTokenRecord>;
  };
  google: {
    clientId: string;
    clientSecret: string;
    accessTokenTtlSec: number;
    /** Keyed by the literal access token string. */
    issuedTokens: Record<string, GoogleIssuedToken>;
    /** Keyed by the literal authorization code string (Task 6). */
    authCodes: Record<string, GoogleAuthCode>;
    /** Keyed by the literal refresh token string (Task 6). */
    refreshTokens: Record<string, GoogleRefreshToken>;
  };
  glean: {
    instance: string;
    clientToken: string;
    indexingToken: string;
    datasource: string;
    docs: Array<{ id: string; title: string; body: string }>;
    /** Keyed by the literal document id (Task 7). Empty at every reset; populated live by
     *  real indexing calls during the run. */
    indexedDocs: Record<string, GleanIndexedDoc>;
  };
  slack: {
    botToken: string;
    signingSecret: string;
    teamId: string;
    botUserId: string;
    /** The run's company name (RunContext.company.name), mirrored here for `auth.test`'s
     *  response (Task 7): the same cross-platform-identity-reuse precedent
     *  `platforms/google/router.ts`'s userinfo handler already sets by reading
     *  `world.github.user` rather than duplicating identity data with no other home. */
    teamName: string;
    channels: Array<{ id: string; name: string; isMember: boolean }>;
    /** Keyed by channel id, newest-message-first (Task 7). Seeded deterministically at
     *  every reset so `conversations.history` has real, reproducible content to page
     *  through; never mutated by `chat.postMessage` (a posted message is not appended
     *  back into this seeded history, since no scenario needs it to be). */
    messages: Record<string, SlackMessage[]>;
  };
}
