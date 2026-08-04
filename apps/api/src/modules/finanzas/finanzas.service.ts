// Finanzas — Reporte de costos por trámite (contabilidad / facturación / cobros).
//
// Cada fila es de una de dos naturalezas, y la diferencia importa:
//   SELLADA   — el trámite está liquidado: se muestran los valores congelados. Aunque hoy la tarifa
//               de la compañía sea otra, lo que se cobró fue eso.
//   ESTIMADA  — aún sin liquidar: se calcula en vivo con lo pagado y las tarifas vigentes. Puede
//               cambiar mañana, y por eso viaja marcada como estimada.
//
// Ya no hay conceptos inventados. Antes existía `COSTOS_FIJOS = { derechoTramite: 75000,
// logistica: 15000, tramiteDigital: 300000, gmf: 7000 }`, cuatro constantes iguales para todos los
// clientes que se sumaban a TODOS los trámites del reporte.

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgSelect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  clients, flitoDerechosTramite, flitoExcepcionesAutogestion, flitoImpuestos, flitoLiquidaciones,
  flitoOrganismoVigencias, flitoSoat, flitoTarifasCompania, flitoTramites, vehicles,
} from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import { TASA_GMF } from '../flito-liquidacion/flito-liquidacion.service.js';

/**
 * En qué punto del ciclo de cobro está el trámite. Son cuatro cajones EXCLUYENTES, y entre los
 * cuatro cubren todo el universo del reporte: cada trámite cae exactamente en uno.
 *
 *   listo        — sin liquidar y con todos sus conceptos resueltos: se puede sellar hoy mismo.
 *   incompleto   — sin liquidar y le falta algo (una tarifa, un recibo, un pago). No se puede sellar.
 *   por_facturar — liquidado, todavía sin facturar.
 *   facturado    — ya facturado.
 *
 * Antes esto se pedía combinando `liquidado` y `facturado` a mano, y «listo para liquidar» no se
 * podía pedir de ninguna manera: era justo la pregunta con la que se entra a esta pantalla.
 */
export const ETAPAS = ['listo', 'incompleto', 'por_facturar', 'facturado'] as const;
export type EtapaReporte = (typeof ETAPAS)[number];

export interface FiltrosReporte {
  buscar?: string; estados?: string[]; empresas?: string[]; tipos?: string[];
  etapa?: EtapaReporte;
  /** true = solo trámites con TODOS los conceptos aplicables documentados (filtro inteligente). */
  documentacionCompleta?: boolean;
  /** Rango sobre la fecha de creación del trámite, en formato yyyy-mm-dd. */
  desde?: string; hasta?: string;
  /** Rango sobre la fecha de aprobación, en formato yyyy-mm-dd. Independiente del anterior. */
  aprobadoDesde?: string; aprobadoHasta?: string;
  page?: number; pageSize?: number;
}

/** `null` = no aplica o no configurado. NUNCA cero: un cero implícito cuadra totales falsos. */
export interface FilaReporte {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  /** Vehículo, homologado con las demás tablas. */
  vin: string | null; marca: string | null; linea: string | null;
  tipoTramite: string | null;
  /** Fecha en que FLIT aprobó el trámite. null mientras siga esperando aprobación. */
  fechaAprobacion: string | null;
  /** Fecha de FLIT, no la de ingesta del sync. */
  fechaCreacion: string | null;
  soat: number | null; impuesto: number | null;
  derechoTramite: number | null; logistica: number | null; tramiteDigital: number | null;
  gmf: number | null; total: number | null;
  /** true = valores congelados por una liquidación; false = estimados en vivo. */
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  /** Conceptos sin tarifa configurada. Si hay alguno, el total es incompleto. */
  noConfigurados: string[];
  /** Conceptos que esperan su documento pagado, no una tarifa. Hoy solo el derecho de tránsito. */
  sinRecibo: string[];
  /** Conceptos que FLITO gestiona y todavía no tienen valor pagado (SOAT, impuesto). Bloquean. */
  pendientesPago: string[];
  /** Conceptos que la compañía se gestiona por su cuenta: FLITO no los cobra ni los espera. */
  autogestionados: string[];
  /** Conceptos que no aplican por el organismo, no por la compañía. Hoy solo el impuesto. */
  noAplican: string[];
}

export interface TotalesReporte {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number;
  /** Cuántas filas del universo filtrado tienen algún concepto sin configurar. */
  filasIncompletas: number;
}
/** Cuántos trámites hay en cada etapa bajo los filtros actuales (sin contar el de etapa). */
export interface ResumenEtapas { listo: number; incompleto: number; porFacturar: number; facturado: number }

export interface ReporteCostos {
  items: FilaReporte[]; total: number; page: number; pageSize: number;
  totales: TotalesReporte; resumen: ResumenEtapas;
}

// Alias para resolver la tarifa: la específica del tipo y la genérica. Cada join casa a lo sumo una
// fila gracias al índice único, así que un COALESCE entre ambas da la que manda, sin LATERAL.
const tdEsp = alias(flitoTarifasCompania, 'td_esp');
const tdGen = alias(flitoTarifasCompania, 'td_gen');
const lgEsp = alias(flitoTarifasCompania, 'lg_esp');
const lgGen = alias(flitoTarifasCompania, 'lg_gen');

const TIPO_NORM = sql`UPPER(TRIM(COALESCE(${flitoTramites.tipoTramite}, '')))`;

// Cada alias tiene su propio nombre literal en el tipo, así que no son intercambiables sin la unión.
type AliasTarifa = typeof tdEsp | typeof tdGen | typeof lgEsp | typeof lgGen;

function joinTarifa(a: AliasTarifa, concepto: string, especifica: boolean): SQL {
  return especifica
    ? sql`${a.companiaId} = ${flitoTramites.companiaId} AND ${a.concepto} = ${concepto} AND ${a.activo} AND ${a.tipoTramite} = ${TIPO_NORM}`
    : sql`${a.companiaId} = ${flitoTramites.companiaId} AND ${a.concepto} = ${concepto} AND ${a.activo} AND ${a.tipoTramite} IS NULL`;
}

// ── Expresiones de valor. Sellada manda; si no, se estima. ───────────────────
//
// No se usa COALESCE(sellado, estimado): en una liquidación sellada, NULL significa «no aplica», y
// un COALESCE lo reemplazaría por el estimado, resucitando un concepto que se decidió no cobrar.
const seLiquido = sql`${flitoLiquidaciones.id} IS NOT NULL`;

// ── Quién gestiona cada concepto. Es la parametrización, y decide TODO lo demás: lo que FLITO
// gestiona se cobra, se exige para liquidar y se pinta como ausencia si falta; lo que no gestiona no
// se cobra, no estorba y se dice que no aplica.
//
// Hay compañías que se gestionan su propio SOAT, su propio impuesto o su propia logística; a las que
// lo autogestionan todo solo se les cobra el trámite digital y el derecho de tránsito.
const AUTO_SOAT = sql`COALESCE(${clients.soatAutogestionable}, false)`;
const AUTO_IMPUESTO = sql`COALESCE(${clients.impuestosAutogestionable}, false)`;
const AUTO_LOGISTICA = sql`COALESCE(${clients.logisticaAutogestionable}, false)`;

// El desbloqueo excepcional POR TRÁMITE (HU #10980) gana a la autogestión de la compañía: una que
// autogestiona puede encargarle a FLITO trámites puntuales, y en esos FLITO desembolsa de verdad.
// Es la misma frontera que ya usan las colas de SOAT e impuestos (`NOT autogestiona OR excepción`).
const EXC_SOAT = sql`COALESCE(${flitoSoat.excepcionAutogestion}, false)`;
const EXC_IMPUESTO = sql`COALESCE(${flitoImpuestos.excepcionAutogestion}, false)`;
/** La logística no tiene registro propio donde marcar: la lleva la excepción vigente del trámite. */
const EXC_LOGISTICA = sql`(${flitoExcepcionesAutogestion.id} IS NOT NULL)`;

const GESTIONA_SOAT = sql`(NOT ${AUTO_SOAT} OR ${EXC_SOAT})`;
const GESTIONA_LOGISTICA = sql`(NOT ${AUTO_LOGISTICA} OR ${EXC_LOGISTICA})`;

/**
 * RN-01 Impuestos, en SQL: es el espejo de `flitoGestionaImpuesto` de shared-types, que es la que
 * aplican el sync y la liquidación. El impuesto tiene DOS ejes —la compañía y el organismo—, y sin
 * vigencia abierta el default del dominio es `autogestionado`: FLITO no lo gestiona. Salvo que se le
 * haya encargado ese trámite en concreto.
 */
const GESTIONA_IMPUESTO = sql`((NOT ${AUTO_IMPUESTO}
  AND COALESCE(${flitoOrganismoVigencias.modalidad}, 'autogestionado') = 'requiere_gestion')
  OR ${EXC_IMPUESTO})`;

const EXPR_SOAT = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorSoat}
  WHEN NOT ${GESTIONA_SOAT} THEN NULL
  WHEN ${flitoSoat.estado} = 'pagado' THEN ${flitoSoat.valorPagado} END`;

const EXPR_IMPUESTO = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorImpuesto}
  WHEN NOT ${GESTIONA_IMPUESTO} THEN NULL
  WHEN ${flitoImpuestos.estado} = 'pagado' THEN ${flitoImpuestos.valorPagado} END`;

const EXPR_DERECHO = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorDerecho}
  ELSE ${flitoDerechosTramite.valor} END`;

const EXPR_DIGITAL = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorTramiteDigital}
  ELSE COALESCE(${tdEsp.valor}, ${tdGen.valor}) END`;

const EXPR_LOGISTICA = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorLogistica}
  WHEN NOT ${GESTIONA_LOGISTICA} THEN NULL
  ELSE COALESCE(${lgEsp.valor}, ${lgGen.valor}) END`;

// Base del 4x1000: el total de los cinco conceptos del trámite. El GMF se calcula sobre esa suma y
// se añade encima, así que el total final es la base más su propio gravamen.
const EXPR_BASE_GMF = sql`COALESCE(${EXPR_SOAT}, 0) + COALESCE(${EXPR_IMPUESTO}, 0) + COALESCE(${EXPR_DERECHO}, 0)
  + COALESCE(${EXPR_DIGITAL}, 0) + COALESCE(${EXPR_LOGISTICA}, 0)`;
const EXPR_GMF = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.valorGmf}
  ELSE ROUND((${EXPR_BASE_GMF}) * ${TASA_GMF}, 2) END`;

const EXPR_TOTAL = sql`CASE WHEN ${seLiquido} THEN ${flitoLiquidaciones.total}
  ELSE (${EXPR_BASE_GMF}) + ROUND((${EXPR_BASE_GMF}) * ${TASA_GMF}, 2) END`;

// ── Qué impide liquidar. Es la MISMA regla que aplica `calcular()` en flito-liquidacion, concepto
// por concepto, escrita en SQL para poder filtrar y contar sobre el universo entero.
//
// Tenía que estar completa, no aproximada: la versión anterior solo miraba derecho, logística y
// trámite digital, así que un trámite con el SOAT o el impuesto sin pagar salía como liquidable, se
// ofrecía su botón «Liquidar» activo y el backend lo rechazaba al pulsarlo.
//
// «No aplica» y «falta» se deciden por la PARAMETRIZACIÓN, no por si existe el registro: lo que
// FLITO gestiona para esa compañía tiene que tener valor, exista o no la fila. La ausencia de fila
// era la pista equivocada — el sync tampoco la crea cuando el trámite no llegó a Asignado o le
// faltaba emparejar compañía u organismo, y ahí sí falta de verdad.

// El pago, en positivo. `= 'pagado'` sobre un enum nulo da NULL, así que el COALESCE de fuera es el
// que convierte «no hay fila» en «no está pagado» en vez de en «no se sabe».
const SOAT_PAGADO = sql`(${flitoSoat.estado} = 'pagado' AND ${flitoSoat.valorPagado} IS NOT NULL)`;
const IMPUESTO_PAGADO = sql`(${flitoImpuestos.estado} = 'pagado' AND ${flitoImpuestos.valorPagado} IS NOT NULL)`;

const BLOQUEA_SOAT = sql`(${GESTIONA_SOAT} AND NOT COALESCE(${SOAT_PAGADO}, false))`;
const BLOQUEA_IMPUESTO = sql`(${GESTIONA_IMPUESTO} AND NOT COALESCE(${IMPUESTO_PAGADO}, false))`;

/** El derecho de tránsito no se configura: se lee del recibo. Sin recibo, falta un costo real. */
const BLOQUEA_DERECHO = sql`${flitoDerechosTramite.valor} IS NULL`;

/** Honorarios de FLITO: sin tarifa negociada no hay nada que cobrar sin inventárselo. */
const BLOQUEA_DIGITAL = sql`COALESCE(${tdEsp.valor}, ${tdGen.valor}) IS NULL`;
const BLOQUEA_LOGISTICA = sql`(${GESTIONA_LOGISTICA} AND COALESCE(${lgEsp.valor}, ${lgGen.valor}) IS NULL)`;

const EXPR_BLOQUEADA = sql`(${BLOQUEA_SOAT} OR ${BLOQUEA_IMPUESTO} OR ${BLOQUEA_DERECHO}
  OR ${BLOQUEA_DIGITAL} OR ${BLOQUEA_LOGISTICA})`;

/**
 * Una fila está incompleta si algún concepto que SÍ debería tener valor no lo tiene. Las
 * liquidaciones selladas nunca lo están: no se pudieron sellar sin resolverlo todo.
 */
const EXPR_INCOMPLETA = sql`(NOT ${seLiquido} AND ${EXPR_BLOQUEADA})`;

/** Sin liquidar y sin nada pendiente: se puede sellar hoy. Es la cola de trabajo del reporte. */
const EXPR_LISTA = sql`(NOT ${seLiquido} AND NOT ${EXPR_BLOQUEADA})`;

/**
 * Documentación completa: cada concepto que APLICA tiene al menos un soporte sin descartar.
 *
 * «Aplica» no es lo mismo que «existe»: si la compañía autogestiona el SOAT, ese trámite nunca
 * tendrá un comprobante de SOAT en FLITO y exigírselo lo dejaría eternamente incompleto. Por eso
 * cada concepto se salta cuando su compañía lo autogestiona.
 *
 * Se mide sobre `flito_soportes` —el documento— y no sobre el valor. Un trámite puede tener valor
 * de SOAT porque se liquidó y aun así no tener el PDF cargado, y para facturar hace falta el papel.
 *
 * Logística vive aparte, en `flito_logistica_documentos`: sus documentos nacen del flujo de entrega,
 * no de una carga de comprobantes.
 */
const EXPR_DOC_COMPLETA = sql`(
     (NOT ${GESTIONA_SOAT} OR EXISTS (
        SELECT 1 FROM flito_soportes s WHERE s.soat_id = ${flitoTramites.soatId} AND NOT s.descartado))
  -- El impuesto se salta con la MISMA regla con la que se exige (RN-01, los dos ejes): si el
  -- organismo no lo entrega en gestión, ese soporte no va a existir nunca y pedirlo dejaba al
  -- trámite eternamente «incompleto de papeles» por una decisión que no es de la compañía.
  AND (NOT ${GESTIONA_IMPUESTO} OR EXISTS (
        SELECT 1 FROM flito_soportes s WHERE s.impuesto_id = ${flitoImpuestos.id} AND NOT s.descartado))
  AND EXISTS (
        SELECT 1 FROM flito_soportes s WHERE s.derecho_id = ${flitoDerechosTramite.id} AND NOT s.descartado)
  AND (NOT ${GESTIONA_LOGISTICA} OR EXISTS (
        SELECT 1 FROM flito_logistica_documentos d WHERE d.tramite_id = ${flitoTramites.id}))
)`;

function condiciones(f: FiltrosReporte): SQL[] {
  const conds: SQL[] = [];
  const t = f.buscar?.trim();
  if (t) {
    const patron = `%${t.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${t.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
    )!);
  }
  if (f.estados?.length) conds.push(inArray(flitoTramites.flitEstado, f.estados));
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  if (f.tipos?.length) conds.push(inArray(flitoTramites.tipoTramite, f.tipos));
  if (f.etapa === 'listo') conds.push(EXPR_LISTA);
  if (f.etapa === 'incompleto') conds.push(EXPR_INCOMPLETA);
  if (f.etapa === 'por_facturar') conds.push(sql`${flitoLiquidaciones.estado} = 'liquidado'`);
  if (f.etapa === 'facturado') conds.push(sql`${flitoLiquidaciones.estado} = 'facturado'`);
  if (f.documentacionCompleta) conds.push(EXPR_DOC_COMPLETA);

  // Los dos rangos son inclusivos por día: `hasta` suma un día para no dejar fuera esa jornada.
  //
  // El de creación mira `fecha_creacion_flit`, que es cuándo NACIÓ el trámite en FLIT, no
  // `created_at`, que es cuándo el sync lo ingirió. Filtrar por `created_at` hacía que los miles de
  // históricos traídos en la carga masiva compartieran una única fecha y el filtro fuera inservible.
  // El COALESCE cubre los trámites viejos cuyo reporte aún no traía el campo.
  const nacimiento = sql`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`;
  if (f.desde) conds.push(sql`${nacimiento} >= ${f.desde}::date`);
  if (f.hasta) conds.push(sql`${nacimiento} < (${f.hasta}::date + INTERVAL '1 day')`);
  if (f.aprobadoDesde) conds.push(sql`${flitoTramites.fechaAprobacion} >= ${f.aprobadoDesde}::date`);
  if (f.aprobadoHasta) conds.push(sql`${flitoTramites.fechaAprobacion} < (${f.aprobadoHasta}::date + INTERVAL '1 day')`);
  return conds;
}

/**
 * Todos los joins del reporte, en un solo sitio. Los comparten la página, el conteo, los totales y
 * la exportación: si el conteo y la página no llevan exactamente los mismos joins, el total y las
 * filas dejan de cuadrar sin que nada avise.
 */
function conJoins<Q extends PgSelect>(q: Q) {
  return q
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .leftJoin(flitoLiquidaciones, eq(flitoLiquidaciones.tramiteId, flitoTramites.id))
    // Vigencia ABIERTA del organismo: es la que dice si hoy FLITO gestiona sus impuestos. El índice
    // único deja como mucho una por organismo, así que no multiplica filas.
    .leftJoin(flitoOrganismoVigencias, and(
      eq(flitoOrganismoVigencias.organismoCodigo, flitoTramites.organismoCodigo),
      isNull(flitoOrganismoVigencias.hasta),
    ))
    // Desbloqueo excepcional VIGENTE de la logística (HU #10980). SOAT e impuesto llevan su marca en
    // el propio registro; la logística no tiene registro donde marcarla. El índice parcial impide
    // dos excepciones vivas del mismo concepto, así que no multiplica filas.
    .leftJoin(flitoExcepcionesAutogestion, and(
      eq(flitoExcepcionesAutogestion.tramiteId, flitoTramites.id),
      eq(flitoExcepcionesAutogestion.concepto, 'logistica'),
      isNull(flitoExcepcionesAutogestion.revocadoEn),
    ))
    .leftJoin(tdEsp, joinTarifa(tdEsp, 'tramite_digital', true))
    .leftJoin(tdGen, joinTarifa(tdGen, 'tramite_digital', false))
    .leftJoin(lgEsp, joinTarifa(lgEsp, 'logistica', true))
    .leftJoin(lgGen, joinTarifa(lgGen, 'logistica', false));
}

const SELECT_FILA = {
  tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit,
  placa: vehicles.plate, estado: flitoTramites.flitEstado, empresa: clients.name,
  // Homologación con las demás tablas: al vehículo le faltaban VIN, marca y línea; al trámite, la
  // fecha de creación.
  vin: vehicles.vin, marca: vehicles.brand, linea: vehicles.model,
  tipoTramite: flitoTramites.tipoTramite,
  fechaAprobacion: flitoTramites.fechaAprobacion,
  // `nacimiento` ya se usa para filtrar por rango; aquí se proyecta para poder mostrarla.
  fechaCreacion: sql<Date | null>`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`,
  sellada: sql<boolean>`${seLiquido}`,
  estadoLiquidacion: flitoLiquidaciones.estado,
  soat: sql<string | null>`${EXPR_SOAT}`,
  impuesto: sql<string | null>`${EXPR_IMPUESTO}`,
  derechoTramite: sql<string | null>`${EXPR_DERECHO}`,
  tramiteDigital: sql<string | null>`${EXPR_DIGITAL}`,
  logistica: sql<string | null>`${EXPR_LOGISTICA}`,
  gmf: sql<string | null>`${EXPR_GMF}`,
  totalFila: sql<string | null>`${EXPR_TOTAL}`,
  // Por qué falta cada cosa. Se resuelve en SQL —donde ya está la regla— y no en el cliente
  // adivinando desde el valor nulo: null significa cosas distintas según la compañía.
  soatPendiente: sql<boolean>`${BLOQUEA_SOAT}`,
  impuestoPendiente: sql<boolean>`${BLOQUEA_IMPUESTO}`,
  // Qué gestiona FLITO en ESTE trámite, ya con el desbloqueo excepcional aplicado. Las banderas de
  // la compañía van aparte porque solo sirven para redactar el motivo, no para decidir.
  gestionaSoat: sql<boolean>`${GESTIONA_SOAT}`,
  gestionaImpuesto: sql<boolean>`${GESTIONA_IMPUESTO}`,
  gestionaLogistica: sql<boolean>`${GESTIONA_LOGISTICA}`,
  soatAutogestionable: sql<boolean>`${AUTO_SOAT}`,
  impuestosAutogestionable: sql<boolean>`${AUTO_IMPUESTO}`,
  logisticaAutogestionable: sql<boolean>`${AUTO_LOGISTICA}`,
} as const;

const n = (v: string | number | null): number | null => (v === null ? null : Number(v));

function aFila(r: Record<string, unknown>): FilaReporte {
  const sellada = Boolean(r.sellada);
  const digital = n(r.tramiteDigital as string | null);
  const logistica = n(r.logistica as string | null);
  const derecho = n(r.derechoTramite as string | null);

  // Tres motivos distintos para que falte un valor, y confundirlos hace daño:
  //
  //   noConfigurados — falta la TARIFA negociada con la compañía. Se resuelve en Clientes y
  //                    proveedores. Solo aplica a logística y trámite digital, que son honorarios
  //                    de FLITO y por eso se pactan cliente a cliente.
  //   sinRecibo      — el derecho de tránsito NO se configura: es un desembolso real que se lee del
  //                    recibo pagado, igual que el SOAT y el impuesto. Si falta, lo que falta es el
  //                    documento, no un parámetro. Decir «no configurado» mandaba a quien lo leyera
  //                    a buscar una pantalla de configuración que no existe.
  //   pendientesPago — el SOAT o el impuesto están comprados pero todavía sin pagar. No es que no
  //                    apliquen: es que su valor aún no existe. Faltaban en esta lista, así que la
  //                    fila se ofrecía liquidable, el botón salía activo y el sellado fallaba al
  //                    pulsarlo, que es donde el reporte y la liquidación se contradecían.
  //
  // Los tres impiden liquidar: sellar sin la tarifa congelaría un cobro inventado, sin el recibo un
  // total al que le falta un costo que existe, y sin el pago un cobro que todavía no ha ocurrido.
  const noConfigurados: string[] = [];
  const sinRecibo: string[] = [];
  const pendientesPago: string[] = [];
  if (!sellada) {
    if (r.soatPendiente) pendientesPago.push('SOAT');
    if (r.impuestoPendiente) pendientesPago.push('Impuesto');
    if (derecho === null) sinRecibo.push('Derecho de tránsito');
    if (digital === null) noConfigurados.push('Trámite digital');
    if (logistica === null && r.gestionaLogistica) noConfigurados.push('Logística');
  }

  // Lo que la compañía se gestiona sola —y que FLITO no le ha desbloqueado en este trámite—. Sin
  // esto, su celda vacía se leía igual que la de un concepto que falta, y no es lo mismo: aquí no
  // hay nada que perseguir.
  const autogestionados: string[] = [];
  if (r.soatAutogestionable && !r.gestionaSoat) autogestionados.push('SOAT');
  if (r.impuestosAutogestionable && !r.gestionaImpuesto) autogestionados.push('Impuesto');
  if (r.logisticaAutogestionable && !r.gestionaLogistica) autogestionados.push('Logística');

  // Y lo que no aplica por el ORGANISMO: la compañía sí querría que FLITO le gestionara el impuesto,
  // pero ese organismo no lo entrega en gestión. Decir «autogestiona» ahí señalaría al cliente por
  // una decisión que no es suya.
  const noAplican: string[] = [];
  if (!r.gestionaImpuesto && !r.impuestosAutogestionable) noAplican.push('Impuesto');

  return {
    tramiteId: r.tramiteId as string, idFlit: r.idFlit as string,
    placa: r.placa as string | null, estado: r.estado as string | null,
    empresa: r.empresa as string | null, tipoTramite: r.tipoTramite as string | null,
    vin: r.vin as string | null, marca: r.marca as string | null, linea: r.linea as string | null,
    fechaAprobacion: aIso(r.fechaAprobacion),
    fechaCreacion: aIso(r.fechaCreacion),
    soat: n(r.soat as string | null), impuesto: n(r.impuesto as string | null),
    derechoTramite: derecho, logistica, tramiteDigital: digital,
    gmf: n(r.gmf as string | null), total: n(r.totalFila as string | null),
    sellada,
    estadoLiquidacion: (r.estadoLiquidacion as FilaReporte['estadoLiquidacion']) ?? null,
    noConfigurados,
    sinRecibo,
    pendientesPago,
    autogestionados,
    noAplican,
  };
}

/**
 * Totales del UNIVERSO FILTRADO, agregados en SQL.
 *
 * Antes se calculaban con un `reduce` sobre la página, así que un filtro de 3.000 trámites mostraba
 * el total de los 50 visibles y lo rotulaba «Totales».
 */
async function totalesDe(where: SQL | undefined): Promise<TotalesReporte> {
  const [t] = await conJoins(db.select({
    soat: sql<string>`COALESCE(SUM(${EXPR_SOAT}), 0)`,
    impuesto: sql<string>`COALESCE(SUM(${EXPR_IMPUESTO}), 0)`,
    derechoTramite: sql<string>`COALESCE(SUM(${EXPR_DERECHO}), 0)`,
    tramiteDigital: sql<string>`COALESCE(SUM(${EXPR_DIGITAL}), 0)`,
    logistica: sql<string>`COALESCE(SUM(${EXPR_LOGISTICA}), 0)`,
    gmf: sql<string>`COALESCE(SUM(${EXPR_GMF}), 0)`,
    total: sql<string>`COALESCE(SUM(${EXPR_TOTAL}), 0)`,
    filasIncompletas: sql<number>`COUNT(*) FILTER (WHERE ${EXPR_INCOMPLETA})::int`,
  }).from(flitoTramites).$dynamic()).where(where);

  return {
    soat: Number(t.soat), impuesto: Number(t.impuesto), derechoTramite: Number(t.derechoTramite),
    tramiteDigital: Number(t.tramiteDigital), logistica: Number(t.logistica),
    gmf: Number(t.gmf), total: Number(t.total), filasIncompletas: Number(t.filasIncompletas),
  };
}

/**
 * Cuántos trámites hay en cada etapa, con TODOS los demás filtros puestos menos la etapa misma.
 *
 * Va en la respuesta para que las pestañas de etapa puedan llevar su número: sin él hay que entrar
 * en cada una para saber si tiene trabajo dentro, que son cuatro consultas a ojo por cada vez que
 * alguien cambia de empresa o de mes.
 */
async function resumenDe(where: SQL | undefined): Promise<ResumenEtapas> {
  // COUNT(DISTINCT) y no COUNT(*), igual que el total: un trámite con dos filas en alguno de los
  // joins contaría dos veces y el número de la pestaña no cuadraría con el de la tabla.
  const cuenta = (cond: SQL) => sql<number>`COUNT(DISTINCT ${flitoTramites.id}) FILTER (WHERE ${cond})::int`;
  const [r] = await conJoins(db.select({
    listo: cuenta(EXPR_LISTA),
    incompleto: cuenta(EXPR_INCOMPLETA),
    porFacturar: cuenta(sql`${flitoLiquidaciones.estado} = 'liquidado'`),
    facturado: cuenta(sql`${flitoLiquidaciones.estado} = 'facturado'`),
  }).from(flitoTramites).$dynamic()).where(where);

  return {
    listo: Number(r.listo), incompleto: Number(r.incompleto),
    porFacturar: Number(r.porFacturar), facturado: Number(r.facturado),
  };
}

export async function reporteCostos(f: FiltrosReporte = {}): Promise<ReporteCostos> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
  const conds = condiciones(f);
  const where = conds.length ? and(...conds) : undefined;
  // El resumen ignora la etapa elegida a propósito: si contara solo dentro de ella, las otras tres
  // pestañas marcarían cero y parecería que no queda nada por hacer.
  const condsSinEtapa = condiciones({ ...f, etapa: undefined });
  const whereSinEtapa = condsSinEtapa.length ? and(...condsSinEtapa) : undefined;

  const [countRows, rows, totales, resumen] = await Promise.all([
    conJoins(db.select({ total: sql<number>`count(distinct ${flitoTramites.id})::int` })
      .from(flitoTramites).$dynamic()).where(where),
    conJoins(db.select(SELECT_FILA).from(flitoTramites).$dynamic()).where(where)
      .orderBy(sql`${flitoTramites.createdAt} DESC`).limit(pageSize).offset((page - 1) * pageSize),
    totalesDe(where),
    resumenDe(whereSinEtapa),
  ]);

  return {
    items: rows.map((r: Record<string, unknown>) => aFila(r)),
    total: Number(countRows[0]?.total ?? 0), page, pageSize, totales, resumen,
  };
}

/** Todas las filas del filtro, sin paginar, para exportar. Tope duro por si el filtro está vacío. */
export const TOPE_EXPORTACION = 20_000;

export async function filasParaExportar(f: FiltrosReporte = {}): Promise<FilaReporte[]> {
  const conds = condiciones(f);
  const where = conds.length ? and(...conds) : undefined;
  const rows = await conJoins(db.select(SELECT_FILA).from(flitoTramites).$dynamic()).where(where)
    .orderBy(sql`${flitoTramites.createdAt} DESC`).limit(TOPE_EXPORTACION);
  return rows.map((r: Record<string, unknown>) => aFila(r));
}

const CABECERAS_CSV = [
  'Trámite', 'Placa', 'Estado', 'Empresa', 'Tipo', 'Aprobado', 'SOAT', 'Impuesto',
  'Derecho de tránsito', 'Trámite digital', 'Logística', 'GMF', 'Total', 'Liquidación',
  // Todo lo que impide liquidar, no solo las tarifas: quien concilia necesita la lista completa de
  // lo que hay que resolver, le dé igual si es una tarifa, un recibo o un pago pendiente.
  'Qué falta para liquidar',
] as const;

/** Solo el día, en ISO. Excel lo reconoce como fecha; el instante completo lo trata como texto. */
const soloDia = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

/** Una celda CSV segura: comillas escapadas y campo entrecomillado si lleva separador o salto. */
function celda(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV con `;` y BOM: es lo que Excel en español abre sin pedir asistente de importación. Con `,`
 * mete todo en una columna, y sin BOM se comen las tildes.
 */
export function aCsv(filas: FilaReporte[]): string {
  const lineas = [CABECERAS_CSV.join(';')];
  for (const f of filas) {
    lineas.push([
      f.idFlit, f.placa, f.estado, f.empresa, f.tipoTramite, soloDia(f.fechaAprobacion),
      f.soat, f.impuesto, f.derechoTramite, f.tramiteDigital, f.logistica, f.gmf, f.total,
      f.sellada ? (f.estadoLiquidacion === 'facturado' ? 'Facturado' : 'Liquidado') : 'Estimado',
      [...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago].join(' | '),
    ].map(celda).join(';'));
  }
  return `﻿${lineas.join('\r\n')}\r\n`;
}

export interface FacetasReporte {
  estados: string[];
  /**
   * Una entrada por EMPRESA, no por NIT. `valor` lleva todos los NITs con los que esa empresa
   * aparece en los trámites, separados por coma, que es como los espera el filtro `empresas`.
   */
  empresas: { valor: string; nombre: string }[];
  tipos: string[];
}

/** Solo los dígitos: FLIT manda el NIT unas veces con puntos y guion y otras pelado. */
const digitos = (v: string): string => v.replace(/\D/g, '');

/**
 * Las formas con las que un mismo NIT puede escribirse: él mismo y, si lleva el dígito de
 * verificación pegado, su raíz sin ese dígito. Se exige que tenga 10 o más para no recortar un
 * documento de 9 —que ya es la raíz— y acabar cruzando dos empresas distintas.
 */
const clavesNit = (v: string): string[] => (v.length >= 10 ? [v, v.slice(0, -1)] : [v]);

/**
 * Una entrada por EMPRESA a partir de los NITs que aparecen en los trámites.
 *
 * Una empresa se listaba DOS VECES: una con su nombre y otra con el NIT crudo. Pasa cuando sus
 * trámites llegan con el NIT escrito de dos maneras (con y sin dígito de verificación): el sync
 * empareja con `clients` solo los que coinciden exactos, y los demás quedan con `compania_id` nulo
 * y sin nombre que enseñar. Agrupar por NIT no lo arreglaba, porque eran dos NITs distintos.
 *
 * Aquí la identidad es la EMPRESA: primero la que ya emparejó el sync, y si no, la que case por NIT
 * normalizado. Los NITs de una misma empresa se juntan en un solo valor separado por comas —que es
 * como el filtro `empresas` los espera—, así que elegirla trae sus trámites hayan llegado como
 * hayan llegado.
 */
export function agruparEmpresas(
  filas: Array<{ nit: string | null; companiaId: number | null }>,
  maestro: Array<{ id: number; nombre: string; documento: string | null }>,
): Array<{ valor: string; nombre: string }> {
  const porClave = new Map<string, { id: number; nombre: string }>();
  for (const c of maestro) {
    if (!c.documento) continue;
    for (const clave of clavesNit(digitos(c.documento))) {
      if (!porClave.has(clave)) porClave.set(clave, { id: c.id, nombre: c.nombre });
    }
  }
  const porId = new Map(maestro.map((c) => [c.id, c.nombre]));

  const grupos = new Map<string, { nombre: string; nits: string[] }>();
  for (const f of filas) {
    if (!f.nit) continue;
    const propias = clavesNit(digitos(f.nit));
    const empresa = (f.companiaId !== null && porId.has(f.companiaId))
      ? { id: f.companiaId, nombre: porId.get(f.companiaId)! }
      : propias.map((k) => porClave.get(k)).find(Boolean);

    // Sin empresa en el maestro no hay nombre que enseñar: se rotula como lo que es, un NIT sin
    // empresa registrada, en vez de disfrazarlo de nombre propio. La clave de agrupación es la raíz
    // del NIT, así que sus dos escrituras siguen cayendo juntas aunque nadie la haya dado de alta.
    const clave = empresa ? `c${empresa.id}` : `n${propias[propias.length - 1]}`;
    const nombre = empresa ? empresa.nombre : `NIT ${f.nit} (sin empresa registrada)`;
    const grupo = grupos.get(clave) ?? { nombre, nits: [] };
    if (!grupo.nits.includes(f.nit)) grupo.nits.push(f.nit);
    grupos.set(clave, grupo);
  }

  return [...grupos.values()]
    .map((g) => ({ valor: g.nits.join(','), nombre: g.nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

export async function facetas(): Promise<FacetasReporte> {
  const [estados, filas, tipos, maestro] = await Promise.all([
    db.selectDistinct({ v: flitoTramites.flitEstado }).from(flitoTramites).where(sql`${flitoTramites.flitEstado} is not null`),
    db.selectDistinct({ nit: flitoTramites.companiaNit, companiaId: flitoTramites.companiaId })
      .from(flitoTramites).where(sql`${flitoTramites.companiaNit} is not null`),
    db.selectDistinct({ v: flitoTramites.tipoTramite }).from(flitoTramites).where(sql`${flitoTramites.tipoTramite} is not null`),
    db.select({ id: clients.id, nombre: clients.name, documento: clients.document }).from(clients),
  ]);

  return {
    estados: estados.map((e) => e.v).filter((v): v is string => !!v).sort(),
    empresas: agruparEmpresas(filas, maestro),
    tipos: tipos.map((e) => e.v).filter((v): v is string => !!v).sort(),
  };
}
