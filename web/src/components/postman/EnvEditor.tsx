import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store.js';
import { Modal } from '../Modal.js';

/**
 * Environment management (docs/SPEC.md section 13: "environments holding a baseUrl and a
 * token"): create/rename/delete environments, and edit one environment's `{{var}}` table.
 * Opened from the Sidebar's gear icon next to the environment selector.
 */

const fieldClass =
  'rounded-md border border-gym-border bg-gym-panel2 px-2 py-1 font-mono text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim';

export function EnvEditor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const environments = useStore((s) => s.environments);
  const activeEnvironmentId = useStore((s) => s.activeEnvironmentId);
  const createEnvironment = useStore((s) => s.createEnvironment);
  const renameEnvironment = useStore((s) => s.renameEnvironment);
  const deleteEnvironment = useStore((s) => s.deleteEnvironment);
  const setActiveEnvironment = useStore((s) => s.setActiveEnvironment);
  const addEnvVariable = useStore((s) => s.addEnvVariable);
  const updateEnvVariable = useStore((s) => s.updateEnvVariable);
  const removeEnvVariable = useStore((s) => s.removeEnvVariable);

  const [selectedId, setSelectedId] = useState<string | null>(activeEnvironmentId ?? environments[0]?.id ?? null);
  const selected = environments.find((e) => e.id === selectedId) ?? null;

  function handleCreate(): void {
    createEnvironment();
    // The store assigns a fresh id; select whichever environment is newest after the call.
    setTimeout(() => {
      const latest = useStore.getState().environments;
      const created = latest[latest.length - 1];
      if (created) setSelectedId(created.id);
    }, 0);
  }

  return (
    <Modal title="Environments" onClose={onClose} widthClassName="max-w-2xl">
      <div className="flex h-[420px] gap-4">
        <div className="flex w-48 shrink-0 flex-col border-r border-gym-border pr-3">
          <button
            type="button"
            onClick={handleCreate}
            className="mb-2 flex items-center justify-center gap-1 rounded-md border border-dashed border-gym-border py-1.5 text-xs text-gym-text-dim hover:border-gym-accent-dim hover:text-gym-accent-soft"
          >
            <Plus size={12} />
            New environment
          </button>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {environments.length === 0 && <p className="px-1 py-3 text-[11px] italic text-gym-text-faint">No environments yet.</p>}
            {environments.map((env) => (
              <button
                key={env.id}
                type="button"
                onClick={() => setSelectedId(env.id)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  selectedId === env.id ? 'bg-gym-panel3 text-gym-text' : 'text-gym-text-dim hover:bg-gym-panel2'
                }`}
              >
                {env.id === activeEnvironmentId && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gym-green" title="Active" />}
                <span className="min-w-0 flex-1 truncate">{env.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center text-center text-xs text-gym-text-faint">
              Select or create an environment.
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={selected.name}
                  onChange={(e) => renameEnvironment(selected.id, e.target.value)}
                  aria-label="Environment name"
                  className={`flex-1 py-1.5 text-sm font-semibold ${fieldClass}`}
                />
                {selected.id !== activeEnvironmentId && (
                  <button
                    type="button"
                    onClick={() => setActiveEnvironment(selected.id)}
                    className="shrink-0 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 text-xs text-gym-text-dim hover:border-gym-accent-dim hover:text-gym-accent-soft"
                  >
                    Set active
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete environment "${selected.name}"? This cannot be undone.`)) {
                      deleteEnvironment(selected.id);
                      setSelectedId(null);
                    }
                  }}
                  className="shrink-0 rounded-md p-1.5 text-gym-text-faint hover:text-gym-red"
                  aria-label="Delete environment"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Variables</span>
                <button
                  type="button"
                  onClick={() => addEnvVariable(selected.id)}
                  className="flex items-center gap-1 text-[11px] text-gym-text-dim hover:text-gym-accent-soft"
                >
                  <Plus size={12} />
                  Add
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {selected.variables.length === 0 && (
                  <p className="py-3 text-center text-[11px] italic text-gym-text-faint">
                    No variables yet. Try <code className="text-gym-accent-soft">baseUrl</code> and{' '}
                    <code className="text-gym-accent-soft">token</code>.
                  </p>
                )}
                {selected.variables.map((v) => (
                  <div key={v.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={v.enabled}
                      onChange={(e) => updateEnvVariable(selected.id, v.id, { enabled: e.target.checked })}
                      className="h-3.5 w-3.5 shrink-0 accent-gym-accent"
                      aria-label="Enable variable"
                    />
                    <input
                      value={v.key}
                      onChange={(e) => updateEnvVariable(selected.id, v.id, { key: e.target.value })}
                      placeholder="key"
                      spellCheck={false}
                      className={`w-32 py-1 text-[11px] ${fieldClass}`}
                    />
                    <input
                      value={v.value}
                      onChange={(e) => updateEnvVariable(selected.id, v.id, { value: e.target.value })}
                      placeholder="value"
                      spellCheck={false}
                      className={`flex-1 py-1 text-[11px] ${fieldClass}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvVariable(selected.id, v.id)}
                      className="shrink-0 text-gym-text-faint hover:text-gym-red"
                      aria-label="Remove variable"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
