// Torre de Control Gerencial (Épica #14590, B5) — piezas SQL de Operativa › EQUIPO: la GESTIÓN con autor (el
// funcionario que la registró) como una sola tabla derivada `torre_gestion`, sobre la que cuentan el tablero y lista el
// detalle (RN-TOR-D1: la cifra y su detalle salen del MISMO fragmento).
//
// RN-TOR-EQ1 (fuentes, diseño §12 B5): una gestión es un movimiento con autor de:
//   · un trámite: cambio de `flit_estado` en `flito_tramite_historial`;
//   · un SOAT o un impuesto: cambio de estado en `flito_estado_historial` (concepto `soat`/`impuesto`) y la marca de
//     gestión de operaciones (`gestion_operaciones_por_id` / `_en`). `enviado_por_id` NO entra: el envío ya deja su
//     cambio de estado `pendiente → solicitado` en `flito_estado_historial` y contarlo dos veces inflaría la cifra;
//   · un derecho: su registro (`registrado_por_id`, `created_at`);
//   · un traslado: su registro (`registrado_por_id`, `registrado_en`);
//   · una solicitud incompleta de SOAT: su resolución (`resuelta_por_id`, `resuelta_en`).
// RN-TOR-EQ2 (Ley 1581): del funcionario solo se proyecta `users.name`. `flito_estado_historial.usuario_email` no se
//   lee en ninguna rama (ni en el SELECT ni en un WHERE); del titular, solo la placa y el código FLIT.
// RN-TOR-EQ3 (gestiones del periodo): cada movimiento con autor cuya fecha cae en el periodo cuenta una vez; un mismo
//   trámite puede sumar varias gestiones.
// RN-TOR-EQ4 (carga abierta, foto): por cada registro ABIERTO (trámite en curso = `EN_CURSO`; SOAT o impuesto sin
//   pagar; traslado registrado o en camino) se toma su ÚLTIMO movimiento (de cualquiera, incluido el sistema: `DISTINCT
//   ON (registro) … ORDER BY fecha DESC`). Cuenta para el funcionario si ese último movimiento es suyo. Derechos e
//   incompletas resueltas no quedan abiertos (su único movimiento con autor los cierra).
// RN-TOR-EQ5 (fuera de ANS): de la carga abierta, la que lleva desde su último movimiento más de: 2 días el trámite
//   (`ANS_OPERATIVO.SIN_APROBAR_DIAS`), `horas_soat_impuesto_sin_soporte` horas el SOAT o el impuesto y
//   `dias_traslado_abierto` días el traslado (estos dos, de Umbrales y alertas).
// RN-TOR-EQ6: la gestión solo tiene compañía (la del registro): el resto del filtro global no aplica.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { ANS_OPERATIVO, type ColumnaDetalleId } from '@operaciones/shared-types';
import {
  flitoDerechosTramite, flitoEstadoHistorial, flitoImpuestos, flitoLogisticaTraslados, flitoSoat, flitoSoatIncompletas,
  flitoTramiteHistorial, flitoTramites, users,
} from '../../db/schema.js';
import { EN_CURSO } from './flito-torre.catalogo.js';
import type { DimensionesBase, FechaBase } from './flito-torre.filtro.js';
import { TRASLADO_ABIERTO } from './flito-torre.logistica-sql.js';

type Cols = Partial<Record<ColumnaDetalleId, SQL>>;

const T = flitoTramites;
const H = flitoTramiteHistorial;
const EH = flitoEstadoHistorial;
const S = flitoSoat;
const I = flitoImpuestos;
const D = flitoDerechosTramite;
const TR = flitoLogisticaTraslados;
const SI = flitoSoatIncompletas;

/** El alias de la tabla derivada (sus columnas se nombran a mano: no es una tabla de Drizzle). */
const G = sql.identifier('torre_gestion');
const col = (c: string): SQL => sql`${G}.${sql.identifier(c)}`;
const NULO_TEXTO = sql`NULL::text` as unknown as AnyColumn;

/** El primer trámite de un SOAT (como `sin_gestion` de B1): placa y código salen de él. */
const TRAMITE_DEL_SOAT = sql`LEFT JOIN LATERAL (SELECT ${T.id} AS id, ${T.idFlit} AS id_flit, ${T.plateComplete} AS placa FROM ${T}
  WHERE ${T.soatId} = ${S.id} ORDER BY ${T.createdAt} ASC LIMIT 1) torre_ts ON true`;

const SOAT_ABIERTO = sql`${S.estado} <> 'pagado'`;
const IMPUESTO_ABIERTO = sql`${I.estado} <> 'pagado'`;

/**
 * RN-TOR-EQ1: las ramas del `UNION ALL`, todas con las mismas columnas y en el mismo orden:
 * `g_id, usuario_id, fecha, tipo, registro, tramite_id, placa, codigo_flit, compania_id, estado_evento, estado_actual`.
 * `abierta` = condición de registro abierto de la rama (RN-TOR-EQ4); `null` = la rama nunca queda abierta.
 */
interface Rama { select: SQL; abierta: SQL | null }

const RAMAS: readonly Rama[] = [
  {
    select: sql`SELECT 'th:' || ${H.id}::text, ${H.usuarioId}, ${H.createdAt}, 'tramite'::text, 'tramite:' || ${T.id}::text, ${T.id},
      ${T.plateComplete}::text, ${T.idFlit}::text, ${T.companiaId}, ${H.valorNuevo}::text, ${T.flitEstado}::text
      FROM ${H} INNER JOIN ${T} ON ${T.id} = ${H.tramiteId} WHERE ${H.campo} = 'flit_estado'`,
    abierta: EN_CURSO,
  },
  {
    select: sql`SELECT 'eh:' || ${EH.id}::text, ${EH.usuarioId}, ${EH.createdAt}, 'soat'::text, 'soat:' || ${S.id}::text, torre_ts.id,
      torre_ts.placa::text, torre_ts.id_flit::text, ${S.companiaId}, ${EH.estadoNuevo}::text, ${S.estado}::text
      FROM ${EH} INNER JOIN ${S} ON ${S.id} = ${EH.registroId} ${TRAMITE_DEL_SOAT} WHERE ${EH.concepto} = 'soat'`,
    abierta: SOAT_ABIERTO,
  },
  {
    select: sql`SELECT 'eh:' || ${EH.id}::text, ${EH.usuarioId}, ${EH.createdAt}, 'impuesto'::text, 'impuesto:' || ${I.id}::text, ${T.id},
      ${T.plateComplete}::text, ${T.idFlit}::text, ${I.companiaId}, ${EH.estadoNuevo}::text, ${I.estado}::text
      FROM ${EH} INNER JOIN ${I} ON ${I.id} = ${EH.registroId} LEFT JOIN ${T} ON ${T.id} = ${I.tramiteId} WHERE ${EH.concepto} = 'impuesto'`,
    abierta: IMPUESTO_ABIERTO,
  },
  {
    select: sql`SELECT 'so:' || ${S.id}::text, ${S.gestionOperacionesPorId}, ${S.gestionOperacionesEn}, 'soat'::text, 'soat:' || ${S.id}::text,
      torre_ts.id, torre_ts.placa::text, torre_ts.id_flit::text, ${S.companiaId}, 'gestion_operaciones'::text, ${S.estado}::text
      FROM ${S} ${TRAMITE_DEL_SOAT} WHERE ${S.gestionOperacionesPorId} IS NOT NULL AND ${S.gestionOperacionesEn} IS NOT NULL`,
    abierta: SOAT_ABIERTO,
  },
  {
    select: sql`SELECT 'io:' || ${I.id}::text, ${I.gestionOperacionesPorId}, ${I.gestionOperacionesEn}, 'impuesto'::text, 'impuesto:' || ${I.id}::text,
      ${T.id}, ${T.plateComplete}::text, ${T.idFlit}::text, ${I.companiaId}, 'gestion_operaciones'::text, ${I.estado}::text
      FROM ${I} LEFT JOIN ${T} ON ${T.id} = ${I.tramiteId}
      WHERE ${I.gestionOperacionesPorId} IS NOT NULL AND ${I.gestionOperacionesEn} IS NOT NULL`,
    abierta: IMPUESTO_ABIERTO,
  },
  {
    select: sql`SELECT 'de:' || ${D.id}::text, ${D.registradoPorId}, ${D.createdAt}, 'derecho'::text, 'derecho:' || ${D.id}::text, ${T.id},
      ${T.plateComplete}::text, ${T.idFlit}::text, COALESCE(${D.companiaId}, ${T.companiaId}), 'registrado'::text, 'registrado'::text
      FROM ${D} LEFT JOIN ${T} ON ${T.id} = ${D.tramiteId} WHERE ${D.registradoPorId} IS NOT NULL`,
    abierta: null,
  },
  {
    select: sql`SELECT 'tr:' || ${TR.id}::text, ${TR.registradoPorId}, ${TR.registradoEn}, 'traslado'::text, 'traslado:' || ${TR.id}::text,
      NULL::uuid, NULL::text, NULL::text, ${TR.companiaId}, 'registrado'::text, ${TR.estado}::text
      FROM ${TR} WHERE ${TR.registradoPorId} IS NOT NULL`,
    abierta: TRASLADO_ABIERTO,
  },
  {
    select: sql`SELECT 'si:' || ${SI.id}::text, ${SI.resueltaPorId}, ${SI.resueltaEn}, 'incompleta'::text, 'incompleta:' || ${SI.id}::text,
      NULL::uuid, ${SI.placa}::text, NULL::text, ${SI.companiaId}, ${SI.estado}::text, ${SI.estado}::text
      FROM ${SI} WHERE ${SI.resueltaPorId} IS NOT NULL AND ${SI.resueltaEn} IS NOT NULL`,
    abierta: null,
  },
];

const COLUMNAS_DERIVADA = sql.raw('(g_id, usuario_id, fecha, tipo, registro, tramite_id, placa, codigo_flit, compania_id, estado_evento, estado_actual)');
const FUNCIONARIO = sql`LEFT JOIN ${users} ON ${users.id} = ${col('usuario_id')}`;

/** RN-TOR-EQ3: todos los movimientos (con y sin autor). El rango del periodo baja a cada rama por la columna `fecha`. */
export const DESDE_GESTIONES = sql`(${sql.join(RAMAS.map((r) => r.select), sql` UNION ALL `)}) ${G} ${COLUMNAS_DERIVADA} ${FUNCIONARIO}`;

/** RN-TOR-EQ4: el último movimiento de cada registro abierto (el filtro de abierto va DENTRO de cada rama). */
const RAMAS_ABIERTAS = RAMAS.filter((r): r is Rama & { abierta: SQL } => r.abierta != null).map((r) => sql`${r.select} AND ${r.abierta}`);
export const DESDE_CARGA = sql`(SELECT DISTINCT ON (torre_ev.registro) torre_ev.* FROM
  (${sql.join(RAMAS_ABIERTAS, sql` UNION ALL `)}) torre_ev ${COLUMNAS_DERIVADA}
  ORDER BY torre_ev.registro, torre_ev.fecha DESC, torre_ev.g_id DESC) ${G} ${FUNCIONARIO}`;

export const DIMS_GESTION: DimensionesBase = {
  compania: col('compania_id') as unknown as AnyColumn, organismo: NULO_TEXTO, tipoTramite: NULO_TEXTO, flitEstado: NULO_TEXTO,
};
export const FECHA_GESTION: FechaBase = { expr: col('fecha') };
export const ID_GESTION = col('g_id');
export const ID_REGISTRO = col('registro');
export const TRAMITE_GESTION = col('tramite_id');
/** El segmento `funcionario` (= `users.id`, como texto para `enClave`). */
export const FUNCIONARIO_GESTION = sql`${col('usuario_id')}::text`;
export const USUARIO_GESTION = col('usuario_id');
export const CON_AUTOR = sql`${col('usuario_id')} IS NOT NULL`;

const HORAS_DESDE = sql`(EXTRACT(EPOCH FROM (now() - ${col('fecha')})) / 3600.0)`;
/** RN-TOR-EQ5. */
export const fueraDeAns = (horasSoatImpuesto: number, diasTraslado: number): SQL => sql`(CASE ${col('tipo')}
  WHEN 'tramite' THEN ${HORAS_DESDE} > ${ANS_OPERATIVO.SIN_APROBAR_DIAS * 24}::numeric
  WHEN 'soat' THEN ${HORAS_DESDE} > ${horasSoatImpuesto}::numeric
  WHEN 'impuesto' THEN ${HORAS_DESDE} > ${horasSoatImpuesto}::numeric
  WHEN 'traslado' THEN ${HORAS_DESDE} > (${diasTraslado}::numeric * 24)
  ELSE false END)`;

const QUE = sql`(CASE ${col('tipo')} WHEN 'tramite' THEN 'Trámite' WHEN 'soat' THEN 'SOAT' WHEN 'impuesto' THEN 'Impuesto'
  WHEN 'derecho' THEN 'Derecho' WHEN 'traslado' THEN 'Traslado' ELSE 'Solicitud' END)`;
const COMUNES: Cols = {
  placa: col('placa'), codigo_flit: col('codigo_flit'), que_se_gestiono: QUE, compania: col('compania_id'),
  // RN-TOR-EQ2: solo el nombre.
  funcionario: sql`${users.name}`,
};
/** Detalle de las gestiones del periodo: el estado que dejó ESE movimiento. */
export const COLS_EVENTO: Cols = { ...COMUNES, estado: col('estado_evento'), gestionado_en: col('fecha') };
/** Detalle de la carga y de lo fuera de ANS: el estado actual del registro y su último movimiento. */
export const COLS_CARGA: Cols = {
  ...COMUNES, estado: col('estado_actual'), ultimo_movimiento: col('fecha'), horas_desde_movimiento: sql`round(${HORAS_DESDE}, 1)`,
};
