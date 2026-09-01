import { Plus, Trash2 } from 'lucide-react';
import type { BodyMode } from '@gym/shared';
import { useActiveVars, useStore } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';

/** The Body tab (docs/SPEC.md section 13): none, raw JSON, form-urlencoded. */

const MODES: Array<{ id: BodyMode; label: string }> = [
  { id: 'none', label: 'none' },
  { id: 'raw-json', label: 'raw (JSON)' },
  { id: 'form-urlencoded', label: 'x-www-form-urlencoded' },
];

export function BodyTab(): React.JSX.Element {
  const bodyMode = useStore((s) => s.request.bodyMode);
  const setBodyMode = useStore((s) => s.setBodyMode);
  const rawBody = useStore((s) => s.request.rawBody);
  const setRawBody = useStore((s) => s.setRawBody);
  const formBody = useStore((s) => s.request.formBody);
  const addFormRow = useStore((s) => s.addFormRow);
  const updateFormRow = useStore((s) => s.updateFormRow);
  const removeFormRow = useStore((s) => s.removeFormRow);
  const vars = useActiveVars();

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-gym-border px-3 py-2">
        {MODES.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-gym-text-dim">
            <input
              type="radio"
              name="body-mode"
              checked={bodyMode === m.id}
              onChange={() => setBodyMode(m.id)}
              className="accent-gym-accent"
            />
            {m.label}
          </label>
        ))}
      </div>

      {bodyMode === 'none' && (
        <div className="flex flex-1 items-center justify-center text-xs text-gym-text-faint">This request has no body.</div>
      )}

      {bodyMode === 'raw-json' && (
        <div className="min-h-0 flex-1 p-3">
          <CodeMirrorBox
            value={rawBody}
            onChange={setRawBody}
            language="json"
            vars={vars}
            className="h-full overflow-auto rounded-md border border-gym-border bg-gym-panel2"
          />
        </div>
      )}

      {bodyMode === 'form-urlencoded' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Form fields</span>
            <button type="button" onClick={addFormRow} className="flex items-center gap-1 text-[11px] text-gym-text-dim hover:text-gym-accent-soft">
              <Plus size={12} />
              Add
            </button>
          </div>
          <div className="space-y-1">
            {formBody.map((row) => (
              <div key={row.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => updateFormRow(row.id, { enabled: e.target.checked })}
                  className="h-3.5 w-3.5 shrink-0 accent-gym-accent"
                  aria-label="Enable field"
                />
                <input
                  value={row.key}
                  onChange={(e) => updateFormRow(row.id, { key: e.target.value })}
                  placeholder="key"
                  spellCheck={false}
                  className="w-40 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1 font-mono text-[11px] text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
                />
                <input
                  value={row.value}
                  onChange={(e) => updateFormRow(row.id, { value: e.target.value })}
                  placeholder="value"
                  spellCheck={false}
                  className="flex-1 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1 font-mono text-[11px] text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
                />
                <button type="button" onClick={() => removeFormRow(row.id)} className="shrink-0 text-gym-text-faint hover:text-gym-red" aria-label="Remove field">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
