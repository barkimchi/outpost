import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';

/**
 * The one CodeMirror 6 wrapper used for the request body editor and the response panel's
 * Pretty/Raw views (the brief's "CodeMirror for bodies"). A bespoke dark theme instead of
 * an imported one, matching this app's own palette (`tailwind.config.js`'s `gym-*`
 * tokens) rather than a generic editor look.
 */

const darkTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: '#e6e9f0',
      fontSize: '12.5px',
      height: '100%',
    },
    '.cm-content': {
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      caretColor: '#e0a12e',
      padding: '10px 12px',
    },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#5c6478',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(224,161,46,0.22) !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(224,161,46,0.28) !important' },
    '.cm-cursor': { borderLeftColor: '#e0a12e' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(224,161,46,0.2)', outline: 'none' },
    '.cm-foldGutter, .cm-lineNumbers': { color: '#5c6478' },
    // {{var}} highlighting (docs/SPEC.md section 13: "highlighting in the URL, headers,
    // and body"). Same resolved/unresolved color convention as `VarHighlightInput.tsx`'s
    // URL-bar overlay: accent for a variable the active environment defines, red for one
    // that would silently send its own literal `{{name}}` text if sent as-is.
    '.cm-var-resolved': { backgroundColor: 'rgba(74,58,28,0.7)', color: '#f2c46b', borderRadius: '3px' },
    '.cm-var-missing': { backgroundColor: 'rgba(74,34,38,0.7)', color: '#f0616a', borderRadius: '3px' },
  },
  { dark: true },
);

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function buildVarDecorations(view: EditorView, vars: Record<string, string>): DecorationSet {
  const text = view.state.doc.toString();
  const ranges: Array<{ from: number; to: number; resolved: boolean }> = [];
  VAR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAR_PATTERN.exec(text)) !== null) {
    const name = (match[1] ?? '').trim();
    ranges.push({ from: match.index, to: match.index + match[0].length, resolved: Object.prototype.hasOwnProperty.call(vars, name) });
  }
  return Decoration.set(
    ranges.map((r) => Decoration.mark({ class: r.resolved ? 'cm-var-resolved' : 'cm-var-missing' }).range(r.from, r.to)),
  );
}

/** A CodeMirror extension that decorates every `{{var}}` span in the document, colored by
 *  whether `vars` (the active environment's flattened, enabled-only key/value map) defines
 *  it. Rebuilt on every doc change; request bodies here are small enough that a full rescan
 *  per edit is not a performance concern. */
function varHighlightExtension(vars: Record<string, string>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildVarDecorations(view, vars);
      }
      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = buildVarDecorations(update.view, vars);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export interface CodeMirrorBoxProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: 'json' | 'javascript' | 'none';
  className?: string;
  /** Enabled-only flattened environment variables (`lib/vars.ts`'s `flattenEnvVars`). When
   *  provided, every `{{var}}` span in the document is highlighted, resolved vs missing.
   *  Reconfigured in place via a `Compartment` when this changes (e.g. switching the active
   *  environment), so it never resets the editor's undo history or cursor position the way
   *  a full remount would. */
  vars?: Record<string, string>;
}

export function CodeMirrorBox({ value, onChange, readOnly = false, language = 'none', className, vars }: CodeMirrorBoxProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const varCompartmentRef = useRef<Compartment>(new Compartment());

  // (Re)create the view when the host mounts or when readOnly/language changes (rare,
  // e.g. switching Pretty<->Raw between json and plain). Value updates after mount are
  // synced by the effect below, via a targeted dispatch rather than a full rebuild, so
  // an in-progress edit is never clobbered by a re-render.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const varCompartment = varCompartmentRef.current;
    const extensions: Extension[] = [basicSetup, darkTheme, EditorView.lineWrapping, varCompartment.of(vars ? varHighlightExtension(vars) : [])];
    if (language === 'json') extensions.push(json());
    if (language === 'javascript') extensions.push(javascript());
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    } else {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
      );
    }
    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint: value intentionally excluded; see the sync effect below. `vars`'s initial
    // value is captured here; subsequent changes are applied by the effect below via the
    // compartment, without forcing this whole effect to rerun.
  }, [readOnly, language]); // eslint-disable-line react-hooks/exhaustive-deps -- see comment above

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: varCompartmentRef.current.reconfigure(vars ? varHighlightExtension(vars) : []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `vars` identity changes every
    // resolution pass; reconfiguring on reference change (not deep-equality) is intended.
  }, [vars]);

  return <div ref={hostRef} className={className} />;
}
