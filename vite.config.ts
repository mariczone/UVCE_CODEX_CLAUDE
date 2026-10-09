import { defineConfig } from 'vite';

export default defineConfig({
  // Compiled UVCE assets are written to public/uvce-compiled by `pnpm assets:build`
  // and served/copied verbatim (content-addressed file names, no bundler processing).
  publicDir: 'public',
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~700 kB minified; splitting is a later optimisation, not a POC concern.
    chunkSizeWarningLimit: 1200,
  },
});
