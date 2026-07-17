import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // FIONA-F2 — un único chunk `vendor-react` que CO-LOCA todo el runtime
        // React (react + react-dom + scheduler + router + toast). El intento previo
        // (#144) separaba vendor-react de vendor-router y rompía `React.memo`
        // («Cannot read properties of undefined») por orden de carga entre vendors.
        // Co-locándolos NO hay dependencia cruzada entre chunks de vendor → seguro.
        // Beneficio: ese ~70 KB gzip estable se cachea entre deploys (no re-descarga
        // al cambiar app-code). pdfjs sigue lazy (dynamic import) y NO entra aquí.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const REACT_RUNTIME = [
            'react', 'react-dom', 'scheduler', 'use-sync-external-store',
            'react-router', 'react-router-dom', '@remix-run/router',
            'react-hot-toast', 'goober',
          ];
          // Trailing slash → `react` no captura `react-dom`/`react-router`.
          if (REACT_RUNTIME.some((p) => id.includes(`/node_modules/${p}/`))) {
            return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://localhost:3005',
    },
  },
});
