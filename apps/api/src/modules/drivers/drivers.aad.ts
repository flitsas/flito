// Feature #13978, HU #13987 (ADR-0034 D3) — AAD de `driver_profile`, compartida por la ruta y el script de
// rotación: importar la ruta desde un Job arrastraría Express entero.
import type { AadPii } from '../../shared/utils/crypto.js';
import type { ColumnaAadConductor } from '../../shared/utils/pii-columnas.js';

export const aadConductor = (column: ColumnaAadConductor, userId: number | string, aadNonce: string): AadPii => (
  { table: 'driver_profile', column, empresaNit: String(userId), aadNonce }
);
