import { defineConfig } from 'vite';

// Cross-origin isolation gives performance.now() 5 us resolution (100 us otherwise) for frame metrics.
// Every resource is same-origin, so require-corp costs nothing here.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  // Compiled UVCE assets are written to public/uvce-compiled by `pnpm assets:build`
  // and served/copied verbatim (content-addressed file names, no bundler processing).
  publicDir: 'public',
  server: { port: 5173, headers: isolation },
  preview: { port: 4173, headers: isolation },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~700 kB minified; splitting is a later optimisation, not a POC concern.
    chunkSizeWarningLimit: 1200,
  },
});
