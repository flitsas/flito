// Épica #14548 (ADR-0051) — Esquemas Zod del visor de consumo de IA. `.strict()` en todo: una clave de más es un 400.
// Los filtros con datos personales (`usuario`, `placa`, `entidad`) solo viajan en el cuerpo de la búsqueda (AGENTS §14);
// cualquier query string en una ruta del visor es un 400 (lo aplica la ruta con `sinQuery`).
import { z } from 'zod';
import { ORIGENES_IA, PROVEEDORES_IA, RESULTADOS_IA, TIPOS_TAREA_IA } from '../../shared/ia-consumo/catalogo.js';
import { normalizarPlacaIa } from '../../shared/ia-consumo/contexto.js';
import { esUuid } from '../../shared/utils/uuid.js';

/** `YYYY-MM-DD` de calendario válido: rechaza `2026-02-30` y `2026-13-01`. */
export function esFechaIso(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [anio, mes, dia] = valor.split('-').map(Number) as [number, number, number];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia;
}

const fechaIso = z.string().refine(esFechaIso, 'La fecha debe tener el formato AAAA-MM-DD y existir en el calendario.');
const slug = z.string().regex(/^[a-z0-9_]{1,40}$/, 'Identificador no válido.');
const modelo = z.string().regex(/^[a-z0-9.-]{1,60}$/, 'Modelo no válido.');
const placa = z.string().max(40).refine((valor) => normalizarPlacaIa(valor) !== null, 'La placa no es válida.');

/** Texto libre con caracteres de control (U+0000–U+001F y U+007F): PostgreSQL rechaza el U+0000 (22021) y el valor acabaría en el log. */
const MENSAJE_SIN_CONTROL = 'El texto contiene caracteres no permitidos.';

export const filtroIaSchema = z.object({
  // Cadena inline a propósito: `scripts/contratos/esquemas.mjs` lee min, max y el literal de `regex` del AST de la cadena,
  // y el contrato OpenAPI debe conservar minLength/maxLength. Un helper o un `refine` los oculta.
  // eslint-disable-next-line no-control-regex -- rechaza justo U+0000–U+001F y U+007F
  usuario: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/, MENSAJE_SIN_CONTROL).optional(),
  placa: placa.optional(),
  // eslint-disable-next-line no-control-regex -- rechaza justo U+0000–U+001F y U+007F
  entidad: z.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]*$/, MENSAJE_SIN_CONTROL).optional(),
  origen: z.enum(ORIGENES_IA).optional(),
  modulo: slug.optional(),
  proceso: slug.optional(),
  tipoTarea: z.enum(TIPOS_TAREA_IA).optional(),
  proveedor: z.enum(PROVEEDORES_IA).optional(),
  modelo: modelo.optional(),
  resultado: z.enum(RESULTADOS_IA).optional(),
}).strict();

/** Cuerpo de `POST /registros/buscar`. Las fechas son opcionales aquí: su ausencia la responde el servicio (`rango_invalido`). */
export const buscarIaSchema = z.object({
  desde: fechaIso.optional(),
  hasta: fechaIso.optional(),
  cursor: z.string().min(1).max(200).optional(),
  filtros: filtroIaSchema.optional(),
}).strict();

/** Las rutas sin parámetros de búsqueda: cualquier query string es un 400. */
export const sinQuery = z.object({}).strict();

export const idRegistroSchema = z.string().refine(esUuid, 'El identificador del registro no es válido.');

export type FiltrosIaEntrada = z.infer<typeof filtroIaSchema>;
export type BuscarIaEntrada = z.infer<typeof buscarIaSchema>;
