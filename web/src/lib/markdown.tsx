import type { ReactNode } from 'react';

/**
 * A small, dependency-free Markdown-to-JSX renderer. Ticket and solution text (spec
 * section 8/9's `ticketMd`/`solutionMd`) only ever uses headings, bold, inline code,
 * unordered lists, indented code blocks, and paragraphs (see the live examples in
 * `.superpowers/sdd/PLAN/task-3-report.md`), so a full CommonMark implementation is more
 * dependency weight than this project needs. Supports: `# / ## / ###` headings, `**bold**`,
 * `` `inline code` ``, `- item` unordered lists, 4-space-indented code blocks, and
 * paragraphs.
 *
 * Fix round: a single `\n` inside a paragraph used to render as a hard `<br/>`. CommonMark
 * treats a single newline as a SOFT break (a space): the ticket source is legitimately
 * hard-wrapped at a terminal-friendly column width for readability in the TypeScript
 * source, and that wrapping is not meant to survive into the rendered page. Joining a
 * paragraph's lines with a single space before inline-parsing lets the text reflow to
 * whatever measure the container actually provides, which is what `TicketTab.tsx`'s
 * `max-w-[68ch]` wrapper depends on to do anything.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${i}`} className="font-semibold text-gym-text">
          {match[2]}
        </strong>,
      );
    } else if (match[4] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c-${i}`} className="rounded bg-gym-panel3 px-1.5 py-0.5 font-mono text-[0.85em] text-gym-accent-soft">
          {match[4]}
        </code>,
      );
    }
    lastIndex = re.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function headingClass(level: number): string {
  if (level === 1) return 'text-lg font-semibold tracking-tight text-gym-text mt-1 mb-2';
  if (level === 2) return 'text-base font-semibold tracking-tight text-gym-text mt-4 mb-2 first:mt-0';
  return 'text-sm font-semibold text-gym-text mt-3 mb-1.5 first:mt-0';
}

export function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  // Trim only whitespace-only lines at each block's edges (a stray blank line the
  // `\n{2,}` split boundary can leave behind) and trailing spaces at the very end, never
  // leading spaces on a block's first content line: a bare `.trim()` here used to strip
  // exactly the 4-space indent an indented code block depends on, so
  // "    HTTP 405 Method Not Allowed" silently lost its own signal before the code-block
  // check below ever ran and rendered as ordinary proportional body text instead of a
  // monospace block.
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.replace(/^[ \t]*\n+/, '').replace(/\s+$/, ''))
    .filter((b) => b !== '');

  return (
    <div className={className}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const first = lines[0] ?? '';
        const headingMatch = /^(#{1,6})\s+(.*)$/.exec(first);

        if (headingMatch && lines.length === 1) {
          const level = Math.min(headingMatch[1]?.length ?? 3, 3);
          const content = headingMatch[2] ?? '';
          const inline = renderInline(content, `h${bi}`);
          if (level === 1) return <h1 key={bi} className={headingClass(1)}>{inline}</h1>;
          if (level === 2) return <h2 key={bi} className={headingClass(2)}>{inline}</h2>;
          return <h3 key={bi} className={headingClass(3)}>{inline}</h3>;
        }

        // A block indented 4+ spaces (or a tab) on every line is a CommonMark indented
        // code block: literal text, no inline parsing, rendered monospace. The ticket
        // source uses this for a pasted log line (a real example: `t1-wrong-method`'s
        // "    HTTP 405 Method Not Allowed").
        const isCodeBlock = lines.every((l) => /^(?: {4}|\t)/.test(l));
        if (isCodeBlock) {
          const code = lines.map((l) => l.replace(/^(?: {4}|\t)/, '')).join('\n');
          return (
            <pre
              key={bi}
              className="my-3 overflow-x-auto rounded-md bg-gym-panel3/60 p-3 font-mono text-xs leading-relaxed text-gym-text-dim"
            >
              <code>{code}</code>
            </pre>
          );
        }

        const isList = lines.every((l) => /^[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={bi} className="my-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-gym-text-dim marker:text-gym-text-faint">
              {lines.map((l, li) => (
                <li key={li} className="text-gym-text-dim">
                  {renderInline(l.replace(/^[-*]\s+/, ''), `l${bi}-${li}`)}
                </li>
              ))}
            </ul>
          );
        }

        // Soft break (CommonMark): a single newline inside a paragraph is a space, not a
        // line break. Joining before inline-parsing lets the paragraph reflow to the
        // container's actual measure instead of freezing at wherever the source's own
        // hard-wrap column happened to land.
        return (
          <p key={bi} className="my-2 text-sm leading-relaxed text-gym-text-dim first:mt-0 last:mb-0">
            {renderInline(lines.join(' '), `p${bi}`)}
          </p>
        );
      })}
    </div>
  );
}
