import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
});
