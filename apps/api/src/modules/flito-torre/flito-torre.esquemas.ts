// Torre de Control Gerencial (Épica #14590) — esquemas Zod del contrato. Todo `.strict()` y con `z.enum` del
// catálogo de shared-types: ningún identificador SQL viene del cliente.
//
// RN-TOR-M10/M11 (ADR-0044): `fechaBase` fuera de la matriz medida × fecha de la métrica es 400 (el servicio la vuelve
//   a exigir). En las de foto (`fechasBase: []`) cualquier `fechaBase` es 400.
// RN-TOR-C1: como máximo 2 agrupaciones; `agrupacionColumnas` exige `agrupacion`, distinta de ella, permitida por la
//   métrica y no las dos temporales.
// RN-TOR-K4: `top` ∈ `TOPES_TORRE.TOP_GRUPOS` (5/10/20/50); solo cambia el cruce en pantalla.
// RN-TOR-K2: `comparar` con una métrica de foto (no hay rango) o con `agrupacionColumnas` (cruce) es 400.
// Los mensajes no repiten el valor recibido (`detalleZod` solo concatena la ruta y el mensaje).
import { z } from 'zod';
import {
  AGRUPACIONES_TORRE, FECHAS_BASE_TORRE, METRICAS_TORRE_IDS, PRESETS_RANGO_TORRE, TOPES_TORRE, esAgrupacionPermitida,
  esAgrupacionTemporal, esFechaBasePermitida, metricaTorre,
} from '@operaciones/shared-types';

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'debe ser una fecha YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'no es una fecha válida');

export const rangoTorreSchema = z.union([
  z.object({ preset: z.enum(PRESETS_RANGO_TORRE) }).strict(),
  z.object({ desde: FECHA, hasta: FECHA }).strict()
    .refine((r) => r.desde <= r.hasta, { message: 'desde no puede ser posterior a hasta', path: ['desde'] }),
]);

const lista = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(200).optional();

export const filtroTorreSchema = z.object({
  rango: rangoTorreSchema,
  companiaIds: lista(z.number().int().positive()),
  organismos: lista(z.string().regex(/^\d{5}$/, 'debe ser un código DIVIPOLA de 5 dígitos')),
  departamentos: lista(z.string().regex(/^\d{2}$/, 'debe ser un código DANE de 2 dígitos')),
  tiposTramite: lista(z.string().trim().min(1).max(60)),
  flitEstados: lista(z.string().trim().min(1).max(60)),
}).strict();

export const consultaMetricaSchema = z.object({
  metrica: z.enum(METRICAS_TORRE_IDS),
  agrupacion: z.enum(AGRUPACIONES_TORRE).optional(),
  agrupacionColumnas: z.enum(AGRUPACIONES_TORRE).optional(),
  fechaBase: z.enum(FECHAS_BASE_TORRE).optional(),
  filtro: filtroTorreSchema,
  limite: z.number().int().positive().max(TOPES_TORRE.FILAS_PANTALLA_MAX).optional(),
  top: z.literal(TOPES_TORRE.TOP_GRUPOS, { error: 'debe ser 5, 10, 20 o 50' }).optional(),
  comparar: z.boolean().optional(),
}).strict()
  .refine((c) => !c.agrupacion || esAgrupacionPermitida(c.metrica, c.agrupacion), {
    message: 'la agrupación no está permitida para esa métrica', path: ['agrupacion'],
  })
  .refine((c) => !c.agrupacionColumnas || esAgrupacionPermitida(c.metrica, c.agrupacionColumnas), {
    message: 'la agrupación no está permitida para esa métrica', path: ['agrupacionColumnas'],
  })
  .refine((c) => !c.agrupacionColumnas || !!c.agrupacion, {
    message: 'exige una agrupación principal', path: ['agrupacionColumnas'],
  })
  .refine((c) => !c.agrupacionColumnas || c.agrupacionColumnas !== c.agrupacion, {
    message: 'no puede repetir la principal', path: ['agrupacionColumnas'],
  })
  .refine((c) => !(c.agrupacion && c.agrupacionColumnas
    && esAgrupacionTemporal(c.agrupacion) && esAgrupacionTemporal(c.agrupacionColumnas)), {
    message: 'solo una de las dos agrupaciones puede ser de tiempo', path: ['agrupacionColumnas'],
  })
  .refine((c) => !c.fechaBase || esFechaBasePermitida(c.metrica, c.fechaBase), {
    message: 'esa fecha base no aplica a la métrica', path: ['fechaBase'],
  })
  .refine((c) => !c.comparar || metricaTorre(c.metrica).fechasBase.length > 0, {
    message: 'no aplica a una métrica sin periodo', path: ['comparar'],
  })
  .refine((c) => !c.comparar || !c.agrupacionColumnas, {
    message: 'no aplica con dos agrupaciones', path: ['comparar'],
  });

export const exportarMetricaSchema = z.object({
  consulta: consultaMetricaSchema,
  formato: z.enum(['xlsx', 'pdf']),
}).strict();

/** Placa colombiana: letras y dígitos, sin espacios ni guiones (la ruta normaliza a mayúsculas). */
export const buscarPlacaSchema = z.object({
  placa: z.string().trim().regex(/^[A-Za-z0-9]{5,7}$/, 'debe ser una placa de 5 a 7 letras y dígitos'),
}).strict();

/** Texto parcial de la placa (RN-TOR-P5). La web ya lo manda normalizado (sin espacios ni guiones). */
export const sugerirPlacaSchema = z.object({
  texto: z.string().trim().regex(/^[A-Za-z0-9]{3,7}$/, 'debe tener de 3 a 7 letras y dígitos'),
}).strict();

export const tableroSchema = z.object({ filtro: filtroTorreSchema }).strict();

/** 400 con el detalle legible de Zod. */
export function detalleZod(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ');
}
