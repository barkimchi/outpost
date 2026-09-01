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
 * One access token the Google OAuth mock has issued. Placeholder shape (Task 2 fix
 * round): the brief for this task said token registries live in World, and google's
 * section only held static client config, no issued-token registry at all. Left empty
 * and unpopulated until Task 6 builds the OAuth mock and its authorization-code /
 * refresh-token registries alongside it; this establishes the pattern (keyed by the
 * literal token string, mirroring GithubTokenRecord) without guessing at fields Task 6
 * has not designed yet.
 */
export interface GoogleIssuedToken {
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
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
    grantedScopes: string[];
    requestedScopes: string[];
    accessTokenTtlSec: number;
    /** Keyed by the literal access token string. Empty until Task 6 populates it. */
    issuedTokens: Record<string, GoogleIssuedToken>;
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
