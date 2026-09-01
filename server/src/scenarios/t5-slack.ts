import type { Fault, RunContext, ScenarioDef } from '@gym/shared';
import { escapeRegex } from '../engine/match.js';
import { OLDEST_SLACK_MESSAGE_MARKER } from '../platforms/world.js';

/**
 * Tier 5: Slack (docs/SPEC.md section 12, scenarios 14-15). Both target the `/slack`
 * router built in `platforms/slack/{router.ts,fixtures.ts,sign.ts}`.
 *
 * `t5-envelope-trap` is a state fault (docs/SPEC.md section 7: "prefer state faults"),
 * forcing one channel's `isMember` to `false` at activation regardless of what
 * `generate.ts`'s own 50/50 draw happened to assign it, so the scenario is guaranteed
 * solvable every run. `t5-hmac-signature` registers no fault at all: nothing in the World
 * needs to be broken for the lesson to hold, since the exercise is fundamentally
 * mechanical (compute the signature correctly, within the replay window) rather than a
 * "diagnose which credential is bad" puzzle. This mirrors the same judgment call
 * `t3-revoked-refresh` and `t3-token-expiry` already made in tier 3 (see `t3-google.ts`'s
 * header comment): hard constraint 7a's "the position of the correct answer must vary" only
 * applies where there IS a multi-candidate answer to position. `t5-hmac-signature` has
 * none: the ticket hands over the one real signing secret, and per-run generation (hard
 * constraint 6, already satisfied since `signingSecret`, the timestamp, and the request
 * body all differ every single REQUEST, not merely every run) already makes memorization
 * impossible on its own.
 *
 * Hard constraint 7a for `t5-envelope-trap`: WHICH channel starts un-joined is drawn from
 * `ctx.vars.slackTargetChannelIndex` (`engine/generate.ts`), independent of the channel
 * pool's own per-channel `isMember` draw, so the target channel's identity genuinely
 * varies run to run.
 *
 * Hard constraint 7c: neither ticket says "the bot was never added to the channel" or
 * "recompute the HMAC with the current secret." Both state only the observed symptom.
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

Bot token: \`${ctx.slack.botToken}\`
Channel: \`${targetChannel.id}\` (#${targetChannel.name})

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
          match: { method: 'POST', pathPattern: '^/slack/api/chat\\.postmessage$' },
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
          match: { method: 'GET', pathPattern: '^/slack/api/conversations\\.history$' },
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
  docsRef: ['slack'],
  build(ctx: RunContext) {
    const ticketMd = `
## Ticket

${ctx.company.name} just stood up a webhook consumer for Slack Events at
\`/slack/webhook/events\`, and every single delivery against it so far has been rejected;
nothing has ever gotten through yet.

Signing secret on file: \`${ctx.slack.signingSecret}\`

Send Slack's standard \`url_verification\` handshake
(\`{"type":"url_verification","challenge":"<any text>"}\`) and get it accepted, with the
same challenge value echoed back in the response.
`.trim();

    return {
      ticketMd,
      setup: [],
      faults: [],
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
          attemptHint:
            'A rejected request here gives no detail about why. Recompute v0=HMAC-SHA256(signingSecret, "v0:{timestamp}:{rawBody}"), hex-encoded, and send it fresh, with a timestamp within 5 minutes of right now.',
        },
      ],
      hints: [
        'Slack signs the EXACT raw bytes of the request body. If anything reformats or re-serializes the JSON before hashing it (a pretty-printer, a different key order), the signature will never match, even with the right secret.',
        'The base string is "v0:{timestamp}:{body}", colon-joined, hashed with HMAC-SHA256 using the signing secret, hex-encoded, then prefixed with "v0=". See the Docs tab for a one-line openssl command that does exactly this.',
        'A timestamp more than 5 minutes old (or in the future) is rejected outright, signature aside. Use the current time for every attempt, not one you computed and saved earlier.',
      ],
      solutionMd: `
## Root cause

Nothing was wrong with the signing secret itself. No request ever carried a correctly
computed \`X-Slack-Signature\` header, matching Slack's own \`v0=\` HMAC-SHA256 scheme over
\`v0:{timestamp}:{rawBody}\`, computed from the exact raw bytes of the body and a
timestamp within 5 minutes of the current time.

## Fix

Compute the signature freshly for every request:

    ts=$(date +%s)
    body='{"type":"url_verification","challenge":"abc"}'
    sig="v0=$(printf "v0:$ts:$body" | openssl dgst -sha256 -hmac "${ctx.slack.signingSecret}" -r | cut -d' ' -f1)"

Send it as \`X-Slack-Request-Timestamp: $ts\` and \`X-Slack-Signature: $sig\`, with the
exact same \`$body\` bytes as the request body.
`.trim(),
    };
  },
};

export const t5Scenarios: ScenarioDef[] = [t5EnvelopeTrap, t5HmacSignature];
