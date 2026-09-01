import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DocDetail, DocSummary } from '@gym/shared';

/**
 * The Docs tab's source registry (docs/SPEC.md section 4: "content/index.ts # doc
 * registry"; section 10: `GET /_trainer/api/docs`, `GET /_trainer/api/docs/:id`).
 * `server/src/trainer/docs.ts` wires these into HTTP handlers; this file only knows what
 * docs exist and how to read one.
 *
 * `here` mirrors `config.ts`'s own trick (`path.dirname(fileURLToPath(import.meta.url))`):
 * in dev this resolves to `server/src/content/`, in production to
 * `server/dist/content/` after `npm run build` compiles this file there. The markdown
 * files themselves are not TypeScript, so `tsc` never copies them; `server/package.json`'s
 * `build` script copies `docs/*.md` into `dist/content/docs/` alongside the compiled JS so
 * production reads from the same relative `docs/` folder dev does.
 *
 * Only GitHub and Google OAuth are registered here: those are the two platforms with a
 * working mock behind them as of this task (`platforms/github/**` and the concurrently-
 * built `platforms/google/**`). `docs/PLAN.md`'s Task 8 brief owns "the full
 * `content/docs/*.md` set (one per platform plus auth topics)"; adding Glean and Slack
 * stub pages now, before either platform exists, would risk writing content Task 7's real
 * implementation later contradicts. `variables` and `auth-methods` are genuinely usable
 * today (they document this task's own `{{var}}` resolution and Auth tab), so they are
 * registered now rather than deferred.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(here, 'docs');

interface DocEntry {
  id: string;
  title: string;
  platform: string;
  file: string;
}

const REGISTRY: DocEntry[] = [
  { id: 'github', title: 'GitHub REST API', platform: 'github', file: 'github.md' },
  { id: 'google-oauth', title: 'Google OAuth 2.0', platform: 'google', file: 'google-oauth.md' },
  { id: 'variables', title: 'Environments and Variables', platform: 'mixed', file: 'variables.md' },
  { id: 'auth-methods', title: 'Authentication Methods', platform: 'mixed', file: 'auth-methods.md' },
];

export function listDocs(): DocSummary[] {
  return REGISTRY.map(({ id, title, platform }) => ({ id, title, platform }));
}

export function getDoc(id: string): DocDetail | null {
  const entry = REGISTRY.find((e) => e.id === id);
  if (!entry) return null;
  const md = readFileSync(path.join(DOCS_DIR, entry.file), 'utf8');
  return { id: entry.id, title: entry.title, md };
}
