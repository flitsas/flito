// FLITO sync — selector del adaptador del feed de FLIT 2 (HU #13091). `FLIT2_SYNC_ADAPTER`:
// `http` (real, por defecto) o `fake` (páginas ficticias en memoria; prohibido en producción).
// Instancia perezosa, como `flit.adapter.ts`: el HTTP no exige la base URL al arrancar, sino al usarse.

import { env } from '../../config/env.js';
import { crearFlit2SyncFake } from './flit2-sync-fake.adapter.js';
import { crearFlit2SyncHttp } from './flit2-sync-http.adapter.js';
import type { Flit2SyncPort } from './flit2-sync.port.js';

let instancia: Flit2SyncPort | null = null;

export function getFlit2SyncAdapter(): Flit2SyncPort {
  if (instancia) return instancia;
  instancia = env.FLIT2_SYNC_ADAPTER === 'fake' ? crearFlit2SyncFake() : crearFlit2SyncHttp();
  return instancia;
}
