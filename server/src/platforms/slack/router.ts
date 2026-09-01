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
 * `channel_not_found`, `invalid_auth`, `not_authed`): this is not an oversight, it is the
 * lesson. The one genuine non-200 status in this file is `POST /webhook/events`'s
 * signature failure, which is not a real slack.com endpoint at all (see `sign.ts`'s header
 * comment on what this endpoint actually simulates) and follows this mock's own,
 * documented-as-such convention instead.
 */

function extractSlackToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  const body = req.body as Record<string, unknown> | undefined;
  const bodyToken = body?.token;
  if (typeof bodyToken === 'string' && bodyToken !== '') return bodyToken;
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken !== '') return queryToken;
  return null;
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

function readChannelId(source: unknown): string {
  const value = (source as Record<string, unknown> | undefined)?.channel;
  return typeof value === 'string' ? value : '';
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

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = Number(decoded);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
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
  router.post('/api/auth.test', (req, res) => {
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
  });

  // --- chat.postMessage (the envelope trap) -------------------------------------------
  router.post('/api/chat.postMessage', (req, res) => {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = readChannelId(req.body);
    const text = typeof (req.body as Record<string, unknown> | undefined)?.text === 'string' ? String((req.body as Record<string, unknown>).text) : '';
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
  });

  // --- conversations.list --------------------------------------------------------------
  router.get('/api/conversations.list', (req, res) => {
    if (!authenticateOrRespond(req, res)) return;
    res.json(slackListChannelsBody(activeWorld().slack.channels));
  });

  // --- conversations.join --------------------------------------------------------------
  router.post('/api/conversations.join', (req, res) => {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = readChannelId(req.body);
    const channel = world.slack.channels.find((c) => c.id === channelId);
    if (!channel) {
      res.json(slackError('channel_not_found'));
      return;
    }
    const alreadyMember = channel.isMember;
    channel.isMember = true;
    res.json(slackJoinSuccess(channel, alreadyMember));
  });

  // --- conversations.history (cursor pagination) ----------------------------------------
  router.get('/api/conversations.history', (req, res) => {
    if (!authenticateOrRespond(req, res)) return;
    const world = activeWorld();
    const channelId = typeof req.query.channel === 'string' ? req.query.channel : '';
    const channel = world.slack.channels.find((c) => c.id === channelId);
    if (!channel) {
      res.json(slackError('channel_not_found'));
      return;
    }
    if (!channel.isMember) {
      res.json(slackError('not_in_channel'));
      return;
    }
    const all = world.slack.messages[channelId] ?? [];
    const offset = decodeCursor(req.query.cursor);
    const page = all.slice(offset, offset + HISTORY_PAGE_SIZE);
    const hasMore = offset + HISTORY_PAGE_SIZE < all.length;
    const nextCursor = hasMore ? encodeCursor(offset + HISTORY_PAGE_SIZE) : '';
    res.json(slackHistoryPage(page.map(toHistoryMessage), hasMore, nextCursor));
  });

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

  return router;
}
