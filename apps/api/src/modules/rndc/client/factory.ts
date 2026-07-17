import { env } from '../../../config/env.js';
import { IRndcClient } from './types.js';
import { RndcMockClient } from './RndcMockClient.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('rndc-factory');

let instance: IRndcClient | null = null;

export function getRndcClient(): IRndcClient {
  if (instance) return instance;

  if (env.RNDC_MODE === 'real') {
    // Fase 4.3: cliente SOAP real plc.mintransporte.gov.co:8080/ws
    throw new Error('RNDC_MODE=real aún no implementado (Fase 4.3)');
  }

  // Banner muy visible si arrancamos en mock dentro de producción.
  if (env.NODE_ENV === 'production') {
    log.warn({ mode: 'mock', envMode: 'production' }, 'modo=mock en producción — verifique RNDC_MODE');
  } else {
    log.info({ mode: 'mock' }, 'desarrollo');
  }

  instance = new RndcMockClient();
  return instance;
}

// Para tests: permite inyectar un cliente custom.
export function _setRndcClientForTesting(c: IRndcClient | null): void {
  instance = c;
}
