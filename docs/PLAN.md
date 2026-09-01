# Postman Gym: Implementation Plan

Spec: `docs/SPEC.md` (binding authority). Read the relevant spec sections before writing code.

Repo root: `/Users/barkimchi/BarKimchiMain/02 Projects/Postman Gym` (its own git repo, branch `master`).
Note the space in the path: quote it in every shell command.

## Global Constraints

These bind every task. A reviewer treats a violation as an Important finding.

1. **Port 4600**, `PORT` env override, listen on `0.0.0.0`. One process, one port.
2. **No em-dashes anywhere in user-facing copy** (tickets, docs, README, UI strings, error
   text). Use commas, periods, semicolons, or separate sentences. This is a hard style rule.
3. **No real credentials, no network egress** to real GitHub/Google/Glean/Slack. Every
   token is a generated fake. The proxy only permits localhost targets (spec §10).
4. **Raw body captured before JSON parsing** via `express.json({verify})` → `req.rawBody:
   Buffer`. Slack HMAC depends on it.
5. **Per-run generation**: scenario definitions are templates taking `RunContext`. No
   hardcoded tokens, usernames, org names, repo names, channel names, or scopes in a
   scenario or an assertion. Activating the same scenario twice must produce different
   concrete data, and run 1's valid token must NOT solve run 2.
6. **`resetState()` on every activation.** Any scenario must be re-runnable indefinitely.
7. **Never assert on the absence of a request header.** Postman injects its own.
8. **Middleware mount order** is exactly spec §6. Reordering is a defect.
9. **TypeScript strict mode on.** `npm run typecheck` must pass at the end of every task.
10. **Fixtures carry a `// source: <url>` comment**, or `// UNVERIFIED SHAPE: approximated
    from <what>` when a real body could not be confirmed. Never claim byte-exactness you
    did not verify.
11. **Every task ends with its verification commands actually run**, with real output
    pasted into the report. Not "this should return 401" but the actual response.
12. Commit as you go with clear messages. Do not amend or force-push.

## Conventions for implementers

- You are working in an existing repo with `docs/SPEC.md` and `docs/PLAN.md` already
  present. Read `docs/SPEC.md` first.
- Do not dispatch subagents. Review arrives from the controller after your report.
- Write your full report to the report path given in your dispatch. Return only: status,
  commits, one-line test summary, concerns.
- If the server needs to run for your checks, start it in the background, run the checks,
  then stop it. Never leave a process listening.
- `npm run typecheck` and (from Task 1 on) `npm test` must pass before you report DONE.

---

## Task 0: Scaffold

Create the workspace skeleton so every later task has somewhere to land.

**Build:**
- Root `package.json`: private, `"workspaces": ["shared","server","web"]`, scripts:
  - `dev`: runs server (tsx watch) and web (vite) concurrently
  - `dev:server`, `dev:web`
  - `build`: `npm run build -w shared && npm run build -w server && npm run build -w web`
  - `start`: `node server/dist/index.js` (serves `web/dist` on the same port)
  - `typecheck`: `tsc -b` across workspaces
  - `test`: node's built-in test runner (`node --test`) over `server/dist` tests, or
    `tsx --test 'server/src/**/*.test.ts'`. Pick one and be consistent forever.
- `tsconfig.base.json` with `strict: true`, `moduleResolution: "bundler"` for web and
  `"node16"`/`"nodenext"` for server as appropriate, `target: ES2022`.
- `.gitignore`: `node_modules/`, `dist/`, `data/*.json`, `.superpowers/`, `.DS_Store`,
  `*.log`.
- `data/.gitkeep`.
- `shared/`: package `@gym/shared`, builds to `dist`, empty-but-valid `src/index.ts`.
- `server/`: package `@gym/server`, Express 4, `src/config.ts` (PORT from env, default
  4600), `src/app.ts` exporting `createApp()`, `src/index.ts` calling
  `app.listen(PORT, '0.0.0.0')`. One route: `GET /_trainer/api/health` →
  `{ok:true, version, port}`.
- `web/`: React 18 + Vite + TS + Tailwind. `vite.config.ts` proxies `/_trainer`,
  `/github`, `/google`, `/glean`, `/slack` to `http://127.0.0.1:4600`. A placeholder
  `App.tsx` that fetches `/_trainer/api/health` and renders the result.
- Server in production mode serves `web/dist` statically with an SPA fallback that does
  **not** swallow `/github`, `/google`, `/glean`, `/slack`, or `/_trainer`.

**Verify (run these, paste output):**
```bash
cd "/Users/barkimchi/BarKimchiMain/02 Projects/Postman Gym"
npm install
npm run typecheck
npm run dev:server &   # or tsx server/src/index.ts
sleep 2
curl -s http://127.0.0.1:4600/_trainer/api/health          # -> {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4600/nope   # -> 404
kill %1
npm run build && node server/dist/index.js &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4600/       # -> 200 (index.html)
kill %1
```

---

## Task 1: Middleware spine

The choke point that makes built-in-UI and real-Postman detection identical.

Read spec §6 and §10 first.

**Build:**
- `shared/src/events.ts`: `RequestEvent` and the `TrainerEvent` union (spec §6, §10).
- `server/src/middleware/rawBody.ts`: the `express.json/urlencoded/text` stack with
  `verify` stashing `req.rawBody: Buffer`. Augment the Express Request type in a
  `.d.ts` or via module augmentation. 2mb limit. Malformed JSON must yield a 400 JSON
  error, not an HTML stack trace.
- `server/src/bus.ts`: `EventEmitter` plus a 200-entry ring buffer with `recent()`.
- `server/src/middleware/requestLog.ts`: wrap `res.write`/`res.end` to capture the
  response body (cap 8KB, note truncation), record timing, derive `platform` from the
  first path segment, emit `RequestEvent` on the bus. Must not corrupt binary or chunked
  responses, and must not break SSE (skip capture for `text/event-stream`).
- `server/src/middleware/faultInjector.ts`: consults the engine for an active intercept
  fault; a no-op stub is fine now (Task 3 wires the engine in) but the mount point and
  the matching call site must exist.
- `server/src/trainer/sse.ts`: `GET /_trainer/events`. Headers `Content-Type:
  text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`. Replays `bus.recent()` on connect, then streams. 15s
  `heartbeat`. Cleans up on client disconnect.
- `server/src/trainer/proxy.ts`: `POST /_trainer/api/proxy` per spec §10, including the
  localhost-only allowlist (reject other hosts with 400 and a clear message). Uses
  `undici.request`. Returns `{status, headers, body, timeMs, sizeBytes}`.
- `server/src/trainer/router.ts` mounting health, proxy, SSE.
- Wire mount order in `app.ts` exactly per spec §6.
- Tests: rawBody preserves exact bytes for a body with unicode and trailing whitespace;
  ring buffer caps at 200; proxy rejects a non-localhost URL.

**Verify (run these, paste output):**
```bash
# terminal A
curl -N http://127.0.0.1:4600/_trainer/events &
# terminal B
curl -s -X POST http://127.0.0.1:4600/_trainer/api/proxy \
  -H 'content-type: application/json' \
  -d '{"method":"GET","url":"http://127.0.0.1:4600/_trainer/api/health","headers":{}}'
# -> terminal A must show a `log` event for the health request
curl -s -X POST http://127.0.0.1:4600/_trainer/api/proxy -H 'content-type: application/json' \
  -d '{"method":"GET","url":"https://api.github.com/user","headers":{}}'   # -> 400, blocked
```

---

## Task 2: GitHub platform

Read spec §5, §7.

**First, a small cross-cutting addition (do this before the GitHub work):**
Add `scripts/check-style.mjs` and wire it as root `npm run lint:style`, also called from
`npm test`. It fails with a non-zero exit and a file:line list if it finds:
- an em-dash (U+2014) or en-dash (U+2013) in any tracked `.ts`, `.tsx`, `.md`, `.json`, or
  `.mjs` file, EXCLUDING `docs/reference/**` (archived documents from another session,
  preserved verbatim on purpose) and `package-lock.json`.
- the literal string for the port reserved in `docs/SPEC.md` section 2, anywhere outside
  that file (that port belongs to a different long-running process on this machine and
  must never be reintroduced).

No em-dashes is the project owner's hard style rule and it has already been violated once
across the spec, the plan, and the ledger. A grep in CI is cheaper than remembering. Keep
the script dependency-free and under 60 lines.

**Then the GitHub work:**
- **`shared/src/scenario.ts`: author the COMPLETE type file, exactly as spec §8 defines
  it.** All of it: `RunContext` (including `vars`), `Assertion` (including the `custom`
  escape hatch), `RequestMatcher`, `Step`, `Fault`, `BuiltScenario`, `ScenarioDef`. These
  are pure type declarations, fully specified in the spec, and cheap to write. Task 3
  implements against them and may extend but must not reshape them. Do NOT resurrect the
  superseded drafts in `docs/reference/superseded-drafts/`; they contradict spec §8 and
  were removed for that reason. Write from the spec.
- `server/src/platforms/world.ts`: the `World` type holding all mutable per-run state for
  all four platforms, plus `resetState(ctx: RunContext)` and `activeWorld()`. Task 3
  generates the `RunContext`; for now build one by hand in a test fixture so this task can
  run standalone. Rate-limit counters, token registries, and channel membership all live
  here.
- `server/src/platforms/github/fixtures.ts`: byte-exact error bodies with `// source:`
  comments. At minimum:
  - 401 `{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}`
  - 403 rate limit `{"message":"API rate limit exceeded for user ID <id>.","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting","status":"403"}`
  - 403 scope `{"message":"Resource not accessible by personal access token","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"403"}`
  - 404 `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}`
  - 405 `{"message":"Method Not Allowed","documentation_url":"https://docs.github.com/rest"}`
  Verify each against GitHub's public REST docs where you can reach them; where you
  cannot, mark `// UNVERIFIED SHAPE`.
- `server/src/platforms/github/router.ts`:
  - Accepts `Authorization: token X` **and** `Authorization: Bearer X`.
  - `GET /user`, `GET /user/repos` (with `per_page`, `page`, `Link` header pagination,
    default `per_page=30`), `GET /repos/:owner/:repo`, `GET /orgs/:org/repos`,
    `GET /rate_limit`.
  - Response headers on every authenticated call: `x-ratelimit-limit`,
    `x-ratelimit-remaining`, `x-ratelimit-reset` (unix seconds), `x-ratelimit-used`,
    `x-ratelimit-resource`, `x-oauth-scopes`, `x-accepted-oauth-scopes`,
    `x-github-request-id`.
  - **Private repos return 404, not 403**, to an unauthorized token. This is GitHub's real
    behavior and scenario 6 depends on it.
  - Wrong method on a GET-only path → 405 with an `Allow` header.
  - Missing required scope → 403 with the scope fixture and accurate
    `x-accepted-oauth-scopes`.
  - Rate limit exhausted → 403 rate-limit fixture with `x-ratelimit-remaining: 0`.
- Tests covering the matrix above.

**Verify (run these, paste output):**
```bash
curl -si http://127.0.0.1:4600/github/user -H 'Authorization: Bearer BAD' | head -20
curl -si http://127.0.0.1:4600/github/user -H "Authorization: token $VALID" | head -20
curl -si http://127.0.0.1:4600/github/user -H "Authorization: Bearer $VALID" | head -5
curl -si -X POST http://127.0.0.1:4600/github/user -H "Authorization: token $VALID" | head -5   # 405 + Allow
curl -si "http://127.0.0.1:4600/github/user/repos?per_page=2&page=2" -H "Authorization: token $VALID" | head -20
curl -si http://127.0.0.1:4600/github/rate_limit -H "Authorization: token $VALID"
```
**Manual gate (human, after this task):** real Postman desktop, new environment with
`baseUrl = http://localhost:4600/github`, `GET {{baseUrl}}/user` with Bearer auth returns 200.

---

## Task 3: Engine + scenarios 1-7

The heart. Read spec §7, §8, §9, §12.

**Build:**
- `shared/src/scenario.ts` exactly as spec §8.
- **Boot the World with a default run context.** Verified defect as of commit `351ecb3`:
  with no scenario activated, `GET /github/user` returns
  `500 {"error":"Internal Server Error","message":"activeWorld() called before
  resetState(): no scenario is active yet"}`. That is wrong for three reasons. A learner
  who opens the app and pokes around before picking an exercise sees a broken tool. The
  implementation track and free exploration both need working platforms with no scenario
  active. And a 500 teaches nothing; it reads as a defect, which it is. At boot, mint a
  seed and call `resetState(generate(seed))` so all four platforms always serve a healthy
  world. Activating a scenario then replaces it with a fresh one, as it already does.
- `server/src/engine/generate.ts`: a seeded PRNG (mulberry32 or xorshift over a hashed
  seed string, implemented inline, no dependency) and `generate(seed): RunContext`
  producing every field in spec §8 from name pools. Company names must vary (never always
  "Acme"). Tokens look real: GitHub `ghp_` + 36 base62; Slack `xoxb-` + digit groups;
  Google client id `<digits>-<32 lowercase alnum>.apps.googleusercontent.com`.
- `server/src/engine/match.ts`, `assert.ts` (including the minimal dotted/bracket
  `jsonPath`, no external dependency), `persist.ts` (atomic write-temp-then-rename,
  250ms debounce).
- `server/src/engine/engine.ts`: the lifecycle in spec §9, `observe()`, hint unlocking at
  3/6/9 attempts, `explain()`, drill mode, and human-readable attempt reasons.
- Wire `faultInjector` to the engine's active intercept faults.
- `server/src/scenarios/index.ts` registry + `t1-warmups.ts` (3) + `t2-github.ts` (4).
  All seven built as templates over `RunContext`.
- Trainer endpoints from spec §10 for scenarios/activate/drill/reset/state/hint/solution/explain.
- Tests: activating twice yields different `RunContext` values; an assertion built from
  run 1 fails against run 2; `resetState` makes a solved scenario re-runnable.

**Verify (run these, paste output):**
```bash
curl -s -X POST http://127.0.0.1:4600/_trainer/api/scenarios/t2-revoked-pat/activate | jq .
# take the revoked PAT from the ticket, call /github/user with it -> scenario:attempt on SSE
# call with the valid PAT -> scenario:step then scenario:explaining
curl -s -X POST http://127.0.0.1:4600/_trainer/api/explain -H 'content-type: application/json' \
  -d '{"rootCause":"...","customerReply":"..."}'   # -> solutionMd, scenario:solved
# ACTIVATE THE SAME SCENARIO TWICE and diff the two run contexts: every credential,
# name, and ticket detail must differ, and run 1's valid PAT must NOT solve run 2.
```
**Manual gate (human, after this task):** solve one scenario end to end from real Postman
desktop while watching the SSE stream flip to solved.

---

## Task 4: Frontend core

Read spec §13.

**Build:**
- CSS grid layout: `ExerciseBar` (48px) / left Postman column (~62%) / draggable divider /
  right `ReferencePanel` (~38%).
- `state/store.ts` (zustand): workspace, current request, response, scenario state, logs,
  ui (tab selection, demo mode, divider position).
- `api/sse.ts`: exactly ONE `EventSource` for the app, reconnecting with backoff.
- `ExerciseBar`: scenario picker with solved checkmarks, step chips that light up, attempt
  counter, Hint, Reset, Drill, Demo-mode toggle (`Cmd+\`).
- Request builder (method, URL, send) → `POST /_trainer/api/proxy` → response panel with
  status pill, time, size, Pretty/Raw/Headers (CodeMirror for bodies).
- `ReferencePanel` tabs: Ticket (markdown), Logs (live from SSE, newest last, expandable
  request/response), plus placeholder Docs and Notes tabs.
- **Demo mode**: collapses the entire left column; ExerciseBar + reference panel go full
  width. Persisted in `workspace.json`.
- Visual design: this is a portfolio artifact. Dark editor aesthetic, real typography, not
  default-Tailwind gray boxes. It should look like a tool someone built on purpose.

**Verify:** solve a scenario entirely in the browser. Then flip to Demo mode and solve one
from real Postman desktop while the reference panel tracks it. Screenshot both.

---

## Task 5: Postman-clone completeness

**Build:** collections sidebar (create/rename/delete folders and requests, save current
request), environments (create/select/edit, `{{var}}` resolution and highlighting in the
URL and body), Auth tab (No Auth, Bearer, Basic, API Key, OAuth 2.0 helper), Body tab
(none, raw JSON, form-urlencoded), Params tab, Headers tab, `</> Code` export modal
(cURL, Python `requests`, Node axios), persistence to `data/workspace.json` via

`GET/PUT /_trainer/api/workspace`, the Docs tab wired to `/_trainer/api/docs`, and a Notes
tab (CodeMirror, persisted).

**Note for the implementer:** Task 9 adds two more request-builder tabs (Pre-request,
Tests) and two more response-panel tabs (Test Results, Console), plus a `scripts` field on
the persisted request object. Build the tab strips and the request/workspace types so that
adding those is an extension, not a rewrite. Do not build the script engine yourself.

**Verify:** build a collection with an environment, restart the server, confirm everything
persists. Export a request as cURL and run the output verbatim in a shell; it must produce
the same response.

---

## Task 9: Script engine

**Runs immediately after Task 5, before Task 6.** The number is 9 only because the brief
extractor keys off `## Task <N>` and renumbering would invalidate the existing briefs.

Read spec §14 in full. This is learning-path Stage 9, which Bar asked for in v1 after the
initial plan deferred it.

**Build:**
- `web/src/scripts/worker.ts`: the sandboxed Web Worker (created from a Blob URL), the
  `pm` shim per spec §14, `console.log` capture, and the `CryptoJS` global backed by the
  real `crypto-js` package. No DOM, no `fetch`, no network reachable from inside.
- `web/src/scripts/run.ts`: main-thread driver: spawn a fresh worker per execution, post
  `{script, context}`, enforce the **2000ms** timeout via `worker.terminate()`, return
  `{testResults, envPatch, consoleLines, error}`. A timed-out or throwing script surfaces
  as a failed run with the error text, never a hung UI.
- Wire into the send pipeline: **pre-request script → apply `envPatch` → resolve
  `{{vars}}` → proxy call → response → tests script**. The ordering matters: a
  pre-request script that computes a signature or sets a token must affect the request
  that actually goes over the wire.
- Persist `scripts: {preRequest, test}` per request in `workspace.json`.
- UI: **Pre-request** and **Tests** request-builder tabs (CodeMirror, JavaScript mode);
  **Test Results** and **Console** tabs in the response panel, with count badges on the
  tab labels the way Postman does it.
- Docs: a `content/docs/scripting.md` page covering the `pm` surface, the Slack signing
  snippet, and an explicit note that `pm.sendRequest` is not implemented in v1.

**Do not** let any scenario assertion depend on test results. Assertions stay server-side
(spec §14, dual-client rule). Scripts influence the server only through the environment
they mutate, and that is intentional.

**Verify (run these, paste output):**
- A `pm.test("status is 200", () => pm.response.to.have.status(200))` on a live request
  shows one green row.
- A deliberately failing test shows a red row with the assertion message, and does not
  break the response panel.
- A pre-request script doing `pm.environment.set("sig", CryptoJS.HmacSHA256("v0:1:{}", "secret").toString())`
  puts a value into the environment that the outgoing request then carries. Prove it by
  checking the Logs tab shows the resolved header, not the literal `{{sig}}`.
- `while(true){}` in a script terminates at ~2s with an error row and leaves the UI
  responsive.
- A script attempting `fetch(...)` fails with a clear error rather than reaching the network.

---

## Task 6: Google OAuth + scenarios 8-11

Read spec §11 and §12 tier 3. This is the riskiest module; take it slowly.

**Build:** `platforms/google/{oauth.ts,consent.ts,router.ts,fixtures.ts}` per spec §11,
the four tier-3 scenarios, and the OAuth 2.0 helper modal in the UI (popup →
`/_trainer/oauth/callback` → `postMessage` → token exchange **through the proxy** so it
shows up in Logs).

**Verify:**
```bash
# drive the whole code flow by hand with curl: auth -> consent POST -> code -> token
# -> userinfo; then refresh_token; then revoke and confirm invalid_grant
```
Then complete the flow in the built-in UI.
**Manual gate (human, before Task 7):** complete the full OAuth flow in real Postman
desktop with "Authorize using browser" UNCHECKED and the callback set to
`https://oauth.pstmn.io/v1/callback`.

---

## Task 7: Glean + Slack + scenarios 12-15

Read spec §5, §12 tiers 4-5.

**Build:** `platforms/glean/*` (client vs indexing token distinction, search validation
errors, indexing endpoints) and `platforms/slack/*` (the `{"ok":false,"error":"..."}`
envelope inside HTTP 200, cursor pagination on `conversations.history`,
`conversations.join`, and `sign.ts` implementing Slack's `v0=` HMAC-SHA256 over
`v0:{timestamp}:{rawBody}` with the 5-minute replay window). Scenarios 12-15.

Scenario `t5-hmac-signature` is a genuine **pre-request script** rep: Task 9 shipped the
script engine, so the trainee computes the signature in a Pre-request script with
`CryptoJS.HmacSHA256`, exactly as they would in real Postman. The docs page must ALSO
give the `openssl dgst` one-liner as the out-of-band alternative, since that is how you
verify the endpoint by hand and how the rep works from a bare terminal.

Fetch Glean's and Slack's public API docs to get the error shapes right. Where a body
cannot be verified, mark it `// UNVERIFIED SHAPE`.

**Verify:**
```bash
# hand-compute a Slack signature and prove the endpoint accepts it:
ts=$(date +%s); body='{"type":"url_verification","challenge":"abc"}'
sig="v0=$(printf "v0:$ts:$body" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -r | cut -d' ' -f1)"
curl -si -X POST http://127.0.0.1:4600/slack/webhook/events \
  -H "X-Slack-Request-Timestamp: $ts" -H "X-Slack-Signature: $sig" \
  -H 'content-type: application/json' -d "$body"
# and prove the cursor pagination loop terminates rather than looping forever
```

---

## Task 8: Capstone, implementation track, drill, polish

**Build:** the 5-step capstone with `clearFaults` staging, the four implementation-track
scenarios, Drill mode UI (random scenario, hidden title and fault identity, ticket only),
the Explain-back UI (root cause + customer reply, then side-by-side solution reveal),
hints and solution reveal UI, the full `content/docs/*.md` set (one per platform plus auth
topics, written well enough that the implementation track is solvable from them alone),
and `README.md` with the demo script and a real-Postman setup guide.

**Verify:** capstone dry run once fully in the UI and once mixing real Postman; one blind
Drill run solved from ticket and logs alone; one implementation-track go-live completed
from the docs alone; `npm run build && npm start` serves everything on one port.
