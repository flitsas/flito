// Torre de Control Gerencial (Épica #14590, ADR-0047) — CONJUNTOS: el fragmento SQL ÚNICO detrás de cada cifra.
//
// RN-TOR-D1 (invariante central): la cifra de un tablero y el `total` de su detalle salen del MISMO fragmento
//   (`desde` + `base` + `propia`). El tablero cuenta con `contarConjuntos` (count(*) FILTER por conjunto, una consulta
//   por grupo de base) y el detalle lista con `listarConjunto`; nadie reescribe la condición.
// RN-TOR-D2: un segmento de agrupación usa `claveAgrupacion` (la misma expresión del Explorador); `null` = «Sin …».
// RN-TOR-D3: `severidad` = pasa del DOBLE del umbral (`critico`) o pasa del umbral sin llegar al doble (`atencion`).
// RN-TOR-D4: `nivel` (soportes) = `PUNTOS_SOPORTE` 0..3; (entregas) = `primer_intento` / `con_viajes`. `faltante`
//   = le falta ese soporte (OR entre los valores).
// RN-TOR-D5: `filtrosDetalle` se suma con AND; la placa es coincidencia por PREFIJO de `upper(plate_complete)` y llega
//   ya validada ([A-Z0-9]{3,7}: sin comodines de LIKE).
// RN-TOR-D6: el orden sale de una lista blanca (las columnas `ordenables` del contrato) y siempre se desempata por el
//   id de la entidad, para que la paginación sea estable. Ningún identificador sale del body.
// RN-TOR-D7: nunca se proyectan `flit_raw`, `compania_nit`, `flito_compradores`, el VIN ni direcciones: solo las
//   columnas declaradas aquí (placa, compañía, estado, fechas y montos).
// RN-TOR-D8: SOAT e impuesto sin gestión usan los predicados exportados de `flito-tablero` (`condSoatSinGestion`,
//   `condImpuestoSinGestion`), los mismos de `contarSinGestion` con que cuenta el radar.
import { inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  AGRUPACIONES_TORRE, VALORES_FALTANTE_SOPORTE, VALORES_NIVEL_ENTREGAS, VALORES_NIVEL_SOPORTES, conjuntoTorre,
  type AgrupacionTorre, type ClaveUmbralTorre, type ColumnaDetalleId, type ConjuntoTorreId, type EntidadTorre,
  type FiltrosDetalleTorre, type SegmentoDetalle,
} from '@operaciones/shared-types';
import {
  clients, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramites, siigoFacturaTramites,
} from '../../db/schema.js';
import { condicionPorCompania } from '../../shared/alcance-filas.js';
import { condImpuestoSinGestion, condSoatSinGestion } from '../flito-tablero/flito-tablero.service.js';
import {
  APROBADO, BORRADOR_ABANDONADO, DIMS_TRAMITE, EN_CURSO, ESTANCADO_OT, FACTURADO, FECHA_APROBACION, FECHA_CREACION,
  HORAS_CICLO, LIQUIDACION_VIGENTE, PUNTOS_SOPORTE, RADICADO, RECHAZADO, SOPORTE_DERECHO, SOPORTE_IMPUESTO,
  SOPORTE_SOAT, ULTIMO_CAMBIO_ESTADO, VIAJES_ADICIONALES, resolverDef,
} from './flito-torre.catalogo.js';
import {
  claveAgrupacion, condicionesTorre, donde, type DimensionesBase, type FechaBase, type RangoResuelto,
} from './flito-torre.filtro.js';
import type { Ejecutor } from './flito-torre.metricas.service.js';
import { TorreConsultaInvalidaError } from './flito-torre.service.js';
import { condTramites, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';

export type Umbrales = Record<ClaveUmbralTorre, number>;
export type ColsSql = Partial<Record<ColumnaDetalleId, SQL>>;

/** Para los conjuntos que no dependen de ningún umbral (`sin_facturar`, `margen_aprobados`…): su `propia` no lo lee. */
export const SIN_UMBRALES = Object.freeze({}) as Umbrales;

const T = flitoTramites;
const L = flitoLiquidaciones;
const SF = siigoFacturaTramites;
const I = flitoImpuestos;
const S = flitoSoat;

/** El fragmento resuelto: lo que cuentan los tableros y lo que lista el detalle. */
export interface FragmentoDetalle {
  entidad: EntidadTorre;
  /** `resourceTipo` de `pii_access_log` (la tabla de la entidad). */
  tabla: string;
  desde: SQL;
  /** Condiciones compartidas por todos los conjuntos del grupo (filtro + alcance + rango). */
  base: SQL[];
  /** Condiciones propias del conjunto + segmentos + filtros del detalle. */
  propia: SQL[];
  id: SQL;
  tramiteId: SQL | null;
  cols: ColsSql;
  dims: DimensionesBase;
  fecha?: FechaBase;
  rango: RangoResuelto | null;
  campoFecha: string;
}

// ── Columnas ───────────────────────────────────────────────────────────────────────────────────────────

const CREADO = sql`COALESCE(${T.fechaCreacionFlit}, ${T.createdAt})`;
const diasDesde = (e: SQL): SQL => sql`floor(EXTRACT(EPOCH FROM (now() - ${e})) / 86400)::int`;
const FACTURADO_EN = sql`(SELECT min(${SF.createdAt}) FROM ${SF} WHERE ${SF.tramiteId} = ${T.id} AND ${SF.activo} = true)`;
const FALTAN = sql`array_remove(ARRAY[CASE WHEN NOT ${SOPORTE_SOAT} THEN 'SOAT' END,
  CASE WHEN NOT ${SOPORTE_IMPUESTO} THEN 'Impuesto' END, CASE WHEN NOT ${SOPORTE_DERECHO} THEN 'Derecho' END]::text[], NULL)`;
/** Lo cobrado en la liquidación (los 5 componentes que suma el bloque de margen). */
export const COBRADO_LIQUIDACION = sql`(COALESCE(${L.valorTramiteDigital}, 0) + COALESCE(${L.valorSoat}, 0)
  + COALESCE(${L.valorImpuesto}, 0) + COALESCE(${L.valorDerecho}, 0) + COALESCE(${L.valorLogistica}, 0))`;

/** Columnas de un registro con `flito_tramites` en el `FROM` (compañía/organismo de la tabla base). */
export function colsTramite(dims: DimensionesBase = DIMS_TRAMITE): ColsSql {
  return {
    codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, compania: sql`${dims.compania}`,
    organismo: sql`${dims.organismo}`, tipo_tramite: sql`${T.tipoTramite}`, estado: sql`${T.flitEstado}`,
    creado_en: CREADO, aprobado_en: sql`${T.fechaAprobacion}`, facturado_en: FACTURADO_EN,
    dias_antiguedad: diasDesde(CREADO), dias_en_estado: diasDesde(ULTIMO_CAMBIO_ESTADO), faltan_soportes: FALTAN,
    horas_ciclo: HORAS_CICLO, viajes_adicionales: VIAJES_ADICIONALES,
  };
}

// ── Definición SQL de cada conjunto ────────────────────────────────────────────────────────────────────

interface ConjuntoSql {
  /** Conjuntos con el mismo grupo comparten `desde` + `base`: el tablero los cuenta en UNA consulta. */
  grupo: string;
  entidad: EntidadTorre;
  tabla: string;
  desde: SQL;
  base: (ctx: ContextoTablero, rango: RangoResuelto | null) => SQL[];
  propia: (u: Umbrales) => SQL[];
  dims: DimensionesBase;
  fecha?: FechaBase;
  campoFecha: string;
  id: SQL;
  tramiteId: SQL | null;
  cols: ColsSql;
  /** RN-TOR-D3: condición «pasa del doble del umbral». */
  critico?: (u: Umbrales) => SQL;
  /** RN-TOR-D4. */
  nivel?: { expr: SQL; valores: readonly string[] };
  faltante?: boolean;
}

const FOTO_TRAMITES = (ctx: ContextoTablero): SQL[] => condTramites(ctx, null, undefined, ['rango']);
const POR_CREACION = (ctx: ContextoTablero, r: RangoResuelto | null): SQL[] => condTramites(ctx, r, FECHA_CREACION);
const POR_APROBACION = (ctx: ContextoTablero, r: RangoResuelto | null): SQL[] => [APROBADO, ...condTramites(ctx, r, FECHA_APROBACION)];
const POR_APROBACION_LIQ = (ctx: ContextoTablero, r: RangoResuelto | null): SQL[] => [...POR_APROBACION(ctx, r), LIQUIDACION_VIGENTE];

const DESDE_LIQ = sql`${L} INNER JOIN ${T} ON ${T.id} = ${L.tramiteId}`;
const COLS_T = colsTramite();
const COLS_LIQ: ColsSql = { ...COLS_T, valor: COBRADO_LIQUIDACION };

const tramites = (grupo: string, base: ConjuntoSql['base'], propia: ConjuntoSql['propia'], extra: Partial<ConjuntoSql> = {}): ConjuntoSql => ({
  grupo, entidad: 'tramite', tabla: 'flito_tramite', desde: sql`${T}`, base, propia, dims: DIMS_TRAMITE,
  campoFecha: 'estado actual', id: sql`${T.id}`, tramiteId: sql`${T.id}`, cols: COLS_T, ...extra,
});

/** Gestión sin soporte (RN-TOR-D8): alcance + `companiaIds`, como `contarSinGestion`. */
function sinGestion(tipo: 'soat' | 'impuesto'): ConjuntoSql {
  const tabla = tipo === 'soat' ? S : I;
  const TR = sql.identifier('torre_tr');
  const desde = tipo === 'soat'
    ? sql`${S} INNER JOIN ${clients} ON ${clients.id} = ${S.companiaId}
      LEFT JOIN LATERAL (SELECT ${T.id} AS id, ${T.idFlit} AS id_flit, ${T.plateComplete} AS placa FROM ${T}
        WHERE ${T.soatId} = ${S.id} ORDER BY ${T.createdAt} ASC LIMIT 1) ${TR} ON true`
    : sql`${I} INNER JOIN ${clients} ON ${clients.id} = ${I.companiaId} LEFT JOIN ${T} ON ${T.id} = ${I.tramiteId}`;
  const horasSinGestion = sql`(EXTRACT(EPOCH FROM (now() - ${tabla.enviadoEn})) / 3600.0)`;
  const cols: ColsSql = tipo === 'soat'
    ? { codigo_flit: sql`${TR}.id_flit`, placa: sql`${TR}.placa` }
    : { codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}` };
  return {
    grupo: `sin_gestion_${tipo}`, entidad: tipo === 'soat' ? 'gestion_soat' : 'impuesto',
    tabla: tipo === 'soat' ? 'flito_soat' : 'flito_impuestos', desde,
    base: (ctx) => {
      const conds: SQL[] = [];
      const alc = condicionPorCompania(tabla.companiaId, ctx.alcance);
      if (alc) conds.push(alc);
      if (ctx.filtro.companiaIds?.length) conds.push(inArray(tabla.companiaId, ctx.filtro.companiaIds));
      return conds;
    },
    propia: (u) => [tipo === 'soat' ? condSoatSinGestion(u.horas_soat_impuesto_sin_soporte) : condImpuestoSinGestion(u.horas_soat_impuesto_sin_soporte)],
    critico: (u) => sql`${tabla.enviadoEn} < now() - make_interval(hours => ${u.horas_soat_impuesto_sin_soporte * 2})`,
    dims: { compania: tabla.companiaId, organismo: tabla.organismoCodigo, tipoTramite: tabla.estado, flitEstado: tabla.estado },
    campoFecha: 'enviado_en', id: sql`${tabla.id}`, tramiteId: tipo === 'soat' ? sql`${TR}.id` : sql`${T.id}`,
    cols: { ...cols, compania: sql`${tabla.companiaId}`, estado: sql`${tabla.estado}::text`, solicitado_en: sql`${tabla.enviadoEn}`, horas_sin_gestion: horasSinGestion },
  };
}

export const CONJUNTOS_SQL: Record<ConjuntoTorreId, ConjuntoSql> = {
  soat_sin_gestion: sinGestion('soat'),
  impuesto_sin_gestion: sinGestion('impuesto'),
  borrador_abandonado: tramites('tramite_foto', FOTO_TRAMITES, (u) => [BORRADOR_ABANDONADO(u.dias_borrador_abandonado)], {
    critico: (u) => BORRADOR_ABANDONADO(u.dias_borrador_abandonado * 2),
  }),
  estancado_ot: tramites('tramite_foto', FOTO_TRAMITES, (u) => [ESTANCADO_OT(u.dias_respuesta_ot)], {
    critico: (u) => ESTANCADO_OT(u.dias_respuesta_ot * 2),
  }),
  en_curso: tramites('tramite_foto', FOTO_TRAMITES, () => [EN_CURSO]),
  tramites_creados: tramites('tramite_creacion', POR_CREACION, () => [], { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit' }),
  radicados_cohorte: tramites('tramite_creacion', POR_CREACION, () => [RADICADO], { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit' }),
  aprobados_cohorte: tramites('tramite_creacion', POR_CREACION, () => [APROBADO], { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit' }),
  facturados_cohorte: tramites('tramite_creacion', POR_CREACION, () => [FACTURADO], { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit' }),
  rechazados_cohorte: tramites('tramite_creacion', POR_CREACION, () => [RECHAZADO], { fecha: FECHA_CREACION, campoFecha: 'fecha_creacion_flit' }),
  entregas_logistica: {
    ...tramites('liquidacion_aprobacion', POR_APROBACION_LIQ, () => [sql`${L.valorLogistica} > 0`], { fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion' }),
    entidad: 'liquidacion', tabla: 'flito_liquidaciones', desde: DESDE_LIQ, id: sql`${L.id}`, cols: COLS_LIQ,
    nivel: { expr: sql`(CASE WHEN ${VIAJES_ADICIONALES} = 0 THEN 'primer_intento' ELSE 'con_viajes' END)`, valores: VALORES_NIVEL_ENTREGAS },
  },
  // `= resolverDef('sin_facturar')`: el mismo `desde` (trámite + liquidación) y la misma condición que el Explorador.
  sin_facturar: tramites('tramite_liq_aprobacion', POR_APROBACION, () => [sql`NOT ${FACTURADO}`], {
    desde: resolverDef('sin_facturar').desde, fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    cols: { ...COLS_T, valor: sql`(CASE WHEN ${LIQUIDACION_VIGENTE} THEN ${L.total} END)` },
  }),
  soportes_aprobados: tramites('tramite_aprobacion', POR_APROBACION, () => [], {
    fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion',
    nivel: { expr: sql`(${PUNTOS_SOPORTE})::text`, valores: VALORES_NIVEL_SOPORTES }, faltante: true,
  }),
  margen_aprobados: {
    ...tramites('liquidacion_aprobacion', POR_APROBACION_LIQ, () => [], { fecha: FECHA_APROBACION, campoFecha: 'fecha_aprobacion' }),
    entidad: 'liquidacion', tabla: 'flito_liquidaciones', desde: DESDE_LIQ, id: sql`${L.id}`, cols: COLS_LIQ,
  },
};

// ── Segmentos y filtros del detalle ────────────────────────────────────────────────────────────────────

const enClave = (clave: SQL, valores: readonly (string | null)[]): SQL => {
  const conValor = valores.filter((v): v is string => v != null);
  const partes: SQL[] = [];
  if (conValor.length) partes.push(sql`${clave} IN ${conValor}`);
  if (valores.includes(null)) partes.push(sql`${clave} IS NULL`);
  return sql`(${sql.join(partes, sql` OR `)})`;
};

const esAgrupacion = (d: string): d is AgrupacionTorre => (AGRUPACIONES_TORRE as readonly string[]).includes(d);

const invalido = (detalle: string): never => { throw new TorreConsultaInvalidaError('segmentos', detalle); };

const SOPORTE_POR_FALTANTE: Record<(typeof VALORES_FALTANTE_SOPORTE)[number], SQL> = {
  soat: SOPORTE_SOAT, impuesto: SOPORTE_IMPUESTO, derecho: SOPORTE_DERECHO,
};

/** Condición de un segmento sobre un conjunto (RN-TOR-D2..D4). Valor fuera de lo admitido → 400. */
function condSegmento(c: ConjuntoSql | null, dims: DimensionesBase, fecha: FechaBase | undefined, u: Umbrales | null, s: SegmentoDetalle): SQL {
  if (esAgrupacion(s.dimension)) {
    if (!fecha && (s.dimension === 'dia' || s.dimension === 'semana' || s.dimension === 'mes' || s.dimension === 'trimestre')) {
      invalido('un corte de tiempo no aplica a una foto del momento');
    }
    return enClave(claveAgrupacion(s.dimension, dims, fecha), s.valores);
  }
  if (s.valores.includes(null)) invalido('ese segmento no admite «Sin valor»');
  const valores = s.valores as string[];
  if (s.dimension === 'severidad' && c?.critico && u) {
    if (!valores.every((v) => v === 'critico' || v === 'atencion')) invalido('severidad desconocida');
    const crit = c.critico(u);
    const partes = [...new Set(valores)].map((v) => (v === 'critico' ? crit : sql`NOT ${crit}`));
    return sql`(${sql.join(partes, sql` OR `)})`;
  }
  if (s.dimension === 'nivel' && c?.nivel) {
    if (!valores.every((v) => c.nivel!.valores.includes(v))) invalido('nivel desconocido');
    return sql`${c.nivel.expr} IN ${valores}`;
  }
  if (s.dimension === 'faltante' && c?.faltante) {
    if (!valores.every((v) => v in SOPORTE_POR_FALTANTE)) invalido('soporte desconocido');
    const partes = [...new Set(valores)].map((v) => sql`NOT ${SOPORTE_POR_FALTANTE[v as keyof typeof SOPORTE_POR_FALTANTE]}`);
    return sql`(${sql.join(partes, sql` OR `)})`;
  }
  return invalido('esa dimensión no aplica a este conjunto');
}

/** RN-TOR-D5. */
function condFiltrosDetalle(cols: ColsSql, dims: DimensionesBase, fd?: FiltrosDetalleTorre): SQL[] {
  if (!fd) return [];
  const conds: SQL[] = [];
  if (fd.placa && cols.placa) conds.push(sql`upper(${cols.placa}) LIKE ${`${fd.placa.toUpperCase()}%`}`);
  if (fd.companiaIds?.length) conds.push(inArray(dims.compania as AnyColumn, fd.companiaIds));
  if (fd.estados?.length && cols.estado) conds.push(sql`lower(${cols.estado}::text) IN ${fd.estados.map((e) => e.toLowerCase())}`);
  return conds;
}

/** El fragmento de un conjunto con su rango (foto = `null`), segmentos y filtros del detalle. */
export function fragmentoConjunto(
  id: ConjuntoTorreId, ctx: ContextoTablero, u: Umbrales, segmentos: readonly SegmentoDetalle[] = [], fd?: FiltrosDetalleTorre,
): FragmentoDetalle {
  const c = CONJUNTOS_SQL[id];
  const def = conjuntoTorre(id);
  const rango = def.fechaBase ? rangoTablero(ctx) : null;
  for (const s of segmentos) {
    if (!def.segmentosAdmitidos.includes(s.dimension)) invalido('esa dimensión no aplica a este conjunto');
  }
  return {
    entidad: c.entidad, tabla: c.tabla, desde: c.desde, base: c.base(ctx, rango),
    propia: [...c.propia(u), ...segmentos.map((s) => condSegmento(c, c.dims, c.fecha, u, s)), ...condFiltrosDetalle(c.cols, c.dims, fd)],
    id: c.id, tramiteId: c.tramiteId, cols: c.cols, dims: c.dims, fecha: c.fecha, rango, campoFecha: c.campoFecha,
  };
}

const TABLA_ENTIDAD: Partial<Record<EntidadTorre, { tabla: string; id: SQL }>> = {
  tramite: { tabla: 'flito_tramite', id: sql`${T.id}` },
  liquidacion: { tabla: 'flito_liquidaciones', id: sql`${L.id}` },
  impuesto: { tabla: 'flito_impuestos', id: sql`${I.id}` },
  derecho: { tabla: 'flito_derechos_tramite', id: sql`${flitoDerechosTramite.id}` },
};

/**
 * El fragmento de una métrica del Explorador: `resolverDef` tal cual (mismo `desde`, `fijas`, fecha y, en tiempo,
 * `requiere`), con los segmentos sobre `claveAgrupacion` (la misma expresión de la celda).
 */
export function fragmentoMetrica(
  def: ReturnType<typeof resolverDef>, entidad: EntidadTorre, ctx: ContextoTablero, rango: RangoResuelto | null,
  segmentos: readonly SegmentoDetalle[] = [], fd?: FiltrosDetalleTorre,
): FragmentoDetalle {
  const ent = TABLA_ENTIDAD[entidad] ?? TABLA_ENTIDAD.tramite!;
  const cols: ColsSql = { ...colsTramite(def.dims) };
  if (def.forma === 'suma' && def.valor) cols.valor = def.valor;
  if (def.forma === 'tasa' && def.valor) cols.aprobado = sql`(${def.valor})`;
  const base = [...def.fijas, ...condicionesTorre(ctx.filtro, ctx.alcance, def.dims, { rango, fecha: def.fecha })];
  if (def.requiere) base.push(def.requiere);
  return {
    entidad, tabla: ent.tabla, desde: def.desde, base,
    propia: [...segmentos.map((s) => condSegmento(null, def.dims, def.fecha, null, s)), ...condFiltrosDetalle(cols, def.dims, fd)],
    id: ent.id, tramiteId: sql`${T.id}`, cols, dims: def.dims, fecha: def.fecha, rango, campoFecha: def.campoFecha,
  };
}

// ── Contar y listar ────────────────────────────────────────────────────────────────────────────────────

export interface PedidoConteo { clave: string; conjunto: ConjuntoTorreId; segmentos?: SegmentoDetalle[] }

/**
 * RN-TOR-D1: varios conjuntos con el MISMO grupo (desde + base) → UNA consulta con `count(*) FILTER (WHERE propia_i)`.
 * Si no comparten base, una consulta por grupo.
 */
export async function contarConjuntos(
  q: Ejecutor, ctx: ContextoTablero, u: Umbrales, pedidos: readonly PedidoConteo[],
): Promise<Record<string, number>> {
  const grupos = new Map<string, { f: FragmentoDetalle; pedidos: { clave: string; propia: SQL[] }[] }>();
  for (const p of pedidos) {
    const f = fragmentoConjunto(p.conjunto, ctx, u, p.segmentos);
    const g = CONJUNTOS_SQL[p.conjunto].grupo;
    const actual = grupos.get(g) ?? { f, pedidos: [] };
    actual.pedidos.push({ clave: p.clave, propia: f.propia });
    grupos.set(g, actual);
  }
  const salida: Record<string, number> = {};
  for (const { f, pedidos: ps } of grupos.values()) {
    const cuentas = sql.join(ps.map((p, i) => sql`count(*) FILTER (WHERE ${donde(p.propia)})::int AS ${sql.identifier(`k${i}`)}`), sql`, `);
    const [fila] = await q<Record<string, unknown>>(sql`SELECT ${cuentas} FROM ${f.desde} WHERE ${donde(f.base)}`);
    ps.forEach((p, i) => { salida[p.clave] = Number(fila?.[`k${i}`] ?? 0); });
  }
  return salida;
}

/** Condición completa del fragmento. */
export const dondeFragmento = (f: FragmentoDetalle): SQL => donde([...f.base, ...f.propia]);

/** `total` y, si el fragmento tiene `valor`, su suma (= la celda de una métrica de suma). */
export async function totalFragmento(q: Ejecutor, f: FragmentoDetalle): Promise<{ total: number; valorTotal: number | null }> {
  const suma = f.cols.valor ? sql`, COALESCE(sum(${f.cols.valor}), 0)::numeric AS v` : sql``;
  const [fila] = await q<{ n: number; v?: string }>(sql`SELECT count(*)::int AS n${suma} FROM ${f.desde} WHERE ${dondeFragmento(f)}`);
  return { total: Number(fila?.n ?? 0), valorTotal: f.cols.valor ? Number(fila?.v ?? 0) : null };
}

export interface OrdenFragmento { columna: ColumnaDetalleId; dir: 'asc' | 'desc' }

/** RN-TOR-D6: filas crudas (sin etiquetar) en el orden de la lista blanca, desempatadas por el id. */
export async function listarFragmento(
  q: Ejecutor, f: FragmentoDetalle, columnas: readonly ColumnaDetalleId[], orden: OrdenFragmento, limite: number, offset: number,
): Promise<Record<string, unknown>[]> {
  const proyeccion = columnas.filter((c) => f.cols[c]).map((c) => sql`${f.cols[c]} AS ${sql.identifier(c)}`);
  const expr = f.cols[orden.columna];
  if (!expr) throw new TorreConsultaInvalidaError('orden', 'esa columna no se puede ordenar en este detalle');
  const dir = orden.dir === 'asc' ? sql`ASC` : sql`DESC`;
  const tramite = f.tramiteId ? sql`${f.tramiteId}::text` : sql`NULL::text`;
  return q(sql`SELECT ${f.id}::text AS __id, ${tramite} AS __tramite${proyeccion.length ? sql`, ${sql.join(proyeccion, sql`, `)}` : sql``}
    FROM ${f.desde} WHERE ${dondeFragmento(f)}
    ORDER BY ${expr} ${dir} NULLS LAST, ${f.id} ASC LIMIT ${limite} OFFSET ${offset}`);
}
