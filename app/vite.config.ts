import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { MOBILE_SWAPS } from './mobile-swaps';

/**
 * The phone build (#345): `--mode mobile` resolves each module in
 * `MOBILE_SWAPS` to its phone counterpart, wherever it is imported from. The
 * desktop build never runs this.
 */
function mobileSwaps(): Plugin {
  const swaps = new Map(
    Object.entries(MOBILE_SWAPS).map(([from, to]) => [
      path.resolve(import.meta.dirname, from),
      path.resolve(import.meta.dirname, to),
    ]),
  );
  return {
    name: 'vibe-mobile-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const to = resolved === null ? undefined : swaps.get(resolved.id);
      return to === undefined ? resolved : to;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'mobile' ? [mobileSwaps()] : [])],
  resolve: {
    // `@/` is the shadcn convention and what its copied-in components import
    // through. Mirrored in `tsconfig.json`; the two have to agree.
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
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
    watch: { ignored: ['**/src-tauri/**', '**/mobile/**'] },
  },
}));
