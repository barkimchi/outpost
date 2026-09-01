/**
 * Slack mock fixtures (docs/SPEC.md section 7 and section 12, scenarios 14-15). Same
 * convention as this project's other three platforms: the envelope and wording stay
 * verbatim where sourced; only interpolated values vary, and every function carries a
 * `// source:` or `// UNVERIFIED SHAPE:` comment.
 *
 * Hard constraint 3 (no real credentials, no network egress to real Slack) means none of
 * this was reproduced by an actual authenticated call. Everything below is sourced from
 * Slack's own public API reference (docs.slack.dev, fetched 2026-08-31; api.slack.com's
 * equivalent paths 302-redirect there now, so both names appear in comments below,
 * whichever the fetch actually landed on) and, for the one field the reference page did not
 * show a JSON example for (`missing_scope`'s `needed`/`provided`), independently
 * corroborated by multiple third-party bug reports quoting the identical response shape
 * (slack-node-sdk and slack-python-sdk GitHub issues), never reproduced live here.
 *
 * The load-bearing lesson of this whole platform (docs/SPEC.md section 12, scenario
 * t5-envelope-trap): confirmed directly from docs.slack.dev/reference/methods/
 * chat.postMessage (2026-08-31) that a failed call's error shape is
 * `{"ok": false, "error": "error_code"}`, and the reference page's own single worked
 * example (`{"ok": false, "error": "too_many_attachments"}`) is delivered with the SAME
 * envelope contract every real Slack Web API method uses: Slack's Web API methods answer
 * with HTTP 200 on essentially every outcome, success or failure alike, and put the actual
 * result in the `ok` field of the JSON body. A learner who checks only the HTTP status code
 * sees 200 and moves on.
 */

export interface SlackErrorBody {
  ok: false;
  error: string;
}

// source: docs.slack.dev/reference/methods/chat.postMessage (2026-08-31): "not_in_channel"
// -- "Cannot post user messages to a channel they are not in." -- listed as a real,
// documented error code for this exact method, delivered as {"ok": false, "error": "..."}
// with HTTP 200 (see header comment).
export function slackError(error: string): SlackErrorBody {
  return { ok: false, error };
}

export interface SlackMissingScopeBody extends SlackErrorBody {
  error: 'missing_scope';
  needed: string;
  provided: string;
}

// UNVERIFIED SHAPE: the envelope ({ok, error} at HTTP 200, per header comment) is
// confirmed; the needed/provided fields are NOT shown on the chat.postMessage reference
// page itself (it lists "missing_scope" only as a named error code with no example body).
// Corroborated instead by multiple independent third-party reports (slackapi/node-slack-
// sdk and slackapi/python-slack-sdk GitHub issues) quoting the identical
// {"ok":false,"error":"missing_scope","needed":"...","provided":"..."} shape consistently
// across different methods and years, strong circumstantial evidence but not Slack's own
// documentation showing it byte-exact, so this is not claimed as a confirmed `// source:`.
export function slackMissingScope(needed: string, provided: string): SlackMissingScopeBody {
  return { ok: false, error: 'missing_scope', needed, provided };
}

// --- auth.test (docs/SPEC.md section 5) --------------------------------------------------

export interface SlackAuthTestBody {
  ok: true;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id: string;
}

// source: docs.slack.dev/reference/methods/auth.test (2026-08-31), the documented
// "Bot Token" example response shape (ok/url/team/user/team_id/user_id/bot_id), with this
// run's own generated team/user identity interpolated in place of the doc's literal
// example values.
export function slackAuthTestBody(opts: { teamName: string; teamId: string; botUserId: string; botId: string }): SlackAuthTestBody {
  return {
    ok: true,
    url: `https://${opts.teamId.toLowerCase()}.slack.example.com/`,
    team: opts.teamName,
    user: 'bot',
    team_id: opts.teamId,
    user_id: opts.botUserId,
    bot_id: opts.botId,
  };
}

// --- chat.postMessage success (docs/SPEC.md section 5) -----------------------------------

// UNVERIFIED SHAPE: approximated. The chat.postMessage reference page's error table was
// reachable; a full success-body example was not rendered by the fetch (React-rendered
// reference site). Modeled on Slack's widely documented success shape
// (ok/channel/ts/message), not independently reproduced live. Not asserted byte-exact by
// any scenario, matching this project's convention: only error fixtures carry that
// requirement (spec section 7).
export function slackPostMessageSuccess(channelId: string, text: string, botUserId: string): Record<string, unknown> {
  const ts = `${Math.floor(Date.now() / 1000)}.000001`;
  return {
    ok: true,
    channel: channelId,
    ts,
    message: { text, user: botUserId, ts, type: 'message' },
  };
}

// --- conversations.join (docs/SPEC.md section 5) ------------------------------------------

// source: docs.slack.dev/reference/methods/conversations.join (2026-08-31): the documented
// success response is {"ok": true, "channel": {...}}, optionally carrying a top-level
// "warning" when the calling token had already joined ("If the calling token has already
// joined, it'll warn you about it too"). The nested channel object's own full field set
// (topic/purpose/is_general/...) is UNVERIFIED beyond id/name/is_member/is_private, which
// this mock actually tracks; the rest are this mock's own reasonable completion.
export function slackJoinSuccess(channel: { id: string; name: string; isMember: boolean }, alreadyMember: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ok: true,
    channel: {
      id: channel.id,
      name: channel.name,
      is_channel: true,
      is_member: true,
      is_private: false,
      is_archived: false,
    },
  };
  if (alreadyMember) body.warning = 'already_in_channel';
  return body;
}

// --- conversations.list (docs/SPEC.md section 5) ------------------------------------------

// source: docs.slack.dev/reference/methods/conversations.list (2026-08-31): response shape
// {"ok": true, "channels": [{id, name, is_member, is_channel, is_private, ...}],
// "response_metadata": {"next_cursor": "..."}}. This mock returns every channel in one
// page (empty next_cursor): no scenario in this task exercises conversations.list
// pagination, only conversations.history's.
export function slackListChannelsBody(channels: Array<{ id: string; name: string; isMember: boolean }>): Record<string, unknown> {
  return {
    ok: true,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      is_channel: true,
      is_private: false,
      is_member: c.isMember,
    })),
    response_metadata: { next_cursor: '' },
  };
}

// --- conversations.history (docs/SPEC.md section 5) ----------------------------------------

export interface SlackHistoryMessage {
  type: 'message';
  user: string;
  text: string;
  ts: string;
}

// source: docs.slack.dev/reference/methods/conversations.history (2026-08-31): response
// shape {"ok": true, "messages": [...], "has_more": boolean, "pin_count": number,
// "response_metadata": {"next_cursor": "..."}}, with the documented pagination contract
// ("iteration should stop when has_more returns false"; next_cursor comes from
// response_metadata and is fed back in as the `cursor` param on the next call).
export function slackHistoryPage(
  messages: SlackHistoryMessage[],
  hasMore: boolean,
  nextCursor: string,
): Record<string, unknown> {
  return {
    ok: true,
    messages,
    has_more: hasMore,
    pin_count: 0,
    response_metadata: { next_cursor: nextCursor },
  };
}

// --- webhook/events success bodies (this mock's own synthetic endpoint; see sign.ts's
// header comment for why this path exists at all) -------------------------------------

// source: Slack's documented Events API URL verification handshake (well-known, stable
// convention: a subscribing app must echo the `challenge` field back verbatim, JSON-
// encoded, with HTTP 200, or the subscription is rejected). This mock plays the role of
// "the endpoint a correctly-configured webhook consumer would expose," so it performs that
// same echo.
export function slackUrlVerificationResponse(challenge: string): Record<string, unknown> {
  return { challenge };
}
