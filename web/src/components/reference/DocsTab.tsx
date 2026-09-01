/** Placeholder: Task 5 wires this to `GET /_trainer/api/docs` and
 *  `content/docs/*.md` (docs/SPEC.md section 4). Styled consistently with the rest of the
 *  reference panel rather than left blank. */
export function DocsTab(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="font-mono text-[10px] uppercase tracking-widest text-gym-text-faint">Coming soon</span>
      <p className="max-w-xs text-xs leading-relaxed text-gym-text-dim">
        Platform reference docs land here in a later task: GitHub, Google OAuth, Glean, and Slack, wired to{' '}
        <code className="rounded bg-gym-panel3 px-1 py-0.5 font-mono text-[11px] text-gym-accent-soft">GET /_trainer/api/docs</code>.
      </p>
    </div>
  );
}
