import { defineConfig } from 'vite';

// Served at https://<owner>.github.io/planet-canvas2/ via GitHub Pages,
// so asset URLs need the repo name as a base path.
export default defineConfig({
  base: '/planet-canvas2/',
});
