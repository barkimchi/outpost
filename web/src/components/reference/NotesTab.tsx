/** Placeholder: Task 5 wires this to a CodeMirror editor persisted in `workspace.json`
 *  (docs/SPEC.md section 4). Styled consistently with the rest of the reference panel. */
export function NotesTab(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="font-mono text-[10px] uppercase tracking-widest text-gym-text-faint">Coming soon</span>
      <p className="max-w-xs text-xs leading-relaxed text-gym-text-dim">
        A CodeMirror notes editor, persisted per workspace, lands here in a later task.
      </p>
    </div>
  );
}
