// FLITO — selección del adaptador FLIT según FLIT_ADAPTER (mock | http).
// El adaptador HTTP real (OperationApi/api/OperationLookUp) aún no existe: se agrega aquí
// cuando FLIT 1.0 exponga el endpoint, sin tocar la sincronización ni los módulos.

import { env } from '../../config/env.js';
import { createFlitMockAdapter } from './flit-mock.adapter.js';
import type { FlitPort } from './flit.port.js';

let instancia: FlitPort | null = null;

export function getFlitAdapter(): FlitPort {
  if (instancia) return instancia;
  if (env.FLIT_ADAPTER === 'http') {
    throw new Error(
      'FLIT_ADAPTER=http aún no está implementado. Usa FLIT_ADAPTER=mock hasta que exista ' +
        'el adaptador HTTP contra FLIT 1.0.',
    );
  }
  instancia = createFlitMockAdapter();
  return instancia;
}
