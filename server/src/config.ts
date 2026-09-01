import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Single source of truth for the default port (docs/SPEC.md section 2). `PORT` env
 * overrides it. `web/vite.config.ts` cannot import this value directly (it runs through
 * Vite's own esbuild-based config loader, outside this package's build graph, and a
 * fresh clone has no `server/dist` yet), so it keeps its own literal fallback in sync by
 * reading `process.env.PORT` the same way. `config.test.ts` asserts the two literals
 * match so a future port change cannot silently drift between the two files the way it
 * did across this project's first three commits, each of which touched both.
 */
export const DEFAULT_PORT = 4600;

export const PORT = Number(process.env.PORT ?? DEFAULT_PORT);

export const VERSION = '0.0.0';

/**
 * Compiled web app. In production this file runs from server/dist/config.js, so the
 * repo root is two levels up and web/dist is its sibling.
 */
export const WEB_DIST_DIR = path.resolve(here, '../../web/dist');

/** Runtime state directory. progress.json and workspace.json live here (gitignored). */
export const DATA_DIR = path.resolve(here, '../../data');
