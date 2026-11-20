// Torre de Control Gerencial (Épica #14590, B4) — piezas SQL de LOGÍSTICA (traslados, actas, viajes) y de FINANCIERA
// (facturas y cola de Siigo, bolsas, movimientos y boletas): el `FROM`, las dimensiones y las columnas del detalle. Las
// usan los conjuntos (`flito-torre.conjuntos-logistica.ts`) y los tableros, así que la cifra y su detalle no discrepan.
//
// RN-TOR-LG1 (Ley 1581, diseño §12 B4): ninguna columna proyecta `direccion_entrega`, `contacto_*`, `receptor_*`,
//   `entrega_nombre`, `entregado_lat/lng`, storage keys, el mensajero ni `motivo_detalle` de un viaje (texto libre). El
//   motivo de devolución del acta (texto libre) sigue RN-TOR-P4: motivo corto en la columna, clave opaca en el segmento.
// RN-TOR-LG2: traslado abierto = `registrado` o `en_ruta`; «más de N días» = registrado hace más de N días (el doble es
//   crítico, RN-TOR-D3).
// RN-TOR-LG3: acta de entrega = `punto = 'cliente'` (las de organismo son recogidas). Pendiente = `generada`/`despachada`
//   sin `entregado_en`; devuelta = `devuelta`, anclada a su creación (no hay fecha de devolución).
// RN-TOR-LG4: la factura se ve con su PRIMER trámite (LATERAL `flito_tramites`, como el SOAT de B3): compañía y
//   filtros salen del trámite. Error sin corregir = `requiere_revision`, o un `error_code` de una factura no emitida
//   cuyo trámite no volvió a quedar en otra factura activa. El error se muestra como TEXTO LEGIBLE de `TEXTO_ERROR_SIIGO`
//   (nunca el código crudo ni `error_detalle`/payload); sin traducción, «Error de Siigo, ver la factura.».
// RN-TOR-LG5: cola detenida = trámite de un lote encolado, sin factura activa, con el próximo intento ya vencido
//   (`pendiente`/`error`) o `fallido_definitivo` (agotó los intentos).
// RN-TOR-LG6 (= RN-TOR-FI1, ahora en SQL): bolsa de compañía activa; consumo = salidas de los últimos 30 días hasta hoy
//   (Bogotá, o `ctx.hoy`); días = saldo / (consumo / 30) a 1 decimal; saldo ≤ 0 = 0 días y crítico; sin consumo = `null`
//   y al día. Crítico < `dias_cobertura_rojo`, atención < `dias_cobertura_amarillo`. El tablero Financiero (B1) y el
//   conjunto `bolsas_cobertura` usan ESTA expresión.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { ColumnaDetalleId } from '@operaciones/shared-types';
import {
  flitoBolsasUnicas, flitoBolsasUnicasMovimientos, flitoConciliacionBoletas, flitoLogisticaActaLineas, flitoLogisticaActas,
  flitoLogisticaDocumentos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados, flitoProveedoresLogistica, flitoTramiteViajesLogistica,
  flitoTramites, siigoColaFacturacion, siigoFacturaEstadosDian, siigoFacturaTramites, siigoFacturas, siigoLoteTramites,
} from '../../db/schema.js';
import { sumarDias, type DimensionesBase, type FechaBase } from './flito-torre.filtro.js';
import { motivoCorto } from './flito-torre.productos-sql.js';

type Cols = Partial<Record<ColumnaDetalleId, SQL>>;

const T = flitoTramites;
const TR = flitoLogisticaTraslados;
const A = flitoLogisticaActas;
const PL = flitoProveedoresLogistica;
const V = flitoTramiteViajesLogistica;
const F = siigoFacturas;
const SFT = siigoFacturaTramites;
const C = siigoColaFacturacion;
const LT = siigoLoteTramites;
const B = flitoBolsasUnicas;
const M = flitoBolsasUnicasMovimientos;
const BO = flitoConciliacionBoletas;

const NULO_TEXTO = sql`NULL::text` as unknown as AnyColumn;
const diasDesde = (e: AnyColumn | SQL): SQL => sql`floor(EXTRACT(EPOCH FROM (now() - ${e})) / 86400)::int`;
/** Días como intervalo (el umbral es `numeric`: admite decimales). */
const dias = (n: number): SQL => sql`(${n}::numeric * interval '1 day')`;
/** Dimensiones de una tabla que solo tiene compañía. */
const soloCompania = (compania: AnyColumn): DimensionesBase => ({ compania, organismo: NULO_TEXTO, tipoTramite: NULO_TEXTO, flitEstado: NULO_TEXTO });
/** Dimensiones del trámite (sin `diasEnEstado`: ninguna de estas entidades corta por tramo). */
const DIMS_DEL_TRAMITE: DimensionesBase = { compania: T.companiaId, organismo: T.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado };
const COLS_DEL_TRAMITE: Cols = {
  codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, compania: sql`${T.companiaId}`, organismo: sql`${T.organismoCodigo}`,
};

// ── Traslados ──────────────────────────────────────────────────────────────────────────────────────────

export const DESDE_TRASLADOS = sql`${TR}`;
export const DIMS_TRASLADO = soloCompania(TR.companiaId);
export const ESTADOS_TRASLADO_ABIERTO = ['registrado', 'en_ruta'] as const;
/** RN-TOR-LG2. */
export const TRASLADO_ABIERTO = sql`${TR.estado} IN ('registrado', 'en_ruta')`;
export const trasladoMasDe = (n: number): SQL => sql`(${TRASLADO_ABIERTO} AND ${TR.registradoEn} < now() - ${dias(n)})`;
const PUNTO = (e: AnyColumn): SQL => sql`(CASE ${e} WHEN 'organismo' THEN 'Secretaría' WHEN 'flit' THEN 'FLIT' WHEN 'cliente' THEN 'Compañía' ELSE ${e} END)`;
export const COLS_TRASLADO: Cols = {
  codigo_traslado: sql`upper(left(${TR.id}::text, 8))`, compania: sql`${TR.companiaId}`, origen: PUNTO(TR.origen), destino: PUNTO(TR.destino),
  estado: sql`${TR.estado}::text`, registrado_en: sql`${TR.registradoEn}`,
  dias_abierto: sql`(CASE WHEN ${TRASLADO_ABIERTO} THEN ${diasDesde(TR.registradoEn)} END)`,
  n_tramites: sql`(SELECT count(DISTINCT torre_d.tramite_id)::int FROM ${flitoLogisticaTrasladoLts} torre_l
    INNER JOIN ${flitoLogisticaDocumentos} torre_d ON torre_d.id = torre_l.documento_id WHERE torre_l.traslado_id = ${TR.id})`,
};
export const ETIQUETA_RUTA = (origen: string, destino: string): string =>
  `${origen === 'flit' ? 'FLIT' : 'Secretaría'} → ${destino === 'flit' ? 'FLIT' : 'Compañía'}`;

// ── Actas de entrega ───────────────────────────────────────────────────────────────────────────────────

export const DESDE_ACTAS = sql`${A} LEFT JOIN ${PL} ON ${PL.id} = ${A.proveedorLogisticaId}`;
export const DIMS_ACTA = soloCompania(A.companiaId);
export const FECHA_ACTA_CREACION: FechaBase = { expr: A.createdAt };
/** RN-TOR-LG3. */
export const ACTA_DE_ENTREGA = sql`${A.punto} = 'cliente'`;
export const ACTA_PENDIENTE = sql`(${A.estado} IN ('generada', 'despachada') AND ${A.entregadoEn} IS NULL)`;
export const ACTA_DEVUELTA = sql`${A.estado} = 'devuelta'`;
/** Placas de los documentos del acta (por `acta_id` del documento —actas viejas— o por sus líneas, ADR-0030). */
const PLACAS_ACTA = sql`ARRAY(SELECT DISTINCT torre_t.plate_complete FROM ${T} torre_t WHERE torre_t.plate_complete IS NOT NULL
  AND torre_t.id IN (SELECT torre_d.tramite_id FROM ${flitoLogisticaDocumentos} torre_d WHERE torre_d.acta_id = ${A.id}
    UNION SELECT torre_d2.tramite_id FROM ${flitoLogisticaActaLineas} torre_al
      INNER JOIN ${flitoLogisticaDocumentos} torre_d2 ON torre_d2.id = torre_al.documento_id WHERE torre_al.acta_id = ${A.id})
  ORDER BY 1)`;
export const COLS_ACTA: Cols = {
  placas: PLACAS_ACTA, compania: sql`${A.companiaId}`, proveedor_logistica: sql`${PL.nombre}`, creado_en: sql`${A.createdAt}`,
  estado: sql`${A.estado}::text`, dias_antiguedad: diasDesde(A.createdAt), entregado_en: sql`${A.entregadoEn}`,
  motivo: motivoCorto(A.motivoDevolucion),
};

// ── Viajes adicionales ─────────────────────────────────────────────────────────────────────────────────

export const DESDE_VIAJES = sql`${V} INNER JOIN ${T} ON ${T.id} = ${V.tramiteId}`;
export const DIMS_VIAJE = DIMS_DEL_TRAMITE;
export const FECHA_VIAJE: FechaBase = { expr: V.registradoEn };
export const COLS_VIAJE: Cols = {
  ...COLS_DEL_TRAMITE, numero_viaje: sql`${V.numero}`, registrado_en: sql`${V.registradoEn}`, valor: sql`${V.valor}`,
  // El motivo es del catálogo cerrado (CHECK); `motivo_detalle` (texto libre) no se proyecta.
  motivo: sql`(CASE ${V.motivo} WHEN 'devolucion' THEN 'Devolución' WHEN 'segunda_entrega' THEN 'Segunda entrega'
    WHEN 'documento_faltante' THEN 'Documento faltante' ELSE 'Otro' END)`,
};

// ── Facturas de Siigo ──────────────────────────────────────────────────────────────────────────────────

/** RN-TOR-LG4: el primer trámite de la factura (activo o no: la fallida liberó el suyo). */
export const DESDE_FACTURAS = sql`${F} LEFT JOIN LATERAL (SELECT torre_t1.* FROM ${T} torre_t1
    INNER JOIN ${SFT} torre_ft ON torre_ft.tramite_id = torre_t1.id WHERE torre_ft.factura_id = ${F.id}
    ORDER BY torre_ft.created_at ASC, torre_ft.id ASC LIMIT 1) ${sql.identifier('flito_tramites')} ON true`;
export const DIMS_FACTURA = DIMS_DEL_TRAMITE;
export const FECHA_FACTURA_ENVIO: FechaBase = { expr: F.enviadaEn };
export const FACTURA_EMITIDA = sql`${F.estado} = 'emitida'`;
/** RN-TOR-LG4: la fallida cuenta mientras su trámite no esté en OTRA factura activa. */
export const FACTURA_CON_ERROR = sql`(${F.requiereRevision} OR (${F.errorCode} IS NOT NULL AND ${F.estado} <> 'emitida'
  AND NOT EXISTS (SELECT 1 FROM ${SFT} torre_a INNER JOIN ${SFT} torre_b ON torre_b.tramite_id = torre_a.tramite_id
    AND torre_b.activo AND torre_b.factura_id <> torre_a.factura_id WHERE torre_a.factura_id = ${F.id})))`;
/** El último estado ante la DIAN (por `secuencia`, nunca por fecha) es `rechazada`. */
export const FACTURA_RECHAZADA_DIAN = sql`(SELECT torre_ed.estado FROM ${siigoFacturaEstadosDian} torre_ed
  WHERE torre_ed.factura_id = ${F.id} ORDER BY torre_ed.secuencia DESC LIMIT 1) = 'rechazada'`;

/**
 * RN-TOR-LG4: texto legible por `error_code`. Los códigos son los que escriben `facturacion.emision.service.ts` y
 * `facturacion.trabajador.service.ts` (el trabajador antepone `emision_` a los de datos).
 */
export const TEXTO_ERROR_SIIGO: Readonly<Record<string, string>> = {
  siigo_no_responde: 'Siigo no respondió al envío.',
  requests_limit: 'Siigo frenó los envíos por exceso de peticiones.',
  error_interno: 'El envío falló por un error interno de FLITO.',
  sin_configuracion: 'Falta la configuración de emisión de Siigo.',
  sin_mapeo: 'Falta el mapeo de conceptos con Siigo.',
  sin_tramites: 'La factura no tiene trámites para facturar.',
  datos: 'Siigo rechazó los datos de la factura.',
  credenciales_rechazadas: 'Siigo rechazó las credenciales de la integración.',
  sin_credenciales: 'Faltan las credenciales de Siigo.',
  integracion_frenada: 'La integración con Siigo está frenada.',
  sin_factura_local: 'No se encontró la factura en FLITO.',
  no_elegible: 'El trámite ya no se podía facturar.',
  emision_en_curso: 'La emisión sigue en curso en Siigo.',
  sin_desenlace: 'Siigo no confirmó el resultado del envío.',
  reconciliacion_indeterminada: 'No se pudo confirmar en Siigo si la factura existe.',
};
export const TEXTO_ERROR_SIIGO_GENERICO = 'Error de Siigo, ver la factura.';
export const TEXTO_FACTURA_EN_REVISION = 'Quedó marcada para revisión.';
const CODIGOS_ERROR: [string, string][] = Object.entries(TEXTO_ERROR_SIIGO).flatMap(([k, v]): [string, string][] => [[k, v], [`emision_${k}`, v]]);
/** Parametrizado (nunca concatenado): cada código y su texto viajan como parámetros. */
export const ERROR_FACTURA_LEGIBLE = sql`(CASE WHEN ${F.errorCode} IS NULL THEN (CASE WHEN ${F.requiereRevision} THEN ${TEXTO_FACTURA_EN_REVISION}::text END)
  ${sql.join(CODIGOS_ERROR.map(([k, v]) => sql`WHEN ${F.errorCode} = ${k}::text THEN ${v}::text`), sql` `)}
  ELSE ${TEXTO_ERROR_SIIGO_GENERICO}::text END)`;
export const COLS_FACTURA: Cols = {
  numero_factura: sql`${F.numero}`, codigo_flit: sql`${T.idFlit}`, compania: sql`${T.companiaId}`, estado: sql`${F.estado}::text`,
  enviada_en: sql`${F.enviadaEn}`, valor: sql`${F.totalSiigo}`, dias_antiguedad: diasDesde(F.createdAt), error_factura: ERROR_FACTURA_LEGIBLE,
};

// ── Cola de facturación ────────────────────────────────────────────────────────────────────────────────

export const DESDE_COLA = sql`${LT} INNER JOIN ${C} ON ${C.loteId} = ${LT.loteId} INNER JOIN ${T} ON ${T.id} = ${LT.tramiteId}`;
export const DIMS_COLA = DIMS_DEL_TRAMITE;
const COLA_AGOTADA = sql`${C.estado} = 'fallido_definitivo'`;
/** RN-TOR-LG5. */
export const COLA_DETENIDA = sql`(((${C.estado} IN ('pendiente', 'error') AND ${C.proximoIntentoAt} < now()) OR ${COLA_AGOTADA})
  AND NOT EXISTS (SELECT 1 FROM ${SFT} torre_v WHERE torre_v.tramite_id = ${LT.tramiteId} AND torre_v.activo))`;
export const NIVEL_COLA = sql`(CASE WHEN ${COLA_AGOTADA} THEN 'agotado' ELSE 'vencido' END)`;
export const COLS_COLA: Cols = {
  ...COLS_DEL_TRAMITE, situacion_cola: sql`(CASE WHEN ${COLA_AGOTADA} THEN 'Intentos agotados' ELSE 'Reintento vencido' END)`,
  intentos: sql`${C.intentos}`, proximo_intento: sql`${C.proximoIntentoAt}`, solicitado_en: sql`${C.createdAt}`,
};

// ── Bolsas (RN-TOR-LG6) ────────────────────────────────────────────────────────────────────────────────

export const DIAS_CONSUMO_BOLSA = 30;
const MOV = sql.identifier('torre_mov');
/** El `FROM` con el consumo de los últimos 30 días hasta `hoy` (incluido). */
export const desdeBolsas = (hoy: string): SQL => sql`${B} CROSS JOIN LATERAL (SELECT COALESCE(sum(${M.valor}), 0) AS v FROM ${M}
    WHERE ${M.bolsaId} = ${B.id} AND ${M.tipo} = 'salida' AND ${M.fecha} >= ${sumarDias(hoy, -(DIAS_CONSUMO_BOLSA - 1))}::date) ${MOV}`;
export const DIMS_BOLSA = soloCompania(B.companiaId);
export const BOLSA_DE_COMPANIA_ACTIVA = [sql`${B.activa} = true`, sql`${B.companiaId} IS NOT NULL`];
export const CONSUMO_30 = sql`${MOV}.v`;
export const DIAS_COBERTURA = sql`(CASE WHEN ${B.saldo} <= 0 THEN 0::numeric
  WHEN ${MOV}.v > 0 THEN round(${B.saldo} / (${MOV}.v / ${DIAS_CONSUMO_BOLSA}::numeric), 1) END)`;
export const BOLSA_AGOTADA = sql`${B.saldo} <= 0`;
/** Bajo `dias` de cobertura (o sin saldo). */
export const coberturaBajo = (diasUmbral: number): SQL => sql`(${BOLSA_AGOTADA} OR (${MOV}.v > 0 AND ${DIAS_COBERTURA} < ${diasUmbral}::numeric))`;
export const severidadBolsa = (rojo: number, amarillo: number): SQL =>
  sql`(CASE WHEN ${coberturaBajo(rojo)} THEN 'critico' WHEN ${coberturaBajo(amarillo)} THEN 'atencion' ELSE 'ok' END)`;
const ETIQUETA_SEVERIDAD = (s: SQL): SQL => sql`(CASE ${s} WHEN 'critico' THEN 'Crítico' WHEN 'atencion' THEN 'Atención' ELSE 'Al día' END)`;
export const COLS_BOLSA: Cols = {
  compania: sql`${B.companiaId}`, saldo: sql`${B.saldo}`, consumo_diario: sql`round(${MOV}.v / ${DIAS_CONSUMO_BOLSA}::numeric, 1)`,
  dias_cobertura: DIAS_COBERTURA,
};
/** La columna del semáforo depende de los umbrales vigentes. */
export const colsBolsaConUmbrales = (rojo: number, amarillo: number): Cols => ({ severidad: ETIQUETA_SEVERIDAD(severidadBolsa(rojo, amarillo)) });

// ── Movimientos de bolsa ───────────────────────────────────────────────────────────────────────────────

export const DESDE_MOVIMIENTOS = sql`${M} INNER JOIN ${B} ON ${B.id} = ${M.bolsaId} LEFT JOIN ${T} ON ${T.id} = ${M.tramiteId}`;
export const DIMS_MOVIMIENTO: DimensionesBase = { compania: B.companiaId, organismo: M.organismoCodigo, tipoTramite: T.tipoTramite, flitEstado: T.flitEstado };
export const FECHA_MOVIMIENTO: FechaBase = { expr: M.fecha, esDate: true };
export const BOLSA_DEL_MOVIMIENTO = sql`${M.bolsaId}::text`;
export const TIPO_MOVIMIENTO = sql`${M.tipo}`;
export const COLS_MOVIMIENTO: Cols = {
  compania: sql`${B.companiaId}`, tipo_movimiento: sql`(CASE ${M.tipo} WHEN 'entrada' THEN 'Recarga' ELSE 'Consumo' END)`,
  fecha_movimiento: sql`${M.fecha}`, codigo_flit: sql`${T.idFlit}`, placa: sql`${T.plateComplete}`, valor: sql`${M.valor}`,
};

// ── Boletas de conciliación ────────────────────────────────────────────────────────────────────────────

export const DESDE_BOLETAS = sql`${BO}`;
export const DIMS_BOLETA = soloCompania(BO.companiaId);
export const BOLETA_SIN_CONCILIAR = sql`${BO.estado} = 'cargada'`;
export const BOLETA_CON_DIFERENCIA = sql`(${BOLETA_SIN_CONCILIAR} AND ${BO.totalCruzado} IS NOT NULL AND ${BO.totalCruzado} <> ${BO.totalDeclarado})`;
export const COLS_BOLETA: Cols = {
  referencia: sql`${BO.referencia}`, compania: sql`${BO.companiaId}`, estado: sql`${BO.estado}::text`, fecha_pago: sql`${BO.fechaPago}`,
  total_declarado: sql`${BO.totalDeclarado}`, total_cruzado: sql`${BO.totalCruzado}`,
  diferencia: sql`(${BO.totalDeclarado} - COALESCE(${BO.totalCruzado}, 0))`, creado_en: sql`${BO.createdAt}`, dias_antiguedad: diasDesde(BO.createdAt),
};
