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
  };
  slack: {
    botToken: string;
    signingSecret: string;
    teamId: string;
    botUserId: string;
    channels: Array<{ id: string; name: string; isMember: boolean }>;
  };
}
