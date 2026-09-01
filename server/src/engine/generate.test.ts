import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, hashSeedToUint32, mintSeed, mulberry32 } from './generate.js';

test('generate() is a pure function of the seed: the same seed reproduces the exact same RunContext', () => {
  const a = generate('a3f9c1d2');
  const b = generate('a3f9c1d2');
  assert.deepEqual(a, b);
});

test('two different seeds produce different company, user, and credential data (per-run generation)', () => {
  const a = generate('11111111');
  const b = generate('22222222');
  assert.notEqual(a.company.name, b.company.name);
  assert.notEqual(a.user.login, b.user.login);
  assert.notEqual(a.github.validPat, b.github.validPat);
  assert.notEqual(a.github.revokedPat, b.github.revokedPat);
  assert.notEqual(a.github.secondPat, b.github.secondPat);
  assert.notEqual(a.google.clientId, b.google.clientId);
  assert.notEqual(a.slack.botToken, b.slack.botToken);
  assert.notEqual(a.slack.signingSecret, b.slack.signingSecret);
  assert.notDeepEqual(a.github.repos, b.github.repos);
});

test('company name varies across many seeds and is never always "Acme"', () => {
  const names = new Set<string>();
  for (let i = 0; i < 30; i++) {
    names.add(generate(mintSeed()).company.name);
  }
  assert.ok(names.size > 1, 'expected more than one distinct company name across 30 runs');
  for (const name of names) {
    assert.notEqual(name.toLowerCase(), 'acme');
  }
});

test('token formats look real', () => {
  const ctx = generate('deadbeef');
  assert.match(ctx.github.validPat, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(ctx.github.revokedPat, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(ctx.github.secondPat, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(ctx.slack.botToken, /^xoxb-\d{12}-\d{12}-[a-z0-9]{24}$/);
  assert.match(
    ctx.google.clientId,
    /^\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com$/,
  );
  assert.match(ctx.slack.signingSecret, /^[0-9a-f]{32}$/);
});

test('the three GitHub PATs are always distinct from each other within one run', () => {
  for (const seed of ['00000000', 'abc12345', 'fedcba98', mintSeed(), mintSeed()]) {
    const ctx = generate(seed);
    const pats = new Set([ctx.github.validPat, ctx.github.revokedPat, ctx.github.secondPat]);
    assert.equal(pats.size, 3, `PATs collided for seed ${seed}`);
  }
});

test('exactly one repo is private, and privateRepo names it', () => {
  const ctx = generate('c0ffee01');
  const privateOnes = ctx.github.repos.filter((r) => r.private);
  assert.equal(privateOnes.length, 1);
  assert.equal(privateOnes[0]?.name, ctx.github.privateRepo);
});

test('vars carries pageSize and targetRepo, and targetRepo names a real generated repo', () => {
  const ctx = generate('01234567');
  assert.ok(ctx.vars.pageSize === '1' || ctx.vars.pageSize === '2');
  assert.ok(ctx.github.repos.some((r) => r.name === ctx.vars.targetRepo));
});

test('mintSeed() produces an 8 hex char seed, and does not repeat trivially', () => {
  const seeds = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const s = mintSeed();
    assert.match(s, /^[0-9a-f]{8}$/);
    seeds.add(s);
  }
  assert.equal(seeds.size, 20, 'expected 20 distinct seeds from 20 mints');
});

test('hashSeedToUint32 is deterministic and mulberry32 built from it is deterministic', () => {
  const h1 = hashSeedToUint32('same-seed');
  const h2 = hashSeedToUint32('same-seed');
  assert.equal(h1, h2);
  const seq1 = [mulberry32(h1)(), mulberry32(h1)()];
  const seq2 = [mulberry32(h2)(), mulberry32(h2)()];
  assert.deepEqual(seq1, seq2);
});
