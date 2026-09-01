import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxy target. The server always listens on 4700 unless PORT overrides it;
// this stays 4700 to match the documented default (spec section 2).
const TRAINER_TARGET = 'http://127.0.0.1:4700';

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
