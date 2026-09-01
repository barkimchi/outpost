import type { FormEvent } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-gym-green',
  POST: 'text-gym-amber',
  PUT: 'text-gym-blue',
  PATCH: 'text-gym-purple',
  DELETE: 'text-gym-red',
  HEAD: 'text-gym-text-dim',
  OPTIONS: 'text-gym-text-dim',
};

const fieldClass =
  'rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 font-mono text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim';

/**
 * Method + URL + headers + body, `Send` posting through `POST /_trainer/api/proxy`
 * (docs/SPEC.md section 10). Auth/Params/Body-type tabs are Task 5's build (spec section
 * 4 assigns `AuthTab.tsx`/`BodyTab.tsx` there); this task's version is a single raw-JSON
 * body plus a header key/value editor, which is enough to solve scenarios 1-7 by hand
 * (every one of them is driven by an Authorization header or a JSON body).
 */
export function RequestBuilder(): React.JSX.Element {
  const request = useStore((s) => s.request);
  const sending = useStore((s) => s.sending);
  const updateRequestDraft = useStore((s) => s.updateRequestDraft);
  const addHeaderRow = useStore((s) => s.addHeaderRow);
  const updateHeaderRow = useStore((s) => s.updateHeaderRow);
  const removeHeaderRow = useStore((s) => s.removeHeaderRow);
  const sendRequest = useStore((s) => s.sendRequest);

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void sendRequest();
  }

  return (
    <div className="flex shrink-0 flex-col border-b border-gym-border bg-gym-panel">
      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-2.5">
        <select
          value={request.method}
          onChange={(e) => updateRequestDraft({ method: e.target.value })}
          className={`shrink-0 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 font-mono text-xs font-bold focus:outline-none focus:ring-1 focus:ring-gym-accent-dim ${METHOD_COLOR[request.method] ?? 'text-gym-text'}`}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="bg-gym-panel2 text-gym-text">
              {m}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={request.url}
          onChange={(e) => updateRequestDraft({ url: e.target.value })}
          placeholder="http://127.0.0.1:4600/github/user"
          spellCheck={false}
          className={`flex-1 ${fieldClass}`}
        />
        <button
          type="submit"
          disabled={sending}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-gym-accent px-3.5 py-1.5 text-xs font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send size={13} />
          {sending ? 'Sending' : 'Send'}
        </button>
      </form>

      <div className="border-t border-gym-border px-2.5 pb-2.5 pt-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Headers</span>
          <button type="button" onClick={addHeaderRow} className="flex items-center gap-1 text-[11px] text-gym-text-dim hover:text-gym-accent-soft">
            <Plus size={12} />
            Add
          </button>
        </div>
        <div className="space-y-1">
          {request.headers.map((h) => (
            <div key={h.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={h.enabled}
                onChange={(e) => updateHeaderRow(h.id, { enabled: e.target.checked })}
                className="h-3.5 w-3.5 shrink-0 accent-gym-accent"
                aria-label="Enable header"
              />
              <input
                type="text"
                value={h.key}
                onChange={(e) => updateHeaderRow(h.id, { key: e.target.value })}
                placeholder="Header"
                spellCheck={false}
                className={`w-40 py-1 text-[11px] ${fieldClass}`}
              />
              <input
                type="text"
                value={h.value}
                onChange={(e) => updateHeaderRow(h.id, { value: e.target.value })}
                placeholder="Value"
                spellCheck={false}
                className={`flex-1 py-1 text-[11px] ${fieldClass}`}
              />
              <button type="button" onClick={() => removeHeaderRow(h.id)} className="shrink-0 text-gym-text-faint hover:text-gym-red" aria-label="Remove header">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-gym-border px-2.5 pb-2.5 pt-2">
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Body</span>
        <CodeMirrorBox
          value={request.body}
          onChange={(body) => updateRequestDraft({ body })}
          language="json"
          className="h-28 overflow-auto rounded-md border border-gym-border bg-gym-panel2"
        />
      </div>
    </div>
  );
}
