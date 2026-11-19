import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

// The release number shown at the foot of the view bar — read from the ROOT package.json so the
// label and the package version can never disagree.
const APP_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
