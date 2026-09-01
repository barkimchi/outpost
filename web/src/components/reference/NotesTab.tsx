import { useStore } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';

/** A free-form notes editor (docs/SPEC.md section 13), persisted in `workspace.json` via
 *  `state/store.ts`'s `setNotes` (debounced `PUT /_trainer/api/workspace`, the same path
 *  every other workspace field saves through). Plain text/Markdown source, not rendered:
 *  this is scratch space for the learner's own working notes, not another ticket display. */
export function NotesTab(): React.JSX.Element {
  const notes = useStore((s) => s.notes);
  const setNotes = useStore((s) => s.setNotes);

  return (
    <div className="h-full p-3">
      <CodeMirrorBox
        value={notes}
        onChange={setNotes}
        language="none"
        className="h-full overflow-auto rounded-md border border-gym-border bg-gym-panel2"
      />
    </div>
  );
}
