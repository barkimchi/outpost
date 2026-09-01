import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeWorld, OLDEST_SLACK_MESSAGE_MARKER, resetState } from './world.js';
import { buildTestRunContext } from '../testSupport/runContext.js';

// This first test must run before any resetState() call elsewhere in this file (node's
// test runner runs a single file's top-level tests in one process, in definition order),
// so it genuinely observes the pre-activation state.
test('activeWorld throws before resetState has ever run', () => {
  assert.throws(() => activeWorld(), /before resetState/);
});

test('resetState populates github token records from RunContext', () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();

  const valid = world.github.tokens[ctx.github.validPat];
  assert.ok(valid);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.scopes, ctx.github.scopes);
  assert.equal(valid.rateLimit.limit, ctx.github.rateLimit);
  assert.equal(valid.rateLimit.remaining, ctx.github.rateLimit);
  assert.equal(valid.rateLimit.used, 0);

  const revoked = world.github.tokens[ctx.github.revokedPat];
  assert.ok(revoked);
  assert.equal(revoked.valid, false);

  const second = world.github.tokens[ctx.github.secondPat];
  assert.ok(second);
  assert.equal(second.valid, true);
  assert.equal(
    second.rateLimit.remaining,
    ctx.github.rateLimit,
    'the second PAT must have its own, independent rate-limit budget',
  );

  assert.deepEqual(world.github.repos, ctx.github.repos);
  assert.equal(world.github.org, ctx.github.org);
  assert.deepEqual(world.github.user, ctx.user);
});

test('resetState is re-runnable: a second activation replaces state, no leakage from the first', () => {
  const first = buildTestRunContext();
  resetState(first);
  const worldAfterFirst = activeWorld();
  const firstRecord = worldAfterFirst.github.tokens[first.github.validPat];
  assert.ok(firstRecord);
  firstRecord.rateLimit.remaining = 0;
  assert.equal(activeWorld().github.tokens[first.github.validPat]?.rateLimit.remaining, 0);

  const second = buildTestRunContext({
    github: {
      ...first.github,
      validPat: `ghp_${'z'.repeat(36)}`,
      org: 'a-totally-different-org',
    },
  });
  resetState(second);
  const worldAfterSecond = activeWorld();

  // Run 1's valid token must not carry over, and must not solve run 2 (hard constraint 6).
  assert.equal(worldAfterSecond.github.tokens[first.github.validPat], undefined);
  const freshRecord = worldAfterSecond.github.tokens[second.github.validPat];
  assert.ok(freshRecord);
  assert.equal(
    freshRecord.rateLimit.remaining,
    second.github.rateLimit,
    'the fresh reset must not inherit the exhausted budget from the previous run',
  );
  assert.equal(worldAfterSecond.github.org, 'a-totally-different-org');
});

test('resetState populates google, glean, and slack sections from RunContext', () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();

  assert.equal(world.google.clientId, ctx.google.clientId);
  assert.equal(world.google.clientSecret, ctx.google.clientSecret);
  assert.equal(world.google.accessTokenTtlSec, ctx.google.accessTokenTtlSec);
  // Task 6 fix round: the three live registries oauth.ts issues into during a run start
  // empty on every reset.
  assert.deepEqual(world.google.issuedTokens, {});
  assert.deepEqual(world.google.authCodes, {});
  assert.deepEqual(world.google.refreshTokens, {});
  assert.equal(world.glean.indexingToken, ctx.glean.indexingToken);
  assert.deepEqual(world.glean.docs, ctx.glean.docs);
  assert.equal(world.slack.signingSecret, ctx.slack.signingSecret);
  assert.deepEqual(world.slack.channels, ctx.slack.channels);
});

// --- Task 7: Glean indexedDocs + Slack messages/teamName ---------------------------------

test('resetState starts glean.indexedDocs empty, and it is genuinely re-runnable across two activations', () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  assert.deepEqual(activeWorld().glean.indexedDocs, {});

  // Simulate a live indexing call mutating World mid-run (the same thing
  // platforms/glean/router.ts's indexdocument handler does).
  activeWorld().glean.indexedDocs['doc-1'] = { id: 'doc-1', datasource: 'x', indexedAt: Date.now() };
  assert.ok(Object.keys(activeWorld().glean.indexedDocs).length > 0);

  // A second reset (hard constraint 5/6: any scenario re-runnable, no leakage) must wipe
  // it clean again, not carry the previous run's indexed documents forward.
  resetState(buildTestRunContext());
  assert.deepEqual(activeWorld().glean.indexedDocs, {}, 'indexedDocs must not leak across runs');
});

test('resetState seeds slack.messages deterministically per channel, oldest message last, and mirrors company name into teamName', () => {
  const ctx = buildTestRunContext();
  resetState(ctx);
  const world = activeWorld();

  assert.equal(world.slack.teamName, ctx.company.name);

  for (const channel of ctx.slack.channels) {
    const messages = world.slack.messages[channel.id];
    assert.ok(messages, `channel ${channel.id} must have seeded messages`);
    assert.ok((messages?.length ?? 0) >= 9, 'at least 9 seeded messages per channel, per buildSlackChannelMessages');
    assert.equal(messages?.at(-1)?.text, OLDEST_SLACK_MESSAGE_MARKER, 'the last message must be the oldest-message marker');
  }

  // Same seed => same messages (deterministic, hard constraint: a captured seed
  // reproduces the exact same run).
  resetState(buildTestRunContext({ seed: ctx.seed }));
  const secondWorld = activeWorld();
  const firstChannel = ctx.slack.channels[0];
  if (!firstChannel) throw new Error('sanity: fixture must have at least one channel');
  assert.deepEqual(secondWorld.slack.messages[firstChannel.id], world.slack.messages[firstChannel.id]);

  // A different seed must produce different message content (hard constraint 6: per-run
  // generation, not the same canned text regenerated every time).
  resetState(buildTestRunContext({ seed: 'totally-different-seed' }));
  const thirdWorld = activeWorld();
  assert.notDeepEqual(
    thirdWorld.slack.messages[firstChannel.id]?.map((m) => m.text),
    world.slack.messages[firstChannel.id]?.map((m) => m.text),
  );
});
