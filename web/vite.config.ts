import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server proxy target. Reads the same `PORT` env var the server does, so
 * `PORT=4801 npm run dev` retargets both sides instead of the proxy silently pointing at
 * the wrong port. The literal fallback below must match `DEFAULT_PORT` in
 * `server/src/config.ts`; `server/src/config.test.ts` asserts the two stay in sync (see
 * the comment on `DEFAULT_PORT` there for why this file keeps its own literal instead of
 * importing the server's).
 */
const DEFAULT_PORT = '4600';
const TRAINER_TARGET = `http://127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/_trainer': { target: TRAINER_TARGET, changeOrigin: true },
      '/github': { target: TRAINER_TARGET, changeOrigin: true },
      '/google': { target: TRAINER_TARGET, changeOrigin: true },
      '/glean': { target: TRAINER_TARGET, changeOrigin: true },
      '/slack': { target: TRAINER_TARGET, changeOrigin: true },
    },
  },
});
