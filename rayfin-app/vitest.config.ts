import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      // Shared similarity engine at repo root (../engine) — keep in sync with vite.config.ts.
      '@engine': resolve(import.meta.dirname, '../engine'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./src/__tests__/setup.ts'],
    server: { deps: { inline: [/@engine/] } },
  },
});
