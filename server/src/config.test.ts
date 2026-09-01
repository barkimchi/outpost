import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './config.js';

/**
 * `web/vite.config.ts` cannot import DEFAULT_PORT from this file directly (see the
 * comment on it in config.ts), so it keeps its own literal `const DEFAULT_PORT = '4600'`
 * in sync by convention. This test is the actual enforcement: it fails loudly the moment
 * the two numbers drift, which is exactly the bug that shipped three times in this
 * project's first three commits (4700 -> 4800 -> 4600, touching both files each time).
 */
test('web/vite.config.ts default port matches server/src/config.ts DEFAULT_PORT', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viteConfigPath = path.resolve(here, '../../web/vite.config.ts');
  const source = await fs.readFile(viteConfigPath, 'utf8');
  const match = source.match(/const DEFAULT_PORT = '(\d+)'/);
  assert.ok(match, 'expected `const DEFAULT_PORT = \'<port>\'` in web/vite.config.ts');
  const viteDefaultPort = Number(match![1]);
  assert.equal(
    viteDefaultPort,
    DEFAULT_PORT,
    `web/vite.config.ts default (${viteDefaultPort}) does not match server/src/config.ts DEFAULT_PORT (${DEFAULT_PORT})`,
  );
});
