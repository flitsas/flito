// FLITO — selección del adaptador FLIT según FLIT_ADAPTER (mock | http).
// mock: lee de flito_mock_tramite (demo/tests). http: reporte real de FLIT (solo lectura).

import { env } from '../../config/env.js';
import { createFlitMockAdapter } from './flit-mock.adapter.js';
import { createFlitHttpAdapter } from './flit-http.adapter.js';
import type { FlitPort } from './flit.port.js';

let instancia: FlitPort | null = null;

export function getFlitAdapter(): FlitPort {
  if (instancia) return instancia;
  instancia = env.FLIT_ADAPTER === 'http' ? createFlitHttpAdapter() : createFlitMockAdapter();
  return instancia;
}
