import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { CodeExportLanguage } from '../../lib/codeExport.js';
import { generateCode } from '../../lib/codeExport.js';
import { buildResolvedRequest } from '../../lib/buildRequest.js';
import { useActiveVars, useStore } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';
import { Modal } from '../Modal.js';

/**
 * `</> Code` export (docs/SPEC.md section 13): cURL, Python `requests`, Node `axios`. Uses
 * the exact same `buildResolvedRequest` the Send button uses, so this is never decorative:
 * what it shows is byte-for-byte what Send would actually put on the wire (this task's
 * dispatch: verified by piping the generated cURL into a shell and getting the same
 * status Send got).
 */

const LANGUAGES: Array<{ id: CodeExportLanguage; label: string }> = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'node', label: 'Node (axios)' },
];

export function CodeExportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const request = useStore((s) => s.request);
  const vars = useActiveVars();
  const [language, setLanguage] = useState<CodeExportLanguage>('curl');
  const [copied, setCopied] = useState(false);

  const resolved = buildResolvedRequest(request, vars);
  const hasMissing = resolved.missing.length > 0;
  const code = hasMissing ? '' : generateCode(language, resolved);

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
          {!hasMissing && (
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

        {hasMissing ? (
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
