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
  AGRUPACIONES_TORRE, COLUMNAS_DETALLE, COLUMNAS_DETALLE_IDS, CONJUNTOS_TORRE_IDS, DETALLE_METRICA_TORRE,
  DIMENSIONES_SEGMENTO_TORRE, FECHAS_BASE_TORRE, METRICAS_TORRE_IDS, PRESETS_RANGO_TORRE, TOPES_TORRE, conjuntoTorre,
  esAgrupacionPermitida, esAgrupacionTemporal, esFechaBasePermitida, metricaTorre, type AgrupacionTorre,
} from '@operaciones/shared-types';
import { CLAVE_MOTIVO_RE } from './flito-torre.productos-sql.js';

const UUID_BOLSA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** B2 (RN-TOR-I3): el inventario por estado admite además UN organismo (se suma al filtro; ausente o `null` = todos). */
export const inventarioSchema = z.object({
  filtro: filtroTorreSchema,
  organismo: z.string().regex(/^\d{5}$/, 'debe ser un código DIVIPOLA de 5 dígitos').nullable().optional(),
}).strict();

// ── Detalle universal (ADR-0047) ─────────────────────────────────────────────────────────────────────
// RN-TOR-D10: conjunto, segmento, columna de orden y campo desconocidos → 400; `tamano` ∈ {25, 50, 100};
//   `pagina*tamano ≤ FILAS_DETALLE_PAGINABLE_MAX`. El servicio vuelve a exigir cada regla.

const segmentoSchema = z.object({
  dimension: z.enum(DIMENSIONES_SEGMENTO_TORRE),
  valores: z.array(z.string().trim().min(1).max(40).nullable()).min(1).max(TOPES_TORRE.VALORES_SEGMENTO_MAX),
}).strict();

const origenSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('conjunto'), conjunto: z.enum(CONJUNTOS_TORRE_IDS) }).strict(),
  z.object({ tipo: z.literal('metrica'), metrica: z.enum(METRICAS_TORRE_IDS), fechaBase: z.enum(FECHAS_BASE_TORRE).optional() }).strict(),
]);

const filtrosDetalleSchema = z.object({
  placa: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,7}$/, 'debe tener de 3 a 7 letras y dígitos').optional(),
  companiaIds: z.array(z.number().int().positive()).max(50).optional(),
  estados: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
}).strict();

const baseDetalle = {
  origen: origenSchema,
  segmentos: z.array(segmentoSchema).max(TOPES_TORRE.SEGMENTOS_MAX).optional(),
  filtro: filtroTorreSchema,
  filtrosDetalle: filtrosDetalleSchema.optional(),
  orden: z.object({ columna: z.enum(COLUMNAS_DETALLE_IDS), dir: z.enum(['asc', 'desc']) }).strict().optional(),
};

type BaseDetalle = z.infer<z.ZodObject<typeof baseDetalle>>;

function refinarDetalle(c: BaseDetalle & { pagina?: number; tamano?: number }, ctx: z.RefinementCtx): void {
  const o = c.origen;
  const columnas = o.tipo === 'conjunto' ? conjuntoTorre(o.conjunto).columnas : DETALLE_METRICA_TORRE[o.metrica].columnas;
  for (const [i, s] of (c.segmentos ?? []).entries()) {
    const ok = o.tipo === 'conjunto'
      ? conjuntoTorre(o.conjunto).segmentosAdmitidos.includes(s.dimension)
      : (AGRUPACIONES_TORRE as readonly string[]).includes(s.dimension) && esAgrupacionPermitida(o.metrica, s.dimension as AgrupacionTorre);
    if (!ok) ctx.addIssue({ code: 'custom', message: 'esa dimensión no aplica a este detalle', path: ['segmentos', i, 'dimension'] });
    // B3 (RN-TOR-P4): `motivo` viaja como clave opaca (16 hex), nunca como el texto del motivo.
    if (s.dimension === 'motivo' && s.valores.some((v) => v != null && !CLAVE_MOTIVO_RE.test(v))) {
      ctx.addIssue({ code: 'custom', message: 'el motivo va como clave opaca', path: ['segmentos', i, 'valores'] });
    }
    // B4: `bolsa` es el uuid de la bolsa (opaco), sin «Sin valor».
    if (s.dimension === 'bolsa' && s.valores.some((v) => v == null || !UUID_BOLSA_RE.test(v))) {
      ctx.addIssue({ code: 'custom', message: 'la bolsa va como su identificador', path: ['segmentos', i, 'valores'] });
    }
  }
  if (c.orden && !(columnas.includes(c.orden.columna) && COLUMNAS_DETALLE[c.orden.columna].ordenable)) {
    ctx.addIssue({ code: 'custom', message: 'esa columna no se puede ordenar en este detalle', path: ['orden', 'columna'] });
  }
  if (o.tipo === 'metrica' && o.fechaBase && !esFechaBasePermitida(o.metrica, o.fechaBase)) {
    ctx.addIssue({ code: 'custom', message: 'esa fecha base no aplica a la métrica', path: ['origen', 'fechaBase'] });
  }
  if (c.pagina != null && c.tamano != null && c.pagina * c.tamano > TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX) {
    ctx.addIssue({ code: 'custom', message: `solo se pueden paginar los primeros ${TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX} registros`, path: ['pagina'] });
  }
}

export const consultaDetalleSchema = z.object({
  ...baseDetalle,
  pagina: z.number().int().min(1).default(1),
  tamano: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
}).strict().superRefine(refinarDetalle);

export const exportarDetalleSchema = z.object(baseDetalle).strict().superRefine(refinarDetalle);

/** 400 con el detalle legible de Zod. */
export function detalleZod(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ');
}
