import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'web/index.html'),
        login: resolve(import.meta.dirname, 'web/login.html'),
      },
    },
  },
  // `npm run dev`: live-reloading page on http://localhost:5173, talking to the real server on 7337.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7337',
      '^/login$': 'http://127.0.0.1:7337',
      '/ws': { target: 'ws://127.0.0.1:7337', ws: true },
    },
  },
});
