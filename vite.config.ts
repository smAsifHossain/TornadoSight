import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The app is served from https://smasifhossain.github.io/TornadoSight/
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/TornadoSight/' : '/',
  plugins: [react(), tailwindcss()],
  // ONNX Runtime loads its WebAssembly glue by dynamic import at runtime.
  // Prebundling rewrites that import and the request comes back with a ?import
  // query the static handler will not serve, so leave the package alone.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    port: 5178,
    strictPort: true,
    /**
     * Generated assets must not trigger a reload.
     *
     * The facility shards, the replay fixtures and the model weights are all
     * produced by scripts rather than edited by hand, and some of those scripts
     * run for hours. Watching them means the page reloads underneath whoever is
     * using it: upload a photograph, a bake writes its next shard, and the app
     * restarts mid screening.
     */
    watch: {
      ignored: ['**/public/data/**', '**/public/models/**', '**/public/samples/**', '**/data/dataset/**'],
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
