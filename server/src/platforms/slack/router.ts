import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SlackMessage } from '@gym/shared';
import { activeWorld } from '../world.js';
import { verifySlackSignature } from './sign.js';
import {
  slackAuthTestBody,
  slackError,
  slackHistoryPage,
  slackJoinSuccess,
  slackListChannelsBody,
  slackPostMessageSuccess,
  slackUrlVerificationResponse,
  type SlackHistoryMessage,
} from './fixtures.js';

/**
 * `/slack` router (docs/SPEC.md section 5). Mounted at `/slack` by app.ts; every path
 * below is written with Slack's own real casing (`chat.postMessage`, not
 * `chat.postmessage`), byte-identical to Slack's real Web API paths, per the same
 * transfer-by-swapping-baseUrl requirement every other platform in this project follows.
 * Express's router matches paths case-insensitively by default (the same fact
 * `app.ts`'s `isPlatformPath` comment already documents for this project), so this is
 * purely source fidelity, not a functional requirement.
 *
 * The whole platform's central lesson (docs/SPEC.md section 12, scenario
 * t5-envelope-trap; task-7 brief: "the most transferable lesson in the whole gym"):
 * `platforms/slack/fixtures.ts`'s header comment documents, sourced live from
 * docs.slack.dev, that Slack's Web API methods answer with HTTP 200 on essentially every
 * outcome, success or failure, putting the real result in the JSON body's `ok` field.
 * EVERY handler below therefore calls `res.json(...)` with an implicit 200, never
 * `res.status(4xx)`, for any Slack-API-shaped failure (`not_in_channel`,
 * `channel_not_found`, `invalid_auth`, `not_authed`, `invalid_cursor`): this is not an
 * oversight, it is the lesson. The one genuine non-200 status in this file is
 * `POST /webhook/events`'s signature failure, which is not a real slack.com endpoint at
 * all (see `sign.ts`'s header comment on what this endpoint actually simulates) and
 * follows this mock's own, documented-as-such convention instead.
 *
 * Fix round (task-7 review, finding 1, hard constraint 9): real Slack accepts BOTH `GET`
 * and `POST` on every Web API method (form-encoded `POST` is Slack's own canonical style;
 * `GET` with query-string params also works), so a learner's first, entirely plausible
 * attempt might use either verb regardless of which one a given scenario's ticket happens
 * to model. Before this fix, only ONE verb was registered per `/api/*` route (`POST` for
 * `auth.test`/`chat.postMessage`/`conversations.join`, `GET` for `conversations.list`/
 * `conversations.history`), so the OTHER verb 404'd from the generic handler with zero
 * `scenario:attempt` and no SSE event: total silence on a first-choice wrong attempt, a
 * hard constraint 9 violation, and also wrong on its own terms (real Slack never 404s a
 * real method for using the "other" verb; it answers the same JSON envelope either way).
 * Every `/api/*` route below now registers both verbs against the SAME handler function,
 * which reads its parameters from body OR query via `readParam()` so either verb's
 * request shape works identically. `POST /webhook/events` is deliberately excluded: it is
 * not a real Slack Web API method at all (see above), and real webhook DELIVERY from
 * Slack is always POST, so there is no "real Slack accepts GET here too" fact to mirror.
 */

function extractSlackToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  const token = readParam(req, 'token');
  return token === undefined ? null : token;
}

/**
 * Reads one parameter from either the request body (form-encoded or JSON, however `POST`
 * sent it) or the query string (however `GET` sent it), body taking priority when both are
 * present. Fix round (task-7 review, finding 1): every `/api/*` handler now accepts either
 * verb, so every parameter read in this file goes through this single function instead of
 * reaching into `req.body` or `req.query` directly, the way `readChannelId()` (now
 * deleted) and `conversations.history`'s inline `req.query.channel`/`req.query.cursor`
 * reads used to, both of which would have silently returned nothing for a same-shaped
 * request sent via the other verb.
 */
function readParam(req: Request, name: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.[name];
  if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  const fromQuery = req.query[name];
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  return undefined;
}

/** On failure, writes the `{ok:false, error:...}` body itself (HTTP 200, per the header
 *  comment above) and returns null. Mirrors real Slack's own two distinct auth error
 *  codes (`docs.slack.dev/reference/methods/auth.test`'s documented error list):
 *  `not_authed` when no credential was sent at all, `invalid_auth` when one was sent but
 *  does not match. */
function authenticateOrRespond(req: Request, res: Response): true | null {
  const token = extractSlackToken(req);
  if (!token) {
    res.json(slackError('not_authed'));
    return null;
  }
  if (token !== activeWorld().slack.botToken) {
    res.json(slackError('invalid_auth'));
    return null;
  }
  return true;
}

// --- conversations.history pagination (docs/SPEC.md section 12, t5-envelope-trap) --------
//
// Clamped to a small page size regardless of the caller's requested `limit`, deliberately:
// real Slack's default limit is 100, comfortably larger than any single seeded channel's
// history (9-13 messages, `platforms/world.ts`'s `buildSlackChannelMessages`), which would
// let a single, unpaginated call retrieve everything and defeat the entire cursor-
// pagination lesson. This mock's own documented simplification (see the Docs tab content
// in the task-7 report), distinct from the error-envelope fidelity claims spec section 7
// actually requires (those apply to error bodies, not to a success-path page-size choice).
const HISTORY_PAGE_SIZE = 4;

interface CursorDecodeResult {
  ok: boolean;
  offset: number;
}

/**
 * Absent or empty is a legitimate "start from page 1" (the normal, expected shape of the
 * FIRST call in a pagination sequence, never an error). Anything else must decode to a
 * genuine non-negative integer or it is rejected as `invalid_cursor` (fix round, task-7
 * review finding 6): garbage, a tampered value, or a cursor replayed from a different
 * scenario activation (a different `Buffer.from(...)`-decodable-but-nonsensical string)
 * used to silently reset to offset 0 instead of surfacing the real Slack error this exact
 * situation documents (`platforms/slack/fixtures.ts`'s sourced comment on
 * `slackError('invalid_cursor')`). Server-side pagination termination was never at risk
 * either way (a bad cursor never produced an infinite loop), but a learner replaying a
 * stale cursor deserves the real envelope, not a silent restart.
 */
function decodeCursor(cursor: string | undefined): CursorDecodeResult {
  if (cursor === undefined || cursor === '') return { ok: true, offset: 0 };
  // Buffer's base64url decoder never throws on malformed input (it silently drops bytes
  // it cannot parse), so garbage is caught below by the numeric check, not by a try/catch.
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (decoded.trim() === '') return { ok: false, offset: 0 }; // a non-empty param that decoded to nothing meaningful
  const n = Number(decoded);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false, offset: 0 };
  return { ok: true, offset: n };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function toHistoryMessage(m: SlackMessage): SlackHistoryMessage {
  return { type: 'message', user: m.user, text: m.text, ts: m.ts };
}

export function createSlackRouter(): Router {
  const router = Router();

  // --- auth.test ---------------------------------------------------------------------
  function authTest(req: Request, res: Response): void {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    res.json(
      slackAuthTestBody({
        teamName: world.slack.teamName,
        teamId: world.slack.teamId,
        botUserId: world.slack.botUserId,
        botId: `B${world.slack.botUserId.slice(1)}`,
      }),
    );
  }
  router.route('/api/auth.test').get(authTest).post(authTest);

  // --- chat.postMessage (the envelope trap) -------------------------------------------
  function chatPostMessage(req: Request, res: Response): void {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = readParam(req, 'channel') ?? '';
    const text = readParam(req, 'text') ?? '';
    const channel = world.slack.channels.find((c) => c.id === channelId);
    if (!channel) {
      res.json(slackError('channel_not_found'));
      return;
    }
    if (!channel.isMember) {
      res.json(slackError('not_in_channel'));
      return;
    }
    res.json(slackPostMessageSuccess(channel.id, text, world.slack.botUserId));
  }
  router.route('/api/chat.postMessage').get(chatPostMessage).post(chatPostMessage);

  // --- conversations.list --------------------------------------------------------------
  function conversationsList(req: Request, res: Response): void {
    if (!authenticateOrRespond(req, res)) return;
    res.json(slackListChannelsBody(activeWorld().slack.channels));
  }
  router.route('/api/conversations.list').get(conversationsList).post(conversationsList);

  // --- conversations.join --------------------------------------------------------------
  function conversationsJoin(req: Request, res: Response): void {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = readParam(req, 'channel') ?? '';
    const channel = world.slack.channels.find((c) => c.id === channelId);
    if (!channel) {
      res.json(slackError('channel_not_found'));
      return;
    }
    const alreadyMember = channel.isMember;
    channel.isMember = true;
    res.json(slackJoinSuccess(channel, alreadyMember));
  }
  router.route('/api/conversations.join').get(conversationsJoin).post(conversationsJoin);

  // --- conversations.history (cursor pagination) ----------------------------------------
  function conversationsHistory(req: Request, res: Response): void {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = readParam(req, 'channel') ?? '';
    const channel = world.slack.channels.find((c) => c.id === channelId);
    if (!channel) {
      res.json(slackError('channel_not_found'));
      return;
    }
    if (!channel.isMember) {
      res.json(slackError('not_in_channel'));
      return;
    }
    const cursorResult = decodeCursor(readParam(req, 'cursor'));
    if (!cursorResult.ok) {
      res.json(slackError('invalid_cursor'));
      return;
    }
    const all = world.slack.messages[channelId] ?? [];
    const offset = cursorResult.offset;
    const page = all.slice(offset, offset + HISTORY_PAGE_SIZE);
    const hasMore = offset + HISTORY_PAGE_SIZE < all.length;
    const nextCursor = hasMore ? encodeCursor(offset + HISTORY_PAGE_SIZE) : '';
    res.json(slackHistoryPage(page.map(toHistoryMessage), hasMore, nextCursor));
  }
  router.route('/api/conversations.history').get(conversationsHistory).post(conversationsHistory);

  // --- webhook/events (HMAC verification; see sign.ts's header comment) ------------------
  router.post('/webhook/events', (req, res) => {
    const world = activeWorld();
    const verification = verifySlackSignature({
      signingSecret: world.slack.signingSecret,
      timestamp: req.get('x-slack-request-timestamp') ?? undefined,
      signature: req.get('x-slack-signature') ?? undefined,
      rawBody: req.rawBody ?? Buffer.alloc(0),
    });
    if (!verification.ok) {
      // This mock's own convention (not sourced from slack.com: this endpoint plays the
      // CONSUMER side, which real Slack never exposes as an API to call; see sign.ts's
      // header comment). 401 matches the near-universal convention every real webhook
      // receiver (GitHub, Stripe, Slack's own documented reference implementations) uses
      // for a signature that does not verify.
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      res.json(slackUrlVerificationResponse(body.challenge));
      return;
    }
    res.json({ ok: true });
  });

  // Fall-through for any /slack path or method this mock has no route registered for at
  // all, registered last so it never shadows a real route above (fix round, finding 7).
  // Slack's own idiom, per this file's header comment: HTTP 200 with the real result in
  // the JSON body's `ok` field, not the trainer's generic
  // `{"error":"Not Found","path":"..."}` (app.ts's catch-all, which would also be the
  // wrong HTTP status entirely for this platform). A path typo is the commonest real
  // mistake, and it used to teach the wrong shape.
  router.use((_req, res) => {
    res.json(slackError('unknown_method'));
  });

  return router;
}
