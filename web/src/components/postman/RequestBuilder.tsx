import { useState } from 'react';
import type { FormEvent } from 'react';
import { Braces, Plus, Save, Send, Trash2 } from 'lucide-react';
import type { RequestTab } from '../../state/store.js';
import { useActiveVars, useStore } from '../../state/store.js';
import { VarHighlightInput } from '../VarHighlightInput.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';
import { AuthTab } from './AuthTab.js';
import { BodyTab } from './BodyTab.js';
import { CodeExportModal } from './CodeExportModal.js';
import { SaveRequestModal } from './SaveRequestModal.js';
import { parseUrlParams } from '../../lib/urlParams.js';
import { methodColor } from '../../lib/methodColors.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const fieldClass =
  'rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 font-mono text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim';

function ParamsTab(): React.JSX.Element {
  const url = useStore((s) => s.request.url);
  const addParamRow = useStore((s) => s.addParamRow);
  const updateParamRow = useStore((s) => s.updateParamRow);
  const removeParamRow = useStore((s) => s.removeParamRow);
  const vars = useActiveVars();
  const { params } = parseUrlParams(url);

  return (
    <div className="p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Query Params</span>
        <button type="button" onClick={addParamRow} className="flex items-center gap-1 text-[11px] text-gym-text-dim hover:text-gym-accent-soft">
          <Plus size={12} />
          Add
        </button>
      </div>
      {params.length === 0 && <p className="py-3 text-center text-[11px] italic text-gym-text-faint">No query params. Add is above, or type ?key=value in the URL.</p>}
      <div className="space-y-1">
        {params.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={row.enabled}
              onChange={(e) => updateParamRow(i, { enabled: e.target.checked })}
              className="h-3.5 w-3.5 shrink-0 accent-gym-accent"
              aria-label="Enable param"
            />
            <input
              value={row.key}
              onChange={(e) => updateParamRow(i, { key: e.target.value })}
              placeholder="key"
              spellCheck={false}
              className={`w-36 py-1 text-[11px] ${fieldClass}`}
            />
            <div className="flex-1">
              <VarHighlightInput value={row.value} onChange={(value) => updateParamRow(i, { value })} vars={vars} placeholder="value" className="h-7" />
            </div>
            <button type="button" onClick={() => removeParamRow(i)} className="shrink-0 text-gym-text-faint hover:text-gym-red" aria-label="Remove param">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeadersTab(): React.JSX.Element {
  const headers = useStore((s) => s.request.headers);
  const addHeaderRow = useStore((s) => s.addHeaderRow);
  const updateHeaderRow = useStore((s) => s.updateHeaderRow);
  const removeHeaderRow = useStore((s) => s.removeHeaderRow);
  const vars = useActiveVars();

  return (
    <div className="p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Headers</span>
        <button type="button" onClick={addHeaderRow} className="flex items-center gap-1 text-[11px] text-gym-text-dim hover:text-gym-accent-soft">
          <Plus size={12} />
          Add
        </button>
      </div>
      {headers.length === 0 && <p className="py-3 text-center text-[11px] italic text-gym-text-faint">No headers yet.</p>}
      <div className="space-y-1">
        {headers.map((h) => (
          <div key={h.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={h.enabled}
              onChange={(e) => updateHeaderRow(h.id, { enabled: e.target.checked })}
              className="h-3.5 w-3.5 shrink-0 accent-gym-accent"
              aria-label="Enable header"
            />
            <input
              value={h.key}
              onChange={(e) => updateHeaderRow(h.id, { key: e.target.value })}
              placeholder="Header"
              spellCheck={false}
              className={`w-40 py-1 text-[11px] ${fieldClass}`}
            />
            <div className="flex-1">
              <VarHighlightInput value={h.value} onChange={(value) => updateHeaderRow(h.id, { value })} vars={vars} placeholder="Value" className="h-7" />
            </div>
            <button type="button" onClick={() => removeHeaderRow(h.id)} className="shrink-0 text-gym-text-faint hover:text-gym-red" aria-label="Remove header">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Task 9 (spec section 14) fills these in with real execution. This task builds the
 *  persisted text and the tab strip slot only, so Task 9 is an extension, not a rewrite. */
function ScriptPlaceholderTab({ value, onChange, kind }: { value: string; onChange: (v: string) => void; kind: 'preRequest' | 'test' }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col p-3">
      <p className="mb-2 shrink-0 rounded-md border border-gym-border bg-gym-panel2/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-gym-text-faint">
        {kind === 'preRequest'
          ? 'Runs before the request is sent, once the script engine lands. Saved here for now.'
          : 'Runs after the response arrives, once the script engine lands. Saved here for now.'}
      </p>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gym-border bg-gym-panel2">
        <CodeMirrorBox value={value} onChange={onChange} language="none" className="h-full" />
      </div>
    </div>
  );
}

const TABS: Array<{ id: RequestTab; label: string }> = [
  { id: 'params', label: 'Params' },
  { id: 'auth', label: 'Auth' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'prerequest', label: 'Pre-request' },
  { id: 'tests', label: 'Tests' },
];

function TabBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count === 0) return null;
  return <span className="rounded-full bg-gym-panel3 px-1.5 py-0.5 font-mono text-[9px] text-gym-text-faint">{count}</span>;
}

/**
 * Method + URL + Params/Auth/Headers/Body/Pre-request/Tests tabs, `Save` and `</> Code`,
 * and `Send` posting through `POST /_trainer/api/proxy` after `{{var}}` resolution
 * (docs/SPEC.md section 10, section 13).
 */
export function RequestBuilder(): React.JSX.Element {
  const request = useStore((s) => s.request);
  const sending = useStore((s) => s.sending);
  const setMethod = useStore((s) => s.setMethod);
  const setUrl = useStore((s) => s.setUrl);
  const sendRequest = useStore((s) => s.sendRequest);
  const draftLinkedTo = useStore((s) => s.draftLinkedTo);
  const saveCurrentRequest = useStore((s) => s.saveCurrentRequest);
  const activeRequestTab = useStore((s) => s.ui.activeRequestTab);
  const setRequestTab = useStore((s) => s.setRequestTab);
  const setScriptPreRequest = useStore((s) => s.setScriptPreRequest);
  const setScriptTest = useStore((s) => s.setScriptTest);
  const vars = useActiveVars();

  const [codeExportOpen, setCodeExportOpen] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void sendRequest();
  }

  function handleSaveClick(): void {
    if (draftLinkedTo) saveCurrentRequest();
    else setSaveModalOpen(true);
  }

  const { params } = parseUrlParams(request.url);
  const paramCount = params.filter((p) => p.enabled).length;
  const headerCount = request.headers.filter((h) => h.enabled).length;

  return (
    <div className="flex shrink-0 flex-col border-b border-gym-border bg-gym-panel">
      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-2.5">
        <select
          value={request.method}
          onChange={(e) => setMethod(e.target.value)}
          aria-label="HTTP method"
          className={`shrink-0 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 font-mono text-xs font-bold focus:outline-none focus:ring-1 focus:ring-gym-accent-dim ${methodColor(request.method)}`}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="bg-gym-panel2 text-gym-text">
              {m}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          <VarHighlightInput
            value={request.url}
            onChange={setUrl}
            vars={vars}
            placeholder="http://127.0.0.1:4600/github/user"
            ariaLabel="Request URL"
            className="h-8"
          />
        </div>
        <button
          type="button"
          onClick={handleSaveClick}
          title={draftLinkedTo ? 'Save' : 'Save As.'}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 text-xs font-medium text-gym-text-dim hover:border-gym-border-strong hover:text-gym-text"
        >
          <Save size={13} />
          Save
        </button>
        <button
          type="button"
          onClick={() => setCodeExportOpen(true)}
          title="Generate code for this request"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 text-xs font-medium text-gym-text-dim hover:border-gym-border-strong hover:text-gym-text"
        >
          <Braces size={13} />
          Code
        </button>
        <button
          type="submit"
          disabled={sending}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-gym-accent px-3.5 py-1.5 text-xs font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send size={13} />
          {sending ? 'Sending' : 'Send'}
        </button>
      </form>

      <div className="flex items-center gap-0.5 border-t border-gym-border px-2 pt-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setRequestTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              activeRequestTab === t.id ? 'bg-gym-bg text-gym-text' : 'text-gym-text-faint hover:text-gym-text-dim'
            }`}
          >
            {t.label}
            {t.id === 'params' && <TabBadge count={paramCount} />}
            {t.id === 'headers' && <TabBadge count={headerCount} />}
            {t.id === 'auth' && request.auth.type !== 'none' && <span className="h-1.5 w-1.5 rounded-full bg-gym-accent" />}
            {t.id === 'body' && request.bodyMode !== 'none' && <span className="h-1.5 w-1.5 rounded-full bg-gym-accent" />}
          </button>
        ))}
      </div>

      <div className="max-h-[280px] min-h-[160px] overflow-y-auto border-t border-gym-border bg-gym-bg">
        {activeRequestTab === 'params' && <ParamsTab />}
        {activeRequestTab === 'auth' && <AuthTab />}
        {activeRequestTab === 'headers' && <HeadersTab />}
        {activeRequestTab === 'body' && <BodyTab />}
        {activeRequestTab === 'prerequest' && <ScriptPlaceholderTab value={request.scripts.preRequest} onChange={setScriptPreRequest} kind="preRequest" />}
        {activeRequestTab === 'tests' && <ScriptPlaceholderTab value={request.scripts.test} onChange={setScriptTest} kind="test" />}
      </div>

      {codeExportOpen && <CodeExportModal onClose={() => setCodeExportOpen(false)} />}
      {saveModalOpen && <SaveRequestModal onClose={() => setSaveModalOpen(false)} />}
    </div>
  );
}
