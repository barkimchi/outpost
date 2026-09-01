import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Default 4700, not 4600: a stray process has held 4600 on the dev machine for weeks. */
export const PORT = Number(process.env.PORT ?? 4700);

export const VERSION = '0.0.0';

/**
 * Compiled web app. In production this file runs from server/dist/config.js, so the
 * repo root is two levels up and web/dist is its sibling.
 */
export const WEB_DIST_DIR = path.resolve(here, '../../web/dist');

/** Runtime state directory. progress.json and workspace.json live here (gitignored). */
export const DATA_DIR = path.resolve(here, '../../data');
