import { randomBytes } from 'node:crypto';
import type { Fault, RunContext, ScenarioDef, World } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';
import { OLDEST_SLACK_MESSAGE_MARKER } from '../platforms/world.js';

/**
 * Tier 5: Slack (docs/SPEC.md section 12, scenarios 14-15). Both target the `/slack`
 * router built in `platforms/slack/{router.ts,fixtures.ts,sign.ts}`.
 *
 * `t5-envelope-trap` is a state fault (docs/SPEC.md section 7: "prefer state faults"),
 * forcing one channel's `isMember` to `false` at activation regardless of what
 * `generate.ts`'s own 50/50 draw happened to assign it, so the scenario is guaranteed
 * solvable every run.
 *
 * `t5-hmac-signature` (fix round, finding 8): spec section 12 #15 says this scenario
 * fails "after the signing secret rotates," but through the original build and every fix
 * round since it shipped with `setup: []`, `faults: []`, handing over one signing secret
 * that simply always worked: mechanical (compute the signature correctly, within the
 * replay window) but never actually broken, so it was tier 5's implementation-track
 * exercise wearing a troubleshoot-track label, the ONE tier that should have had a genuine
 * diagnostic rep and did not. Fixed the same way `t6-capstone.ts` makes its refresh-token
 * revocation OBSERVABLE (see that file's header comment, "making the break OBSERVABLE"):
 * `apply()` at activation is a genuine no-op (the disclosed secret must work at least
 * once, for real, before anything breaks), and `revert()`, triggered by step 1's own
 * `clearFaults` the instant that first signed request genuinely succeeds, rotates
 * `World.slack.signingSecret` to a freshly minted value the ticket never shows. Step 2
 * sends the byte-identical request that just worked and watches it fail, then has to
 * recompute against the new secret to close the loop, a real before/after over the same
 * action, discoverable as two adjacent Logs tab rows exactly like the capstone's own
 * step 3/4. The new secret is revealed only in a hint (unlocked at 6 attempts, same
 * convention every hint in this codebase already uses, e.g. `t3-token-expiry`'s "the
 * original token exchange already returned a refresh_token... Save it"): real Slack
 * genuinely has no API that returns a signing secret, so unlike a GitHub token or a Google
 * scope there is no live request that could ever surface it, and hints are this
 * codebase's one sanctioned, attempt-gated channel for handing over something otherwise
 * undiscoverable (see this file's own docs/SPEC.md section 9 citation elsewhere in this
 * project: hints are exempt from hard constraint 7c, "shown only in response to a genuine
 * attempt, not the puzzle's opening statement").
 *
 * Hard constraint 7a for `t5-envelope-trap`: WHICH channel starts un-joined is drawn from
 * `ctx.vars.slackTargetChannelIndex` (`engine/generate.ts`), independent of the channel
 * pool's own per-channel `isMember` draw, so the target channel's identity genuinely
 * varies run to run. Hard constraint 7a for `t5-hmac-signature`: no multi-candidate shape
 * to position (there is exactly one currently-correct secret at any moment, never a
 * "which of these two" guess), but the rotated value itself is freshly minted every run
 * (`randomBytes`, same convention `t3-google.ts`'s `mintAccessToken`/`mintRefreshToken`
 * use for scenario-local credentials outside `RunContext`), satisfying hard constraint 6.
 *
 * Hard constraint 7c: neither ticket says "the bot was never added to the channel,"
 * "recompute the HMAC with the current secret," or "the secret rotates." Both state only
 * the observed symptom.
 */

// --- Scenario 14: t5-envelope-trap --------------------------------------------------------

const t5EnvelopeTrap: ScenarioDef = {
  id: 't5-envelope-trap',
  tier: 5,
  track: 'troubleshoot',
  title: 'Slack posts that never post',
  platform: 'slack',
  docsRef: ['slack'],
  build(ctx: RunContext) {
    const targetIndex = Math.min(
      Math.max(Number(ctx.vars.slackTargetChannelIndex ?? '0'), 0),
      ctx.slack.channels.length - 1,
    );
    const targetChannel = ctx.slack.channels[targetIndex];
    if (!targetChannel) throw new Error('t5-envelope-trap: no channel to target, this should be unreachable');

    const fault: Fault = {
      id: 'force-not-in-channel',
      kind: 'state',
      apply(w) {
        const channel = w.slack.channels.find((c) => c.id === targetChannel.id);
        if (channel) channel.isMember = false;
      },
    };

    const ticketMd = `
## Ticket

${ctx.company.name}'s Slack bot is supposedly posting an alert into #${targetChannel.name}
on every run, and the integration's own logs show a clean 200 OK for every single one, but
nobody has ever actually seen a message land in that channel.

- Bot token: \`${ctx.slack.botToken}\`
- Channel: \`${targetChannel.id}\` (#${targetChannel.name})

Get a message actually posted into that channel, then pull its complete message history.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: 'Post a message that genuinely lands',
          // Fix round (task-7 review, finding 1): real Slack accepts BOTH GET and POST on
          // every Web API method, form-encoded POST being Slack's own canonical style
          // (platforms/slack/router.ts's own header comment). A learner reaching for POST
          // here (the natural first instinct) must count as a real attempt whether or not
          // it happens to match the exact verb this ticket's own narrative implies.
          match: { method: ['GET', 'POST'], pathPattern: '^/slack/api/chat\\.postmessage$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'ok', equals: true },
          ],
          attemptHint:
            'chat.postMessage answers HTTP 200 even when it fails. Check the "ok" field and the "error" string in the response body, not just the status code, to see what actually happened.',
        },
        {
          id: 'step-2',
          title: 'Pull the full channel history',
          match: { method: ['GET', 'POST'], pathPattern: '^/slack/api/conversations\\.history$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'jsonPath', path: 'ok', equals: true },
            { kind: 'jsonPath', path: 'has_more', equals: false },
            { kind: 'bodyMatches', matches: escapeRegex(OLDEST_SLACK_MESSAGE_MARKER) },
          ],
          attemptHint:
            'This endpoint only returns a handful of messages per call. Keep sending response_metadata.next_cursor back as the "cursor" query parameter until "has_more" comes back false.',
        },
      ],
      hints: [
        'A 200 status code from Slack\'s Web API never means the call succeeded on its own; the real result lives in the "ok" field of the response body.',
        `"not_in_channel" means the bot has never joined that channel. "POST /slack/api/conversations.join" with the same channel id fixes that before you try posting again.`,
        'conversations.history only returns a few messages per call. Follow response_metadata.next_cursor as the "cursor" parameter, repeatedly, until has_more is false, to see the whole history.',
      ],
      solutionMd: `
## Root cause

The bot was never a member of \`#${targetChannel.name}\`. \`chat.postMessage\` answered
every attempt with \`HTTP 200\` and \`{"ok": false, "error": "not_in_channel"}\`: the
integration's own logging only checked the status code, so it reported success on every
run while nothing was ever actually posted.

## Fix

Call \`POST /slack/api/conversations.join\` with \`channel: "${targetChannel.id}"\` first,
then repost. To read the full history afterward, page \`GET
/slack/api/conversations.history\` with the \`cursor\` query parameter, following
\`response_metadata.next_cursor\` from each response until \`has_more\` is \`false\`.
`.trim(),
    };
  },
};

// --- Scenario 15: t5-hmac-signature -------------------------------------------------------

const t5HmacSignature: ScenarioDef = {
  id: 't5-hmac-signature',
  tier: 5,
  track: 'troubleshoot',
  title: 'Slack webhook signature verification',
  platform: 'slack',
  // 'scripting' added (Task 8 fix round, finding 5): this is the one scenario where a
  // Pre-request script computing the signature (content/docs/scripting.md's own worked
  // example is this exact signature) is a genuinely useful path, and it was the only
  // registered doc with zero scenario referencing it at all.
  docsRef: ['slack', 'scripting'],
  build(ctx: RunContext) {
    // Minted locally, outside RunContext, same convention t3-google.ts's
    // mintAccessToken()/mintRefreshToken() use for scenario-local credentials (this
    // file's header comment). Never shown in ticketMd: real Slack has no API that returns
    // a signing secret, so the only honest, discoverable channel for it is a hint,
    // unlocked only after genuine attempts (see below).
    const rotatedSigningSecret = randomBytes(16).toString('hex');

    const fault: Fault = {
      id: 'signing-secret-rotated',
      kind: 'state',
      apply(_w: World) {
        // Genuinely does nothing at activation: the disclosed secret must work at least
        // once, for real, before anything breaks (same principle t6-capstone.ts's own
        // delayed-refresh-revoke fault documents in its header comment).
      },
      revert(w: World) {
        // Fires the instant step 1 (the first, genuinely successful signed request)
        // completes: ops rotates the signing secret mid-flight, exactly like
        // t6-capstone.ts's refresh-token revocation. The IDENTICAL next signed request
        // (step 2, recomputed with the SAME secret that just worked) now fails.
        w.slack.signingSecret = rotatedSigningSecret;
      },
    };

    const ticketMd = `
## Ticket

${ctx.company.name} just stood up a webhook consumer for Slack Events at
\`/slack/webhook/events\`. Every delivery against it so far has been rejected; nothing has
ever gotten through yet.

- Signing secret on file: \`${ctx.slack.signingSecret}\`

Send Slack's standard \`url_verification\` handshake
(\`{"type":"url_verification","challenge":"<any text>"}\`) and get it accepted, with the
same challenge value echoed back in the response. This integration has looked fixed
before and stopped working again without warning, so prove it actually holds up, not just
that one request went through.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [fault],
      steps: [
        {
          id: 'step-1',
          title: 'Get a signed request accepted',
          match: { method: 'POST', pathPattern: '^/slack/webhook/events$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'reqJsonPath', path: 'type', equals: 'url_verification' },
            { kind: 'jsonPath', path: 'challenge', exists: true },
          ],
          clearFaults: ['signing-secret-rotated'],
          attemptHint:
            'A rejected request here gives no detail about why. Recompute v0=HMAC-SHA256(signingSecret, "v0:{timestamp}:{rawBody}"), hex-encoded, and send it fresh, with a timestamp within 5 minutes of right now.',
        },
        {
          id: 'step-2',
          title: 'Prove it keeps working, not just once',
          match: { method: 'POST', pathPattern: '^/slack/webhook/events$' },
          assertions: [
            { kind: 'status', equals: 200 },
            { kind: 'reqJsonPath', path: 'type', equals: 'url_verification' },
            { kind: 'jsonPath', path: 'challenge', exists: true },
          ],
          attemptHint:
            'The exact request that just worked can fail now for exactly one reason: the signing secret on file is not the one being checked against anymore. Recomputing with the same secret again will not help; a hint below has the new one once you have genuinely tried.',
        },
      ],
      hints: [
        'Slack signs the EXACT raw bytes of the request body. If anything reformats or re-serializes the JSON before hashing it (a pretty-printer, a different key order), the signature will never match, even with the right secret.',
        `The signing secret rotated the moment your first request genuinely succeeded, a real ops rotation, not a fluke. The new one is \`${rotatedSigningSecret}\`: recompute the HMAC with THIS secret, not the one from the ticket.`,
        'The base string is "v0:{timestamp}:{body}", colon-joined, hashed with HMAC-SHA256 using the signing secret, hex-encoded, then prefixed with "v0=". A timestamp more than 5 minutes old (or in the future) is rejected outright, signature aside; use the current time for every attempt, not one you computed and saved earlier. See the Docs tab for a one-line openssl command that does exactly this.',
      ],
      solutionMd: `
## Root cause

Nothing was wrong with the signing secret computation itself. The secret on file,
\`${ctx.slack.signingSecret}\`, genuinely worked once, then rotated the moment that first
request succeeded: every request after that was correctly rejected, since it was signed
against a secret that was no longer the one being checked. The current secret is
\`${rotatedSigningSecret}\`.

## Fix

Compute the signature freshly for every request, against the CURRENT secret:

    ts=$(date +%s)
    body='{"type":"url_verification","challenge":"abc"}'
    sig="v0=$(printf "v0:$ts:$body" | openssl dgst -sha256 -hmac "${rotatedSigningSecret}" -r | cut -d' ' -f1)"

Send it as \`X-Slack-Request-Timestamp: $ts\` and \`X-Slack-Signature: $sig\`, with the
exact same \`$body\` bytes as the request body. Never trust a signing secret you have not
re-confirmed recently: it can rotate without warning, the same way this one just did.
`.trim(),
    };
  },
};

export const t5Scenarios: ScenarioDef[] = [t5EnvelopeTrap, t5HmacSignature];
