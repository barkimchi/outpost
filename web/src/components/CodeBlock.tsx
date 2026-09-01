import type { ReactNode } from 'react';
import { tryPrettyJson } from '../lib/format.js';

/**
 * A lightweight, dependency-free JSON/text preview block. Used inside expandable Logs
 * tab rows, where a real CodeMirror instance per row would be wasteful (potentially
 * dozens on screen at once); the main request/response body editors use real CodeMirror
 * instead (see `CodeMirrorBox.tsx`), per the brief's "CodeMirror for bodies".
 */

function highlightJson(text: string): ReactNode[] {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      const isKey = match[2] !== undefined;
      out.push(
        <span key={i++} className={isKey ? 'text-gym-blue' : 'text-gym-green'}>
          {match[1]}
        </span>,
      );
      if (match[2]) out.push(match[2]);
    } else if (match[3] !== undefined) {
      out.push(
        <span key={i++} className="text-gym-purple">
          {match[3]}
        </span>,
      );
    } else if (match[4] !== undefined) {
      out.push(
        <span key={i++} className="text-gym-accent-soft">
          {match[4]}
        </span>,
      );
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

export function CodeBlock({ text, mode = 'auto' }: { text: string; mode?: 'json' | 'text' | 'auto' }): React.JSX.Element {
  if (text === '') {
    return <p className="rounded-md bg-gym-panel3/50 p-3 font-mono text-xs italic text-gym-text-faint">(empty body)</p>;
  }
  const { pretty, isJson } = mode === 'text' ? { pretty: text, isJson: false } : tryPrettyJson(text);
  const highlight = mode === 'json' || (mode === 'auto' && isJson);
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-gym-panel3/50 p-3 font-mono text-xs leading-relaxed text-gym-text-dim">
      {highlight ? highlightJson(pretty) : pretty}
    </pre>
  );
}
