import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the shared client to its TypeScript SOURCE rather than through
      // node_modules. The package ships no build step, and Vite's dep pre-bundling does
      // not transpile TS found inside a linked workspace package — it would fail on the
      // first type annotation. Aliasing to source sidesteps resolution entirely and keeps
      // HMR working when the client changes.
      '@neoncore/client': fileURLToPath(new URL('../packages/client/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 4041,
    proxy: {
      '/api': 'http://localhost:4040',
      '/socket.io': {
        target: 'http://localhost:4040',
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
