# Postman Gym: Technical Spec

**Status:** binding authority. When the plan and this spec disagree, this spec wins.
**Working name:** `postman-gym`. Postman is a trademark; rename before any public showcase.

## 1. Purpose

A local training gym for enterprise API troubleshooting. It runs four faithful mock
platforms (GitHub REST, Google OAuth 2.0, Glean, Slack) plus a built-in Postman-like
client, and drives scripted breakage/repair exercises. Detection is server-side, so an
exercise can be solved from the built-in UI **or** from real Postman desktop and both
register identically.

Train first, showcase second.

## 2. Hard constraints (never violate)

1. **Single process, single port.** Default `4600` (override with `PORT`). Prod mode
   serves `web/dist` from the same port. `npm start` is the only command a user needs.
   *(4600 was briefly blocked by an orphaned `python -m http.server` running since
   Jul 21; Bar approved killing it on 2026-08-31 and the port is clear. **Do not fall
   back to 4700**: that is Bar's live Atrics client-site preview
   (`python -m http.server 4700 --bind 127.0.0.1`, tmux session `atrics-web`) and must
   not be disturbed. It binds `127.0.0.1` specifically, so a server on `0.0.0.0:4700`
   binds successfully and still loses all localhost traffic to it, which fails silently.
   If 4600 is ever occupied, use `PORT` and pick 4800, not 4700.)*
2. **Listen on `0.0.0.0`.** Document `127.0.0.1` as the fallback base URL for
   IPv6-first resolution. Postman **desktop** only. The web client cannot reach localhost.
3. **No real credentials, ever.** No network egress to real GitHub/Google/Glean/Slack.
   All tokens are generated fakes. No cloud, no telemetry.
4. **Raw body is captured before JSON parsing.** Slack HMAC verification is over the
   exact bytes. `express.json({ verify })` stashing `req.rawBody: Buffer` is the only
   sanctioned mechanism.
5. **Every mutable counter/token/secret lives in the World and is reset by
   `resetState()`.** Activating any scenario calls it first. A scenario that cannot be
   re-run twice in a row is a bug.
6. **Per-run data generation is mandatory.** Every activation mints a fresh seed and
   regenerates all concrete data. Scenario definitions are templates, never literals.
   A token that solved run 1 must fail in run 2.
7. **Assertions compare against the current run's generated values**, never hardcoded
   strings.
7a. **The ANSWER must be generated too, not only the values.** Regenerating credentials
   while the shape of the solution stays fixed produces a memorizable shortcut, which is
   the exact failure per-run generation exists to prevent. Verified example: in
   `t2-revoked-pat` the ticket listed two tokens and the working one was the second across
   8 of 8 activations. Every value differed each run and the stated acceptance test
   passed, yet a learner who ran it three times would learn "use the second token" and
   stop diagnosing. So the generator must also randomize WHICH candidate is the good one,
   WHICH scope is missing, WHICH token is rate-limited, WHICH page holds the target, and
   WHICH field is malformed. **The acceptance test is therefore two-part:** across
   repeated activations, (a) the concrete values differ and run 1's answer fails in run 2,
   AND (b) the position or identity of the correct answer varies. Part (b) is the one that
   is easy to pass by accident while still being broken.
8. **Never assert on the absence of a header.** Postman adds its own (`User-Agent`,
   `Accept`, `Postman-Token`, `Accept-Encoding`, `Connection`).
9. **Attempt feedback always says why it didn't count.** "Right endpoint, still 401"
   beats silence.
10. **The SSE route sets `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
    `X-Accel-Buffering: no`, and is excluded from any compression.** 15s heartbeat.
11. **GitHub accepts both `Authorization: token X` and `Authorization: Bearer X`.**
12. **No em-dashes in any user-facing copy** (tickets, docs, README, UI strings).

## 3. Stack

- Node 22+ (dev machine has v26), TypeScript, **Express 4** (not 5), `tsx` for dev.
- npm workspaces: `shared/`, `server/`, `web/`.
- Server: `undici` for the proxy's outbound requests. No DB.
- Web: React 18, Vite 5, TypeScript, Zustand, Tailwind 3, CodeMirror 6.
- Persistence: `data/progress.json`, `data/workspace.json` (both gitignored, written
  atomically via write-temp-then-rename, debounced 250ms).
- Dev: Vite on 5173 proxying `/_trainer`, `/github`, `/google`, `/glean`, `/slack` to 4600.

## 4. File tree

```
postman-gym/
├── package.json                  # workspaces + root scripts
├── tsconfig.base.json
├── .gitignore                    # node_modules, dist, data/*.json, .superpowers/
├── README.md                     # demo script + real-Postman setup guide
├── docs/{SPEC.md,PLAN.md}
├── data/                         # runtime state (gitignored, .gitkeep tracked)
├── shared/
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── index.ts              # re-exports
│       ├── scenario.ts           # RunContext, ScenarioDef, Step, Fault, Assertion, RequestMatcher
│       ├── events.ts             # RequestEvent, TrainerEvent
│       └── api.ts                # trainer HTTP request/response types
├── server/
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── index.ts              # boot + listen(0.0.0.0, PORT)
│       ├── app.ts                # express app; MOUNT ORDER LIVES HERE
│       ├── config.ts             # PORT, paths, constants
│       ├── bus.ts                # EventEmitter + 200-entry ring buffer
│       ├── middleware/{rawBody.ts,requestLog.ts,faultInjector.ts}
│       ├── engine/
│       │   ├── engine.ts         # lifecycle state machine + observe()
│       │   ├── generate.ts       # seeded RNG + RunContext generator
│       │   ├── match.ts          # RequestMatcher evaluation
│       │   ├── assert.ts         # Assertion evaluation
│       │   └── persist.ts        # progress.json / workspace.json
│       ├── scenarios/
│       │   ├── index.ts          # registry (ordered)
│       │   ├── t1-warmups.ts     # 1-3
│       │   ├── t2-github.ts      # 4-7
│       │   ├── t3-google.ts      # 8-11
│       │   ├── t4-glean.ts       # 12-13
│       │   ├── t5-slack.ts       # 14-15
│       │   ├── t6-capstone.ts    # 16
│       │   └── impl-track.ts     # impl-github, impl-oauth, impl-glean, impl-slack
│       ├── platforms/
│       │   ├── world.ts          # World type + resetState() + activeWorld()
│       │   ├── github/{router.ts,fixtures.ts}
│       │   ├── google/{router.ts,oauth.ts,consent.ts,fixtures.ts}
│       │   ├── glean/{router.ts,fixtures.ts}
│       │   └── slack/{router.ts,fixtures.ts,sign.ts}
│       ├── trainer/
│       │   ├── router.ts         # /_trainer/api/*
│       │   ├── sse.ts            # /_trainer/events
│       │   ├── proxy.ts          # POST /_trainer/api/proxy
│       │   └── oauthCallback.ts  # GET /_trainer/oauth/callback
│       └── content/
│           ├── docs/*.md         # Docs tab source (one file per platform + auth topics)
│           └── index.ts          # doc registry
└── web/
    ├── package.json  vite.config.ts  index.html  tailwind.config.js  postcss.config.js
    └── src/
        ├── main.tsx  App.tsx  index.css
        ├── state/store.ts        # zustand: workspace, request, response, scenario, logs, ui
        ├── api/{client.ts,sse.ts}
        └── components/
            ├── ExerciseBar.tsx
            ├── postman/{Sidebar.tsx,RequestBuilder.tsx,ResponsePanel.tsx,EnvEditor.tsx,AuthTab.tsx,BodyTab.tsx,CodeExportModal.tsx,OAuthModal.tsx}
            └── reference/{ReferencePanel.tsx,TicketTab.tsx,DocsTab.tsx,LogsTab.tsx,NotesTab.tsx,ExplainBack.tsx}
```

## 5. URL layout

| Base | Mirrors | Endpoints |
|---|---|---|
| `/github` | `https://api.github.com` | `GET /user`, `GET /user/repos`, `GET /repos/:owner/:repo`, `GET /orgs/:org/repos`, `GET /rate_limit` |
| `/google` | Google OAuth + APIs | `GET /o/oauth2/v2/auth`, `POST /o/oauth2/v2/auth` (consent submit), `POST /oauth2/token`, `POST /oauth2/revoke`, `GET /oauth2/v3/userinfo`, `GET /calendar/v3/users/me/calendarList`, `GET /calendar/v3/calendars/:id/events` |
| `/glean` | Glean public API | `POST /rest/api/v1/search`, `POST /rest/api/v1/chat`, `POST /api/index/v1/indexdocument`, `POST /api/index/v1/indexdocuments`, `GET /api/index/v1/getdocumentstatus` |
| `/slack` | `https://slack.com` | `POST /api/auth.test`, `POST /api/chat.postMessage`, `GET /api/conversations.list`, `GET /api/conversations.history`, `POST /api/conversations.join`, `POST /webhook/events` (signature-verified) |
| `/_trainer` | control plane | see §9 |

Paths under a platform base are **byte-identical to the real product's paths** so a
Postman collection built here transfers by swapping one `{{baseUrl}}`.

## 6. Middleware spine (`server/src/app.ts`)

Mount order is load-bearing. Any reordering is a defect.

```
1. rawBody          express.json({ limit:'2mb', verify:(req,_res,buf)=>{ req.rawBody = buf } })
                    + express.urlencoded({ extended:true, verify: same })
                    + express.text({ type:['text/*','application/xml'], ... })
2. requestLog       wraps res.write/res.end; on finish builds a RequestEvent
                    { id, ts, method, path, pathLower, query, reqHeaders (redacted values
                      kept, this is a training tool, secrets are fake), reqBody (utf8,
                      capped 8KB), status, resHeaders, resBody (capped 8KB), durationMs,
                      platform, source: 'proxy' | 'external' }
                    -> bus.emit('request', ev)

                    method/path/query are captured BEFORE routing. Express rewrites
                    req.path inside a mounted router when the handler responds without
                    calling next(), which silently truncates the logged path.

                    `path` is verbatim, for display in the Logs tab: it is evidence the
                    learner reads and must show what was actually sent. `pathLower` is
                    lowercased with any trailing slash stripped (except root). THE ENGINE
                    MATCHES ON `pathLower`, never on `path`. Express routes
                    case-insensitively, so `GET /GitHub/user` returns a real 200 from the
                    mock; matching on the verbatim path would make that request invisible
                    to the engine, which is the silent-scenario-failure mode. Platform
                    derivation and the skip list below use `pathLower` for the same reason.

                    Body-parser failures (malformed JSON, 413) must ALSO emit a
                    RequestEvent, from the error handler, built from the pre-routing
                    capture. rawBody mounts above requestLog, so a parser error otherwise
                    jumps straight to the error handler and the learner gets a correct 400
                    with total engine silence, violating hard constraint 9. Malformed
                    bodies are a first-class lesson here (see `t4-malformed-body`), so that
                    path must be observable. Guard `finish()` against re-entry so the error
                    path cannot double-emit and double-count an attempt.
3. faultInjector    if engine has an active intercept fault matching this request,
                    short-circuit with its verbatim body. State faults are NOT here.
4. /_trainer        trainer router (SSE excluded from any compression)
5. /github /google /glean /slack   healthy platform routers
6. static web/dist + SPA fallback (prod only)
7. 404 + error handler
```

`requestLog` sits **above** `faultInjector` so intercepted responses are logged exactly
like organic ones. The bus fans out to (a) SSE `log` events and (b) `engine.observe(ev)`.

`requestLog` **must not log the SSE route itself.** Logging `/_trainer/events` emits a
log event, which the stream then delivers, which is a feedback loop. Skip the SSE path by
path match, not only by content type, and skip `/_trainer/api/proxy` request logging too:
the proxied inner request is the one that matters and is logged on its own way through.

Bus: `EventEmitter` + a 200-entry ring buffer replayed to each new SSE client.

## 7. Fault model

Two kinds. **Prefer state faults.**

```ts
type Fault =
  | { id: string; kind: 'state';     apply(w: World): void }
  | { id: string; kind: 'intercept'; match: RequestMatcher;
      respond: { status: number; headers: Record<string,string>; body: string } }
```

- **State fault** mutates the World at activation (expire a token, drop a scope, rotate
  the signing secret, zero the rate-limit budget). The healthy router then errors on its
  own, so the real-world fix genuinely resolves it.
- **Intercept fault** short-circuits with a verbatim fixture. For stateless breakage only.

Fixtures live in `platforms/*/fixtures.ts` as functions of the run context. Each carries a
`// source: <url> (verified <date>)` comment. The **envelope and wording stay verbatim**;
only interpolated values (usernames, scopes, ids, timestamps) vary. Where a real body could
not be verified against public docs, the comment must say
`// UNVERIFIED SHAPE: approximated from <what>` so nobody claims byte-exactness it lacks.

`clearFaults: string[]` on a Step removes those fault ids when the step completes. This is
how multi-step scenarios (the capstone) stage their breakage.

## 8. Types (`shared/src/scenario.ts`)

```ts
export interface RunContext {
  seed: string;                 // 8 hex chars, shown in the UI as "run #a3f9c1d2"
  company: { name: string; slug: string; domain: string };
  user:    { login: string; name: string; email: string; id: number };
  github: {
    validPat: string; revokedPat: string; secondPat: string;
    scopes: string[]; org: string;
    repos: Array<{ name: string; private: boolean; id: number }>;
    privateRepo: string; rateLimit: number;
  };
  google: {
    clientId: string; clientSecret: string;
    grantedScopes: string[]; requestedScopes: string[];
    accessTokenTtlSec: number;   // 15 for the expiry scenario, 3600 otherwise
  };
  glean: {
    instance: string; clientToken: string; indexingToken: string;
    datasource: string;
    docs: Array<{ id: string; title: string; body: string }>;
  };
  slack: {
    botToken: string; signingSecret: string; teamId: string; botUserId: string;
    channels: Array<{ id: string; name: string; isMember: boolean }>;
  };
  /** Extra per-run template values that do not belong to one platform: which field is
   *  malformed this run, the cursor contents, a page size, a reset epoch. Ticket text,
   *  docs callouts, and assertions read from here so they stay data-driven. */
  vars: Record<string, string>;
}

export type Assertion =
  | { kind:'status';          equals: number }
  | { kind:'statusIn';        oneOf: number[] }
  | { kind:'jsonPath';        path: string; equals?: unknown; matches?: string; exists?: boolean }
  | { kind:'jsonArrayLength'; path: string; min?: number; max?: number; equals?: number }
  | { kind:'headerEquals';    name: string; equals: string }     // name lowercased
  | { kind:'headerMatches';   name: string; matches: string }
  | { kind:'bodyMatches';     matches: string }
  | { kind:'reqHeaderMatches';name: string; matches: string }
  | { kind:'reqJsonPath';     path: string; equals?: unknown; matches?: string; exists?: boolean }
  /** Escape hatch for a check the declarative kinds cannot express (a decoded cursor, a
   *  recomputed HMAC). Resolved by id in engine/assert.ts against a small registry.
   *  Use sparingly: a scenario made entirely of custom assertions is unreviewable. */
  | { kind:'custom';          id: string };

export interface RequestMatcher {
  method?: string | string[];
  pathPattern: string;                      // RegExp source, anchored by the matcher
  queryIncludes?: Record<string,string>;
  reqHeaderPresent?: string[];
}

export interface Step {
  id: string; title: string;
  match: RequestMatcher;
  assertions: Assertion[];
  clearFaults?: string[];
  attemptHint?: string;                     // shown when match hits but assertions fail
}

export interface BuiltScenario {
  ticketMd: string;
  setup: Array<(w: World) => void>;
  faults: Fault[];
  steps: Step[];
  hints: string[];                          // unlock at 3 / 6 / 9 attempts
  solutionMd: string;
}

export interface ScenarioDef {
  id: string;                               // stable across runs (progress key)
  tier: 1|2|3|4|5|6;
  track: 'troubleshoot' | 'implementation';
  title: string;                            // hidden in Drill mode
  platform: 'github'|'google'|'glean'|'slack'|'mixed';
  docsRef: string[];
  build(ctx: RunContext): BuiltScenario;
}
```

`jsonPath` uses a minimal dotted/bracket path (`a.b[0].c`), implemented in
`engine/assert.ts`. No external jsonpath dependency.

## 9. Engine

**Lifecycle:** `idle → active → explaining → solved`.

- `activate(scenarioId | {drill:{tier?}})`: `resetState()` → mint seed → `generate(seed)`
  → `def.build(ctx)` → apply `setup` → register `faults` → step index 0 → emit
  `scenario:activated`.
- `observe(ev: RequestEvent)`: if not `active`, ignore. Evaluate the current step's
  `match`.
  - no match → ignore entirely (browsing does not count as an attempt)
  - match + all assertions pass → step complete; `clearFaults`; emit `scenario:step`;
    advance. Last step → `explaining` (emit `scenario:explaining`).
  - match + any assertion fails → `attempts++`; emit `scenario:attempt` with a **human
    reason** built from the first failing assertion (`"right endpoint, still 401"`,
    `"200 but the body has 0 repos, expected at least 1"`). Unlock hints at 3/6/9.
- `explain({rootCause, customerReply})` → persist both into `progress.json`, emit
  `scenario:solved`, return `solutionMd`.

**Drill mode:** activation with `{drill:{tier?}}` picks a random scenario from the tier
(or all), and the activated payload omits `title` and any fault identity. Only `ticketMd`
and step *count* are exposed. `drill: true` on the event tells the UI to hide the title.

**Progress (`data/progress.json`):**
```json
{ "version": 1,
  "scenarios": { "<id>": { "solved": true, "solvedAt": "...", "runs": 3, "attempts": 7,
                           "explanations": [ { "at":"...", "rootCause":"...", "customerReply":"..." } ] } } }
```

## 10. Trainer API

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/_trainer/api/health` | | `{ok:true, version, port}` |
| GET | `/_trainer/api/scenarios` | | `[{id,tier,track,title,platform,solved,runs}]` |
| POST | `/_trainer/api/scenarios/:id/activate` | | activated payload |
| POST | `/_trainer/api/scenarios/drill` | `{tier?}` | activated payload (title omitted) |
| POST | `/_trainer/api/scenarios/reset` | | `{ok:true}` (re-activates current, new seed) |
| GET | `/_trainer/api/state` | | current engine state + steps + attempts + hints unlocked |
| POST | `/_trainer/api/hint` | | `{index, text}` or 409 if none unlocked |
| POST | `/_trainer/api/solution` | | `{solutionMd}` (marks revealed) |
| POST | `/_trainer/api/explain` | `{rootCause, customerReply}` | `{solutionMd}` |
| POST | `/_trainer/api/proxy` | `{method,url,headers,body}` | `{status,headers,body,timeMs,sizeBytes}` |
| GET | `/_trainer/api/docs` | | `[{id,title,platform}]` |
| GET | `/_trainer/api/docs/:id` | | `{id,title,md}` |
| GET | `/_trainer/api/workspace` | | collections + environments + notes + ui |
| PUT | `/_trainer/api/workspace` | full workspace | `{ok:true}` |
| GET | `/_trainer/events` | | SSE stream |
| GET | `/_trainer/oauth/callback` | `code`/`error` | HTML that `postMessage`s to the opener |

**Proxy** rules: only `http://127.0.0.1:<PORT>`, `http://localhost:<PORT>`, and
`http://0.0.0.0:<PORT>` targets are permitted (reject anything else with 400, which keeps
a training tool from becoming an open SSRF relay). It forwards method/headers/body via
`undici.request`, follows no redirects, and returns the response verbatim. Proxied
requests re-enter the server as genuine HTTP, so `requestLog` sees them exactly like
Postman's.

**SSE events:** `log`, `scenario:activated`, `scenario:attempt`, `scenario:step`,
`scenario:explaining`, `scenario:solved`, `hint:unlocked`, `heartbeat`. The UI keeps
**one** `EventSource` for the whole app.

## 11. Google OAuth mock

The riskiest module. Requirements:

- **Cookie-free, stateless consent page.** `GET /google/o/oauth2/v2/auth` renders an HTML
  consent screen carrying every inbound param as hidden fields; `POST` to the same path
  with `approve=1` issues the code. Postman's embedded browser blocks third-party cookies,
  so no session may be involved.
- **Registered redirect URIs** (exactly these two):
  - `https://oauth.pstmn.io/v1/callback` (real Postman intercepts the navigation; the URL
    is never actually fetched. **"Authorize using browser" must be UNCHECKED.**)
  - `http://localhost:4600/_trainer/oauth/callback` (built-in UI popup → `postMessage`)
- Anything else → `400` HTML page reading **Error 400: redirect_uri_mismatch**.
- `POST /google/oauth2/token` supports `grant_type=authorization_code` and
  `grant_type=refresh_token`. Codes are single-use, 60s TTL. Errors:
  `{"error":"invalid_grant","error_description":"Bad Request"}` (400),
  `{"error":"invalid_client","error_description":"Unauthorized"}` (401),
  `{"error":"redirect_uri_mismatch","error_description":"Bad Request"}` (400).
- Access tokens carry granted scopes; resource endpoints enforce them.
  Insufficient scope → 403 with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` in
  `error.details[0].reason`. Expired/invalid token → 401 `UNAUTHENTICATED`.
- `POST /google/oauth2/revoke` invalidates a refresh token, which then yields
  `invalid_grant` on the next refresh.

## 12. Scenario curriculum

Ids are stable. `#` = order in the registry.

**Tier 1: warm-ups (`t1-warmups.ts`)**
1. `t1-wrong-method`: POST to a GET-only endpoint → 405 + `Allow` header.
2. `t1-pagination`: read `per_page`/`page` from docs, fetch a specific page.
3. `t1-content-type`: JSON body sent without `Content-Type: application/json` → 400.

**Tier 2: GitHub (`t2-github.ts`)**

Per hard constraint 7a, every scenario below hands over two neutrally-labeled candidate
tokens ("Token 1" / "Token 2", not "the wired-in one" / "the spare"); which one is
actually broken is randomized per run, so the fix is found by testing both, never by
position.

4. `t2-revoked-pat`: 401 `Bad credentials` from whichever token was revoked; fix by
   switching to the other.
5. `t2-missing-scope`: 403; diagnose via `X-OAuth-Scopes` vs `X-Accepted-OAuth-Scopes`.
   Which scope is missing is itself randomized between two real, distinct scope-gated
   endpoints (`GET /orgs/:org/repos` needing `read:org`, `GET /notifications` needing
   `notifications`), not just which token has it.
6. `t2-private-404`: private repo returns **404 not 403** (GitHub's privacy behavior);
   the lesson is that 404 can mean "no permission". The token missing the `repo` scope
   is randomized between the two candidates.
7. `t2-rate-limit`: 403 + `x-ratelimit-remaining: 0` from whichever token is exhausted;
   read `x-ratelimit-reset`, switch to the other token.

**Tier 3: Google OAuth (`t3-google.ts`)**
8. `t3-redirect-mismatch`: wrong callback URL in the OAuth helper.
9. `t3-token-expiry`: 15s access-token TTL; token dies mid-exercise → refresh grant.
10. `t3-revoked-refresh`: server revokes the refresh token → `invalid_grant` → full
    re-consent.
11. `t3-insufficient-scope`: `calendar.readonly` missing → `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
    → re-consent with the added scope.

**Tier 4: Glean (`t4-glean.ts`)**
12. `t4-token-type`: indexing token used against the search API → 401. The distinction
    between client and indexing tokens is the lesson.
13. `t4-malformed-body`: search body missing a required field → 400 validation error,
    solved by reading the Docs tab.

**Tier 5: Slack (`t5-slack.ts`)**
14. `t5-envelope-trap`: `chat.postMessage` returns **HTTP 200** with
    `{"ok":false,"error":"not_in_channel"}`; fix by `conversations.join`, then page
    `conversations.history` with a cursor.
15. `t5-hmac-signature`: webhook `v0=` HMAC fails after the signing secret rotates;
    includes the 5-minute timestamp replay guard. A Postman pre-request script rep.

**Tier 6: capstone (`t6-capstone.ts`)**
16. `t6-capstone`: 5 steps: consent + code exchange → prove access via userinfo →
    server revokes the refresh token mid-flight → diagnose `invalid_grant` and re-auth →
    successful Glean indexing call. This is the recordable Ryan demo.

**Implementation track (`impl-track.ts`, `track:'implementation'`, no faults).**
Greenfield go-live reps framed as new-customer onboarding, solved purely by reading Docs:
- `impl-github`: build env + auth from docs, verify org access, paginate all repos.
- `impl-oauth`: configure the OAuth helper from docs, consent, exchange, call userinfo.
- `impl-glean`: obtain an indexing token, index the generated documents, verify they
  come back from search.
- `impl-slack`: join a channel, post a message, page through history.

## 13. Frontend

CSS grid. Top `ExerciseBar` (48px): scenario picker with solved checkmarks, step chips,
attempt count, Hint, Reset, Drill, and the **Demo mode** toggle. Below: left column
(~62%) Postman clone, draggable divider, right column (~38%) reference panel styled like
a text editor with tabs **Ticket / Docs / Logs / Notes**.

**Demo mode:** collapses the entire left column; ExerciseBar + reference panel go full
width. This is the companion view for reps done in real Postman desktop and for screen
recording the capstone. Persisted in `workspace.json`; keyboard shortcut `Cmd+\`.
Drill mode and Demo mode compose.

**Postman clone** must cover: collections sidebar (folders + requests), environment
select + editor, `{{var}}` resolution and highlighting, Params/Auth/Headers/Body tabs,
Auth types (No Auth, Bearer, Basic, API Key, OAuth 2.0 helper modal), Body types (none,
raw JSON, form-urlencoded), Pre-request and Tests script tabs (§14), response panel
(status pill, time, size, Pretty/Raw/Headers, Test Results, Console), and a `</> Code`
export modal producing cURL / Python `requests` / Node axios.

**Explain-back:** on `scenario:explaining`, the reference panel prompts for a 2-3 sentence
root cause and a short customer-facing reply. Submitting persists both, then reveals
`solutionMd` side by side. Only then does the scenario finalize as solved. Works in Demo
mode too.

## 14. Script engine (learning-path Stage 9)

In scope for v1. Postman runs scripts **in the client**, so this does too. It is a
practice surface, not an assertion surface (see the dual-client rule below).

**Execution:** a sandboxed **Web Worker** created from a Blob URL. No DOM, no `window`,
no `fetch`, no network. The main thread posts `{script, context}` and receives
`{testResults, envPatch, consoleLines, error}` via structured clone. Hard timeout of
**2000ms** enforced by `worker.terminate()`; a timed-out script reports as a failed run,
never a hung UI. A fresh worker per execution, so no state leaks between runs.

**Two script slots per request**, persisted in `workspace.json` on the request object as
`scripts: { preRequest: string, test: string }`:
- **Pre-request** runs before the proxy call. Its `envPatch` is applied to the environment,
  and the request is then resolved against the updated environment, so a script that
  computes a signature or refreshes a token genuinely changes what goes over the wire.
- **Tests** runs after the response arrives, with `pm.response` populated.

**`pm` API surface (v1).** Deliberately small, matching what the learning path and the
Slack HMAC rep need:
```
pm.test(name, fn)                     // registers; a throw inside fn = fail
pm.expect(value)                      // .to.eql / .to.equal / .to.include / .to.be.ok
                                      // .to.have.status(n) / .to.have.property(k)
pm.response.code | .status | .responseTime | .json() | .text()
pm.response.headers.get(name)         // case-insensitive
pm.response.to.have.status(n)
pm.request.method | .url | .headers | .body
pm.environment.get(k) / .set(k,v) / .unset(k)
pm.variables.get(k) / .set(k,v)
pm.collectionVariables.get(k) / .set(k,v)
console.log(...)                      // captured into consoleLines, shown in the Console
```
`pm.sendRequest` is **out of scope for v1** (it needs async plumbing through the worker
and the proxy). Say so in the docs rather than stubbing it.

**CryptoJS** is exposed as a global, backed by the real `crypto-js` package, because the
canonical Slack signing snippet uses `CryptoJS.HmacSHA256(...).toString()` and WebCrypto's
async `subtle.sign` cannot match that synchronous call shape. At minimum `HmacSHA256`,
`SHA256`, and `enc.Hex` must work.

**UI:** two more request-builder tabs, **Pre-request** and **Tests**, CodeMirror in
JavaScript mode. The response panel gains a **Test Results** tab (pass/fail rows, green
count badge on the tab) and a **Console** tab for `console.log` output. Tab badges show
counts the way Postman's do.

**Dual-client rule (load-bearing):** scenario assertions stay server-side and never depend
on client test results, because real Postman's results are invisible to the server and
parity between the two clients is the whole point. Scripts still affect server-visible
behavior through the environment they mutate, which is the part that matters. No scenario
may gate on `pm.test` outcomes.

## 15. Verification discipline

Every phase ships with curl commands that prove it. A phase is not done until its checks
run green in a real shell and the output is pasted into the report. "Looks right" is not
evidence. Real-Postman gates are performed by a human and are called out explicitly.
