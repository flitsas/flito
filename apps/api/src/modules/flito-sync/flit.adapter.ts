// FLITO — proveedor del adaptador FLIT. Integración HTTP real contra el reporte de FLIT 1.0
// (solo lectura). Ver docs/integracion/integracionFlit.md.

import { createFlitHttpAdapter } from './flit-http.adapter.js';
import type { FlitPort } from './flit.port.js';

let instancia: FlitPort | null = null;

export function getFlitAdapter(): FlitPort {
  if (instancia) return instancia;
  instancia = createFlitHttpAdapter();
  return instancia;
}
