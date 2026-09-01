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
  },
});
