import { Check, RotateCcw, Video } from 'lucide-react';
import { useStore } from '../state/store.js';
import { ScenarioPicker } from './ScenarioPicker.js';
import { HintButton } from './HintButton.js';
import { DrillMenu } from './DrillMenu.js';

/**
 * The 48px top bar (docs/SPEC.md section 13): wordmark, scenario picker with solved
 * checkmarks, step chips, attempt counter, Hint / Reset / Drill, the Demo mode toggle,
 * and a live SSE connection indicator (this app's whole premise is that traffic never
 * routed through the browser still moves this bar, so showing the reader the stream is
 * actually connected earns its pixel).
 */

function StepChips(): React.JSX.Element | null {
  const scenario = useStore((s) => s.scenario);
  if (scenario.state === 'idle' || scenario.stepCount === 0) return null;

  const chips =
    scenario.steps.length > 0
      ? scenario.steps
      : Array.from({ length: scenario.stepCount }, (_, i) => ({
          id: `anon-${i}`,
          title: undefined as string | undefined,
          done: i < scenario.currentStepIndex,
        }));

  return (
    <div className="flex items-center gap-1">
      {chips.map((chip, i) => {
        const isCurrent = scenario.state === 'active' && i === scenario.currentStepIndex;
        // Drill mode (docs/SPEC.md section 9): "only ticketMd and step count are
        // exposed." A step's title is exactly the kind of fault identity that's supposed
        // to stay hidden, and it is the identity leaking one hover at a time if this
        // tooltip ever shows it, so it is forced back to the anonymous "Step N" form here
        // regardless of what the chip happens to carry.
        const title = scenario.drill ? `Step ${i + 1}` : (chip.title ?? `Step ${i + 1}`);
        return (
          <span
            key={chip.id}
            title={title}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold transition-colors ${
              chip.done
                ? 'bg-gym-green-dim text-gym-green'
                : isCurrent
                  ? 'border border-gym-accent text-gym-accent-soft'
                  : 'border border-gym-border text-gym-text-faint'
            }`}
          >
            {chip.done ? <Check size={11} strokeWidth={3} /> : i + 1}
          </span>
        );
      })}
    </div>
  );
}

function AttemptCounter(): React.JSX.Element | null {
  const scenario = useStore((s) => s.scenario);
  if (scenario.state === 'idle' || scenario.stepCount === 0) return null;
  return (
    <span className="rounded-md bg-gym-panel2 px-2 py-1 font-mono text-[11px] text-gym-text-dim">
      {scenario.attempts} {scenario.attempts === 1 ? 'attempt' : 'attempts'}
    </span>
  );
}

function ResetButton(): React.JSX.Element {
  const scenario = useStore((s) => s.scenario);
  const resetScenario = useStore((s) => s.resetScenario);
  const disabled = scenario.state === 'idle';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void resetScenario()}
      title="Re-activate this scenario with a fresh seed"
      className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        disabled
          ? 'cursor-not-allowed border-gym-border text-gym-text-faint'
          : 'border-gym-border bg-gym-panel2 text-gym-text hover:border-gym-border-strong hover:bg-gym-panel3'
      }`}
    >
      <RotateCcw size={13} />
      Reset
    </button>
  );
}

function DemoToggle(): React.JSX.Element {
  const demoMode = useStore((s) => s.ui.demoMode);
  const toggleDemoMode = useStore((s) => s.toggleDemoMode);
  return (
    <button
      type="button"
      onClick={toggleDemoMode}
      title="Demo mode: collapse the Postman column (Cmd+\\)"
      aria-pressed={demoMode}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        demoMode
          ? 'border-gym-accent-dim bg-gym-accent-dim text-gym-accent-soft'
          : 'border-gym-border bg-gym-panel2 text-gym-text-dim hover:text-gym-text'
      }`}
    >
      <Video size={13} />
      Demo
    </button>
  );
}

function ConnectionIndicator(): React.JSX.Element {
  const status = useStore((s) => s.connectionStatus);
  const dot = status === 'open' ? 'bg-gym-green' : status === 'connecting' ? 'bg-gym-amber animate-pulse' : 'bg-gym-red';
  const label = status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Disconnected';
  return (
    <span className="hidden items-center gap-1.5 font-mono text-[10px] text-gym-text-faint sm:flex" title={`SSE stream: ${label}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function ExerciseBar(): React.JSX.Element {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-b border-gym-border bg-gym-panel px-3 shadow-panel">
      <div className="flex shrink-0 items-center gap-1.5 pr-1">
        <span className="h-2 w-2 rounded-full bg-gym-accent" />
        <span className="font-mono text-[11px] font-semibold tracking-[0.14em] text-gym-text-dim">OUTPOST</span>
      </div>
      <div className="h-5 w-px shrink-0 bg-gym-border" />
      <ScenarioPicker />
      <StepChips />
      <AttemptCounter />
      <div className="flex-1" />
      <HintButton />
      <ResetButton />
      <DrillMenu />
      <div className="h-5 w-px shrink-0 bg-gym-border" />
      <DemoToggle />
      <ConnectionIndicator />
    </header>
  );
}
