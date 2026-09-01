import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProgressStore, defaultScenarioProgressEntry } from './persist.js';

function tmpProgressPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-persist-test-'));
  return path.join(dir, 'progress.json');
}

test('a missing file loads the default value without throwing', () => {
  const store = createProgressStore(tmpProgressPath());
  assert.deepEqual(store.get(), { version: 1, scenarios: {} });
});

test('update() mutates in-memory immediately, before any write happens', () => {
  const store = createProgressStore(tmpProgressPath());
  store.update((p) => {
    p.scenarios['t1-wrong-method'] = { ...defaultScenarioProgressEntry(), runs: 1 };
  });
  assert.equal(store.get().scenarios['t1-wrong-method']?.runs, 1);
});

test('flush() writes atomically (via rename) and the file round-trips through a fresh store', () => {
  const filePath = tmpProgressPath();
  const store = createProgressStore(filePath);
  store.update((p) => {
    p.scenarios['t2-revoked-pat'] = { ...defaultScenarioProgressEntry(), solved: true, runs: 3, attempts: 7 };
  });
  store.flush();

  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assert.deepEqual(onDisk, store.get());

  // No leftover .tmp files after a flush.
  const dir = path.dirname(filePath);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  const reloaded = createProgressStore(filePath);
  assert.equal(reloaded.get().scenarios['t2-revoked-pat']?.solved, true);
  assert.equal(reloaded.get().scenarios['t2-revoked-pat']?.attempts, 7);
});

test('multiple update() calls within the debounce window coalesce into a single write', async () => {
  const filePath = tmpProgressPath();
  const store = createProgressStore(filePath);
  store.update((p) => {
    p.scenarios['a'] = { ...defaultScenarioProgressEntry(), runs: 1 };
  });
  store.update((p) => {
    const entry = p.scenarios['a'];
    if (entry) entry.runs = 2;
  });
  store.update((p) => {
    const entry = p.scenarios['a'];
    if (entry) entry.runs = 3;
  });

  // Before the debounce window elapses, nothing has hit disk yet.
  assert.equal(fs.existsSync(filePath), false);

  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { scenarios: Record<string, { runs: number }> };
  assert.equal(onDisk.scenarios['a']?.runs, 3, 'only the final, coalesced value should have been written');
});
