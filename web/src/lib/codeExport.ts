/**
 * `</> Code` export (docs/SPEC.md section 13). Every generator takes the request AFTER
 * `{{var}}` resolution: this task's dispatch is explicit that the export "must produce
 * output that actually runs," verified by piping the generated cURL into a shell and
 * getting the same status the in-app Send got, so a template literal like `{{token}}`
 * must never appear in generated code, only the real resolved value.
 *
 * All three generators build their string literals through `JSON.stringify` rather than
 * hand-rolled escaping. That is a genuine, not merely a shortcut, choice for the Python and
 * Node generators: JSON's escape set (`\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, `\uXXXX`) is
 * a subset of both languages' own double-quoted string escape sets, so a JSON-encoded
 * string is always a valid Python and a valid JS string literal for the same value, with no
 * separate escaping logic to get subtly wrong per language.
 */

export interface ExportableRequest {
  method: string;
  /** Fully resolved: no `{{var}}` text may remain. */
  url: string;
  /** Fully resolved, enabled headers only. */
  headers: Record<string, string>;
  /** Fully resolved. `undefined` or `''` means no body. */
  body?: string;
}

function hasBody(req: ExportableRequest): boolean {
  return req.body !== undefined && req.body !== '';
}

// --- cURL --------------------------------------------------------------------------------

/** Single-quotes a shell argument, escaping any embedded single quote as `'\''`: close the
 *  quote, an escaped literal quote outside it, reopen the quote. Safe for arbitrary bytes,
 *  including other shells' special characters (`$`, backticks, `"`), since nothing inside a
 *  single-quoted string is interpreted by POSIX shells. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function toCurl(req: ExportableRequest): string {
  const lines: string[] = [`curl -sS -X ${req.method.toUpperCase()}`];
  for (const [key, value] of Object.entries(req.headers)) {
    lines.push(`-H ${shQuote(`${key}: ${value}`)}`);
  }
  if (hasBody(req)) lines.push(`-d ${shQuote(req.body as string)}`);
  lines.push(shQuote(req.url));
  return lines.join(' \\\n  ');
}

// --- Python requests ---------------------------------------------------------------------

export function toPythonRequests(req: ExportableRequest): string {
  const method = req.method.toLowerCase();
  const headerEntries = Object.entries(req.headers);
  const lines: string[] = ['import requests', '', `url = ${JSON.stringify(req.url)}`];

  if (headerEntries.length > 0) {
    lines.push('headers = {');
    for (const [key, value] of headerEntries) lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    lines.push('}');
  }
  if (hasBody(req)) lines.push(`data = ${JSON.stringify(req.body)}`);

  const args: string[] = [];
  if (headerEntries.length > 0) args.push('headers=headers');
  if (hasBody(req)) args.push('data=data');

  lines.push('', `response = requests.${method}(url${args.length > 0 ? `, ${args.join(', ')}` : ''})`, 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

// --- Node axios --------------------------------------------------------------------------

export function toNodeAxios(req: ExportableRequest): string {
  const method = req.method.toLowerCase();
  const headerEntries = Object.entries(req.headers);
  const lines: string[] = ["const axios = require('axios');", '', 'const config = {', `  method: ${JSON.stringify(method)},`, `  url: ${JSON.stringify(req.url)},`];

  if (headerEntries.length > 0) {
    lines.push('  headers: {');
    for (const [key, value] of headerEntries) lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    lines.push('  },');
  }
  if (hasBody(req)) lines.push(`  data: ${JSON.stringify(req.body)},`);
  lines.push('};', '', 'axios(config)', '  .then((response) => {', '    console.log(response.status);', '    console.log(response.data);', '  })', '  .catch((error) => {', '    console.error(error);', '  });');
  return lines.join('\n');
}

export type CodeExportLanguage = 'curl' | 'python' | 'node';

export function generateCode(language: CodeExportLanguage, req: ExportableRequest): string {
  if (language === 'curl') return toCurl(req);
  if (language === 'python') return toPythonRequests(req);
  return toNodeAxios(req);
}
