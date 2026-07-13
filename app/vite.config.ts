import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { resolve } from 'path'

// Single self-contained HTML output — fully client-side, shareable as one file.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      // Shared similarity engine lives at repo root (../engine) — one copy shared with rayfin-app/.
      '@engine': resolve(import.meta.dirname, '../engine'),
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
  // Pinned dev port so the MSAL redirect URI (http://localhost:5188) stays stable.
  // fs.allow lets the dev server read the shared engine/ that sits outside this app root.
  server: { port: 5188, strictPort: true, fs: { allow: [resolve(import.meta.dirname, '..')] } },
})
