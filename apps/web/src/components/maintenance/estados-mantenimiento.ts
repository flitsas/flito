/*
 * Estados de dominio de Mantenimiento y taller (Épica #14560, S4) sobre el registro ESTADO→{tono, glifo|icono}
 * del kit (components/flit/kit/tonos.ts). Claves con prefijo del dominio para no pisar los estados genéricos.
 * Un ícono por estado. Solo piel: los textos visibles los sigue poniendo cada página.
 */
import { registrarEstados } from '../flit/kit/tonos';

/** Orden de trabajo (`work_orders.estado`). */
export const ESTADO_OT = {
  abierta: 'ot-abierta',
  cerrada_tecnica: 'ot-cerrada-tecnica',
  cerrada_final: 'ot-cerrada-final',
  anulada: 'ot-anulada',
} as const;

/** Programación de mantenimiento (`maintenance_schedule.estado`). */
export const ESTADO_PROGRAMACION = {
  pendiente: 'prog-pendiente',
  ejecutada: 'prog-ejecutada',
  vencida: 'prog-vencida',
  cancelada: 'prog-cancelada',
} as const;

/** Liquidación de la OT. */
export const ESTADO_LIQUIDACION = {
  borrador: 'liq-borrador',
  confirmada: 'liq-confirmada',
  anulada: 'liq-anulada',
} as const;

export const ESTADO_STOCK_BAJO = 'stock-bajo';
export const ESTADO_STOCK_APLICADO = 'stock-aplicado';
export const ESTADO_STOCK_PENDIENTE = 'stock-pendiente';

registrarEstados({
  // OT: abierta/en curso = info; cerrada técnica = info (sigue en taller, falta el cierre final);
  // cerrada final = ok; anulada = anulado.
  'ot-abierta': { tono: 'info', icono: 'preparado' },
  'ot-cerrada-tecnica': { tono: 'info', glifo: 'check' },
  'ot-cerrada-final': { tono: 'ok', icono: 'aprobado' },
  'ot-anulada': { tono: 'anulado', icono: 'anulado' },
  // Programación: pendiente = warn; ejecutada = ok; vencida = danger; cancelada = anulado.
  'prog-pendiente': { tono: 'warn', icono: 'pendiente' },
  'prog-ejecutada': { tono: 'ok', icono: 'aprobado' },
  'prog-vencida': { tono: 'danger', glifo: 'alerta' },
  'prog-cancelada': { tono: 'anulado', icono: 'anulado' },
  // Liquidación: borrador = warn (por confirmar); confirmada = ok; anulada = anulado.
  'liq-borrador': { tono: 'warn', icono: 'borrador' },
  'liq-confirmada': { tono: 'ok', icono: 'aprobado' },
  'liq-anulada': { tono: 'anulado', icono: 'anulado' },
  // Inventario: stock bajo = warn; repuesto de la OT aplicado al stock = ok, por aplicar = warn.
  'stock-bajo': { tono: 'warn', glifo: 'alerta' },
  'stock-aplicado': { tono: 'ok', glifo: 'check' },
  'stock-pendiente': { tono: 'warn', glifo: 'espera' },
});
