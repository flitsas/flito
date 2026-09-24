// FLITO — liquidación sellada del trámite (HU #10965, Feature #10939 §2.3).
//
// Liquidar es CONGELAR lo que costó el trámite en este momento: si mañana cambia la tarifa
// negociada con la compañía o la tasa del GMF, un trámite ya liquidado sigue mostrando lo que se
// cobró. Por eso los valores se copian a `flito_liquidaciones` en vez de recalcularse al leer.
//
// RN-07 (HU #12374): la tarifa que se congela es la VIGENTE EN LA FECHA DE APROBACIÓN del trámite,
// no la de hoy; sin fecha de aprobación, la de ahora. Es la misma resolución (`vigenteEn`) que usa
// el reporte de costos para la fila estimada: lo que se muestra es lo que se sella (AC7).
//
// HU #12654 (F3 de la Épica #12245, ADR-0018 §5): el VALOR DOCUMENTAL manda en dos honorarios. Si el
// trámite tiene un comprobante de pago aplicado (`flito_comprobantes`, `estado = 'aplicado' AND
// es_pago = true`, a lo sumo uno por trámite y concepto), el trámite digital se sella con ese valor
// —antes que la tarifa— y la logística lo toma como viaje 1 (`baseLogistica`) ANTES de sumar los
// viajes adicionales; los servicios adicionales se sellan con el catálogo y el comprobante solo deja
// la diferencia. Cada concepto conserva en el detalle sellado `origenValor` (`documental` | `tarifa`
// | `catalogo` | null) y `diferencia` ({ comprobanteId, importe, aceptada } | null). Una diferencia
// NUNCA bloquea el sellado (D5) y la autogestión decide ANTES de mirar el documental (mutante (9)).
// Las expresiones vienen del leaf `flito-comprobantes.expr.ts` como subconsultas escalares, sin join.
//
// No confundir con `apps/api/src/modules/liquidacion/`, que es del subsistema antiguo
// (`tramites_digitales` con id entero + órdenes de trabajo) y no tiene relación con FLITO.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  type ConceptoBolsaTransito, ConceptoCosto, esConceptoBolsaTransito, EstadoImpuesto, EstadoSoat,
  flitoGestionaImpuesto, type ItemServicioSellado, ModalidadOrganismo, type ViajeLogisticaSellado,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoComprobantes, flitoDerechosTramite, flitoExcepcionesAutogestion, flitoImpuestos,
  flitoLiquidacionEventos, flitoLiquidaciones, flitoOrganismoVigencias, flitoSoat, flitoTramites,
} from '../../db/schema.js';
// HU #12654 — la fila documental se lee SOLO por el leaf de comprobantes (ADR-0018 §5): «qué
// comprobante cuenta» tiene una única respuesta, la de `documental()`; aquí no se filtra por estado
// ni por es_pago, ni se hace join con `flito_comprobantes`.
import {
  documental, EXPR_ACEPTADA_SA, EXPR_DIF_SA, EXPR_VALOR_SA, representanteSa, type ConceptoHonorario,
} from '../flito-comprobantes/flito-comprobantes.expr.js';
import { tarifaDe, type ValorTarifa } from '../flito-parametrizacion/flito-tarifas.service.js';
import { excepcionLogisticaViva, gestionaLogistica as flitoGestionaLogistica } from './gestiona-logistica.js';
import {
  registrarSalidasLiquidacion, reversarSalidasLiquidacion, type SalidaConcepto,
} from '../flito-bolsas/flito-bolsas.service.js';
import {
  registrarConsumoTransito, reversarConsumoTransito,
} from '../flito-bolsas/flito-bolsas-transito.service.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
// AC5 de la HU #11343: qué se puede hacer con la factura de un trámite que alguien intenta reversar.
import { viaDeCorreccionDeTramite } from '../siigo/correcciones.service.js';
// HU #12546 — los servicios adicionales del trámite se LEEN de su módulo, no se reconsultan aquí:
// `serviciosAsignadosDe` ya fija el orden (`asignado_en ASC, id ASC`) y la proyección, y
// `bloquearTramite` es el MISMO `SELECT … FOR UPDATE` que toman asignar y quitar (ADR-0017, RN-03).
// Duplicar cualquiera de las dos abriría la puerta a que el sellado leyera un orden o una instantánea
// distintos de los que ve la pantalla que asigna.
import {
  bloquearTramite, type Ejecutor, type FilaAsignacion, serviciosAsignadosDe, TramiteNoEncontradoError,
} from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
// HU #12626 — los viajes ADICIONALES de logística se leen de su módulo con el mismo criterio que los
// servicios: `viajesDe` fija el orden (`numero ASC`) y la proyección, y dentro de `liquidar()` se
// lee con el `tx` que ya tomó el `FOR UPDATE` que registrar/quitar también toman (RN-04 de la HU
// #12619). Leerlos con `db` sellaría un viaje que otro registró entre la previsualización y el sello.
import { aDto as aDtoViaje, type FilaViaje, viajesDe } from '../flito-logistica/flito-logistica-viajes.service.js';

export class LiquidacionError extends Error {
  constructor(message: string, readonly faltantes: string[] = []) {
    super(message);
    this.name = 'LiquidacionError';
  }
}

/**
 * El trámite existe y la petición es válida, pero su estado no permite sellar: `faltantes` no está
 * vacío (una tarifa sin vigencia en su fecha de aprobación, un SOAT sin pagar, un recibo que falta).
 * La ruta lo traduce a 422 (AC9 de la HU #12374); sigue siendo `LiquidacionError` para que el lote
 * lo reporte igual que antes.
 */
export class LiquidacionBloqueadaError extends LiquidacionError {
  constructor(message: string, faltantes: string[] = []) {
    super(message, faltantes);
    this.name = 'LiquidacionBloqueadaError';
  }
}

/**
 * Tasa del gravamen a los movimientos financieros (4 x 1000).
 *
 * Se aplica sobre el total del trámite: SOAT + impuesto + derecho de tránsito + logística +
 * trámite digital. El gravamen se suma encima de esa base, de modo que el total facturado es la
 * base más su propio GMF.
 *
 * La tasa se guarda en cada liquidación (`flito_liquidaciones.tasa_gmf`) en vez de leerse de aquí
 * al reportar: una liquidación sellada hace años debe seguir mostrando la tasa con la que se selló.
 */
export const TASA_GMF = 0.004;

export const ESTADO_LIQUIDACION = { LIQUIDADO: 'liquidado', FACTURADO: 'facturado' } as const;
export type EstadoLiquidacion = (typeof ESTADO_LIQUIDACION)[keyof typeof ESTADO_LIQUIDACION];

/**
 * De dónde salió el valor de un honorario (HU #12654): del comprobante de pago aplicado
 * (`documental`), de la tarifa de la compañía (`tarifa`) o del catálogo de servicios (`catalogo`).
 * null = el concepto no aplica (autogestionado).
 */
export type OrigenValor = 'documental' | 'tarifa' | 'catalogo';

/**
 * La diferencia que dejó el comprobante de pago aplicado (HU #12654): `importe` es
 * `diferencia_tarifa` (valor documental − tarifa de referencia, tolerancia 0) y `aceptada` si alguien
 * la aceptó con motivo ANTES del sello. Se congela tal cual: una aceptación posterior se ve en el
 * reporte de costos (en vivo), no en el sello.
 */
export interface DiferenciaDocumental {
  comprobanteId: string;
  importe: number;
  aceptada: boolean;
}

/** Un concepto del cálculo. `valor: null` = no aplica o no está configurado; NUNCA cero implícito. */
export interface ConceptoLiquidado {
  valor: number | null;
  /** Por qué vale eso: útil para auditar la liquidación años después. */
  origen: string;
  /** Si es true, la liquidación no puede sellarse hasta resolverlo. */
  bloquea: boolean;
  /**
   * Solo los honorarios los llevan (HU #12654); SOAT, impuesto y derecho no cambian (D7) y no los
   * escriben. En los honorarios son obligatorios: ver `ConceptoHonorarioLiquidado`.
   */
  origenValor?: OrigenValor | null;
  diferencia?: DiferenciaDocumental | null;
}

/**
 * Un honorario (trámite digital, logística, servicios adicionales): SIEMPRE dice de dónde salió su
 * valor y qué diferencia dejó el comprobante. `aDto` pone null en ambas cuando lee un sello anterior
 * a la HU #12654 (sin las claves): nunca lanza.
 */
export interface ConceptoHonorarioLiquidado extends ConceptoLiquidado {
  origenValor: OrigenValor | null;
  diferencia: DiferenciaDocumental | null;
}

/**
 * El concepto de los servicios adicionales (HU #12546). Es un `ConceptoLiquidado` con el DESGLOSE:
 * `valor` es la suma —lo que entra en la base del GMF y en la bolsa— e `items` es de qué se compone,
 * en el orden en que la puente los devuelve.
 *
 * Se declara aquí y no en shared-types porque la web no consume el cálculo de la liquidación; lo que
 * sí comparte —`ItemServicioSellado`— ya vive allí y se reutiliza tal cual (HU #12545).
 */
export interface ConceptoServiciosAdicionales extends ConceptoHonorarioLiquidado {
  items: ItemServicioSellado[];
}

/**
 * Origen de los servicios adicionales: vienen de lo ASIGNADO al trámite (`flito_tramite_servicios_
 * adicionales`), no de una tarifa ni de un recibo. Es el mismo con y sin servicios: el porqué del
 * valor no cambia porque la lista esté vacía.
 */
export const ORIGEN_SERVICIOS_ADICIONALES = 'asignacion';

/**
 * El concepto de logística (HU #12626): la tarifa de la compañía es el viaje 1, y cada viaje
 * ADICIONAL registrado en `flito_tramite_viajes_logistica` se suma con el precio con que se
 * registró (RN-02 de la HU #12619), no con la tarifa de hoy. `valor` es la SUMA —lo que entra en la
 * base del GMF, en la bolsa y en la factura—, `tarifa` es el viaje 1 por separado y `viajes` el
 * desglose congelado de los adicionales.
 *
 * `viajes` y `totalViajes` solo valen null al LEER un sello anterior a esta HU (sin snapshot en el
 * detalle): `calcular` y `liquidar` siempre producen array y número, también vacío y 1.
 */
export interface ConceptoLogistica extends ConceptoHonorarioLiquidado {
  /** El viaje 1: la tarifa de logística vigente en la fecha de aprobación —o el valor documental (HU #12654)—. null si no aplica o falta. */
  tarifa: number | null;
  viajes: ViajeLogisticaSellado[] | null;
  /** 1 (el incluido) + adicionales; 0 si la compañía autogestiona su logística. */
  totalViajes: number | null;
}

export interface CalculoLiquidacion {
  tramiteId: string;
  idFlit: string;
  soat: ConceptoLiquidado;
  impuesto: ConceptoLiquidado;
  derecho: ConceptoLiquidado;
  tramiteDigital: ConceptoHonorarioLiquidado;
  logistica: ConceptoLogistica;
  /**
   * Los servicios adicionales del trámite. Nunca bloquea: un trámite sin servicios es lo normal, y
   * `valor: null` dice «no aplica», no «falta algo» — por eso no entra en `faltantes` (AC2).
   */
  serviciosAdicionales: ConceptoServiciosAdicionales;
  baseGmf: number;
  tasaGmf: number;
  valorGmf: number;
  total: number;
  /** Qué impide liquidar. Vacío = se puede sellar. */
  faltantes: string[];
}

export interface LiquidacionDto extends CalculoLiquidacion {
  id: string;
  estado: EstadoLiquidacion;
  liquidadoEn: string;
  facturadoEn: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const redondear = (n: number): number => Math.round(n * 100) / 100;

/** Suma tratando null como ausencia, no como cero. Solo cuenta lo que sí aplica. */
const sumar = (...vs: Array<number | null>): number =>
  vs.reduce<number>((a, v) => a + (v ?? 0), 0);

function deTarifa(t: ValorTarifa, etiqueta: string): ConceptoHonorarioLiquidado {
  if (t.origen === 'no_configurada') {
    return { valor: null, origen: 'No configurado', bloquea: true, origenValor: 'tarifa', diferencia: null };
  }
  return {
    valor: t.valor, origen: t.origen === 'especifica' ? `Tarifa de ${etiqueta}` : 'Tarifa genérica', bloquea: false,
    origenValor: 'tarifa', diferencia: null,
  };
}

/** El origen con que se sella un valor documental: nombra el comprobante para auditarlo años después. */
const origenDocumental = (comprobanteId: string): string => `Valor documental (comprobante ${comprobanteId})`;

/** La fila documental de UN honorario, ya leída: el valor del comprobante y la diferencia que dejó. */
export interface Documental {
  valor: number;
  diferencia: DiferenciaDocumental;
}

/** Las tres filas documentales de un trámite (o null donde no hay comprobante de pago aplicado). */
export interface Documentales {
  tramiteDigital: Documental | null;
  logistica: Documental | null;
  serviciosAdicionales: Documental | null;
}

/** El valor documental como concepto: manda sobre la tarifa y NUNCA bloquea (AC1: sin tarifa, sigue sin bloquear). */
function conceptoDocumental(d: Documental): ConceptoHonorarioLiquidado {
  return { valor: d.valor, origen: origenDocumental(d.diferencia.comprobanteId), bloquea: false, origenValor: 'documental', diferencia: d.diferencia };
}

/** Las cuatro columnas crudas de una fila documental, como las proyecta `PROYECCION_DOCUMENTAL`. */
interface FilaDocumental {
  valor: string | null;
  comprobanteId: string | null;
  diferencia: string | null;
  aceptada: boolean | null;
}

/**
 * `null` sin fila documental. `importe` es `diferencia_tarifa` tal como la escribió aplicar (valor −
 * tarifa de referencia; sin tarifa, el valor entero); `aceptada` es «ya la aceptó alguien».
 */
function documentalDe(f: FilaDocumental): Documental | null {
  // `?? null`: una fila sin las columnas (proyección parcial) se lee como «sin comprobante», no como NaN.
  const crudo = f.valor ?? null;
  const comprobanteId = f.comprobanteId ?? null;
  if (crudo === null || comprobanteId === null) return null;
  const valor = Number(crudo);
  return { valor, diferencia: { comprobanteId, importe: f.diferencia == null ? valor : Number(f.diferencia), aceptada: f.aceptada === true } };
}

interface FilaCalculo {
  tramiteId: string;
  idFlit: string;
  tipoTramite: string | null;
  /** Fecha de referencia para la tarifa (RN-07). null = sin aprobar: se resuelve con «ahora». */
  fechaAprobacion: Date | null;
  companiaId: number | null;
  logisticaAutogestionable: boolean | null;
  soatId: string | null;
  soatEstado: string | null;
  soatValorPagado: string | null;
  soatAutogestionable: boolean | null;
  impuestoId: string | null;
  impuestoEstado: string | null;
  impuestoValorPagado: string | null;
  impuestosAutogestionable: boolean | null;
  /** Modalidad vigente del organismo del trámite. null = sin vigencia abierta. */
  modalidadOrganismo: string | null;
  // Desbloqueos excepcionales de la autogestión, POR TRÁMITE (HU #10980). SOAT e impuesto llevan la
  // marca en su propio registro; la logística no tiene registro, así que se resuelve por la
  // excepción vigente.
  soatExcepcion: boolean | null;
  impuestoExcepcion: boolean | null;
  logisticaExcepcion: boolean | null;
  derechoValor: string | null;
  // HU #12654 — las filas documentales, por subconsulta del leaf de comprobantes (sin join).
  docTramiteDigital: string | null;
  docLogistica: string | null;
  docServiciosAdicionales: string | null;
  docComprobanteTdId: string | null;
  docComprobanteLgId: string | null;
  docComprobanteSaId: string | null;
  docDiferenciaTd: string | null;
  docDiferenciaLg: string | null;
  docDiferenciaSa: string | null;
  docAceptadaTd: boolean | null;
  docAceptadaLg: boolean | null;
  docAceptadaSa: boolean | null;
}

/** «Ya la aceptó alguien»: `diferencia_aceptada_en IS NOT NULL` de la fila documental (NULL sin fila). */
const aceptada = (concepto: ConceptoHonorario) => sql<boolean | null>`(${documental(flitoComprobantes.diferenciaAceptadaEn, concepto)} is not null)`;

/**
 * Las doce columnas documentales (HU #12654), cada una una subconsulta escalar de `documental()`
 * correlacionada con `flito_tramites.id`. Se proyectan en el cálculo y se RELEEN con el `tx` del
 * sellado (`documentalesDe`): una sola definición para que lo previsualizado y lo sellado no puedan
 * leer filas distintas.
 */
const PROYECCION_DOCUMENTAL = {
  docTramiteDigital: documental(flitoComprobantes.valor, ConceptoCosto.TRAMITE_DIGITAL),
  docLogistica: documental(flitoComprobantes.valor, ConceptoCosto.LOGISTICA),
  // Servicios adicionales: N pagos por trámite (uno por tipo, Bug #12913) → suma / representante / bool_or.
  docServiciosAdicionales: EXPR_VALOR_SA,
  docComprobanteTdId: documental(flitoComprobantes.id, ConceptoCosto.TRAMITE_DIGITAL),
  docComprobanteLgId: documental(flitoComprobantes.id, ConceptoCosto.LOGISTICA),
  docComprobanteSaId: representanteSa(flitoComprobantes.id),
  docDiferenciaTd: documental(flitoComprobantes.diferenciaTarifa, ConceptoCosto.TRAMITE_DIGITAL),
  docDiferenciaLg: documental(flitoComprobantes.diferenciaTarifa, ConceptoCosto.LOGISTICA),
  docDiferenciaSa: EXPR_DIF_SA,
  docAceptadaTd: aceptada(ConceptoCosto.TRAMITE_DIGITAL),
  docAceptadaLg: aceptada(ConceptoCosto.LOGISTICA),
  docAceptadaSa: sql<boolean | null>`${EXPR_ACEPTADA_SA}`,
} as const;

type FilaDocumentales = Pick<FilaCalculo, keyof typeof PROYECCION_DOCUMENTAL>;

/** Las tres filas documentales que trae una fila del cálculo. */
function documentalesDeFila(f: FilaDocumentales): Documentales {
  return {
    tramiteDigital: documentalDe({ valor: f.docTramiteDigital, comprobanteId: f.docComprobanteTdId, diferencia: f.docDiferenciaTd, aceptada: f.docAceptadaTd }),
    logistica: documentalDe({ valor: f.docLogistica, comprobanteId: f.docComprobanteLgId, diferencia: f.docDiferenciaLg, aceptada: f.docAceptadaLg }),
    serviciosAdicionales: documentalDe({ valor: f.docServiciosAdicionales, comprobanteId: f.docComprobanteSaId, diferencia: f.docDiferenciaSa, aceptada: f.docAceptadaSa }),
  };
}

/**
 * Las filas documentales de un trámite leídas con `ejecutor` (AC5): dentro de `liquidar()` es el `tx`
 * que ya tomó el `FOR UPDATE` del trámite —el MISMO que toma `aplicar` antes de escribir la fila
 * documental—, así que lo que se sella es lo aplicado al COMMIT, no lo que vio la previsualización.
 * Mismo patrón que `serviciosAsignadosDe` y `viajesDe`. Trámite inexistente ⇒ las tres en null.
 */
export async function documentalesDe(ejecutor: Ejecutor, tramiteId: string): Promise<Documentales> {
  const [f] = await ejecutor.select(PROYECCION_DOCUMENTAL).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).limit(1) as FilaDocumentales[];
  return documentalesDeFila(f ?? {
    docTramiteDigital: null, docLogistica: null, docServiciosAdicionales: null,
    docComprobanteTdId: null, docComprobanteLgId: null, docComprobanteSaId: null,
    docDiferenciaTd: null, docDiferenciaLg: null, docDiferenciaSa: null,
    docAceptadaTd: null, docAceptadaLg: null, docAceptadaSa: null,
  });
}

function proyeccionCalculo() {
  return db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    fechaAprobacion: flitoTramites.fechaAprobacion,
    companiaId: flitoTramites.companiaId,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    soatId: flitoSoat.id,
    soatEstado: flitoSoat.estado,
    soatValorPagado: flitoSoat.valorPagado,
    impuestoId: flitoImpuestos.id,
    impuestoEstado: flitoImpuestos.estado,
    impuestoValorPagado: flitoImpuestos.valorPagado,
    modalidadOrganismo: flitoOrganismoVigencias.modalidad,
    soatExcepcion: flitoSoat.excepcionAutogestion,
    impuestoExcepcion: flitoImpuestos.excepcionAutogestion,
    logisticaExcepcion: sql<boolean>`${flitoExcepcionesAutogestion.id} IS NOT NULL`,
    derechoValor: flitoDerechosTramite.valor,
    ...PROYECCION_DOCUMENTAL,
  }).from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    // La vigencia ABIERTA del organismo (hasta IS NULL) es la que manda hoy. El índice único deja
    // como mucho una por organismo, así que el join no multiplica filas.
    .leftJoin(flitoOrganismoVigencias, and(
      eq(flitoOrganismoVigencias.organismoCodigo, flitoTramites.organismoCodigo),
      isNull(flitoOrganismoVigencias.hasta),
    ))
    // La logística desbloqueada excepcionalmente. Un trámite no puede tener dos excepciones vivas
    // del mismo concepto (índice parcial), así que tampoco multiplica filas.
    .leftJoin(flitoExcepcionesAutogestion, excepcionLogisticaViva())
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id));
}

/**
 * Calcula lo que costaría liquidar, SIN sellar nada. Es lo que alimenta la previsualización y lo que
 * `liquidar()` persiste si no hay faltantes.
 *
 * QUIÉN GESTIONA CADA CONCEPTO decide qué se exige, y eso sale de la parametrización, no de si el
 * registro existe:
 *
 *  - SOAT      → lo gestiona FLITO salvo que la compañía lo autogestione (`clients`).
 *  - Impuesto  → RN-01: lo gestiona FLITO si la compañía no lo autogestiona Y el organismo está en
 *                `requiere_gestion`. Sin vigencia abierta, el default es autogestionado.
 *  - Logística → lo gestiona FLITO salvo que la compañía la autogestione.
 *  - Derecho de tránsito y trámite digital → SIEMPRE los cobra FLITO; no hay parametrización que los
 *    exima.
 *
 * Y por encima de todo eso manda el DESBLOQUEO EXCEPCIONAL (HU #10980): una compañía que autogestiona
 * puede encargarle a FLITO trámites puntuales, y entonces ese concepto se gestiona, se exige y SE
 * COBRA en ese trámite —solo en ese—. Es un desembolso real de FLITO: dejarlo fuera del total sería
 * regalarlo. La marca vive en el registro creado (`flito_soat`, `flito_impuestos`); la logística no
 * tiene registro propio, así que la lleva la excepción vigente.
 *
 * Y entonces: lo que FLITO gestiona TIENE que tener valor para poder sellar; lo que no gestiona vale
 * null (nunca cero) y no estorba.
 *
 * Antes, la ausencia de registro de SOAT o de impuesto se leía como «exento» y dejaba liquidar. Esa
 * lectura venía del sync, que no crea el registro cuando el concepto es autogestionado — pero no
 * crearlo no es la única razón por la que puede faltar: si el trámite no llegó a estado Asignado, o
 * llegó sin compañía u organismo emparejados, tampoco se crea, y ahí sí falta de verdad. Con la
 * lectura vieja, un trámite de una compañía a la que FLITO le gestiona TODO se sellaba sin SOAT y
 * sin impuesto, congelando un total al que le faltaban dos desembolsos reales.
 *
 * Reglas de valor:
 *  - SOAT / impuesto: el valor pagado. Pendientes o inexistentes, bloquean.
 *  - Derecho de tránsito: el valor real del recibo. Sin recibo, bloquea.
 *  - Trámite digital: tarifa de la compañía. Sin tarifa, «No configurado» y bloquea.
 *  - Logística: tarifa de la compañía, salvo que la compañía autogestione su logística. La tarifa
 *    es el viaje 1; los viajes adicionales registrados se suman con su precio (HU #12626).
 */
export async function calcular(tramiteId: string): Promise<CalculoLiquidacion> {
  const [f] = await proyeccionCalculo().where(eq(flitoTramites.id, tramiteId)).limit(1) as FilaCalculo[];
  if (!f) throw new LiquidacionError('El trámite no existe');
  // Fuera de transacción: esto es la PREVISUALIZACIÓN. `liquidar()` vuelve a leer la puente con su
  // propio `tx` después de bloquear el trámite y recompone la base con esa lectura (AC3).
  const servicios = await serviciosAsignadosDe(db, tramiteId);
  // Los viajes se leen SIEMPRE, gestione o no la logística: quién decide si cuentan es
  // `conceptoLogistica`, no esta consulta (un autogestionable con filas las ignora).
  const viajes = await viajesDe(db, tramiteId);
  const docs = documentalesDeFila(f);
  return calcularDeFila(f, conceptoServicios(servicios, docs.serviciosAdicionales), viajes, docs);
}

/**
 * Las filas de la puente como CONCEPTO: la suma en `valor` y el desglose en `items`, en el orden que
 * da `serviciosAsignadosDe` (`asignado_en ASC, id ASC`).
 *
 * Sin servicios, `valor` es null y NO cero: es la misma regla que el resto de conceptos —null es «no
 * aplica»— y es lo que deja la columna sellada en NULL en vez de fingir un cobro de 0. `items` en
 * cambio SIEMPRE es un array (vacío si no hay), para que `jsonb_array_length` sobre el detalle
 * sellado por esta HU responda 0 y no NULL.
 */
export function conceptoServicios(filas: FilaAsignacion[], documental: Documental | null = null): ConceptoServiciosAdicionales {
  const items: ItemServicioSellado[] = filas.map((f) => ({
    tipoId: f.tipoId, nombre: f.nombre, valor: Number(f.valor),
  }));
  const valor = items.length === 0 ? null : redondear(items.reduce((a, i) => a + i.valor, 0));
  // HU #12654 (D3, mutante (10)): el comprobante de servicios adicionales NO manda. `valor` sigue
  // siendo Σ items —lo que Siigo factura línea a línea (`servicios_no_cuadran`)— y el documental solo
  // deja la diferencia. Sumarla aquí descuadraría la factura sin una línea que la explique.
  return { valor, origen: ORIGEN_SERVICIOS_ADICIONALES, bloquea: false, items, origenValor: 'catalogo', diferencia: documental?.diferencia ?? null };
}

/** El sufijo que el origen de la logística lleva cuando hay viajes adicionales; vacío con cero. */
function sufijoViajes(n: number): string {
  return n === 0 ? '' : ` + ${n} viaje${n > 1 ? 's' : ''} adicional${n > 1 ? 'es' : ''}`;
}

/**
 * La tarifa de logística (viaje 1) MÁS los viajes adicionales, como concepto (HU #12626).
 *
 * `base` es lo que la tarifa resolvió sola —`deTarifa` o «la compañía autogestiona»— y decide qué
 * hacer con las filas:
 *  - no gestiona (valor null sin bloquear): las filas se IGNORAN. Un autogestionable no paga
 *    logística, y si quedaron viajes de una excepción que ya venció, tampoco: `viajes: []`, 0 viajes.
 *  - bloquea (sin tarifa vigente en la fecha de aprobación): sigue bloqueando con el mismo faltante,
 *    `valor` null; el desglose se conserva para que la previsualización enseñe qué hay registrado.
 *  - normal: `valor = tarifa + Σ valor de cada viaje`, con el precio CON QUE SE REGISTRÓ cada uno
 *    (su `valor`, nunca `tarifaVigente` ni la tarifa de hoy).
 *
 * Es pura para poder afirmarla sola; `totalizar` la vuelve a aplicar dentro del sellado.
 */
export function conceptoLogistica(base: ConceptoHonorarioLiquidado, filas: FilaViaje[]): ConceptoLogistica {
  if (base.valor === null && !base.bloquea) return { ...base, tarifa: null, viajes: [], totalViajes: 0 };
  const viajes: ViajeLogisticaSellado[] = filas.map((f) => {
    const { registradoPorId: _interno, ...v } = aDtoViaje(f);
    return v;
  });
  const totalViajes = 1 + viajes.length;
  if (base.bloquea) return { ...base, valor: null, tarifa: null, viajes, totalViajes };
  const tarifa = base.valor as number;
  return {
    valor: redondear(viajes.reduce((a, v) => a + v.valor, tarifa)),
    origen: `${base.origen}${sufijoViajes(viajes.length)}`,
    bloquea: false, tarifa, viajes, totalViajes,
    // El viaje 1 puede ser el documental (HU #12654): el origen y la diferencia son los de la base.
    origenValor: base.origenValor, diferencia: base.diferencia,
  };
}

/**
 * La inversa exacta de `conceptoLogistica` sobre su propio resultado: la tarifa vuelve a ser el
 * valor y al origen se le quita el sufijo que `sufijoViajes` le puso (por longitud, no por regex: es
 * el mismo texto que se compuso, así que no hay ambigüedad). Existe para que `totalizar` pueda
 * recomponer la logística desde el cálculo previo sin arrastrar un campo interno hasta el detalle.
 */
export function baseDeLogistica(l: ConceptoLogistica): ConceptoHonorarioLiquidado {
  // Solo el caso normal (con tarifa) lleva sufijo: bloqueado y autogestionado conservan su origen.
  const sufijo = l.tarifa === null ? '' : sufijoViajes(l.viajes?.length ?? 0);
  return {
    valor: l.tarifa, origen: l.origen.slice(0, l.origen.length - sufijo.length), bloquea: l.bloquea,
    origenValor: l.origenValor ?? null, diferencia: l.diferencia ?? null,
  };
}

/**
 * El honorario con la fila documental RELEÍDA (HU #12654, AC5): si hay comprobante, manda; si no, el
 * concepto sigue como estaba (tarifa, o «no aplica»). La autogestión decide ANTES: un concepto con
 * `origenValor: null` es «no se cobra» y ningún comprobante lo cambia (mutante (9)).
 */
function conDocumental(c: ConceptoHonorarioLiquidado, d: Documental | null): ConceptoHonorarioLiquidado {
  if (c.origenValor === null || d === null) return c;
  return conceptoDocumental(d);
}

/**
 * Recompone base, gravamen y total del cálculo con OTRO concepto de servicios adicionales y OTRAS
 * filas de viajes.
 *
 * Existe porque `liquidar()` relee la puente dentro de su transacción: el cálculo que se previsualizó
 * puede ser de hace unos segundos, y lo que se sella tiene que ser lo que estaba asignado bajo el
 * bloqueo. Es UNA función y no dos sumas parecidas para que la base del sellado y la del cálculo no
 * puedan divergir.
 */
function totalizar(
  c: CalculoLiquidacion, servicios: ConceptoServiciosAdicionales, viajes: FilaViaje[], docs: Documentales,
): CalculoLiquidacion {
  // El documental releído manda en el trámite digital y en el viaje 1 de la logística (HU #12654);
  // los viajes adicionales se suman ENCIMA del documental, nunca al revés.
  const tramiteDigital = conDocumental(c.tramiteDigital, docs.tramiteDigital);
  const logistica = conceptoLogistica(conDocumental(baseDeLogistica(c.logistica), docs.logistica), viajes);
  const baseGmf = redondear(sumar(
    c.soat.valor, c.impuesto.valor, c.derecho.valor, tramiteDigital.valor, logistica.valor,
    servicios.valor,
  ));
  const valorGmf = redondear(baseGmf * TASA_GMF);
  return {
    ...c, tramiteDigital, logistica, serviciosAdicionales: servicios, baseGmf, valorGmf, total: redondear(baseGmf + valorGmf),
  };
}

async function calcularDeFila(
  f: FilaCalculo, servicios: ConceptoServiciosAdicionales, viajes: FilaViaje[], docs: Documentales,
): Promise<CalculoLiquidacion> {
  const faltantes: string[] = [];

  // Modalidad vigente del organismo; sin vigencia abierta, el default del dominio es autogestionado.
  const modalidad = (f.modalidadOrganismo as ModalidadOrganismo | null) ?? ModalidadOrganismo.AUTOGESTIONADO;

  // Qué gestiona FLITO en ESTE trámite. El desbloqueo excepcional gana a la autogestión de la
  // compañía: si se le encargó este SOAT, FLITO lo pagó y tiene que cobrarlo.
  const gestionaSoat = !f.soatAutogestionable || Boolean(f.soatExcepcion);
  const gestionaImpuesto = flitoGestionaImpuesto(Boolean(f.impuestosAutogestionable), modalidad)
    || Boolean(f.impuestoExcepcion);
  const gestionaLogistica = flitoGestionaLogistica(f.logisticaAutogestionable, f.logisticaExcepcion);

  const soat: ConceptoLiquidado = !gestionaSoat
    ? { valor: null, origen: 'La compañía autogestiona el SOAT', bloquea: false }
    : f.soatEstado === EstadoSoat.PAGADO && f.soatValorPagado !== null
      ? { valor: num(f.soatValorPagado), origen: 'Valor pagado del SOAT', bloquea: false }
      // Sin registro y sin pagar bloquean igual, pero se dicen distinto: uno se resuelve en la cola
      // de SOAT y el otro ni siquiera ha entrado en ella.
      : {
        valor: null, bloquea: true,
        origen: f.soatId === null ? 'Sin SOAT gestionado' : `SOAT en estado "${f.soatEstado}"`,
      };

  const impuesto: ConceptoLiquidado = !gestionaImpuesto
    ? {
      valor: null, bloquea: false,
      origen: f.impuestosAutogestionable
        ? 'La compañía autogestiona el impuesto'
        : 'El organismo no requiere gestión del impuesto',
    }
    : f.impuestoEstado === EstadoImpuesto.PAGADO && f.impuestoValorPagado !== null
      ? { valor: num(f.impuestoValorPagado), origen: 'Valor pagado del impuesto', bloquea: false }
      : {
        valor: null, bloquea: true,
        origen: f.impuestoId === null ? 'Sin impuesto gestionado' : `Impuesto en estado "${f.impuestoEstado}"`,
      };

  const derecho: ConceptoLiquidado = f.derechoValor !== null
    ? { valor: num(f.derechoValor), origen: 'Recibo de derecho de tránsito', bloquea: false }
    : { valor: null, origen: 'Sin recibo de derecho de tránsito', bloquea: true };

  const etiquetaTipo = f.tipoTramite ?? 'tipo';
  // HU #12654 (AC1): el comprobante de pago aplicado manda ANTES de la tarifa: con documental no se
  // consulta `tarifaDe` y el concepto no bloquea aunque la tarifa no esté configurada.
  // RN-07: sin documental, la vigencia que contiene la fecha de aprobación; sin aprobar, la de ahora.
  const tramiteDigital: ConceptoHonorarioLiquidado = docs.tramiteDigital
    ? conceptoDocumental(docs.tramiteDigital)
    : deTarifa(await tarifaDe(f.companiaId, 'tramite_digital', f.tipoTramite, f.fechaAprobacion), etiquetaTipo);

  // La logística se cobra a toda compañía que no la autogestione, haya habido entrega o no —y a la
  // que sí la autogestiona, en los trámites que le haya encargado a FLITO. La autogestión decide
  // PRIMERO (mutante (9)): con ella, un comprobante de logística aplicado no se cobra (null).
  // Después, el documental es el viaje 1 (D1, HU #12654); sin él, la tarifa.
  const baseLogistica: ConceptoHonorarioLiquidado = !gestionaLogistica
    ? { valor: null, origen: 'La compañía autogestiona su logística', bloquea: false, origenValor: null, diferencia: null }
    : docs.logistica
      ? conceptoDocumental(docs.logistica)
      : deTarifa(await tarifaDe(f.companiaId, 'logistica', f.tipoTramite, f.fechaAprobacion), etiquetaTipo);
  // El viaje 1 (tarifa o documental); los adicionales se suman encima con su precio congelado (HU #12626).
  const logistica = conceptoLogistica(baseLogistica, viajes);

  if (soat.bloquea) faltantes.push(soat.origen);
  if (impuesto.bloquea) faltantes.push(impuesto.origen);
  if (derecho.bloquea) faltantes.push(derecho.origen);
  // El faltante nombra la fecha (AC9): «no configurada» a secas haría buscar la tarifa de hoy, que
  // puede existir; lo que falta es la vigencia de ESA fecha.
  const enFecha = f.fechaAprobacion ? ` en la fecha de aprobación (${diaColombia(f.fechaAprobacion)})` : '';
  if (tramiteDigital.bloquea) faltantes.push(`Tarifa de trámite digital no configurada para la compañía${enFecha}`);
  if (logistica.bloquea) faltantes.push(`Tarifa de logística no configurada para la compañía${enFecha}`);

  // Base del 4x1000: el total de los SEIS conceptos (los servicios adicionales entran desde la
  // HU #12546). El gravamen se calcula sobre esa suma y se añade encima, de modo que el total es la
  // base más su propio GMF. Los conceptos que no aplican valen null y `sumar` los ignora: no entran
  // a la base como cero disfrazado. La suma vive en `totalizar` para que el sellado —que relee los
  // servicios bajo bloqueo— use exactamente la misma.
  // Una diferencia documental (aceptada o no) NUNCA entra en `faltantes` (D5): el sello la conserva.
  return totalizar({
    tramiteId: f.tramiteId, idFlit: f.idFlit,
    soat, impuesto, derecho, tramiteDigital, logistica, serviciosAdicionales: servicios,
    baseGmf: 0, tasaGmf: TASA_GMF, valorGmf: 0, total: 0, faltantes,
  }, servicios, viajes, docs);
}

/**
 * Identificadores y organismos que necesita la bolsa para imputar cada salida (HU #11122).
 *
 * Van aparte del cálculo porque no son parte de lo que se sella: el cálculo responde «cuánto», esto
 * responde «a qué organismo y con qué llave no cobrarlo dos veces».
 */
export interface IdentificadoresTramite {
  companiaId: number | null;
  soatId: string | null;
  soatOrganismo: string | null;
  impuestoId: string | null;
  impuestoOrganismo: string | null;
  derechoId: string | null;
  derechoOrganismo: string | null;
}

async function identificadoresDe(tramiteId: string): Promise<IdentificadoresTramite | undefined> {
  const [f] = await db.select({
    companiaId: flitoTramites.companiaId,
    soatId: flitoSoat.id,
    soatOrganismo: flitoSoat.organismoCodigo,
    impuestoId: flitoImpuestos.id,
    impuestoOrganismo: flitoImpuestos.organismoCodigo,
    derechoId: flitoDerechosTramite.id,
    derechoOrganismo: flitoDerechosTramite.organismoCodigo,
  }).from(flitoTramites)
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(eq(flitoTramites.id, tramiteId))
    .limit(1);
  return f;
}

/**
 * Traduce el cálculo sellado a las salidas que consumirán la bolsa del cliente.
 *
 * Las LLAVES son lo delicado, porque definen qué se cobra una sola vez:
 *  - SOAT      → `soat:{soatId}`. `flito_soat.vin` es UNIQUE, así que una fila es un vehículo: la
 *                llave ya cobra una única vez por VIN aunque el trámite se anule y se rehaga (AC4).
 *  - Impuesto  → `impuesto:{impuestoId}`. NO se puede deduplicar por VIN: `flito_impuestos` es una
 *                fila POR TRÁMITE y el sistema no implementa RN-01 para impuestos. Si un trámite se
 *                anula y el nuevo vuelve a pagar impuesto, hay dos pagos reales y la bolsa debe
 *                mostrar dos salidas: taparlo aquí ocultaría un doble pago en vez de evitarlo.
 *  - Los otros → `tramite:{tramiteId}:{concepto}`, que es su naturaleza: se pagan por radicación.
 *
 * El ORGANISMO de cada concepto sale de su propio registro y no del trámite: los tres se congelan al
 * crearse y el del trámite se reescribe en cada sincronización, así que pueden diferir. Trámite
 * digital y logística no llevan organismo: son honorarios de FLIT, no desembolsos a un organismo.
 *
 * El GMF va SIEMPRE al final (HU #11160). Las salidas se asientan en serie y cada una lee el saldo
 * que dejó la anterior, así que el orden de esta lista es el orden del libro: poner el gravamen en
 * cualquier otra posición dejaría el `saldo_resultante` de la última línea distinto del saldo final
 * de la bolsa, que es justo lo que el extracto usa para auditar sin recalcular.
 */
export function salidasDe(calculo: CalculoLiquidacion, ids: IdentificadoresTramite): SalidaConcepto[] {
  const salidas: SalidaConcepto[] = [];
  const porTramite = (concepto: string) => `tramite:${calculo.tramiteId}:${concepto}`;

  // Un concepto que cuesta cero no es un desembolso y no genera línea en el libro. Importa más de lo
  // que parece: el tarifario admite el cero a propósito (una tarifa de cortesía), y como el asiento
  // va dentro de la transacción del sellado, intentar mover $0 haría que el trámite no se pudiera
  // liquidar en absoluto.
  const cobrable = (v: number | null): v is number => v !== null && v > 0;

  if (cobrable(calculo.soat.valor) && ids.soatId !== null) {
    salidas.push({
      concepto: 'soat', valor: calculo.soat.valor,
      organismoCodigo: ids.soatOrganismo, llave: `soat:${ids.soatId}`,
    });
  }
  if (cobrable(calculo.impuesto.valor) && ids.impuestoId !== null) {
    salidas.push({
      concepto: 'impuesto', valor: calculo.impuesto.valor,
      organismoCodigo: ids.impuestoOrganismo, llave: `impuesto:${ids.impuestoId}`,
    });
  }
  if (cobrable(calculo.derecho.valor)) {
    salidas.push({
      concepto: 'derecho', valor: calculo.derecho.valor,
      organismoCodigo: ids.derechoOrganismo, llave: porTramite('derecho'),
    });
  }
  if (cobrable(calculo.tramiteDigital.valor)) {
    salidas.push({
      concepto: 'tramite_digital', valor: calculo.tramiteDigital.valor,
      organismoCodigo: null, llave: porTramite('tramite_digital'),
    });
  }
  if (cobrable(calculo.logistica.valor)) {
    salidas.push({
      concepto: 'logistica', valor: calculo.logistica.valor,
      organismoCodigo: null, llave: porTramite('logistica'),
    });
  }
  // Los servicios adicionales, por su SUMA y no uno por servicio (HU #12546): la bolsa lleva el
  // dinero y el desglose por tipo va en el detalle sellado. Una salida por servicio obligaría a una
  // llave por asignación, y esa llave no sobrevive a quitar y volver a asignar el mismo tipo.
  // Sin esta línea la bolsa descontaría `total − Σ servicios`: los servicios ya entran en la base
  // del GMF y en el total, así que el gravamen crece solo y el importe de los servicios no se
  // asentaría en ninguna parte. No lleva organismo: es un honorario de FLIT.
  if (cobrable(calculo.serviciosAdicionales.valor)) {
    salidas.push({
      concepto: 'servicios_adicionales', valor: calculo.serviciosAdicionales.valor,
      organismoCodigo: null, llave: porTramite('servicios_adicionales'),
    });
  }
  // El gravamen, al final y sobre la base ya calculada. Si todos los conceptos no aplicaran o
  // valieran cero, `valorGmf` sería cero y `cobrable` lo descarta igual que a cualquier otro: un
  // trámite de cortesía completo se sella sin mover un peso de la bolsa.
  if (cobrable(calculo.valorGmf)) {
    salidas.push({
      concepto: 'gmf', valor: calculo.valorGmf,
      organismoCodigo: null, llave: porTramite('gmf'),
    });
  }
  return salidas;
}

/** Liquidación vigente de un trámite, o null. */
export async function liquidacionDe(tramiteId: string): Promise<LiquidacionDto | null> {
  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) return null;
  const [t] = await db.select({ idFlit: flitoTramites.idFlit }).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  return aDto(l, t?.idFlit ?? '');
}

function aDto(l: typeof flitoLiquidaciones.$inferSelect, idFlit: string): LiquidacionDto {
  const d = (l.detalle ?? {}) as Partial<Record<string, ConceptoLiquidado>>
    & { serviciosAdicionales?: Partial<ConceptoServiciosAdicionales>; logistica?: Partial<ConceptoLogistica> };
  const concepto = (k: string, valor: string | null): ConceptoLiquidado =>
    d[k] ?? { valor: num(valor), origen: 'Sellado', bloquea: false };
  // Los honorarios llevan `origenValor` y `diferencia` desde la HU #12654; un sello anterior no trae
  // las claves y se lee con null en ambas — nunca se reconsulta `flito_comprobantes`: lo sellado no
  // se mueve, y una aceptación posterior se ve en el reporte, no aquí.
  const honorario = (k: string, valor: string | null): ConceptoHonorarioLiquidado => {
    const c = concepto(k, valor);
    return { ...c, origenValor: c.origenValor ?? null, diferencia: c.diferencia ?? null };
  };
  // La logística tampoco pasa por `concepto()`: lleva `tarifa` y `viajes` (HU #12626). Un sello
  // anterior a esta HU no tiene `viajes` en su detalle y se lee con `viajes: null` / `totalViajes:
  // null` — NUNCA `[]` ni 1, que afirmarían «se selló sin viajes» sobre algo que no se sabe. Y en
  // ningún caso se reconsulta `flito_tramite_viajes_logistica`: tras un reverso los viajes cambian y
  // lo sellado no.
  const logistica: ConceptoLogistica = Array.isArray(d.logistica?.viajes)
    ? {
      valor: d.logistica.valor ?? null, origen: d.logistica.origen ?? 'Sellado', bloquea: false,
      tarifa: d.logistica.tarifa ?? null, viajes: d.logistica.viajes,
      totalViajes: d.logistica.totalViajes ?? null,
      origenValor: d.logistica.origenValor ?? null, diferencia: d.logistica.diferencia ?? null,
    }
    : {
      valor: num(l.valorLogistica), origen: d.logistica?.origen ?? 'Sellado', bloquea: false,
      tarifa: null, viajes: null, totalViajes: null, origenValor: null, diferencia: null,
    };
  // Los servicios adicionales no pasan por `concepto()`: llevan `items`, que la columna no guarda.
  // El detalle manda y la columna es el respaldo, igual que los otros cinco — una liquidación
  // sellada ANTES de la HU #12546 no tiene la clave y su columna es NULL, y así se lee sin romper.
  // Lo que NO se hace en ningún caso es recalcular desde la puente: los servicios pueden haberse
  // quitado o su tipo haberse dado de baja después del sello, y lo sellado no se mueve (AC4).
  const serviciosAdicionales: ConceptoServiciosAdicionales = d.serviciosAdicionales
    ? {
      valor: d.serviciosAdicionales.valor ?? null,
      origen: d.serviciosAdicionales.origen ?? ORIGEN_SERVICIOS_ADICIONALES,
      bloquea: false,
      items: d.serviciosAdicionales.items ?? [],
      origenValor: d.serviciosAdicionales.origenValor ?? null, diferencia: d.serviciosAdicionales.diferencia ?? null,
    }
    : {
      valor: num(l.valorServiciosAdicionales), origen: 'Sellado', bloquea: false, items: [], origenValor: null, diferencia: null,
    };
  return {
    id: l.id,
    tramiteId: l.tramiteId,
    idFlit,
    estado: l.estado as EstadoLiquidacion,
    soat: concepto('soat', l.valorSoat),
    impuesto: concepto('impuesto', l.valorImpuesto),
    derecho: concepto('derecho', l.valorDerecho),
    tramiteDigital: honorario('tramiteDigital', l.valorTramiteDigital),
    logistica,
    serviciosAdicionales,
    baseGmf: Number(l.baseGmf), tasaGmf: Number(l.tasaGmf), valorGmf: Number(l.valorGmf),
    total: Number(l.total),
    faltantes: [],
    liquidadoEn: l.liquidadoEn.toISOString(),
    facturadoEn: l.facturadoEn ? l.facturadoEn.toISOString() : null,
  };
}

/**
 * Sella la liquidación. Falla —con la lista de faltantes— si algún concepto aplicable no está
 * resuelto: liquidar a medias congelaría un cobro incompleto que nadie volvería a revisar.
 */
export async function liquidar(tramiteId: string, usuarioId: number | null): Promise<LiquidacionDto> {
  const existente = await liquidacionDe(tramiteId);
  if (existente) {
    throw new LiquidacionError('El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.');
  }

  const previo = await calcular(tramiteId);
  if (previo.faltantes.length > 0) {
    throw new LiquidacionBloqueadaError('El trámite no puede liquidarse todavía', previo.faltantes);
  }

  const ids = await identificadoresDe(tramiteId);

  const dto = await db.transaction(async (tx) => {
    // El MISMO bloqueo que toman asignar y quitar (ADR-0017, RN-03 de la HU #12545): a partir de
    // aquí nadie mete ni saca un servicio de este trámite hasta el COMMIT. Se toma ANTES de leer la
    // puente, que es lo único que hace que lo sellado sea lo que estaba asignado.
    await bloquearTramite(tx, tramiteId).catch(traducirTramiteNoEncontrado);
    // Las filas documentales, con el MISMO `tx` y bajo el mismo bloqueo (HU #12654, AC5): `aplicar`
    // toma este `FOR UPDATE` antes de escribirlas, así que lo que se lee aquí es lo aplicado al COMMIT.
    const docs = await documentalesDe(tx, tramiteId);
    const servicios = conceptoServicios(await serviciosAsignadosDe(tx, tramiteId), docs.serviciosAdicionales);
    // Los viajes adicionales, con el MISMO `tx` y bajo el mismo bloqueo (HU #12626): registrar y
    // quitar lo toman también, así que nadie mete un viaje entre esta lectura y el COMMIT.
    const viajes = await viajesDe(tx, tramiteId);
    // Base, gravamen y total se RECOMPONEN con lo que se acaba de leer bajo bloqueo. El cálculo de
    // arriba solo decidió que no faltaba nada; si alguien aplicó un comprobante, asignó un servicio o
    // registró un viaje entre medias, lo que se sella —y lo que alimenta las bolsas— es esta lectura.
    const calculo = totalizar(previo, servicios, viajes, docs);

    const detalle = {
      soat: calculo.soat, impuesto: calculo.impuesto, derecho: calculo.derecho,
      // Con `origenValor` y `diferencia` (HU #12654): el reporte de costos lee
      // `detalle->'tramiteDigital'->>'origenValor'` de las filas selladas.
      tramiteDigital: calculo.tramiteDigital,
      // Con `tarifa`, `viajes` (SIEMPRE array, también vacío) y `totalViajes`: el desglose por viaje
      // se congela aquí y `aDto` lo lee sin volver a la tabla (HU #12626).
      logistica: calculo.logistica,
      // Se escribe SIEMPRE, también vacía: así `detalle->'serviciosAdicionales'->'items'` existe en
      // todo lo sellado por esta HU y el reporte puede distinguir «cero servicios» (0) de «sellada
      // antes de la HU» (sin clave), en vez de leer lo mismo en los dos casos.
      serviciosAdicionales: calculo.serviciosAdicionales,
    };
    const valores = {
      tramiteId,
      estado: ESTADO_LIQUIDACION.LIQUIDADO,
      valorSoat: calculo.soat.valor === null ? null : String(calculo.soat.valor),
      valorImpuesto: calculo.impuesto.valor === null ? null : String(calculo.impuesto.valor),
      valorDerecho: calculo.derecho.valor === null ? null : String(calculo.derecho.valor),
      valorTramiteDigital: calculo.tramiteDigital.valor === null ? null : String(calculo.tramiteDigital.valor),
      valorLogistica: calculo.logistica.valor === null ? null : String(calculo.logistica.valor),
      valorServiciosAdicionales: calculo.serviciosAdicionales.valor === null
        ? null
        : String(calculo.serviciosAdicionales.valor),
      baseGmf: String(calculo.baseGmf), tasaGmf: String(calculo.tasaGmf), valorGmf: String(calculo.valorGmf),
      total: String(calculo.total), detalle, liquidadoPorId: usuarioId,
    };
    // Se calculan UNA vez y alimentan los dos libros: el del cliente por lo que se le cobra, y el de
    // tránsito por lo que se paga ante la secretaría. Recalcularlas por separado abriría la puerta a
    // que los dos lados del asiento dejaran de cuadrar entre sí. Y se calculan DENTRO de la
    // transacción, sobre el cálculo ya recompuesto: si se hicieran fuera, la bolsa descontaría el
    // importe viejo y el sellado guardaría el nuevo.
    const salidas = ids ? salidasDe(calculo, ids) : [];

    const [fila] = await tx.insert(flitoLiquidaciones).values(valores).returning();
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'liquidar', usuarioId, snapshot: { ...detalle, total: calculo.total },
    });

    // Las salidas de la bolsa se asientan DENTRO de esta transacción (HU #11122): si el sellado no
    // cuaja, el descuento no puede quedar hecho. La compañía puede faltar en trámites que aún no
    // cruzaron con un cliente; ahí no hay bolsa a la que cobrar.
    if (ids?.companiaId != null) {
      await registrarSalidasLiquidacion(
        tx,
        {
          companiaId: ids.companiaId,
          tramiteId,
          fecha: fechaContable(),
          conceptos: salidas,
        },
        { userId: usuarioId, nombre: 'sistema' },
      );
    }

    // El OTRO lado del asiento (HU #11161): lo que se paga ANTE una secretaría también consume la
    // bolsa que FLIT precargó para ella. Es un libro distinto del de la compañía, así que el mismo
    // concepto deja una línea en cada uno — en el del cliente por lo que se le cobra, en el de
    // tránsito por lo que se gasta del saldo precargado.
    //
    // Se recorren las MISMAS salidas que ya alimentan la bolsa del cliente en vez de recalcularlas:
    // cada una trae su concepto, su valor y el organismo de su propio registro (que puede diferir
    // del organismo del trámite). Las que no van a una secretaría —trámite digital, logística, GMF—
    // no traen organismo y quedan fuera solas; el GMF además ya viene incluido en el total del
    // comprobante del organismo (AC4).
    //
    // No depende de la compañía: un cliente autogestionado consume igual, porque el pago ante la
    // secretaría ocurre de todas formas. Y si ninguna bolsa cubre ese par, `registrarConsumoTransito`
    // no hace nada: sellar un trámite de una secretaría que nadie metió en una bolsa sigue igual.
    for (const salida of salidas) {
      if (salida.organismoCodigo === null || !esConceptoDeTransito(salida.concepto)) continue;
      await registrarConsumoTransito(
        tx,
        {
          organismoCodigo: salida.organismoCodigo,
          concepto: salida.concepto,
          tramiteId,
          valor: salida.valor,
          fecha: fechaContable(),
          llave: salida.llave,
        },
        { userId: usuarioId, nombre: 'sistema' },
      );
    }

    return aDto(fila, calculo.idFlit);
  });
  return dto;
}

/**
 * `TramiteNoEncontradoError` es del módulo de servicios adicionales; la ruta de liquidación no lo
 * conoce y lo traduciría a 500. Se convierte al error de dominio de aquí, que ya sabe salir por 404.
 */
function traducirTramiteNoEncontrado(e: unknown): never {
  if (e instanceof TramiteNoEncontradoError) throw new LiquidacionError('El trámite no existe');
  throw e;
}

/**
 * ¿Este concepto se paga ANTE una secretaría?
 *
 * Estrecha el `string` de `SalidaConcepto` al subconjunto que la bolsa de tránsito puede cubrir. Los
 * que quedan fuera (trámite digital, logística, GMF) no llevan organismo, así que en la práctica ya
 * se filtran solos; esto además se lo demuestra al compilador.
 */
function esConceptoDeTransito(concepto: string): concepto is ConceptoBolsaTransito {
  return esConceptoBolsaTransito(concepto);
}

/** Un instante como día calendario de Colombia (yyyy-mm-dd). */
function diaColombia(instante: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instante);
}

/** Hoy en Colombia: la fecha con la que se imputa el descuento al periodo contable. */
function fechaContable(): string {
  return diaColombia(new Date());
}

/**
 * Deshace la liquidación. Permitido hasta que el trámite se marque como facturado; después, los
 * valores quedan congelados de verdad.
 *
 * Borra la fila (el UNIQUE por trámite lo exige) y guarda el snapshot completo en la bitácora: nada
 * se pierde y volver a liquidar queda limpio.
 */
export async function reversar(tramiteId: string, motivo: string, usuarioId: number | null): Promise<void> {
  const texto = motivo.trim();
  if (texto.length < 5) throw new LiquidacionError('Indica el motivo del reverso (mínimo 5 caracteres)');

  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) throw new LiquidacionError('El trámite no está liquidado');
  if (l.estado === ESTADO_LIQUIDACION.FACTURADO) {
    // HU #11343, AC5 — **la prohibición no cambia**: una factura electrónica aceptada por la DIAN no
    // se deshace reversando una fila de FLITO. Lo que cambia es que el mensaje deja de ser un
    // callejón sin salida. Antes decía «no puede reversarse» y ahí se acababa, y quien lo leía se iba
    // a preguntar por WhatsApp — donde la respuesta no queda registrada en ningún sitio.
    //
    // `viaDeCorreccionDeTramite` no lanza: si la consulta falla o el trámite se facturó por otro
    // medio, devuelve null y el mensaje se queda como estaba. Convertir un rechazo de negocio
    // explicado en un 500 sería peor que no dar la vía.
    const via = await viaDeCorreccionDeTramite(tramiteId);
    throw new LiquidacionError(via
      ? `El trámite ya está facturado: su liquidación no puede reversarse. ${via}`
      : 'El trámite ya está facturado: su liquidación no puede reversarse');
  }

  await db.transaction(async (tx) => {
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'reversar', motivo: texto, usuarioId,
      snapshot: { ...(l.detalle as object ?? {}), total: Number(l.total), liquidadoEn: l.liquidadoEn.toISOString() },
    });
    // Devuelve a la bolsa lo descontado por este sellado y libera las llaves, para que volver a
    // liquidar vuelva a cobrar (HU #11122, AC5).
    await reversarSalidasLiquidacion(tx, tramiteId, { userId: usuarioId, nombre: 'sistema' });
    // Y lo mismo del otro lado: las bolsas de tránsito recuperan lo que este trámite les consumió
    // (HU #11161, AC9). Es un no-op si ninguna bolsa cubría sus conceptos.
    await reversarConsumoTransito(tx, tramiteId, { userId: usuarioId, nombre: 'sistema' });
    await tx.delete(flitoLiquidaciones).where(eq(flitoLiquidaciones.id, l.id));
  });
}

/** Marca como facturado. A partir de aquí la liquidación deja de poder reversarse. */
export async function facturar(tramiteId: string, usuarioId: number | null): Promise<LiquidacionDto> {
  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) throw new LiquidacionError('El trámite no está liquidado: no puede facturarse');
  if (l.estado === ESTADO_LIQUIDACION.FACTURADO) throw new LiquidacionError('El trámite ya está facturado');

  const dto = await db.transaction(async (tx) => {
    const [fila] = await tx.update(flitoLiquidaciones)
      .set({ estado: ESTADO_LIQUIDACION.FACTURADO, facturadoPorId: usuarioId, facturadoEn: new Date(), updatedAt: new Date() })
      .where(eq(flitoLiquidaciones.id, l.id)).returning();
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'facturar', usuarioId, snapshot: { total: Number(fila.total) },
    });
    return fila;
  });

  const [t] = await db.select({ idFlit: flitoTramites.idFlit }).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  return aDto(dto, t?.idFlit ?? '');
}

export interface EventoLiquidacion {
  id: string; accion: string; motivo: string | null; snapshot: unknown; creadoEn: string;
}

/** Bitácora de la liquidación de un trámite, más reciente primero. */
export async function eventosDe(tramiteId: string): Promise<EventoLiquidacion[]> {
  const filas = await db.select().from(flitoLiquidacionEventos)
    .where(eq(flitoLiquidacionEventos.tramiteId, tramiteId))
    .orderBy(desc(flitoLiquidacionEventos.createdAt));
  return filas.map((f) => ({
    id: f.id, accion: f.accion, motivo: f.motivo, snapshot: f.snapshot, creadoEn: f.createdAt.toISOString(),
  }));
}

/**
 * Liquidación en lote. Nunca falla entera: cada trámite se intenta por separado y se reporta su
 * resultado, porque en un lote de 50 lo normal es que a unos pocos les falte algo.
 */
export interface ResultadoLote {
  liquidados: string[];
  fallidos: Array<{ tramiteId: string; motivo: string; faltantes: string[] }>;
}

export async function liquidarLote(tramiteIds: string[], usuarioId: number | null): Promise<ResultadoLote> {
  const r: ResultadoLote = { liquidados: [], fallidos: [] };
  for (const id of tramiteIds) {
    try {
      await liquidar(id, usuarioId);
      r.liquidados.push(id);
    } catch (e) {
      const err = e as LiquidacionError;
      r.fallidos.push({ tramiteId: id, motivo: err.message, faltantes: err.faltantes ?? [] });
    }
  }
  return r;
}
