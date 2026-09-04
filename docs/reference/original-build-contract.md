# Postman Gym — Build Contract

**Working name only.** `postman-gym` is not the shipping name. Postman is a trademark; before any
public showcase this gets renamed and vetted (Google + WHOIS first). Do not put the name in a README
headline, a package `name` you intend to publish, or any domain.

**Purpose:** train first, showcase second. A local gym for realistic enterprise API troubleshooting
reps that doubles as a portfolio artifact. Builds on
`03 Areas/Projects/Active/AI Learning and Development/Postman_Learning_Path.md` (Stages 0-8).

**Absolute rules for every subagent:**
1. No real credentials, ever. No network egress. Everything is localhost + fabricated data.
2. No em-dashes in any user-facing string (tickets, docs, UI copy, README). Use commas, periods,
   semicolons, or separate sentences.
3. Run your phase's verification commands before reporting done. Paste real output, not a claim.
4. Do not delete files you did not create in this phase.
5. If a contract in this file is wrong or impossible, say so in your report. Do not silently deviate.

---

## 0. Stack and layout

- Node 22+ (dev machine has v26), npm workspaces. TypeScript everywhere.
- **server:** Express **4** (not 5), single process, `tsx` for dev, `tsc` for build. Port from
  `process.env.PORT`, default **4600**. Listen on **`0.0.0.0`** (Postman desktop + IPv6-first
  resolution; README documents the `127.0.0.1` fallback).
- **web:** React 18 + Vite + TS, Zustand, Tailwind, CodeMirror 6 (body / response / notes editors).
- No database. Scenario definitions are typed TS. Persistence is `data/progress.json` and
  `data/workspace.json` (both gitignored).
- Prod: `npm run build && npm start` serves `web/dist` from the same port. Dev: Vite on 5173
  proxying `/_trainer` and all four platform prefixes to 4600.

### File tree (authoritative)

```
postman-gym/
  package.json                 # workspaces: shared, server, web
  tsconfig.base.json
  .gitignore                   # node_modules, dist, data/, .DS_Store
  README.md                    # demo script + real-Postman setup guide (Phase 8)
  PLAN.md                      # this file
  data/                        # gitignored, created at runtime
    progress.json
    workspace.json
  shared/
    package.json  tsconfig.json
    src/
      index.ts                 # re-exports
      scenario.ts              # Scenario, Step, RequestMatcher, Assertion, Fault, RunContext
      events.ts                # RequestEvent, TrainerEvent
      proxy.ts                 # ProxyRequest, ProxyResponse
  server/
    package.json  tsconfig.json
    src/
      index.ts                 # bootstrap + listen
      app.ts                   # express app, MOUNT ORDER LIVES HERE
      bus.ts                   # EventEmitter + 200-entry ring buffer
      middleware/
        rawBody.ts  requestLog.ts  faultInjector.ts
      engine/
        engine.ts              # state machine, activate/observe/reset
        generate.ts            # seeded RunContext generator
        match.ts               # RequestMatcher evaluation
        assert.ts              # Assertion evaluation
        progress.ts            # data/progress.json read/write
      scenarios/
        index.ts               # registry (id -> ScenarioTemplate)
        t1-basics.ts  t2-github.ts  t3-oauth.ts
        t4-glean.ts   t5-slack.ts   t6-capstone.ts  impl-track.ts
      docs/                    # markdown served to the Docs tab, one file per platform
        github.md  google.md  glean.md  slack.md
      platforms/
        state.ts               # world state + resetState(ctx)
        github/  router.ts  auth.ts  fixtures.ts
        google/  router.ts  oauth.ts  consent.ts  fixtures.ts
        glean/   router.ts  fixtures.ts
        slack/   router.ts  signature.ts  fixtures.ts
      trainer/
        router.ts  sse.ts  proxy.ts  oauthCallback.ts
  web/
    package.json  tsconfig.json  vite.config.ts  tailwind.config.js  index.html
    src/
      main.tsx  App.tsx
      state/store.ts
      lib/  sse.ts  vars.ts  auth.ts  codegen.ts
      components/
        ExerciseBar.tsx  Divider.tsx
        postman/  PostmanPane.tsx  Sidebar.tsx  EnvSelect.tsx  RequestBuilder.tsx
                  ParamsTab.tsx  AuthTab.tsx  HeadersTab.tsx  BodyTab.tsx
                  OAuthModal.tsx  CodeModal.tsx  ResponsePanel.tsx
        reference/ ReferencePanel.tsx  TicketTab.tsx  DocsTab.tsx  LogsTab.tsx
                   NotesTab.tsx  ExplainBack.tsx
```

---

## 1. URL layout (one port)

| Base | Mirrors | Paths |
|---|---|---|
| `/github` | `https://api.github.com` | `/user`, `/user/repos`, `/repos/:owner/:repo`, `/rate_limit` |
| `/google` | Google OAuth + APIs | `/o/oauth2/v2/auth`, `/oauth2/token`, `/oauth2/v3/userinfo`, `/calendar/v3/...` |
| `/glean`  | Glean public API | `/rest/api/v1/search`, `/api/index/v1/indexdocuments` |
| `/slack`  | `https://slack.com` | `/api/auth.test`, `/api/chat.postMessage`, `/api/conversations.*` |
| `/_trainer` | control plane | scenarios API, proxy, SSE, OAuth callback |

Paths after the prefix are **identical to the real platform** so a Postman environment only needs
`baseUrl` swapped. Never invent a path shape.

---

## 2. Middleware spine (`server/src/app.ts`) — mount order is load-bearing

```
1. rawBody          express.json({ verify }) stashing the raw Buffer on req.rawBody
                    ALSO express.urlencoded + express.text where the platform needs it.
                    Slack HMAC verifies the RAW bytes. Parse-then-restringify will never match.
2. requestLog       wraps res.write/res.end, captures status + body + timing,
                    emits RequestEvent onto the bus.
3. faultInjector    consults the active scenario, applies a matching intercept fault.
4. platform routers /github /google /glean /slack  (healthy behaviour only)
5. trainer router   /_trainer
6. static           web/dist + SPA fallback (prod only, mounted LAST)
```

The bus fans out to (a) SSE `log` events for the Logs tab and (b) `engine.observe()` for assertion
checking. **This single choke point is the whole design.** It is why the built-in UI and real Postman
desktop are indistinguishable to the detection layer.

`requestLog` must not log `/_trainer/sse` itself (infinite loop) and must cap captured bodies at
~64 KB.

---

## 3. Faults: two kinds, prefer the first

**State faults** are applied at scenario activation: expire a token, revoke a scope, rotate the
signing secret, zero the rate-limit counter. The healthy router then errors *naturally*, so the real
fix genuinely resolves it. **Prefer these.**

**Intercept faults** short-circuit in middleware with a verbatim fixture. Use only for stateless
breakage that no state mutation can produce.

Fixtures are **byte-exact real error bodies** with a source-URL comment above each one, so they hold
up to a side-by-side check against the real product. Dynamic values inside a fixture (usernames, scopes, timestamps,
reset epochs) are interpolated from the run context; the envelope and wording stay verbatim.

---

## 4. Per-run data generation (REQUIRED — no memorizable answers)

`server/src/engine/generate.ts` exports `generateRunContext(seed: string): RunContext`.

Every scenario **activation** mints a fresh seed and regenerates **all** concrete data:
company/org name (not always "Acme"), usernames, emails, PAT strings, OAuth client id + secret,
scopes, repo names, channel names, page sizes, cursor contents, rate-limit reset times, *which*
field is malformed, and the webhook signing secret.

Scenario definitions are therefore **templates**: ticket text, docs credential callouts, seeded
platform data, fault parameters, and step assertions are all **functions of `RunContext`**, never
hardcoded literals. Assertions compare against *this run's* generated values.

> **The acceptance test for this whole section:** activate the same scenario twice. Every credential,
> name, and ticket detail differs, and run 1's valid token does **not** solve run 2. If a remembered
> answer works, the gym is broken.

Scenario `id` stays stable for progress tracking. Only concrete data varies.

Use a seeded PRNG (mulberry32 or sfc32 over a hashed seed string). No `Math.random()` inside
generation, so a seed fully reproduces a run for debugging.

---

## 5. Shared schema (`shared/src/scenario.ts`)

```ts
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
export type Platform = 'github' | 'google' | 'glean' | 'slack';

export interface RunContext {
  seed: string;
  company: { name: string; slug: string; domain: string };
  actor:   { login: string; name: string; email: string; id: number };
  github:  { validPat: string; revokedPat: string; scopes: string[]; grantedScopes: string[];
             repos: { name: string; private: boolean }[]; rateLimitResetEpoch: number };
  google:  { clientId: string; clientSecret: string; scopes: string[];
             accessTokenTtlSec: number; refreshToken: string };
  glean:   { clientToken: string; indexingToken: string; datasource: string;
             docs: { id: string; title: string; body: string }[] };
  slack:   { botToken: string; signingSecret: string;
             channels: { id: string; name: string; joined: boolean }[] };
  vars: Record<string, string>;   // extra template values (malformed field name, cursor, etc.)
}

export interface RequestMatcher {
  method?: string | string[];
  path?: string | RegExp;         // matched against the full mock path, e.g. '/github/user'
  platform?: Platform;
  query?: Record<string, string>;
  bodyContains?: string;
}

export type Assertion =
  | { kind: 'status';        equals: number }
  | { kind: 'statusIn';      oneOf: number[] }
  | { kind: 'bodyJsonPath';  path: string; equals?: unknown; exists?: boolean }
  | { kind: 'bodyContains';  text: string }
  | { kind: 'headerEquals';  name: string; value: string }
  | { kind: 'custom';        id: string };   // resolved in engine/assert.ts

export interface Step {
  id: string;
  label: string;                  // shown on the progress chip
  match: RequestMatcher;
  assertions: Assertion[];
  clearFaults?: string[];         // fault ids retired when this step completes
  attemptHint?: string;           // fallback reason text
}

export interface Fault {
  id: string;
  kind: 'state' | 'intercept';
  apply: (ctx: RunContext) => void;             // state faults mutate platforms/state
  match?: RequestMatcher;                        // intercept only
  respond?: (ctx: RunContext) => { status: number; headers?: Record<string,string>; body: unknown };
}

export interface ScenarioTemplate {
  id: string;                     // STABLE across runs, e.g. 't2-revoked-pat'
  tier: Tier;
  platform: Platform;
  title: string;                  // hidden in Drill mode
  docsRef: Platform;
  ticket:   (ctx: RunContext) => string;    // support-escalation markdown
  setup:    (ctx: RunContext) => void;      // seed healthy world state
  faults:   (ctx: RunContext) => Fault[];
  steps:    (ctx: RunContext) => Step[];
  hints:    (ctx: RunContext) => string[];  // unlock at 3 / 6 / 9 attempts
  solutionMd: (ctx: RunContext) => string;
  implementationTrack?: true;     // no faults, go-live framing
}
```

**Attempt feedback is mandatory and must say *why*.** A matched-but-failed request emits
`scenario:attempt` with a human reason ("right endpoint, still 401 — the token is being sent but
GitHub is rejecting it"). Silent non-counting is the #1 frustration bug.

---

## 6. Engine lifecycle

```
idle -> activate(scenarioId)  # mints seed, resetState(), setup(), faults applied
     -> running               # observe() every RequestEvent
     -> (last step passes) -> explaining
     -> (explain-back submitted) -> solved   # persisted to data/progress.json
```

`observe(event)`:
- Not matching the current step's matcher: ignore.
- Matching but assertions fail: `scenario:attempt` + reason. Increment attempts. Unlock hints at
  3 / 6 / 9.
- Matching and all assertions pass: `scenario:step`, retire `clearFaults`, advance. Last step ->
  `explaining`.

**Explain-back gate** (trains support-handoff narration): before `solved`, the UI prompts for (1) root
cause in 2-3 sentences and (2) a short customer-facing reply. Both are stored in `progress.json`,
then `solutionMd` is revealed side-by-side for self-comparison. Only after submission does the
scenario finalize as solved. Works in Demo mode too (prompt renders in the reference panel).

**SSE events** on `/_trainer/sse`: `log`, `scenario:activated`, `scenario:attempt`, `scenario:step`,
`scenario:solved`, `hint:unlocked`, plus a 15s heartbeat. Ring-buffer replay on connect. Route must
set `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and disable compression.
**The UI uses exactly ONE shared `EventSource`.**

`resetState()` must reset **every** counter, token, cursor, and joined-channel flag. A solved
scenario that bricks its own rerun is a build failure.

---

## 7. Sending requests from the built-in UI

`POST /_trainer/api/proxy` — the server executes the request with **undici** and returns status,
headers, body, timing. This kills CORS entirely, and the proxied request arrives at the mock stack
as genuine HTTP, indistinguishable from Postman. One detection path, not two.

The UI resolves `{{variables}}` and the Auth tab into concrete headers **before** proxying.

---

## 8. Google OAuth mock (the riskiest piece)

- Consent page is **stateless and cookie-free**: every OAuth param is carried through as a hidden
  form field. Postman's embedded browser does not reliably keep cookies.
- `authorization_code` grant: `invalid_grant`, `redirect_uri_mismatch`, and scope faults.
- `refresh_token` grant per Google's real behaviour and error bodies.
- Client registry with **two** registered redirect URIs:
  - `https://oauth.pstmn.io/v1/callback` — real Postman intercepts the navigation, so this URL is
    never actually hit. **"Authorize using browser" must be UNCHECKED.** Document this in the README;
    it is the #1 way this flow fails for a user.
  - `http://localhost:4600/_trainer/oauth/callback` — built-in UI popup, `postMessage` back to the
    opener, token exchange routed **through the proxy** so it shows up in the Logs tab.
- Access token TTL is short by design (15s in the expiry scenario) so tokens die mid-exercise.

---

## 9. Frontend layout

CSS grid. Top: 48px `ExerciseBar` (scenario picker with solved checkmarks, progress step chips,
attempt count, Hint, Reset, Drill toggle, Demo toggle). Left ~62%: Postman clone. Right ~38%:
editor-styled `ReferencePanel` with four tabs (Ticket / Docs / Logs / Notes). Draggable divider.

**Demo mode:** a toggle collapses the entire left column. ExerciseBar + ReferencePanel remain, tabs
go full width. This is the companion view for reps done in real Postman desktop and for screen
recording the capstone: ticket, docs, live logs, notes, and progress chips all reacting via SSE to
Postman-originated traffic. Persists in `workspace.json`. Keyboard shortcut to flip.

**Drill mode:** picks a random scenario from a chosen tier (or all), **hides the scenario title and
fault identity**, presents only the ticket. Blind diagnosis, the closest rep to a cold escalation.
Drill + Demo compose: blind ticket beside real Postman is the full cold-escalation simulation.

**`</> Code` export:** cURL / Python `requests` / Node axios (learning path Stage 7.5).

---

## 10. Curriculum (16 troubleshooting + 4 implementation)

**T1 warm-ups** — 405 wrong method with an `Allow` header; query-param pagination; missing
Content-Type to 400.

**T2 GitHub** — revoked PAT 401 `Bad credentials`; missing `repo` scope 403 plus `X-OAuth-Scopes`
forensics; private repo returning **404 not 403** (GitHub's privacy behaviour); rate limit, read
`x-ratelimit-reset`, switch tokens.

**T3 Google OAuth** — `redirect_uri_mismatch`; 15s-TTL token expiring mid-exercise into a refresh
grant; revoked refresh token to `invalid_grant` and full re-consent; missing `calendar.readonly` to
`ACCESS_TOKEN_SCOPE_INSUFFICIENT` and re-consent with the scope.

**T4 Glean** — indexing token used against the search API returns 401 (the token-type distinction);
malformed search body returns a 400 validation error, solved by reading the Docs tab.

**T5 Slack** — `not_in_channel` inside an HTTP **200** (the envelope trap) plus a cursor pagination
step; webhook `v0=` HMAC signature failure with a timestamp replay guard (pre-request script rep).

**T6 Capstone** (the recordable demo, 5 steps) — OAuth consent + exchange, prove access via
userinfo, server revokes the refresh token mid-flight, diagnose `invalid_grant` and re-auth,
successful Glean indexing call. Progress chips lighting up while partly working in real Postman is
the money shot.

**Implementation Track** (parallel, **no faults**, greenfield go-live reps) — `impl-github` (build
env + auth from docs, verify org access, paginate all repos), `impl-oauth` (configure the OAuth
helper from docs, consent, exchange, call userinfo), `impl-glean` (obtain an indexing token, index
generated documents, verify they return from search), `impl-slack` (join a channel, post a message,
page through history). Same step/assertion engine and same per-run generation. Success is the
correct sequence of successful calls, driven purely by reading the Docs tab. Tickets are framed as
"new customer onboarding", not escalations.

---

## 11. Known gotchas (bake in, do not rediscover)

- Postman **desktop** only for localhost. The web client cannot reach it.
- Listen on `0.0.0.0`; document `127.0.0.1` fallback for IPv6-first resolution.
- SSE route: no compression, `no-transform`, heartbeats.
- Capture the raw body **before** JSON parsing or Slack HMAC never matches.
- Every counter and token goes behind `resetState()`, or solved scenarios brick their reruns.
- Accept **both** `token X` and `Bearer X` for GitHub.
- Attempt feedback must say why an attempt did not count.
- Postman auto-adds headers. **Never assert on header absence.**

---

## 12. Build order

0. Scaffold. 1. Spine. 2. GitHub. 3. Engine + generator + scenarios 1-7.
4. Frontend core + Demo mode. 5. Postman-clone completeness. 6. Google OAuth + scenarios 8-11.
7. Glean + Slack + scenarios 12-15. 8. Capstone + Implementation Track + Drill mode + polish.

Manual gates needing a human at the keyboard: real-Postman smoke tests in Phases 2, 3, and 6.

## 13. Out of scope for v1

Timed mode, per-scenario stats, spaced repetition, inbound webhook inspector.

