# Postman Gym

A local training gym for enterprise API troubleshooting. One process, one port, four
faithful mock platforms (GitHub REST, Google OAuth 2.0, Glean, Slack), and a built-in
Postman-like client. Every exercise can be solved from the built-in UI **or** from real
Postman desktop, and both register identically, because detection is entirely
server-side.

Working name only. "Postman" is a trademark; rename before any public showcase.

## Run it

```
npm install
npm run build && npm start
```

Open `http://localhost:4600` (or `http://127.0.0.1:4600` if `localhost` gives you any
trouble resolving). `npm start` serves the built web client and the API from that one
port; this is also the only mode the OAuth 2.0 helper's automatic popup capture works in
(see "OAuth in real Postman" below).

For active development, `npm run dev` runs the server and the Vite dev server together
(server on 4600, web client on 5173, Vite proxying `/_trainer`, `/github`, `/google`,
`/glean`, `/slack` back to 4600). The OAuth 2.0 helper's automatic capture does not work
under `npm run dev`; use `npm start` whenever a scenario needs it.

`PORT` overrides the default port if 4600 is ever occupied.

## The gym, at a glance

Pick a scenario from the top bar. Each one hands you a ticket (a support ticket for the
troubleshoot track, a go-live checklist for the implementation track) describing a
situation, never the fix. The reference panel on the right has four tabs:

- **Ticket**: the situation, and whatever credentials/values are on file.
- **Docs**: reference documentation for whichever platform(s) this scenario touches,
  written to be enough on its own. The implementation-track scenarios (`impl-github`,
  `impl-oauth`, `impl-glean`, `impl-slack`) are specifically designed to be solvable from
  this tab alone, with nothing broken to diagnose.
- **Logs**: every request that hits the mock, whichever client sent it, built-in or real
  Postman.
- **Notes**: a scratch pad for your own notes.

Send requests from the built-in Postman clone on the left (collections, environments,
`{{variables}}`, Auth tab, Body tab, Pre-request/Tests scripts, a response panel with
Pretty/Raw/Headers/Test Results/Console, and a `</> Code` export for cURL/Python/Node), or
point real Postman desktop at the same URLs directly. The engine only cares what actually
hit the server; it has no idea which client sent it.

When a step's request matches but doesn't pass, you get a real reason, not silence
("right endpoint, still 401", "200 but the body has 0 repos, expected at least 1").
Three wrong attempts unlocks the first hint; 6 and 9 unlock the next two. Once every step
passes, you're prompted for a short root cause and a customer-facing reply before the
solution reveals, the same "explain it back" discipline a real support handoff needs.

**Drill mode** picks a random troubleshoot-track scenario and hides its title, so you
solve it from the ticket and the logs alone, the way a cold escalation actually arrives.

**Demo mode** (`Cmd+\`) collapses the built-in Postman clone entirely, leaving the top
bar and the reference panel full width: the companion view for a rep done in real Postman
desktop, and for screen-recording the capstone.

## The capstone: a recordable demo

`t6-capstone` ("Full go-live: Google OAuth into Glean", tier 6) is the flagship: a live
OAuth consent, a token that genuinely works, a moment where it stops working with nothing
else about the request changed, a real re-auth, and a Glean status check that ends on a
visible payload instead of an empty body. It is designed to be screen-recorded end to end
in one continuous take. A run looks like this:

1. **Consent and exchange.** Open the OAuth 2.0 helper (Auth tab), fill in the values
   from the ticket, click "Get New Access Token," approve the consent screen. You now
   have a real access token and refresh token.
2. **Prove it.** Call `GET /oauth2/v3/userinfo` with the access token. It returns your
   identity.
3. **Refresh it, and watch it work.** Call `POST /oauth2/token` with
   `grant_type=refresh_token` and the refresh token from step 1. A clean 200, a new
   access token. The credential is genuinely healthy, not a trick.
4. **Send the identical request again.** Same refresh token, same everything.
   `invalid_grant`. Nothing on your end changed between the two calls; something changed
   on the server's. This is the moment the ticket's "has looked done before and turned
   out not to be" line is pointing at, and it's visible as two adjacent rows in the Logs
   tab: 200, then 400, same request.
5. **Reconnect.** Run consent again for a brand new authorization code, exchange it. A
   genuinely fresh pair, and it keeps working.
6. **Finish the job.** Index the document named in the ticket into Glean with the
   indexing token, then confirm it with `GET /api/index/v1/getdocumentstatus`. The
   response is real and checkable: an id, a datasource, `"status": "INDEXED"`, a title, a
   timestamp. Not an empty `{}`, an actual answer to "is this really done."

Every value (client id/secret, the Glean instance and tokens, the document's title and
text) is freshly generated per run; running it twice never plays the same. Nothing in the
ticket ever says a token will be revoked, or names `invalid_grant`, or tells you to
refresh twice, that has to be discovered the same way steps 3 and 4 are discovered.

## OAuth in real Postman

Two callback URLs are registered:

- `https://oauth.pstmn.io/v1/callback`, for real Postman desktop. Postman's app
  intercepts this navigation itself and never actually fetches it. **"Authorize using
  browser" must be UNCHECKED** in Postman's OAuth 2.0 helper for the intercept to work;
  leaving it checked sends the browser to a URL nothing here serves.
- `http://localhost:4600/_trainer/oauth/callback`, for the built-in UI's own popup.

Anything else fails with a 400 page reading `Error 400: redirect_uri_mismatch`, an exact
string match, not "close enough" (a trailing slash or `127.0.0.1` instead of `localhost`
both count as a different URI).

The built-in UI's popup auto-fills the code once consent completes, no copy-paste,
**but only under `npm start`**: the callback page and the app both have to be served from
the exact same origin for the browser to deliver the `postMessage` that carries the code
back. `npm run dev`'s split origins (5173 for the UI, 4600 for the API) cannot receive it
regardless of anything this app does; the OAuth 2.0 helper falls back to a manual
paste-the-code field there instead, which still works.

## Setting up a real Postman environment

Create one environment with these variables (adjust the port if you changed `PORT`):

| Variable | Value |
|---|---|
| `githubBaseUrl` | `http://127.0.0.1:4600/github` |
| `googleBaseUrl` | `http://127.0.0.1:4600/google` |
| `gleanBaseUrl` | `http://127.0.0.1:4600/glean` |
| `slackBaseUrl` | `http://127.0.0.1:4600/slack` |

Every path under a platform base is byte-identical to the real product's (`GET
{{githubBaseUrl}}/user`, `POST {{gleanBaseUrl}}/rest/api/v1/search`, and so on), so a
collection built here transfers to the real APIs by swapping these four values for the
real ones. Read the Docs tab for the platform(s) a scenario touches before building
requests; the implementation track is written to be solvable from exactly that.

No real credentials are ever involved. Every token, secret, and id is a generated fake,
and nothing here makes a network call to a real GitHub, Google, Glean, or Slack.

## Development

```
npm install
npm run dev          # server (4600) + web (5173), live reload
npm run typecheck
npm run lint:style    # style guard: no em-dashes, no reintroducing a banned dev port
npm test              # lint:style, then server+shared, then web
```

`data/progress.json` and `data/workspace.json` hold your solved history, attempt counts,
explain-back writeups, and saved collections/environments; both are gitignored. One
control in the app can destroy part of that on purpose: **Reset all progress**, a small,
muted button that lives permanently in the sidebar footer, away from the per-scenario
`Reset` in the top bar (which just re-seeds the current scenario and is used constantly).
It calls `DELETE /_trainer/api/progress`, which permanently wipes every scenario's solve
history, run/attempt counts, and explain-back writeups (each root cause and customer
reply you have submitted), for every tier. It does not touch collections, environments,
notes, or the request builder, and there is no undo. The server refuses the request
without an explicit `{"confirm": "RESET PROGRESS"}` body, and the button only sends that
body once you have typed the exact phrase into a confirmation modal, not on a click;
nothing else in this app calls this endpoint.
