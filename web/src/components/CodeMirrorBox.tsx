import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';

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
  },
  { dark: true },
);

export interface CodeMirrorBoxProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: 'json' | 'none';
  className?: string;
}

export function CodeMirrorBox({ value, onChange, readOnly = false, language = 'none', className }: CodeMirrorBoxProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // (Re)create the view when the host mounts or when readOnly/language changes (rare,
  // e.g. switching Pretty<->Raw between json and plain). Value updates after mount are
  // synced by the effect below, via a targeted dispatch rather than a full rebuild, so
  // an in-progress edit is never clobbered by a re-render.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions: Extension[] = [basicSetup, darkTheme, EditorView.lineWrapping];
    if (language === 'json') extensions.push(json());
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
    // eslint: value intentionally excluded; see the sync effect below.
    // (initial doc content is captured once at construction time)
  }, [readOnly, language]); // eslint-disable-line react-hooks/exhaustive-deps -- see comment above

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={className} />;
}
