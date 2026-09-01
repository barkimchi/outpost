#!/usr/bin/env node
// Style guard (docs/PLAN.md Task 2). Dependency-free grep over tracked source files:
//   1. no em-dash (U+2014) or en-dash (U+2013) outside docs/reference/** and
//      package-lock.json (project owner's hard style rule, already broken once).
//   2. no reintroduction of the literal banned port outside docs/SPEC.md (that port
//      belongs to a different long-running process on this machine).
// The banned port digits are assembled at runtime, not written literally, so this
// script does not trip its own check when it scans itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', '.superpowers']);
const CHECKED_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json', '.mjs']);
const DASH_EXCLUDE_PREFIX = 'docs/reference/';
const DASH_EXCLUDE_FILE = 'package-lock.json';
const PORT_ALLOWED_FILE = 'docs/SPEC.md';
// Built from code points, not written as literal glyphs, so this file does not trip its
// own check when it scans itself.
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const BANNED_PORT = ['4', '7', '0', '0'].join('');

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const files = [];
walk(ROOT, files);

const violations = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  if (!CHECKED_EXTENSIONS.has(extname(rel))) continue;
  const text = readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const checkDashes = rel !== DASH_EXCLUDE_FILE && !rel.startsWith(DASH_EXCLUDE_PREFIX);
  const checkPort = rel !== PORT_ALLOWED_FILE;
  lines.forEach((line, i) => {
    if (checkDashes && (line.includes(EM_DASH) || line.includes(EN_DASH))) {
      violations.push(`${rel}:${i + 1}: em-dash or en-dash is not allowed`);
    }
    if (checkPort && line.includes(BANNED_PORT)) {
      violations.push(`${rel}:${i + 1}: literal banned port string found (see docs/SPEC.md section 2)`);
    }
  });
}

if (violations.length > 0) {
  console.error('Style check failed:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Style check passed (${files.length} files scanned).`);
