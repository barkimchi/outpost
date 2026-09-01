import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { CodeExportLanguage } from '../../lib/codeExport.js';
import { generateCode } from '../../lib/codeExport.js';
import type { ResolvedRequest } from '../../lib/buildRequest.js';
import { useStore } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';
import { Modal } from '../Modal.js';

/**
 * `</> Code` export (docs/SPEC.md section 13): cURL, Python `requests`, Node `axios`.
 *
 * Fix round (coordinator review, finding 5): this used to call `buildResolvedRequest`
 * directly, which skips the Pre-request script entirely. A script doing
 * `pm.environment.set("sig", ...)` made Send genuinely resolve and send the real header
 * while this modal either refused with "Undefined variable: {{sig}}" (nothing had set it
 * yet in this view's eyes) or showed whatever the PREVIOUS send happened to leave in the
 * environment: two different requests behind one claimed-identical export. Task 5
 * centralized `{{var}}` resolution into `buildResolvedRequest` specifically so Send and
 * this export could never diverge; the fix is to run through `state/store.ts`'s
 * `resolveRequestForExport`, which calls the exact same `runPreRequestScript` helper
 * `sendRequest` calls, so there is only one place a Pre-request script ever runs and both
 * callers reach it the same way. That makes this async (running a script can take up to
 * 2000ms), where the old version was a synchronous render-time computation.
 */

const LANGUAGES: Array<{ id: CodeExportLanguage; label: string }> = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'node', label: 'Node (axios)' },
];

export function CodeExportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const resolveRequestForExport = useStore((s) => s.resolveRequestForExport);
  const [language, setLanguage] = useState<CodeExportLanguage>('curl');
  const [copied, setCopied] = useState(false);
  const [resolving, setResolving] = useState(true);
  const [resolved, setResolved] = useState<ResolvedRequest | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);

  // Runs once per modal open, not on every render: a Pre-request script that mutates the
  // environment (or simply takes noticeable time) should not silently re-run on an
  // unrelated re-render, e.g. a language tab switch.
  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    void resolveRequestForExport().then((result) => {
      if (cancelled) return;
      setResolved(result.resolved);
      setScriptError(result.scriptError);
      setResolving(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only, see comment above.
  }, []);

  const hasMissing = (resolved?.missing.length ?? 0) > 0;
  const code = resolved && !hasMissing ? generateCode(language, resolved) : '';

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission can be denied; the code is still visible and selectable.
    }
  }

  return (
    <Modal title="Code" onClose={onClose} widthClassName="max-w-2xl">
      <div className="flex h-[440px] flex-col">
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <div className="flex gap-1">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLanguage(l.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  language === l.id ? 'bg-gym-panel3 text-gym-text' : 'text-gym-text-faint hover:text-gym-text-dim'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          {!resolving && !hasMissing && (
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex items-center gap-1.5 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1 text-xs text-gym-text-dim hover:border-gym-border-strong hover:text-gym-text"
            >
              {copied ? <Check size={12} className="text-gym-green" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>

        {scriptError && (
          <p className="mb-3 shrink-0 rounded-md border border-gym-red-dim bg-gym-red-dim/15 px-3 py-2 text-xs leading-relaxed text-gym-red">
            <span className="font-semibold">Pre-request script error.</span> {scriptError} The code below reflects the request as
            far as resolution got.
          </p>
        )}

        {resolving ? (
          <div className="flex flex-1 items-center justify-center text-xs text-gym-text-faint">
            Running the Pre-request script.
          </div>
        ) : hasMissing && resolved ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-gym-amber-dim bg-gym-amber-dim/15 px-6 text-center">
            <p className="text-xs font-semibold text-gym-amber">
              Undefined variable{resolved.missing.length > 1 ? 's' : ''}: {resolved.missing.map((n) => `{{${n}}}`).join(', ')}
            </p>
            <p className="max-w-sm text-xs leading-relaxed text-gym-text-dim">
              Set {resolved.missing.length > 1 ? 'these' : 'it'} in the active environment before exporting: the
              generated code must show the real value that would be sent, never the literal template text.
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gym-border bg-gym-panel2">
            <CodeMirrorBox value={code} readOnly language="none" className="h-full" />
          </div>
        )}
      </div>
    </Modal>
  );
}
