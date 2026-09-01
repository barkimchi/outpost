import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';
import { startLiveConnection } from './api/sse.js';
import { useStore } from './state/store.js';

/**
 * The single `EventSource` for the whole app (docs/SPEC.md section 10), started here at
 * module scope, before `ReactDOM.createRoot(...).render(...)`. This makes it immune to
 * React 18 StrictMode's double-invoked effects in dev: a `useEffect` in `App` would run
 * twice on mount and risk opening a second connection, but a top-level call in the entry
 * module runs exactly once regardless of how React later mounts and unmounts components.
 * `api/sse.ts`'s `startLiveConnection` is additionally idempotent as a second line of
 * defense.
 */
startLiveConnection(
  (event) => useStore.getState().handleTrainerEvent(event),
  (status) => useStore.getState().setConnectionStatus(status),
);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
