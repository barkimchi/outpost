/**
 * `{{var}}` tokenization and resolution (docs/SPEC.md section 13: "environments ...
 * `{{var}}` resolution and highlighting in the URL, headers, and body"; this task's
 * dispatch: "resolution happens before the request is sent, and the resolved value is what
 * must go over the wire and appear in the Logs tab", and "never render a secret as
 * unresolvable and silently send the literal `{{token}}`. If a variable is undefined, say
 * so visibly before sending.").
 *
 * `tokenizeVars` splits a string into plain-text and variable spans for highlighting
 * (`VarHighlightInput.tsx`, the CodeMirror body decoration). `resolveVars` substitutes,
 * and separately reports every name that had no defined value, so a caller can refuse to
 * send rather than silently forwarding the literal `{{name}}` text as if it were the value.
 */

export interface VarToken {
  kind: 'text' | 'var';
  /** The literal source text: for a `var` token this includes the `{{`/`}}` delimiters. */
  raw: string;
  /** Only set on `kind: 'var'` tokens: the trimmed name inside the delimiters. */
  name?: string;
}

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function tokenizeVars(input: string): VarToken[] {
  const tokens: VarToken[] = [];
  let lastIndex = 0;
  VAR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAR_PATTERN.exec(input)) !== null) {
    if (match.index > lastIndex) tokens.push({ kind: 'text', raw: input.slice(lastIndex, match.index) });
    const name = match[1] ?? '';
    tokens.push({ kind: 'var', raw: match[0], name });
    lastIndex = VAR_PATTERN.lastIndex;
  }
  if (lastIndex < input.length) tokens.push({ kind: 'text', raw: input.slice(lastIndex) });
  return tokens;
}

/** Every distinct variable name referenced in `input`, in first-seen order. */
export function varNamesIn(input: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeVars(input)) {
    if (token.kind === 'var' && token.name !== undefined) seen.add(token.name);
  }
  return [...seen];
}

export interface ResolveResult {
  /** `input` with every defined `{{var}}` substituted. Undefined variables are left as
   *  their literal `{{name}}` text here too (the caller must check `missing` and refuse to
   *  send rather than trust this field blindly when it is non-empty). */
  value: string;
  /** Every variable name that had no enabled, defined value, in first-seen order. Empty
   *  when every reference resolved. */
  missing: string[];
}

/** `vars` should already be the flattened, enabled-only key/value map for the active
 *  environment (build it once per send, not per field, so the "which variables are enabled
 *  right now" decision is made in one place). */
export function resolveVars(input: string, vars: Record<string, string>): ResolveResult {
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  const value = input.replace(VAR_PATTERN, (whole, rawName: string) => {
    const name = rawName.trim();
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name] as string;
    if (!seenMissing.has(name)) {
      seenMissing.add(name);
      missing.push(name);
    }
    return whole;
  });
  return { value, missing };
}

/** Flattens an environment's variable rows into a plain key/value map, enabled rows only,
 *  last-one-wins on a duplicate key (matching how a real Postman environment behaves). */
export function flattenEnvVars(variables: Array<{ key: string; value: string; enabled: boolean }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables) {
    if (!v.enabled) continue;
    const key = v.key.trim();
    if (key === '') continue;
    out[key] = v.value;
  }
  return out;
}
