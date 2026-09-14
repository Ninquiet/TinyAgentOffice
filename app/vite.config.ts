import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5188',
      '/ws': {
        target: 'ws://127.0.0.1:5188',
        ws: true,
      },
    },
  },
});
