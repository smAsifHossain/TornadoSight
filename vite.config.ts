import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The app is served from https://smasifhossain.github.io/TornadoSight/
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/TornadoSight/' : '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5178, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
