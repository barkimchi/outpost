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
 * Task 5 registered GitHub and Google OAuth here (the two platforms with a working mock
 * behind them at the time) plus `variables` and `auth-methods`, both genuinely usable
 * already. Task 8 completes the set: `glean` and `slack` (content written in the Task 7
 * report, placed here once this task owns `content/**`) and `scripting` (content written
 * in the Task 9 report for the script engine that task built). Every implementation-track
 * scenario's `docsRef` must resolve to a real entry here, since those scenarios are meant
 * to be solvable from this tab alone.
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
  { id: 'glean', title: 'Glean API', platform: 'glean', file: 'glean.md' },
  { id: 'slack', title: 'Slack API', platform: 'slack', file: 'slack.md' },
  { id: 'variables', title: 'Environments and Variables', platform: 'mixed', file: 'variables.md' },
  { id: 'auth-methods', title: 'Authentication Methods', platform: 'mixed', file: 'auth-methods.md' },
  { id: 'scripting', title: 'Scripting (Pre-request and Tests)', platform: 'mixed', file: 'scripting.md' },
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
