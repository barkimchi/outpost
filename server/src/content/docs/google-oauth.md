## Google OAuth 2.0 (mock)

This mock lives under `/google` and mirrors Google's real OAuth 2.0 authorization-code
flow plus two Calendar endpoints, closely enough to practice the mechanics: consent,
code exchange, refresh, revoke, and scope-gated resources.

### Registered redirect URIs

Exactly two callback URLs are registered for this mock app. Anything else fails.

- `https://oauth.pstmn.io/v1/callback`: for real Postman desktop. Postman's app intercepts this navigation itself, it is never actually fetched. "Authorize using browser" must be UNCHECKED in Postman's OAuth 2.0 helper for the intercept to work.
- `http://localhost:PORT/_trainer/oauth/callback`: for the built-in UI's OAuth helper, where PORT is this server's actual port (4600 by default).

Google validates `redirect_uri` as an exact string match, not "close enough." A trailing slash, `http` instead of `https`, `127.0.0.1` instead of `localhost`, or a missing path segment all count as a completely different URI and fail the same way an unrelated URL would. Sending anything not on this list returns `400` with an HTML page titled "Error 400: redirect_uri_mismatch".

### The consent flow

`GET /o/oauth2/v2/auth` renders a consent page listing the requested scopes. It is stateless: every query parameter you send is carried forward as a hidden form field, so nothing about the request needs to be remembered server-side between the GET and the following POST. Approving the form redirects to your `redirect_uri` with a `code` query parameter; declining redirects with `error=access_denied`.

Required query parameters: `response_type=code`, `client_id`, `redirect_uri`, `scope` (space-separated), and an optional `state` that comes back unchanged on the redirect.

Authorization codes are single-use and expire 60 seconds after being issued.

### Exchanging the code for a token

`POST /oauth2/token` with `Content-Type: application/x-www-form-urlencoded`:

    grant_type=authorization_code
    code=THE_CODE_FROM_CONSENT
    redirect_uri=SAME_REDIRECT_URI_USED_ABOVE
    client_id=YOUR_CLIENT_ID
    client_secret=YOUR_CLIENT_SECRET

The `redirect_uri` here must be byte-identical to the one used in the authorize step, or the exchange itself returns `redirect_uri_mismatch`, separately from the consent step's own check. A successful exchange returns:

    { "access_token": "...", "expires_in": 3600, "refresh_token": "...", "scope": "...", "token_type": "Bearer" }

### Refreshing an access token

Once an access token expires, exchange the refresh token from the same original response for a new access token, without repeating consent:

    grant_type=refresh_token
    refresh_token=THE_REFRESH_TOKEN
    client_id=YOUR_CLIENT_ID
    client_secret=YOUR_CLIENT_SECRET

The response does not include a new `refresh_token`; this mock does not rotate refresh tokens on use, so keep reusing the same one. If the refresh token was revoked, this returns `invalid_grant` no matter how many times you retry it; the only fix is a brand new consent.

### Token endpoint errors

    400  { "error": "invalid_grant", "error_description": "Bad Request" }
    401  { "error": "invalid_client", "error_description": "Unauthorized" }
    400  { "error": "redirect_uri_mismatch", "error_description": "Bad Request" }

### Revoking a token

`POST /oauth2/revoke` with `token=THE_ACCESS_OR_REFRESH_TOKEN` invalidates it. Revoking an access token also invalidates its paired refresh token.

### Calling protected endpoints

Send the access token as `Authorization: Bearer YOUR_ACCESS_TOKEN`.

- `GET /oauth2/v3/userinfo`: the authenticated user's profile. Fields returned depend on granted scopes: `email`/`email_verified` need the `email` scope, `name` and related fields need `profile`, `sub` is always present with just `openid`.
- `GET /calendar/v3/users/me/calendarList`: the user's calendar list. Requires `https://www.googleapis.com/auth/calendar.readonly`.
- `GET /calendar/v3/calendars/:calendarId/events`: events on a calendar. Requires the same readonly scope.

An expired or invalid access token returns `401 UNAUTHENTICATED`. A token missing a required scope returns `403` with `error.details[0].reason` set to `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, naming exactly which scope was needed. A token can never gain a scope after the fact; the fix is always a fresh consent with the missing scope added, not a retry.

### Using the built-in OAuth 2.0 helper

On the request builder's Auth tab, pick OAuth 2.0, fill in Auth URL (`{{baseUrl}}/o/oauth2/v2/auth`), Token URL (`{{baseUrl}}/oauth2/token`), Client ID, Client Secret, Scope, and Callback URL (the built-in callback listed above), then click "Get New Access Token". The exchange goes through this app's own request proxy, so it shows up in the Logs tab exactly like any other request.

### Automatic popup capture only works under `npm start`

Approving consent in the popup window normally closes it and fills in the access token
automatically, with no copy-paste. That automatic capture depends on the popup and the
main app running on the exact same origin, since it works by the callback page
`postMessage`-ing the code back to the window that opened it.

Under `npm start` (this app's single-port production mode) that is always true. Under
`npm run dev`, the UI is served from Vite on port 5173 while the API runs on its own
backend port; the popup's callback page is served from the API's origin, not 5173's, so
the browser will not deliver its message back to the dev-mode window no matter what this
app does. This is a real, structural limit of running two different origins in dev, not
a bug waiting on a fix.

If a scenario needs the OAuth helper, run it under `npm start`. Under `npm run dev`, the
helper falls back to a manual "paste the code" field after consent, which still works,
just without the automatic capture.
