// Feature #13978, HU #13987 (ADR-0034 D3) — AAD de `manifiestos.titular_pago_cuenta`, compartida por la ruta
// y el script de rotación. La clave de fila es `numero`, no `id`.
import type { AadPii } from '../../shared/utils/crypto.js';

export const aadTitularPago = (numero: string, aadNonce: string): AadPii => (
  { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: numero, aadNonce }
);
