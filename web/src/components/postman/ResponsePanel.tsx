import { useStore } from '../../state/store.js';
import type { ResponseViewMode } from '../../state/store.js';
import { CodeMirrorBox } from '../CodeMirrorBox.js';
import { formatBytes, formatMs, statusBand, statusText, tryPrettyJson } from '../../lib/format.js';
import { STATUS_BAND_CLASSES } from '../../lib/statusColors.js';

const TABS: Array<{ id: ResponseViewMode; label: string }> = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'headers', label: 'Headers' },
  { id: 'test-results', label: 'Test Results' },
  { id: 'console', label: 'Console' },
];

/** Test Results tab (docs/SPEC.md section 14): one row per `pm.test(name, fn)` call from
 *  the request's Tests script, green check for a pass, red cross plus the assertion
 *  message for a fail. A script-level failure (a syntax error, or a throw outside any
 *  `pm.test`) is represented the same way, as its own named row (`state/store.ts`'s
 *  `sendRequest` pushes "Pre-request script"/"Tests script" rows for that), so a broken
 *  script is always visible here and never silently swallowed. */
function TestResultsView(): React.JSX.Element {
  const testResults = useStore((s) => s.testResults);

  if (testResults.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-widest text-gym-text-faint">No tests ran</span>
        <p className="max-w-xs text-xs leading-relaxed text-gym-text-dim">
          Write a pm.test(...) call in the Tests tab, then Send. Pass/fail rows land here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {testResults.map((t, i) => (
        <div
          key={`${t.name}-${i}`}
          className={`rounded-md border px-2.5 py-1.5 text-xs ${
            t.passed ? 'border-gym-green-dim bg-gym-green-dim/20' : 'border-gym-red-dim bg-gym-red-dim/20'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`font-mono text-[10px] font-bold ${t.passed ? 'text-gym-green' : 'text-gym-red'}`}>{t.passed ? 'PASS' : 'FAIL'}</span>
            <span className="text-gym-text">{t.name}</span>
          </div>
          {t.error && <p className="mt-1 font-mono text-[11px] text-gym-red">{t.error}</p>}
        </div>
      ))}
    </div>
  );
}

/** Console tab (docs/SPEC.md section 14): combined `console.log`/`.warn`/`.error`/`.info`
 *  output from both scripts on the most recent send, in call order (Pre-request's lines
 *  first, then Tests'). */
function ConsoleView(): React.JSX.Element {
  const consoleLines = useStore((s) => s.consoleLines);

  if (consoleLines.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-widest text-gym-text-faint">Nothing logged</span>
        <p className="max-w-xs text-xs leading-relaxed text-gym-text-dim">console.log(...) output from Pre-request and Tests scripts lands here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 font-mono text-xs text-gym-text-dim">
      {consoleLines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all border-b border-gym-border/40 pb-1 last:border-0">
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * Attempt feedback (docs/SPEC.md hard constraint 9: "Attempt feedback always says why it
 * didn't count"). `reason` is the mechanical why, always shown when present; `attemptHint`
 * is the scenario author's human nudge, shown alongside it when present, per the
 * coordinator's mid-task note. Falls back to the state-hydration-only `scenario.attemptHint`
 * (no paired reason) after a page reload, before any live SSE attempt has arrived.
 */
function AttemptFeedback(): React.JSX.Element | null {
  const scenario = useStore((s) => s.scenario);
  const reason = scenario.lastAttempt?.reason;
  const hint = scenario.lastAttempt?.attemptHint ?? scenario.attemptHint;
  if (!reason && !hint) return null;
  return (
    <div className="mx-3 mt-3 rounded-md border border-gym-amber-dim bg-gym-amber-dim/30 px-3 py-2">
      {reason && (
        <p className="text-xs text-gym-amber">
          <span className="font-semibold">Did not count.</span> {reason}
        </p>
      )}
      {hint && (
        <p className={`text-xs text-gym-text-dim ${reason ? 'mt-1' : ''}`}>
          <span className="font-semibold text-gym-text">Nudge.</span> {hint}
        </p>
      )}
    </div>
  );
}

/** Postman-style count badge on the Test Results tab: `passed/total`, colored green when
 *  everything passed and red when at least one row failed. Hidden until at least one test
 *  has run, matching the Params/Headers tab badges' own "hidden at zero" convention. */
function TestResultsBadge(): React.JSX.Element | null {
  const testResults = useStore((s) => s.testResults);
  if (testResults.length === 0) return null;
  const passed = testResults.filter((t) => t.passed).length;
  const allPassed = passed === testResults.length;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
        allPassed ? 'bg-gym-green-dim text-gym-green' : 'bg-gym-red-dim text-gym-red'
      }`}
    >
      {passed}/{testResults.length}
    </span>
  );
}

function ConsoleBadge(): React.JSX.Element | null {
  const count = useStore((s) => s.consoleLines.length);
  if (count === 0) return null;
  return <span className="rounded-full bg-gym-panel3 px-1.5 py-0.5 font-mono text-[9px] text-gym-text-faint">{count}</span>;
}

function ResponseTabs(): React.JSX.Element {
  const mode = useStore((s) => s.ui.responseViewMode);
  const setResponseViewMode = useStore((s) => s.setResponseViewMode);
  return (
    <div className="flex gap-1 border-b border-gym-border px-3 pt-2">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setResponseViewMode(t.id)}
          className={`flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === t.id ? 'bg-gym-panel2 text-gym-text' : 'text-gym-text-faint hover:text-gym-text-dim'
          }`}
        >
          {t.label}
          {t.id === 'test-results' && <TestResultsBadge />}
          {t.id === 'console' && <ConsoleBadge />}
        </button>
      ))}
    </div>
  );
}

export function ResponsePanel(): React.JSX.Element {
  const response = useStore((s) => s.response);
  const sending = useStore((s) => s.sending);
  const mode = useStore((s) => s.ui.responseViewMode);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AttemptFeedback />

      {!response && !sending && (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-gym-text-faint">
          Send a request to see the response here.
        </div>
      )}
      {sending && <div className="flex flex-1 items-center justify-center text-xs text-gym-text-faint">Sending.</div>}

      {response && response.kind === 'error' && (
        <div className="m-3 rounded-md border border-gym-red-dim bg-gym-red-dim/30 px-3 py-2 text-xs text-gym-red">{response.message}</div>
      )}

      {response && response.kind === 'success' && (
        <>
          <div className="flex shrink-0 items-center gap-3 px-3 pt-3">
            <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold ${STATUS_BAND_CLASSES[statusBand(response.status)]}`}>
              {response.status} {statusText(response.status)}
            </span>
            <span className="font-mono text-xs text-gym-text-dim">{formatMs(response.timeMs)}</span>
            <span className="font-mono text-xs text-gym-text-dim">{formatBytes(response.sizeBytes)}</span>
          </div>
          <ResponseTabs />
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {mode === 'headers' ? (
              <table className="w-full border-collapse text-left text-xs">
                <tbody>
                  {Object.entries(response.headers).map(([key, value]) => (
                    <tr key={key} className="border-b border-gym-border/60 last:border-0">
                      <td className="w-48 py-1.5 pr-4 align-top font-mono text-gym-text-dim">{key}</td>
                      <td className="break-all py-1.5 font-mono text-gym-text">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : mode === 'test-results' ? (
              <TestResultsView />
            ) : mode === 'console' ? (
              <ConsoleView />
            ) : (
              <CodeMirrorBox
                value={mode === 'pretty' ? tryPrettyJson(response.body).pretty : response.body}
                readOnly
                language={mode === 'pretty' && tryPrettyJson(response.body).isJson ? 'json' : 'none'}
                className="h-full"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
