import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * A standalone config (not merged with `vite.config.ts`, which carries dev-only proxy
 * settings tests do not need). `tsx --test` (the root `npm test` runner for
 * `{shared,server}/src`) cannot execute a real DOM or a Web Worker (Task 9's script
 * engine is web-side), which is why `web/` gets Vitest instead: see the root
 * `package.json` test script and this task's report.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // `@testing-library/react` registers its own automatic post-test `cleanup()` (unmounts
    // every render, empties `document.body`) ONLY when it detects a real global `afterEach`
    // on `globalThis`; every test file here already imports `describe`/`it`/`expect`/etc.
    // from 'vitest' explicitly (those local imports keep working unchanged, `globals` just
    // ALSO exposes them on `globalThis`), so this is additive, not a migration. Without it,
    // component tests silently accumulate DOM across renders within a file, which is
    // exactly the kind of cross-test collision this build has already burned a full
    // investigation on once (an intermittent failure that looked like an app bug, turned
    // out to be tests colliding on ephemeral ports).
    globals: true,
  },
});
