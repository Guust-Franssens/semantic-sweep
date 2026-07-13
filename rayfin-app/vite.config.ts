import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      // Shared similarity engine lives at repo root (../engine) so app/ and rayfin-app/ share ONE
      // copy. Per-app data/auth adapters stay local under src/data/.
      '@engine': resolve(import.meta.dirname, '../engine'),
    },
  },
  // Allow Vite dev server + Vitest to read the shared engine/ that sits outside this app root.
  server: {
    fs: { allow: [resolve(import.meta.dirname, '..')] },
  },
  build: {
    target: 'es2022',
  },
  esbuild: {
    target: 'es2022',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
});
