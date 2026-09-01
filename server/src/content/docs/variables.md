## Environments and variables

An environment is a named set of key/value pairs. `{{name}}` anywhere in a request's URL, headers, or body is replaced with that key's current value from whichever environment is active, right before the request is sent.

### Why use variables instead of pasting values directly

A ticket hands you real values every run: a base URL, a token, an org name. Pasting them straight into the URL bar works for one request, but breaks the moment you reuse that request against a different run, a different token, or a teammate's own credentials. An environment variable holds the value in exactly one place; every request that references `{{token}}` picks up whatever that environment currently has, without editing each request by hand.

### Setting one up

Open the environment editor from the gear icon next to the environment dropdown in the sidebar. Create an environment, then add rows like:

    baseUrl  = http://127.0.0.1:4600/github
    token    = your-token-here

Pick that environment from the dropdown to make it active. Only the active environment's enabled rows are available for resolution; a disabled row behaves exactly like an undefined variable.

### Referencing a variable

Use double curly braces around the key name: `{{baseUrl}}/user`, or `Authorization: Bearer {{token}}`. This works in the URL bar, in header values, in the Auth tab's fields, and in the request body. A reference resolves the same way everywhere it appears.

### What happens with an undefined variable

If a request references a variable the active environment does not define, or does not have enabled, sending is refused outright with a message naming exactly which variable is missing. The request is never sent with the literal `{{name}}` text standing in for a real value: a silently-sent literal token is indistinguishable from a genuine 401, and would teach the wrong lesson.

### Highlighting

Every place a `{{var}}` can appear (the URL bar, header values, param values, Auth tab fields, and the JSON body editor) highlights it in place: one color when the active environment defines it, another when it does not. This is the fastest way to tell, before ever sending, whether a request is actually ready to fire.

### The `</> Code` export

Code generated from the `</> Code` button always uses the fully resolved values, the same ones Send would actually put on the wire, never the `{{name}}` template text. If a variable is undefined, the export shows a warning instead of code until it is fixed.
