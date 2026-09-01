#!/usr/bin/env node
// Style guard (docs/PLAN.md Task 2, hardened in the Task 2 fix round). Dependency-free
// grep over tracked source files for:
//   1. em-dash/en-dash and three common lookalikes (figure dash, horizontal bar, minus
//      sign) in any of the raw glyph, a JS/TS \u escape sequence, an HTML entity (named
//      or numeric), or a String.fromCharCode/fromCodePoint construction with a literal
//      code point argument, outside docs/reference/** and package-lock.json. A first
//      version of this script only caught the raw glyph in five text extensions; a
//      review defeated it with all four bypass forms plus two extensions (.html, .css)
//      it never scanned at all, which happen to be exactly where UI copy lives.
//   2. no reintroduction of the literal banned port outside docs/SPEC.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', '.superpowers']);
const CHECKED_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json', '.mjs', '.html', '.css']);
const DASH_EXCLUDE_PREFIX = 'docs/reference/';
const DASH_EXCLUDE_FILE = 'package-lock.json';
const PORT_ALLOWED_FILE = 'docs/SPEC.md';
const BANNED_PORT = ['4', '7', '0', '0'].join('');

// Em dash (U+2014), en dash (U+2013), and three lookalikes worth banning alongside them:
// figure dash (U+2012), horizontal bar (U+2015), minus sign (U+2212). Stored only as
// code points here, never as literal glyphs or as a direct fromCharCode/fromCodePoint
// call with the digits inlined, which is exactly what the construction check below
// looks for: this file's own reference data must not trip its own checks.
const BANNED_CODE_POINTS = [0x2012, 0x2013, 0x2014, 0x2015, 0x2212];
const NAMED_ENTITIES = { 0x2013: 'ndash', 0x2014: 'mdash', 0x2212: 'minus' };

const hex4 = (cp) => cp.toString(16).padStart(4, '0');
const bannedChars = BANNED_CODE_POINTS.map((cp) => String.fromCodePoint(cp));
const escapePatterns = BANNED_CODE_POINTS.map((cp) => new RegExp('\\\\u\\{?0*' + hex4(cp) + '\\}?', 'i'));
const entityPatterns = BANNED_CODE_POINTS.flatMap((cp) => {
  const patterns = [new RegExp('&#0*' + cp + ';'), new RegExp('&#x0*' + hex4(cp) + ';', 'i')];
  const name = NAMED_ENTITIES[cp];
  if (name) patterns.push(new RegExp('&' + name + ';', 'i'));
  return patterns;
});
const constructionPatterns = BANNED_CODE_POINTS.flatMap((cp) => [
  new RegExp('from(?:CharCode|CodePoint)\\s*\\(\\s*0*' + cp + '\\s*\\)'),
  new RegExp('from(?:CharCode|CodePoint)\\s*\\(\\s*0x0*' + hex4(cp) + '\\s*\\)', 'i'),
]);
const allDashPatterns = [...escapePatterns, ...entityPatterns, ...constructionPatterns];

function hasBannedDash(line) {
  if (bannedChars.some((ch) => line.includes(ch))) return true;
  return allDashPatterns.some((re) => re.test(line));
}

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
    if (checkDashes && hasBannedDash(line)) {
      violations.push(`${rel}:${i + 1}: em-dash, en-dash, or a lookalike/bypass is not allowed`);
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
