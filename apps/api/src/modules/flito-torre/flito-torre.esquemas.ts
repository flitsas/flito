// Torre de Control Gerencial (Épica #14590) — esquemas Zod del contrato. Todo `.strict()` y con `z.enum` del
// catálogo de shared-types: ningún identificador SQL viene del cliente.
import { z } from 'zod';
import {
  AGRUPACIONES_TORRE, METRICAS_TORRE_IDS, PRESETS_RANGO_TORRE, TOPES_TORRE, esAgrupacionPermitida,
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
  filtro: filtroTorreSchema,
  limite: z.number().int().positive().max(TOPES_TORRE.FILAS_PANTALLA_MAX).optional(),
}).strict().refine((c) => !c.agrupacion || esAgrupacionPermitida(c.metrica, c.agrupacion), {
  message: 'la agrupación no está permitida para esa métrica', path: ['agrupacion'],
});

export const exportarMetricaSchema = z.object({
  consulta: consultaMetricaSchema,
  formato: z.enum(['xlsx', 'pdf']),
}).strict();

/** Placa colombiana: letras y dígitos, sin espacios ni guiones (la ruta normaliza a mayúsculas). */
export const buscarPlacaSchema = z.object({
  placa: z.string().trim().regex(/^[A-Za-z0-9]{5,7}$/, 'debe ser una placa de 5 a 7 letras y dígitos'),
}).strict();

export const tableroSchema = z.object({ filtro: filtroTorreSchema }).strict();

/** 400 con el detalle legible de Zod. */
export function detalleZod(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ');
}
