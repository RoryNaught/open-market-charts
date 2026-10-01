import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/lightweight-charts') ||
            id.includes('node_modules/fancy-canvas')
          )
            return 'chart-vendor';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler'))
            return 'react-vendor';
        },
      },
    },
  },
  server: { port: 5173 },
  worker: { format: 'es' },
});
