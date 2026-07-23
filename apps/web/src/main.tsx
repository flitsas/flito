import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initRum } from './lib/rum';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// RUM Web Vitals (FIONA PR2) — fuera del árbol React, best-effort.
initRum();

// PWA (Logística Fase 2): registra el service worker para instalabilidad (CA-14) y carga offline
// del app-shell. Solo en producción — en dev interferiría con el HMR de Vite.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[pwa] SW no registrado', err));
  });
}
