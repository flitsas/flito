// FLITO — Catálogo de tipos de servicio adicional (HU #12541, Feature #12540, épica #12246).
//
// Un «servicio adicional» es algo que FLIT cobra aparte del trámite (paz y salvo, diagnóstico,
// derecho de petición…). Este archivo fija el contrato del CATÁLOGO de tipos, que la API y la web
// comparten. Reglas que el contrato hace visibles:
//   · Baja LÓGICA: un tipo no se borra, se da de baja (`activo: false` + `dadoDeBajaEn`) y no se
//     reactiva. Su nombre queda libre para un tipo nuevo.
//   · El nombre es único entre los ACTIVOS comparado plegado (minúsculas, sin tilde): «Diagnóstico»
//     y «diagnostico» son el mismo tipo.
// La asignación de servicios a trámites NO va aquí (Feature 2 de la épica).
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
