// HU #14134 — tipos de la carga masiva de SOAT (los de masivo no viven en shared-types).
// Espejo de `AvanceLote` / `FilaAvance` en apps/api/src/modules/flito-soat/flito-soat-masivo.service.ts.

export type TipoMasivo = 'renovacion' | 'inicial';

export type EstadoFila = 'en_cola' | 'consultando' | 'creada' | 'por_validar' | 'rechazada';

/** Una fila del lote SIN documento ni datos del propietario. Placa, VIN y vehículo son efímeros (ADR-0032). */
export interface FilaLote {
  nFila: number;
  placa: string | null;
  vin: string | null;
  estado: EstadoFila;
  marca: string | null;
  linea: string | null;
  modelo: number | null;
  motivo: { codigo: string; mensaje: string } | null;
}

export interface ResumenLoteDto {
  total: number;
  creadas: number;
  porValidar: number;
  rechazadas: number;
  porValidarFactura: number;
  porValidarPropietario: number;
}

export interface AvanceLoteDto {
  loteId: string;
  estado: string;
  tipo: string;
  total: number;
  pendientes: number;
  procesando: number;
  aceptadas: number;
  porValidar: number;
  rechazadas: number;
  resumen: ResumenLoteDto | null;
  descargaRechazadas: boolean;
  filas: FilaLote[];
}

export interface LoteCreadoDto { loteId: string }

/** Rótulo y tono de cada estado de fila (el color nunca es el único portador: el chip lleva texto). */
export const ESTADO_FILA: Record<EstadoFila, { rotulo: string; tone: 'draft' | 'active' | 'success' | 'warning' | 'danger' }> = {
  en_cola: { rotulo: 'En cola', tone: 'draft' },
  consultando: { rotulo: 'Consultando', tone: 'active' },
  creada: { rotulo: 'Creada', tone: 'success' },
  por_validar: { rotulo: 'Por validar', tone: 'warning' },
  rechazada: { rotulo: 'Rechazada', tone: 'danger' },
};
