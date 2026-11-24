/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `--mode mock` loads .env.mock (VITE_MOCK=1): the SPA then talks to an in-memory API.
// Otherwise /api is proxied to a galley backend on this machine.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
  server: {
    port: 5173,
    proxy: mode === 'mock' ? undefined : {
      '/api': { target: 'https://127.0.0.1:8443', secure: false, changeOrigin: true },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
