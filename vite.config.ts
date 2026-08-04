import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Served at https://<owner>.github.io/planet-canvas2/ via GitHub Pages,
// so asset URLs need the repo name as a base path.
export default defineConfig({
  base: '/planet-canvas2/',
  build: {
    rollupOptions: {
      // gpgpu-test.html is a standalone diagnostic (see src/gpgpuTest.ts):
      // a minimal per-frame render-target ping-pong, isolated from the
      // rest of the app, for checking whether a device can sustain that
      // pattern at all before betting the real continent-drift simulation
      // on it. Needs its own entry so Vite builds and serves it.
      input: {
        main: resolve(__dirname, 'index.html'),
        gpgpuTest: resolve(__dirname, 'gpgpu-test.html'),
        // Reads real pixel values back from plateSim's actual color-
        // advection render target, printed as text — for verifying the
        // render-target write itself takes effect on a device without
        // needing a screenshot. See src/advectTest.ts.
        advectTest: resolve(__dirname, 'advect-test.html'),
      },
    },
  },
});
