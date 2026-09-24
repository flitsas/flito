// FLITO — Catálogo de tipos de servicio adicional (HU #12541, Feature #12540, épica #12246).
//
// Un «servicio adicional» es algo que FLIT cobra aparte del trámite (paz y salvo, diagnóstico,
// derecho de petición…). Este archivo fija el contrato del CATÁLOGO de tipos, que la API y la web
// comparten. Reglas que el contrato hace visibles:
//   · Baja LÓGICA: un tipo no se borra, se da de baja (`activo: false` + `dadoDeBajaEn`) y no se
//     reactiva. Su nombre queda libre para un tipo nuevo.
//   · El nombre es único entre los ACTIVOS comparado plegado (minúsculas, sin tilde): «Diagnóstico»
//     y «diagnostico» son el mismo tipo.
// La ASIGNACIÓN a un trámite (HU #12545, Feature #12544) vive al final del archivo: la fila puente
// lleva el SNAPSHOT del tipo (nombre, descripción, valor) en el instante de asignar.
import { TARIFA_VALOR_MAX } from './flito-tarifas.js';

/** Largo máximo del nombre (`varchar(120)` en la 0191). */
export const SERVICIO_ADICIONAL_NOMBRE_MAX = 120;
/** Largo máximo de la descripción (texto libre acotado por Zod; la columna es `text`). */
export const SERVICIO_ADICIONAL_DESCRIPCION_MAX = 2000;
/** Tope de `numeric(14,2)`: el mismo de las tarifas. */
export const SERVICIO_ADICIONAL_VALOR_MAX = TARIFA_VALOR_MAX;

/** Un tipo del catálogo, tal como lo publica `GET /api/flito/parametrizacion/servicios-adicionales`. */
export interface ServicioAdicionalTipo {
  id: string;
  nombre: string;
  descripcion: string | null;
  valor: number;
  /** false = dado de baja. Solo aparece en el listado con `incluirBajas=1`. */
  activo: boolean;
  /** ISO; null mientras está activo. Va en pareja con `dadoDeBajaPorId`. */
  dadoDeBajaEn: string | null;
  dadoDeBajaPorId: number | null;
  creadoEn: string;
  /** null en los tres tipos sembrados por la migración (no hubo actor). */
  creadoPorId: number | null;
  actualizadoEn: string;
  actualizadoPorId: number | null;
}

/** Cuerpo de `POST /servicios-adicionales`. */
export interface CrearServicioAdicionalInput {
  nombre: string;
  descripcion?: string | null;
  valor: number;
}

/** Cuerpo de `PATCH /servicios-adicionales/:id`: cualquier subconjunto no vacío del alta. */
export type EditarServicioAdicionalInput = Partial<CrearServicioAdicionalInput>;

/** Cuerpo del 409 al crear o editar con un nombre que otro tipo ACTIVO ya usa (plegado). */
export interface ServicioAdicionalNombreDuplicado {
  error: string;
  codigo: 'NOMBRE_DUPLICADO';
  /** El tipo activo que ya lleva ese nombre. */
  choca: { id: string; nombre: string };
}

// ── Asignación a un trámite (HU #12545, Feature #12544) ─────────────────────────────────────────

/**
 * Un servicio adicional ASIGNADO a un trámite, tal como lo publica
 * `GET /api/finanzas/tramites/:id/servicios-adicionales`. `nombre`, `descripcion` y `valor` son la
 * copia del tipo en el instante de asignar: editar o dar de baja el tipo después no los cambia.
 */
export interface TramiteServicioAdicional {
  id: string;
  tipoId: string;
  nombre: string;
  descripcion: string | null;
  valor: number;
  asignadoPorId: number | null;
  asignadoPorNombre: string | null;
  /** ISO. */
  asignadoEn: string;
  /**
   * Bug #12913: `comprobante` si la asignación la escribió un comprobante de pago aplicado de ese tipo
   * (no se puede quitar desde el panel: 409 `asignacion_de_comprobante`); `manual` si la asignó una persona.
   */
  origen: OrigenServicioAdicional;
}

/** Bug #12913: de dónde viene una asignación de servicio adicional. */
export type OrigenServicioAdicional = 'manual' | 'comprobante';

/** Cuerpo de `POST /api/finanzas/tramites/:id/servicios-adicionales`. */
export interface AsignarServicioAdicionalInput {
  tipoId: string;
}

/** Respuesta del GET: los asignados en orden de asignación, su suma y si el trámite ya está liquidado. */
export interface ServiciosAdicionalesDeTramite {
  items: TramiteServicioAdicional[];
  /** Suma de `items[].valor` redondeada a centavos. */
  total: number;
  /** true = hay liquidación sellada: la lista es de solo lectura hasta reversarla. */
  liquidado: boolean;
}

/** Lo que la liquidación sella por servicio (HU #12546) y lo que Siigo convierte en línea (HU #12547). */
export interface ItemServicioSellado {
  tipoId: string;
  nombre: string;
  valor: number;
}

/** Códigos del cuerpo de error de la asignación (`{ error, codigo }`). */
export const CODIGO_SERVICIO_ADICIONAL_TRAMITE = {
  /** 404: el tipo no existe o está dado de baja. */
  TIPO_NO_DISPONIBLE: 'TIPO_NO_DISPONIBLE',
  /** 409: ese tipo ya está asignado al trámite (UNIQUE tramite_id, tipo_id). */
  SERVICIO_YA_ASIGNADO: 'SERVICIO_YA_ASIGNADO',
  /** 409: el trámite está liquidado; hay que reversar la liquidación para cambiar los servicios. */
  TRAMITE_LIQUIDADO: 'TRAMITE_LIQUIDADO',
  /** 409 (Bug #12913): la asignación la escribió un comprobante de pago aplicado; no se quita desde el panel. */
  ASIGNACION_DE_COMPROBANTE: 'ASIGNACION_DE_COMPROBANTE',
} as const;
export type CodigoServicioAdicionalTramite =
  (typeof CODIGO_SERVICIO_ADICIONAL_TRAMITE)[keyof typeof CODIGO_SERVICIO_ADICIONAL_TRAMITE];
