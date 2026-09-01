import { useRef } from 'react';
import type { ChangeEvent, UIEvent } from 'react';
import { tokenizeVars } from '../lib/vars.js';

/**
 * A single-line text input that highlights `{{var}}` references in place, the way real
 * Postman colors variable tokens directly in the URL bar (docs/SPEC.md section 13:
 * "`{{var}}` resolution and highlighting in the URL, headers, and body").
 *
 * Technique: two stacked, identically-fonted elements in a `relative` wrapper. The real
 * `<input>` has its text painted transparent (`color: transparent`, a visible
 * `caret-color`) so it stays the actual editable, focusable, selectable element; a
 * non-interactive backdrop `<div>` behind it renders the same text with `{{var}}` spans
 * colored by resolved/unresolved. Horizontal scroll is kept in sync on every input/scroll
 * event: a plain text input scrolls its overflowed content internally, and the backdrop
 * mirrors that offset via `translateX` so the colored text never drifts out from under the
 * real caret.
 */

export interface VarHighlightInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Enabled-only, flattened environment variables (`lib/vars.ts`'s `flattenEnvVars`). A
   *  var token is colored green when its name is a key here, red otherwise: undefined
   *  variables must be visibly flagged before the request is ever sent. */
  vars: Record<string, string>;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  spellCheck?: boolean;
  monospace?: boolean;
}

export function VarHighlightInput({
  value,
  onChange,
  vars,
  placeholder,
  ariaLabel,
  className,
  spellCheck = false,
}: VarHighlightInputProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  function syncScroll(): void {
    if (inputRef.current && backdropRef.current) {
      backdropRef.current.style.transform = `translateX(${-inputRef.current.scrollLeft}px)`;
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    onChange(e.target.value);
    // The DOM has already scrolled to keep the caret visible by the time onChange fires;
    // sync on the same tick rather than waiting for a future scroll event.
    requestAnimationFrame(syncScroll);
  }

  function handleScroll(_e: UIEvent<HTMLInputElement>): void {
    syncScroll();
  }

  const tokens = tokenizeVars(value);
  const sharedFieldClass = 'h-full w-full whitespace-pre px-2.5 py-1.5 font-mono text-xs leading-normal';

  return (
    // The wrapper carries the visible chrome (border, background). Both the backdrop and
    // the input are absolutely positioned to fill it exactly; the input's OWN background
    // must stay transparent, since positioned siblings paint in DOM order and the input
    // comes second; an opaque input background would otherwise paint directly over the
    // colored backdrop text and hide it completely, which is exactly what an earlier
    // version of this component did (both elements had a background, so the top one always
    // won and every {{var}} highlight silently rendered invisible).
    <div className={`relative rounded-md border border-gym-border bg-gym-panel2 focus-within:ring-1 focus-within:ring-gym-accent-dim ${className ?? ''}`}>
      <div ref={backdropRef} aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${sharedFieldClass}`}>
        {value === '' ? (
          <span className="text-gym-text-faint">{placeholder}</span>
        ) : (
          tokens.map((t, i) =>
            t.kind === 'var' ? (
              <span
                key={i}
                className={
                  t.name !== undefined && Object.prototype.hasOwnProperty.call(vars, t.name)
                    ? 'rounded-[3px] bg-gym-accent-dim/70 text-gym-accent-soft'
                    : 'rounded-[3px] bg-gym-red-dim/70 text-gym-red'
                }
              >
                {t.raw}
              </span>
            ) : (
              <span key={i} className="text-gym-text">
                {t.raw}
              </span>
            ),
          )
        )}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onScroll={handleScroll}
        onKeyUp={syncScroll}
        onClick={syncScroll}
        placeholder={placeholder}
        spellCheck={spellCheck}
        aria-label={ariaLabel}
        className={`absolute inset-0 bg-transparent text-transparent caret-gym-text outline-none placeholder:text-transparent ${sharedFieldClass}`}
      />
    </div>
  );
}
