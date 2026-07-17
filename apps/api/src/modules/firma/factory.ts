// TRAM-INNOV-B3 — selección del proveedor de firma según env (FIRMA_PROVIDER).

import { env } from '../../config/env.js';
import type { FirmaProvider } from './provider.js';
import { MockFirmaProvider } from './mock.provider.js';
import { ZapsignFirmaProvider } from './zapsign.provider.js';

let cached: FirmaProvider | null = null;

export function getFirmaProvider(): FirmaProvider {
  if (cached) return cached;
  cached = env.FIRMA_PROVIDER === 'zapsign' ? new ZapsignFirmaProvider() : new MockFirmaProvider();
  return cached;
}

/** Solo para tests: reinyecta o limpia el proveedor cacheado. */
export function __setFirmaProviderForTest(p: FirmaProvider | null): void {
  cached = p;
}
