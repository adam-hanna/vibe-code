import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri serves the built assets from the bundle, not from a host, so every
  // reference has to be relative.
  base: './',
  build: {
    outDir: 'dist',
    // The fonts are 108 KB across six files and every one of them is needed on
    // first paint. Inlining nothing keeps them cacheable and keeps the bundle
    // readable.
    assetsInlineLimit: 0,
  },
  server: {
    port: 1420,
    strictPort: true,
    // Cargo output is not webview source. Watching its locked executables on
    // Windows can stop Vite while a packaged build is running.
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
