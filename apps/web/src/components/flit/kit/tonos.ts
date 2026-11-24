/*
 * Tonos de la etiqueta con punta del UI Kit 2026 (`.badge` de la propuesta; StatusBadge/etiquetaKit de flit develop).
 * El color lo pone el CSS por `data-tono` (claro y oscuro, styles/kit/kit-react.css): aquí no hay hex.
 */
import type { CSSProperties } from 'react';
import type { NombreIcono } from './iconos-kit.generated';

export type TonoKit =
  | 'ok' | 'warn' | 'danger' | 'info' | 'neutro' | 'tinta'
  | 'radicado' | 'entregado' | 'revocado' | 'anulado' | 'preasignacion';

/**
 * Para chips propios que no son <StatusChip>: `<span {...etiquetaKit('warn')}>…</span>`. No toca textos ni aria.
 * Dentro, `<span className={ETIQUETA_PUNTO_CLS} aria-hidden />` o un ícono 20 px con `ETIQUETA_ICONO_CLS`.
 */
export function etiquetaKit(tono: TonoKit, opciones: { icono?: boolean; className?: string } = {}): {
  className: string; 'data-tono': TonoKit; style?: CSSProperties;
} {
  return {
    className: `kit-etiqueta${opciones.icono ? ' kit-etiqueta--icono' : ''}${opciones.className ? ` ${opciones.className}` : ''}`,
    'data-tono': tono,
  };
}
export const ETIQUETA_PUNTO_CLS = 'kit-etiqueta__punto';
export const ETIQUETA_ICONO_CLS = 'kit-etiqueta__icono';

/** Disco de estado del kit (public/kit/estado-*.svg). */
export const ICONO_ESTADO_KIT = {
  borrador: '/kit/estado-borrador.svg',
  preparado: '/kit/estado-preparado.svg',
  pendiente: '/kit/estado-pendiente.svg',
  entregado: '/kit/estado-entregado.svg',
  aprobado: '/kit/estado-aprobado.svg',
  rechazado: '/kit/estado-rechazado.svg',
  anulado: '/kit/estado-anulado.svg',
  revocado: '/kit/estado-revocado.svg',
  subsanado: '/kit/estado-subsanado.svg',
  placa: '/kit/estado-placa.svg',
  'sin-placa': '/kit/estado-sin-placa.svg',
} as const;

export interface EstadoKit { tono: TonoKit; glifo?: NombreIcono; icono?: keyof typeof ICONO_ESTADO_KIT }

/**
 * Registro ESTADO → {tono, glifo|icono}, extensible: cada módulo registra sus estados de dominio una vez
 * (`registrarEstados({ 'en-ruta': { tono: 'info', glifo: 'ruta' } })`) y pinta con <EtiquetaEstado estado="en-ruta" />.
 * Un estado sin registrar cae en neutro. Un ícono por estado (regla del kit).
 */
const ESTADOS = new Map<string, EstadoKit>(Object.entries({
  borrador: { tono: 'neutro', icono: 'borrador' },
  pendiente: { tono: 'warn', icono: 'pendiente' },
  preparado: { tono: 'info', icono: 'preparado' },
  radicado: { tono: 'radicado', icono: 'entregado' },
  entregado: { tono: 'entregado', icono: 'entregado' },
  aprobado: { tono: 'ok', icono: 'aprobado' },
  finalizado: { tono: 'ok', glifo: 'finalizado' },
  rechazado: { tono: 'danger', icono: 'rechazado' },
  anulado: { tono: 'anulado', icono: 'anulado' },
  revocado: { tono: 'revocado', icono: 'revocado' },
  subsanacion: { tono: 'warn', icono: 'subsanado' },
  preasignacion: { tono: 'preasignacion', icono: 'sin-placa' },
  activo: { tono: 'ok', glifo: 'encendido' },
  inactivo: { tono: 'neutro', glifo: 'menos' },
  error: { tono: 'danger', glifo: 'alerta' },
} satisfies Record<string, EstadoKit>));

export function registrarEstados(mapa: Record<string, EstadoKit>): void {
  for (const [k, v] of Object.entries(mapa)) ESTADOS.set(k, v);
}
export function estadoKit(estado: string): EstadoKit {
  return ESTADOS.get(estado) ?? { tono: 'neutro' };
}
