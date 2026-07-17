// TRAM-INNOV-B3 — proveedor de firma MOCK (CI/dev/demo). No llama a ningún externo.

import crypto from 'crypto';
import { env } from '../../config/env.js';
import type { FirmaProvider, CrearFirmaInput, CrearFirmaResult } from './provider.js';

export class MockFirmaProvider implements FirmaProvider {
  readonly nombre = 'mock';

  async crearSolicitud(input: CrearFirmaInput): Promise<CrearFirmaResult> {
    const envelopeId = `mock_${input.tramiteId}_${input.rol}_${crypto.randomBytes(6).toString('hex')}`;
    const base = env.PUBLIC_URL.replace(/\/$/, '');
    // Página de firma simulada (la consume el portal del participante en PR UI).
    const signUrl = `${base}/tramite/firma-simulada/${envelopeId}`;
    return { envelopeId, signUrl };
  }
}
