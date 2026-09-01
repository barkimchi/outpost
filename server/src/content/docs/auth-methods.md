## Authentication methods (Auth tab)

The request builder's Auth tab configures how the request identifies itself, separately from anything typed by hand into the Headers tab. Every credential field here supports `{{variables}}` the same way the URL bar does.

### No Auth

No authorization is added. Use this for endpoints that need no credential, or when you are building the Authorization header yourself directly on the Headers tab.

### Bearer Token

Adds `Authorization: Bearer YOUR_TOKEN` using whatever is in the Token field. This is what GitHub's `token`/`Bearer` scheme and most modern APIs expect. If you also typed an `Authorization` header by hand on the Headers tab, the Auth tab's value wins: it is the source of truth for the header it owns, not merely a suggestion.

### Basic Auth

Adds `Authorization: Basic BASE64(username:password)`, computed automatically from the Username and Password fields. Nothing needs to be encoded by hand.

### API Key

Adds a single key/value pair, either as a header (most common) or appended to the URL as a query parameter, controlled by the "Add to" setting. The Key field is the header name or query parameter name; the Value field is what goes into it.

### OAuth 2.0

A helper for the full authorization-code flow: fill in the Auth URL, Token URL, Client ID, Client Secret, Scope, and Callback URL, then use "Get New Access Token" to run consent and the code exchange. The resulting Access Token field is what actually gets applied to the request, as `Authorization: Bearer YOUR_ACCESS_TOKEN`, exactly like a manually pasted Bearer token would. See the Google OAuth 2.0 doc for the mechanics of the flow itself.

### Precedence with the Headers tab

The Auth tab and the Headers tab both ultimately produce headers on the outgoing request. When they disagree on the same header name (almost always `Authorization`), the Auth tab wins. To send a completely custom Authorization scheme this app does not model as an Auth type, set Auth to No Auth and add the header by hand on the Headers tab instead.
