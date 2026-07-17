// TRAM-INNOV-B3 — proveedor ZapSign (SKELETON). La integración real se completa
// cuando el PO entregue ZAPSIGN_API_TOKEN. No rompe el boot: solo falla al USARSE
// sin token, con mensaje claro para volver a FIRMA_PROVIDER=mock.

import { env } from '../../config/env.js';
import type { FirmaProvider, CrearFirmaInput, CrearFirmaResult } from './provider.js';

export class ZapsignFirmaProvider implements FirmaProvider {
  readonly nombre = 'zapsign';

  async crearSolicitud(_input: CrearFirmaInput): Promise<CrearFirmaResult> {
    if (!env.ZAPSIGN_API_TOKEN) {
      throw new Error('ZAPSIGN_API_TOKEN no configurado. Use FIRMA_PROVIDER=mock hasta tener el token.');
    }
    // TODO(B3-prod): POST /api/v1/docs/ (host sandbox/prod según ZAPSIGN_SANDBOX) con el
    // signer (email del firmante) y el PDF de compraventa; devolver
    // { envelopeId: doc.token, signUrl: signer.sign_url }. Estado se confirma vía webhook HMAC.
    throw new Error('ZapSign aún no implementado (skeleton TRAM-INNOV-B3). Pendiente integración con token del PO.');
  }
}
