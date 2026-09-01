## Slack API (mock)

This mock lives under `/slack` and mirrors Slack's real Web API closely enough to practice
the two gotchas that catch almost every real Slack integration at some point: the envelope
trap, and request signature verification.

### The envelope trap

Slack's Web API methods answer nearly every outcome, success or failure, with `HTTP 200`.
The real result lives in the JSON body's `ok` field, not the status code:

    { "ok": false, "error": "not_in_channel" }

Checking only the HTTP status code will make a failing integration look healthy. Always
check `ok` first.

### Authentication

Send the bot token as `Authorization: Bearer YOUR_BOT_TOKEN` on every call. A missing
token returns `{"ok": false, "error": "not_authed"}`; a wrong one returns
`{"ok": false, "error": "invalid_auth"}`. Both are `HTTP 200`.

### Endpoints

- `POST /api/auth.test`: confirms identity. Returns `team`, `team_id`, `user_id`, `bot_id`.
- `POST /api/chat.postMessage`: body `{ "channel": "...", "text": "..." }`. Fails with
  `channel_not_found` if the channel id does not exist, `not_in_channel` if the bot has
  never joined it.
- `POST /api/conversations.join`: body `{ "channel": "..." }`. Adds the bot to the channel.
  Already a member? Succeeds anyway, with a `warning: "already_in_channel"`.
- `GET /api/conversations.list`: every channel the bot knows about, with `is_member`.
- `GET /api/conversations.history?channel=...`: paginated message history. Also
  `not_in_channel` if the bot has never joined.

### Paginating conversations.history

This mock deliberately returns only a few messages per call, regardless of the `limit`
requested, so real pagination is unavoidable. Follow `response_metadata.next_cursor` from
each response as the next `cursor` query parameter until `has_more` is `false`:

    GET /api/conversations.history?channel=C123
    -> { "messages": [...], "has_more": true, "response_metadata": { "next_cursor": "abc" } }
    GET /api/conversations.history?channel=C123&cursor=abc
    -> { "messages": [...], "has_more": false, "response_metadata": { "next_cursor": "" } }

### Verifying webhook signatures

`POST /webhook/events` checks the request the same way a real Slack webhook consumer
would verify an inbound delivery from Slack. Two headers are required:

- `X-Slack-Request-Timestamp`: unix seconds.
- `X-Slack-Signature`: `v0=` followed by a hex HMAC-SHA256 digest.

The signed base string is `v0:{timestamp}:{raw request body}`, colon-joined, hashed with
the signing secret. The exact raw bytes of the body matter: reformatting or re-serializing
the JSON before signing (a pretty-printer, a different key order) produces a different
signature even with the right secret.

Requests with a timestamp more than 5 minutes old (or in the future) are rejected outright,
signature aside, as a replay guard.

There are two equally valid ways to produce this signature. Use whichever fits what you
are doing.

**In a Pre-request script**, the way a real Postman user would write it (see the
Scripting doc for the full `pm` surface). This is the version worth practicing, since it
is what actually ships in a real collection:

    var ts = Math.floor(Date.now() / 1000).toString();
    var body = pm.request.body || '';
    var base = 'v0:' + ts + ':' + body;
    var sig = 'v0=' + CryptoJS.HmacSHA256(base, pm.environment.get('signingSecret')).toString(CryptoJS.enc.Hex);
    pm.environment.set('ts', ts);
    pm.environment.set('sig', sig);

Reference `{{ts}}` and `{{sig}}` in the request's `X-Slack-Request-Timestamp` and
`X-Slack-Signature` headers, with `signingSecret` already set in the active environment.
Set the request body first and leave it alone: the signature is only correct for the
exact bytes that go out, and the pre-request script runs before the request is sent.

**By hand, from a bare shell**, useful for checking the endpoint itself with no UI at
all, or for confirming a script's output independently:

    ts=$(date +%s)
    body='{"type":"url_verification","challenge":"abc"}'
    sig="v0=$(printf "v0:$ts:$body" | openssl dgst -sha256 -hmac "YOUR_SIGNING_SECRET" -r | cut -d' ' -f1)"
    curl -si -X POST http://127.0.0.1:PORT/slack/webhook/events \
      -H "X-Slack-Request-Timestamp: $ts" -H "X-Slack-Signature: $sig" \
      -H 'content-type: application/json' -d "$body"

Both compute the identical `v0:{timestamp}:{body}` HMAC-SHA256; only the tool differs.

Sending Slack's standard `url_verification` handshake payload (`type` and `challenge`)
gets the same `challenge` value echoed back in the response once the signature verifies.
