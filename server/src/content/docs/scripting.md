## Scripting (Pre-request and Tests)

Every request has two script slots, both plain JavaScript: **Pre-request** runs before
the request goes out, **Tests** runs after the response comes back. Real Postman runs
these scripts in the client, never on the server, so this app does the same: each one
runs inside its own sandboxed Web Worker, with no DOM, no `window`, and no network access
at all.

### The `pm` object

    pm.test(name, fn)                    // registers a test; a throw inside fn = fail
    pm.expect(value)                     // .to.eql(x) / .to.equal(x) / .to.include(x)
                                          // .to.be.ok / .to.have.status(n) / .to.have.property(k, v?)
    pm.response.code                     // status code (Tests only)
    pm.response.status                   // status text
    pm.response.responseTime             // milliseconds
    pm.response.json()                   // parses the body as JSON
    pm.response.text()                   // the raw body text
    pm.response.headers.get(name)        // case-insensitive
    pm.response.to.have.status(n)
    pm.request.method
    pm.request.url
    pm.request.headers
    pm.request.body
    pm.environment.get(key) / .set(key, value) / .unset(key)
    pm.variables.get(key) / .set(key, value)
    pm.collectionVariables.get(key) / .set(key, value)
    console.log(...) / console.info(...) / console.warn(...) / console.error(...)

`pm.response` is only populated in the Tests script; in Pre-request it is `null`, since
no response exists yet.

`pm.variables` reads and writes the exact same store as `pm.environment` in this app:
there is no separate global/local variable scope the way real Postman has one, so a value
set with either name shows up under both. `pm.collectionVariables` is a genuinely
separate store, but it only lives for the one script run currently executing; nothing
here persists it into the saved workspace.

### `pm.sendRequest` is not implemented

Real Postman's `pm.sendRequest(...)` fires an additional HTTP request from inside a
script. **This app does not implement it, not in v1 and not at all right now.** Calling
it throws a plain "not a function" error rather than silently doing nothing or hanging.
If a script needs the result of a second request, there is no scripted way to get one
here; make it as its own separate request in the collection instead.

### The sandbox

Each script runs in its own, freshly created Web Worker: nothing carries over from one
run to the next, even for the exact same request run twice in a row. Inside that worker,
`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, and
`navigator.sendBeacon` are all overridden to throw immediately. A script that tries to
reach the network fails loudly and instantly, naming exactly what it tried to call, never
a silent no-op and never a real request actually leaving the browser.

Every script also has a hard 2000ms timeout. An infinite loop, or anything else that runs
too long, is terminated and reported as a failed run ("Script timed out after 2000ms"),
never a hung UI.

### What a Pre-request script can actually change

A Pre-request script's `pm.environment.set(...)`/`.unset(...)` calls are applied to the
active environment BEFORE the request is resolved and sent. A script that computes a
signature, or refreshes a token, and stores the result with `pm.environment.set(...)`
genuinely changes what goes out on the wire: reference the same key as a `{{var}}`
anywhere in the request (a header value is the common case), and the freshly computed
value is what gets sent, never a stale one left over from the last run.

If no environment is currently active, the same values still apply, just as a one-request
overlay instead of a saved environment change.

### `CryptoJS`

`CryptoJS` is available as a global inside the script sandbox, backed by the real
`crypto-js` package, not a hand-rolled substitute. At minimum, `CryptoJS.HmacSHA256(...)`,
`CryptoJS.SHA256(...)`, and `.toString(CryptoJS.enc.Hex)` work exactly as the library
itself documents them.

### Worked example: the Slack signature, in a Pre-request script

The Slack doc's `openssl` one-liner and this script compute the identical value; this is
the version worth practicing, since it is what an integration actually ships with. Put
this in the request's **Pre-request** tab, with an environment variable `signingSecret`
already set to the run's signing secret:

    var ts = Math.floor(Date.now() / 1000).toString();
    var body = pm.request.body || '';
    var base = 'v0:' + ts + ':' + body;
    var sig = 'v0=' + CryptoJS.HmacSHA256(base, pm.environment.get('signingSecret')).toString(CryptoJS.enc.Hex);
    pm.environment.set('ts', ts);
    pm.environment.set('sig', sig);

Then reference `{{ts}}` and `{{sig}}` in the request's `X-Slack-Request-Timestamp` and
`X-Slack-Signature` headers. `pm.request.body` is the raw, unresolved body text exactly
as configured on the request, not a parsed object; that is exactly what the signature
needs to be computed over, since it signs the literal bytes that go out, not a
re-serialized version of them. Set the request body first and leave it alone: the
signature this script computes is only correct for the exact body that is actually sent.

### Test Results and Console

The response panel's **Test Results** tab shows each `pm.test(...)` call as a pass or
fail row, with the failure message when one fails, and a `passed/total` count badge on
the tab itself. The **Console** tab shows everything logged with
`console.log`/`.info`/`.warn`/`.error` during either script's run, in the order it ran.

A script-level failure (a syntax error, an uncaught exception outside any `pm.test`, or
the 2000ms timeout) shows up as its own row rather than hiding the response: the request
still succeeded or failed on its own terms, and the script failure is reported alongside
it, never instead of it.

### One thing scripts do not affect

Whether a scenario in this gym counts a step as solved is always decided by the server,
reading the actual HTTP request and response. Nothing about `pm.test` pass/fail counts
toward that; a script exists to help you build and verify a request the way real Postman
does, not to grade you. Real Postman's own test results are invisible to any server for
the same reason, so this keeps the built-in client and real Postman desktop scored
identically.
