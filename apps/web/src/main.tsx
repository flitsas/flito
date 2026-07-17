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
