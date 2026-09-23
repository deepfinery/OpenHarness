import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: '../../dist/studio',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: { flow: ['@xyflow/react', 'yaml'], markdown: ['react-markdown', 'remark-gfm'] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.DEV_API_URL ?? 'http://localhost:8088',
        changeOrigin: true,
        headers: { Origin: process.env.DEV_API_ORIGIN ?? 'http://localhost:8088' },
      },
    },
  },
});
