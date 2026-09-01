// FLITO Conciliación — carga del Excel del portal y CRUCE por número de póliza (HU #11676).
//
// Qué hace esta HU y qué NO hace: aquí NO sale un peso de ninguna bolsa. La carga lee el archivo,
// cruza cada fila contra los SOAT de la compañía y deja la boleta en `cargada` con su cuadre
// resuelto. Mover el dinero es la HU #11677 (`conciliar`), y por eso este archivo no importa nada
// del libro de bolsa salvo para RESPONDER una pregunta de lectura (ver `yaDescontadoEnLiquidacion`).
//
// ── Las reglas del cruce, en el orden en que se aplican ──────────────────────────────────────────
//
// Para cada fila del Excel, con su póliza ya normalizada:
//
//   1. ¿Cuántos SOAT tienen esa póliza?  ← se CUENTAN, no se coge el primero
//        0  → no_encontrada
//        >1 → poliza_duplicada, con cuántos son
//   2. Con exactamente uno:
//        ¿es de otra compañía?            → otra_compania
//        ¿no está en 'pagado'?            → no_pagado, con el estado de hoy
//        ¿ya se concilió en otra boleta?  → ya_conciliada, con cuál y cuándo
//        ¿la llave ya está en OTRA bolsa? → cobrado_otro_cliente (Bug #11773)
//        ¿el valor no coincide al peso?   → valor_distinto, con los dos importes
//        si no                            → ok
//
// El punto 1 es el que hay que defender: `idx_flito_soat_numero_poliza` es **NO ÚNICO** a propósito
// (ADR-0006 §8), así que un `LIMIT 1` sobre esa consulta no fallaría — cruzaría en silencio contra
// el SOAT equivocado y descontaría de la bolsa el valor de otro vehículo. Contar es lo que convierte
// ese riesgo en una fila marcada delante de la persona que puede corregir el número.
//
// El orden de los descartes del punto 2 tampoco es arbitrario: cada uno responde una pregunta que
// invalida las siguientes. Un SOAT de otro cliente no se arregla pagándolo, uno ya conciliado no
// se arregla corrigiéndole el valor, y uno cobrado en la bolsa de otro cliente no se «adopta».
//
// ── El valor se compara ESTRICTO (AC3) ───────────────────────────────────────────────────────────
//
// Un peso de diferencia es `valor_distinto` y para la boleta entera. No hay tolerancia y no debe
// haberla: el ADR-0006 §2.6 explica por qué —con una tolerancia, la bolsa se llevaría el importe del
// primero que llegase (Excel o liquidación) y la factura diría otro número—. La comparación se hace
// en CENTAVOS ENTEROS y no en flotantes: `740800.10 !== 740800.10` es una posibilidad real cuando
// los dos lados vienen de sitios distintos (un `numeric` de Postgres y un double de Excel).
//
// Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md
// Redacción de los motivos en pantalla: docs/ux/flito-conciliacion.md

import { createHash } from 'crypto';
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import {
  CodigoErrorConciliacion, ResultadoCruce,
  type BoletaDetalleDto, type BoletaListadoDto, type BoletaResumenDto, type ConceptoBoleta,
  type ConteoResultados, type EstadoBoleta, type LineaBoletaDto,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsaMovimientos, flitoConciliacionBoletas, flitoConciliacionLineas, flitoSoat,
  vehicles,
} from '../../db/schema.js';
import { hoyIso, num, redondear, type CtxUsuario, type Tx } from '../flito-bolsas/flito-bolsas.service.js';
import { parsearBoleta, type FilaBoleta } from './flito-conciliacion.excel.js';
import { comprobanteDeBoleta } from './flito-conciliacion.comprobante.service.js';
import { ConciliacionError } from './flito-conciliacion.errores.js';

type DbOrTx = typeof db | Tx;

// El error de dominio vive en su propio archivo para no cerrar un ciclo de importación con el
// servicio del comprobante, que también lo lanza (ver su cabecera). Se re-exporta para que ningún
// importador tenga que enterarse.
export { ConciliacionError };

/** Prefijo de la llave con la que la liquidación reserva la salida de un SOAT (`salidasDe`). */
const LLAVE_SALIDA_SOAT = 'salida:soat:';

/** Página del listado. Se acota aquí y no en la ruta: el tope es del recurso, no del transporte. */
const LISTADO_LIMITE_MAX = 100;
const LISTADO_LIMITE_DEFECTO = 25;

/** Todos los desenlaces posibles, para que el conteo traiga las ocho claves aunque valgan 0. */
const RESULTADOS = Object.values(ResultadoCruce);

// ───────────────────────────── Contexto del cruce ────────────────────────────

/** Un SOAT candidato, con lo que el cuadre necesita enseñar de él. */
export interface SoatInfo {
  id: string;
  numeroPoliza: string | null;
  estado: string;
  valorPagado: number | null;
  companiaId: number;
  companiaNombre: string | null;
  placa: string | null;
  /**
   * Organismo al que se imputa la salida, congelado en el propio SOAT.
   *
   * No lo usa el cruce: lo usa el asiento de la HU #11677, y sale de aquí porque es EXACTAMENTE la
   * misma fuente que `salidasDe` de la liquidación (`ids.soatOrganismo`). Si los dos caminos
   * tomaran el organismo de sitios distintos —uno del SOAT y otro del trámite, que se reescribe en
   * cada sincronización—, el mismo pago acabaría imputado a dos secretarías según quién lo asentara.
   * `null` es valor real: el canal Cliente nace sin organismo (HU #11935); no se sustituye por `''`.
   */
  organismoCodigo: string | null;
}

interface BoletaPrevia {
  referencia: string;
  fechaPago: string;
}

/**
 * Todo lo que hace falta para evaluar (o para volver a explicar) un conjunto de pólizas.
 *
 * Se arma con cuatro consultas y no con una por fila: 500 filas × 4 consultas serían 2 000 viajes a
 * la base dentro de una transacción que, en la HU siguiente, además mueve dinero.
 */
export interface ContextoCruce {
  /** Póliza normalizada → TODOS los SOAT que la tienen. La longitud del array es `candidatos`. */
  porPoliza: Map<string, SoatInfo[]>;
  /** SOAT por id, para poder explicar una línea aunque su póliza haya cambiado desde el cruce. */
  porSoatId: Map<string, SoatInfo>;
  /** SOAT ya conciliado en OTRA boleta → cuál y cuándo se pagó. */
  previas: Map<string, BoletaPrevia>;
  /**
   * SOAT cuya salida de bolsa ya reservó el sellado de ESTA compañía (`origen='automatico'`).
   * Un `automatico` de otro cliente no entra aquí: eso es `cobradosOtro`.
   */
  descontados: Set<string>;
  /** SOAT cuya llave `salida:soat:<id>` ya está en el libro de OTRO cliente, cualquier origen. */
  cobradosOtro: Map<string, { companiaNombre: string | null }>;
}

function infoDeFila(f: {
  id: string; numeroPoliza: string | null; estado: string; valorPagado: string | null;
  companiaId: number; companiaNombre: string | null; placa: string | null;
  organismoCodigo: string | null;
}): SoatInfo {
  return {
    id: f.id,
    numeroPoliza: f.numeroPoliza,
    estado: f.estado,
    valorPagado: f.valorPagado === null ? null : num(f.valorPagado),
    companiaId: f.companiaId,
    companiaNombre: f.companiaNombre,
    placa: f.placa,
    organismoCodigo: f.organismoCodigo,
  };
}

/** La proyección de un SOAT candidato: id, póliza, estado, valor, cliente, placa y organismo. */
function seleccionSoat() {
  return {
    id: flitoSoat.id,
    numeroPoliza: flitoSoat.numeroPoliza,
    estado: flitoSoat.estado,
    valorPagado: flitoSoat.valorPagado,
    companiaId: flitoSoat.companiaId,
    companiaNombre: clients.name,
    placa: vehicles.plate,
    organismoCodigo: flitoSoat.organismoCodigo,
  };
}

/**
 * Arma el contexto de un conjunto de pólizas.
 *
 * Las consultas van EN SERIE y en este orden fijo a propósito: el mock de drizzle de la suite
 * enruta por tabla y encola por orden dentro de cada tabla, así que un `Promise.all` haría que los
 * tests dependieran de un orden que la especificación de `Promise.all` no garantiza.
 *
 * @param boletaId Boleta que se está cruzando. Sus PROPIAS líneas quedan fuera de `previas`: al
 *   re-cruzar (AC5) una boleta no puede acusarse a sí misma de haber conciliado ya el SOAT.
 * @param companiaBoletaId Compañía de la boleta. Distingue `descontados` (esta bolsa) de
 *   `cobradosOtro` (la llave vive en el libro de otro cliente).
 */
async function contextoDe(
  dbx: DbOrTx,
  polizas: string[],
  boletaId: string,
  companiaBoletaId: number,
): Promise<ContextoCruce> {
  const porPoliza = new Map<string, SoatInfo[]>();
  const porSoatId = new Map<string, SoatInfo>();
  const previas = new Map<string, BoletaPrevia>();
  const descontados = new Set<string>();
  const cobradosOtro = new Map<string, { companiaNombre: string | null }>();

  if (polizas.length === 0) {
    return { porPoliza, porSoatId, previas, descontados, cobradosOtro };
  }

  // 1. TODOS los SOAT con alguna de esas pólizas. Sin filtro de compañía: `otra_compania` solo se
  //    puede diagnosticar si el SOAT del otro cliente entra en el resultado.
  const candidatos = await dbx.select(seleccionSoat())
    .from(flitoSoat)
    .leftJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(inArray(flitoSoat.numeroPoliza, polizas));

  for (const fila of candidatos) {
    const info = infoDeFila(fila);
    porSoatId.set(info.id, info);
    const clave = info.numeroPoliza ?? '';
    const lista = porPoliza.get(clave) ?? [];
    lista.push(info);
    porPoliza.set(clave, lista);
  }

  const soatIds = [...porSoatId.keys()];
  if (soatIds.length === 0) return { porPoliza, porSoatId, previas, descontados, cobradosOtro };

  // 2. ¿Alguno de esos SOAT ya se concilió en otra boleta? Es el diagnóstico de `ya_conciliada`; la
  //    barrera de verdad es `idx_flito_concil_linea_soat_unica`, que vive en la base.
  const conciliadas = await dbx.select({
    soatId: flitoConciliacionLineas.soatId,
    referencia: flitoConciliacionBoletas.referencia,
    fechaPago: flitoConciliacionBoletas.fechaPago,
  })
    .from(flitoConciliacionLineas)
    .innerJoin(
      flitoConciliacionBoletas,
      eq(flitoConciliacionLineas.boletaId, flitoConciliacionBoletas.id),
    )
    .where(and(
      inArray(flitoConciliacionLineas.soatId, soatIds),
      isNotNull(flitoConciliacionLineas.conciliadaEn),
      ne(flitoConciliacionLineas.boletaId, boletaId),
    ));

  for (const c of conciliadas) {
    if (c.soatId) previas.set(c.soatId, { referencia: c.referencia, fechaPago: c.fechaPago });
  }

  // 3. ¿Alguna de esas llaves ya está en el libro? El unique es GLOBAL, así que el asiento puede
  //    ser de ESTA compañía o de otra. Se leen TODOS los orígenes: `cobrado_otro_cliente` no
  //    distingue liquidación de conciliación ajena. `yaDescontadoEnLiquidacion` sí: solo el
  //    `automatico` de ESTA compañía (sin ese filtro, una boleta conciliada se acusaría a sí misma).
  const movimientos = await dbx.select({
    llave: flitoBolsaMovimientos.llaveIdempotencia,
    companiaId: flitoBolsaMovimientos.companiaId,
    origen: flitoBolsaMovimientos.origen,
    companiaNombre: clients.name,
  })
    .from(flitoBolsaMovimientos)
    .leftJoin(clients, eq(flitoBolsaMovimientos.companiaId, clients.id))
    .where(inArray(
      flitoBolsaMovimientos.llaveIdempotencia,
      soatIds.map((id) => `${LLAVE_SALIDA_SOAT}${id}`),
    ));

  for (const m of movimientos) {
    const llave = m.llave;
    if (!llave || !llave.startsWith(LLAVE_SALIDA_SOAT)) continue;
    const soatId = llave.slice(LLAVE_SALIDA_SOAT.length);
    if (m.companiaId !== companiaBoletaId) {
      cobradosOtro.set(soatId, { companiaNombre: m.companiaNombre ?? null });
      continue;
    }
    if (m.origen === 'automatico') descontados.add(soatId);
  }

  return { porPoliza, porSoatId, previas, descontados, cobradosOtro };
}

/**
 * Completa el contexto con los SOAT que las líneas YA guardadas apuntan pero cuya póliza ya no
 * coincide con la de la línea.
 *
 * Pasa de verdad: alguien corrige el número de póliza del SOAT —que es justo lo que la pantalla le
 * pide hacer ante un `poliza_duplicada`— y desde ese momento el detalle de una boleta vieja no
 * podría enseñar ni la placa ni el valor de un SOAT que sí cruzó en su día.
 */
async function completarPorSoatId(dbx: DbOrTx, ctx: ContextoCruce, soatIds: string[]): Promise<void> {
  const faltantes = soatIds.filter((id) => !ctx.porSoatId.has(id));
  if (faltantes.length === 0) return;
  const filas = await dbx.select(seleccionSoat())
    .from(flitoSoat)
    .leftJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(inArray(flitoSoat.id, faltantes));
  for (const fila of filas) ctx.porSoatId.set(fila.id, infoDeFila(fila));
}

// ───────────────────────────── La evaluación ─────────────────────────────────

/** Lo que el cruce decide de UNA fila: su desenlace y los campos que lo explican. */
interface Evaluacion {
  resultado: string;
  soatId: string | null;
  detalle: string | null;
  candidatos: number | null;
}

/** Compara en centavos enteros: dos `numeric` que pasan por double no son fiables al céntimo. */
function centavos(valor: number): number {
  return Math.round(redondear(valor) * 100);
}

/**
 * Evalúa una fila contra el contexto. Función PURA: no toca la base, no lanza y no depende del
 * reloj — que es lo que permite probar los ocho desenlaces sin montar una transacción.
 */
export function evaluarFila(
  fila: { numeroPolizaNorm: string; valorDeclarado: number },
  ctx: ContextoCruce,
  companiaBoletaId: number,
): Evaluacion {
  const candidatos = ctx.porPoliza.get(fila.numeroPolizaNorm) ?? [];

  if (candidatos.length === 0) {
    return {
      resultado: ResultadoCruce.NO_ENCONTRADA,
      soatId: null,
      detalle: 'Ningún SOAT de FLITO tiene este número de póliza.',
      candidatos: null,
    };
  }

  if (candidatos.length > 1) {
    // NO se elige uno. El índice de póliza es no único (ADR-0006 §8) y quedarse con el primero es
    // exactamente el fallo silencioso que ese diseño evita: se para la fila y se dice cuántos hay.
    return {
      resultado: ResultadoCruce.POLIZA_DUPLICADA,
      soatId: null,
      detalle: `Esta póliza aparece en ${candidatos.length} SOAT distintos.`,
      candidatos: candidatos.length,
    };
  }

  const soat = candidatos[0];

  if (soat.companiaId !== companiaBoletaId) {
    // El cliente de referencia es el que se eligió al cargar la boleta, no el del primer SOAT que
    // cruce: deducirlo del archivo permitiría descontar de la bolsa de un cliente los SOAT de otro.
    return {
      resultado: ResultadoCruce.OTRA_COMPANIA,
      soatId: soat.id,
      detalle: 'El SOAT pertenece a otro cliente.',
      candidatos: null,
    };
  }

  if (soat.estado !== 'pagado') {
    return {
      resultado: ResultadoCruce.NO_PAGADO,
      soatId: soat.id,
      detalle: `El SOAT existe pero está en «${soat.estado}», no en «pagado».`,
      candidatos: null,
    };
  }

  const previa = ctx.previas.get(soat.id);
  if (previa) {
    return {
      resultado: ResultadoCruce.YA_CONCILIADA,
      soatId: soat.id,
      detalle: `Este SOAT ya se concilió en la boleta ${previa.referencia}.`,
      candidatos: null,
    };
  }

  // Bug #11773: la llave ya está en el libro de OTRO cliente. Va después de `otra_compania` /
  // `ya_conciliada` y antes de `ok` (y de `valor_distinto`): el dueño del asiento manda sobre el
  // importe. Cualquier origen. No se adopta ni se vuelve a cobrar.
  if (ctx.cobradosOtro.has(soat.id)) {
    return {
      resultado: ResultadoCruce.COBRADO_OTRO_CLIENTE,
      soatId: soat.id,
      detalle: 'Este SOAT ya se descontó de la bolsa de otro cliente.',
      candidatos: null,
    };
  }

  // Un SOAT 'pagado' sin `valor_pagado` no es conciliable: no hay contra qué comparar y el importe
  // que saldría de la bolsa sería cero. Se trata como diferencia de valor, que es lo que es.
  if (soat.valorPagado === null || centavos(soat.valorPagado) !== centavos(fila.valorDeclarado)) {
    return {
      resultado: ResultadoCruce.VALOR_DISTINTO,
      soatId: soat.id,
      detalle: soat.valorPagado === null
        ? 'El SOAT no tiene registrado el valor pagado.'
        : `El portal cobra ${fila.valorDeclarado} y el SOAT vale ${soat.valorPagado}.`,
      candidatos: null,
    };
  }

  return { resultado: ResultadoCruce.OK, soatId: soat.id, detalle: null, candidatos: null };
}

// ───────────────────────────── Los DTO ───────────────────────────────────────

/** Fila de `flito_conciliacion_lineas` tal como sale de la base. */
export interface FilaLinea {
  id: string;
  filaNumero: number;
  numeroPolizaNorm: string;
  valorDeclarado: string;
  soatId: string | null;
  resultado: string;
  detalle: string | null;
  conciliadaEn: Date | null;
}

/**
 * Compone la línea que ve la pantalla.
 *
 * `resultado` y `detalle` salen de la BASE —son el rastro de lo que se decidió el día del cruce— y
 * los campos que EXPLICAN el motivo se recalculan aquí contra el estado de hoy. La pantalla no
 * recibe ni una frase redactada por el servidor: compone el texto con estos campos (docs/ux). Si el
 * motivo viniera hecho, cambiar una palabra exigiría migrar datos.
 */
function lineaDto(linea: FilaLinea, ctx: ContextoCruce): LineaBoletaDto {
  const soat = linea.soatId ? ctx.porSoatId.get(linea.soatId) ?? null : null;
  const candidatos = ctx.porPoliza.get(linea.numeroPolizaNorm)?.length ?? 0;
  const previa = linea.soatId ? ctx.previas.get(linea.soatId) ?? null : null;

  return {
    id: linea.id,
    filaNumero: linea.filaNumero,
    numeroPolizaNorm: linea.numeroPolizaNorm,
    valorDeclarado: num(linea.valorDeclarado),
    resultado: linea.resultado as LineaBoletaDto['resultado'],
    detalle: linea.detalle,
    soatId: linea.soatId,
    placa: soat?.placa ?? null,
    valorSoat: soat?.valorPagado ?? null,
    soatEstado: soat?.estado ?? null,
    companiaSoatNombre: soat?.companiaNombre ?? null,
    // Solo se informa cuando de verdad hay más de uno: un `1` invitaría a leerlo como «hay un
    // problema» en las 499 líneas que están bien.
    candidatos: candidatos > 1 ? candidatos : null,
    boletaAnteriorRef: previa?.referencia ?? null,
    boletaAnteriorFecha: previa?.fechaPago ?? null,
    companiaCobroNombre: linea.soatId
      ? ctx.cobradosOtro.get(linea.soatId)?.companiaNombre ?? null
      : null,
    yaDescontadoEnLiquidacion: linea.soatId ? ctx.descontados.has(linea.soatId) : false,
    conciliadaEn: linea.conciliadaEn ? linea.conciliadaEn.toISOString() : null,
  };
}

function conteoVacio(): ConteoResultados {
  const c = {} as ConteoResultados;
  for (const r of RESULTADOS) c[r] = 0;
  return c;
}

function conteoDe(resultados: string[]): ConteoResultados {
  const c = conteoVacio();
  for (const r of resultados) {
    if (r in c) c[r as keyof ConteoResultados] += 1;
  }
  return c;
}

/** Fila de `flito_conciliacion_boletas` con el nombre del cliente. */
export interface FilaBoletaDb {
  id: string;
  referencia: string;
  companiaId: number;
  concepto: string;
  estado: string;
  archivoNombre: string;
  filas: number;
  totalDeclarado: string;
  totalCruzado: string | null;
  fechaPago: string;
  cargadaPorNombre: string;
  conciliadaEn: Date | null;
  conciliadaPorNombre: string | null;
  createdAt: Date;
}

function resumenDto(
  b: FilaBoletaDb,
  companiaNombre: string | null,
  conteo: ConteoResultados,
): BoletaResumenDto {
  return {
    id: b.id,
    referencia: b.referencia,
    companiaId: b.companiaId,
    companiaNombre,
    concepto: b.concepto as ConceptoBoleta,
    estado: b.estado as EstadoBoleta,
    archivoNombre: b.archivoNombre,
    filas: b.filas,
    totalDeclarado: num(b.totalDeclarado),
    totalCruzado: b.totalCruzado === null ? null : num(b.totalCruzado),
    fechaPago: b.fechaPago,
    cargadaPorNombre: b.cargadaPorNombre,
    conciliadaEn: b.conciliadaEn ? b.conciliadaEn.toISOString() : null,
    conciliadaPorNombre: b.conciliadaPorNombre,
    createdAt: b.createdAt.toISOString(),
    conteo,
    // Lo que decide si la boleta se puede conciliar (CF-02): basta UNA línea fuera de `ok`.
    sinCuadrar: b.filas - conteo[ResultadoCruce.OK],
  };
}

// ───────────────────────────── Lectura ───────────────────────────────────────

const SELECCION_BOLETA = {
  id: flitoConciliacionBoletas.id,
  referencia: flitoConciliacionBoletas.referencia,
  companiaId: flitoConciliacionBoletas.companiaId,
  concepto: flitoConciliacionBoletas.concepto,
  estado: flitoConciliacionBoletas.estado,
  archivoNombre: flitoConciliacionBoletas.archivoNombre,
  filas: flitoConciliacionBoletas.filas,
  totalDeclarado: flitoConciliacionBoletas.totalDeclarado,
  totalCruzado: flitoConciliacionBoletas.totalCruzado,
  fechaPago: flitoConciliacionBoletas.fechaPago,
  cargadaPorNombre: flitoConciliacionBoletas.cargadaPorNombre,
  conciliadaEn: flitoConciliacionBoletas.conciliadaEn,
  conciliadaPorNombre: flitoConciliacionBoletas.conciliadaPorNombre,
  createdAt: flitoConciliacionBoletas.createdAt,
};

const SELECCION_LINEA = {
  id: flitoConciliacionLineas.id,
  filaNumero: flitoConciliacionLineas.filaNumero,
  numeroPolizaNorm: flitoConciliacionLineas.numeroPolizaNorm,
  valorDeclarado: flitoConciliacionLineas.valorDeclarado,
  soatId: flitoConciliacionLineas.soatId,
  resultado: flitoConciliacionLineas.resultado,
  detalle: flitoConciliacionLineas.detalle,
  conciliadaEn: flitoConciliacionLineas.conciliadaEn,
};

async function boletaPorId(dbx: DbOrTx, id: string): Promise<{
  boleta: FilaBoletaDb; companiaNombre: string | null;
}> {
  const [fila] = await dbx.select({ b: SELECCION_BOLETA, companiaNombre: clients.name })
    .from(flitoConciliacionBoletas)
    .leftJoin(clients, eq(flitoConciliacionBoletas.companiaId, clients.id))
    .where(eq(flitoConciliacionBoletas.id, id))
    .limit(1);
  if (!fila) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.BOLETA_NO_EXISTE, 'Esa boleta no existe o se descartó.',
    );
  }
  return { boleta: fila.b as FilaBoletaDb, companiaNombre: fila.companiaNombre };
}

async function lineasDe(dbx: DbOrTx, boletaId: string): Promise<FilaLinea[]> {
  return await dbx.select(SELECCION_LINEA)
    .from(flitoConciliacionLineas)
    .where(eq(flitoConciliacionLineas.boletaId, boletaId))
    .orderBy(flitoConciliacionLineas.filaNumero) as FilaLinea[];
}

/**
 * Detalle de una boleta con su cuadre.
 *
 * `filasOmitidas` sale como 0: solo se conoce en el momento de leer el Excel y no hay columna que lo
 * guarde. Se informa en la respuesta de la CARGA, que es cuando el usuario puede hacer algo al
 * respecto (volver a descargar el archivo). Añadir una columna para eso sería cambiar el esquema de
 * la HU anterior por un dato que caduca en cuanto se cierra el modal.
 */
export async function detalleBoleta(id: string): Promise<BoletaDetalleDto> {
  const { boleta, companiaNombre } = await boletaPorId(db, id);
  const lineas = await lineasDe(db, id);
  // AC2 de la HU #11678: quien mira la boleta ve su comprobante con un enlace FIRMADO y caducable,
  // nunca la clave del almacenamiento. Quién decide cuál es el comprobante vivo vive en su archivo.
  const comprobante = await comprobanteDeBoleta(db, id);
  const ctx = await contextoDe(
    db, [...new Set(lineas.map((l) => l.numeroPolizaNorm))], id, boleta.companiaId,
  );
  await completarPorSoatId(
    db, ctx, lineas.map((l) => l.soatId).filter((s): s is string => s !== null),
  );
  return {
    ...resumenDto(boleta, companiaNombre, conteoDe(lineas.map((l) => l.resultado))),
    lineas: lineas.map((l) => lineaDto(l, ctx)),
    filasOmitidas: 0,
    comprobante,
  };
}

export interface FiltroListado {
  companiaId?: number;
  estado?: string;
  desde?: string;
  hasta?: string;
  /** ISO del `created_at` de la última boleta de la página anterior. Ninguno de los filtros es PII. */
  cursor?: string;
  limite?: number;
}

/**
 * Bandeja de boletas.
 *
 * El conteo por resultado de cada boleta se resuelve con UNA agregación sobre las líneas de la
 * página, no con una consulta por boleta: 25 boletas serían 25 viajes para pintar unos chips.
 */
export async function listarBoletas(filtro: FiltroListado): Promise<BoletaListadoDto> {
  const limite = Math.min(Math.max(filtro.limite ?? LISTADO_LIMITE_DEFECTO, 1), LISTADO_LIMITE_MAX);
  const condiciones = [];
  if (filtro.companiaId !== undefined) {
    condiciones.push(eq(flitoConciliacionBoletas.companiaId, filtro.companiaId));
  }
  if (filtro.estado !== undefined) condiciones.push(eq(flitoConciliacionBoletas.estado, filtro.estado));
  if (filtro.desde !== undefined) {
    condiciones.push(sql`${flitoConciliacionBoletas.fechaPago} >= ${filtro.desde}`);
  }
  if (filtro.hasta !== undefined) {
    condiciones.push(sql`${flitoConciliacionBoletas.fechaPago} <= ${filtro.hasta}`);
  }
  if (filtro.cursor !== undefined) {
    condiciones.push(lt(flitoConciliacionBoletas.createdAt, new Date(filtro.cursor)));
  }

  const filas = await db.select({ b: SELECCION_BOLETA, companiaNombre: clients.name })
    .from(flitoConciliacionBoletas)
    .leftJoin(clients, eq(flitoConciliacionBoletas.companiaId, clients.id))
    .where(condiciones.length > 0 ? and(...condiciones) : undefined)
    .orderBy(desc(flitoConciliacionBoletas.createdAt))
    .limit(limite + 1);

  const hayMas = filas.length > limite;
  const pagina = hayMas ? filas.slice(0, limite) : filas;
  const ids = pagina.map((f) => (f.b as FilaBoletaDb).id);

  const conteos = new Map<string, ConteoResultados>();
  if (ids.length > 0) {
    const agregado = await db.select({
      boletaId: flitoConciliacionLineas.boletaId,
      resultado: flitoConciliacionLineas.resultado,
      cuantas: sql<number>`count(*)::int`,
    })
      .from(flitoConciliacionLineas)
      .where(inArray(flitoConciliacionLineas.boletaId, ids))
      .groupBy(flitoConciliacionLineas.boletaId, flitoConciliacionLineas.resultado);

    for (const a of agregado) {
      const c = conteos.get(a.boletaId) ?? conteoVacio();
      if (a.resultado in c) c[a.resultado as keyof ConteoResultados] += Number(a.cuantas);
      conteos.set(a.boletaId, c);
    }
  }

  const items = pagina.map((f) => {
    const b = f.b as FilaBoletaDb;
    return resumenDto(b, f.companiaNombre, conteos.get(b.id) ?? conteoVacio());
  });

  return {
    items,
    siguienteCursor: hayMas && items.length > 0 ? items[items.length - 1].createdAt : null,
  };
}

// ───────────────────────────── Carga ─────────────────────────────────────────

export interface ArchivoBoleta {
  nombre: string;
  buffer: Buffer;
}

export interface DatosCarga {
  companiaId: number;
  /** ISO 'YYYY-MM-DD'. La del pago en el portal, no la de hoy: decide el periodo contable. */
  fechaPago: string;
  maxFilas: number;
}

/** `23505`: el índice único ganó una carrera. Se traduce, no se deja subir como 500. */
function esClaveDuplicada(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Carga el Excel del portal, lo cruza y deja la boleta en `cargada`.
 *
 * **No mueve dinero.** El orden importa y es este:
 *
 *   1. se valida la fecha y el cliente ANTES de leer el archivo (barato antes que caro);
 *   2. se calcula el hash y se busca una boleta viva con el mismo → 409 con su referencia;
 *   3. se lee el Excel (si falla, no se ha creado nada: no queda boleta huérfana, AC7);
 *   4. dentro de UNA transacción: se inserta la boleta, se cruza y se insertan sus líneas.
 *
 * El paso 4 es una sola transacción por una razón concreta: una boleta sin líneas violaría el
 * `CHECK filas > 0` que la HU anterior puso en la base, y —peor— sería una boleta que la bandeja
 * enseña como cargada y que no se puede ni conciliar ni entender.
 */
export async function cargarBoleta(
  archivo: ArchivoBoleta,
  datos: DatosCarga,
  ctx: CtxUsuario,
): Promise<BoletaDetalleDto> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fechaPago) || Number.isNaN(Date.parse(datos.fechaPago))) {
    throw new ConciliacionError(
      400, CodigoErrorConciliacion.FECHA_INVALIDA, 'La fecha de pago no es una fecha válida.',
    );
  }
  if (datos.fechaPago > hoyIso()) {
    throw new ConciliacionError(
      400, CodigoErrorConciliacion.FECHA_INVALIDA, 'La fecha de pago no puede ser futura.',
    );
  }

  const [compania] = await db.select({ id: clients.id })
    .from(clients).where(eq(clients.id, datos.companiaId)).limit(1);
  if (!compania) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.COMPANIA_NO_EXISTE, 'El cliente que elegiste ya no está disponible.',
    );
  }

  const hash = sha256(archivo.buffer);
  const [previa] = await db.select({
    id: flitoConciliacionBoletas.id, referencia: flitoConciliacionBoletas.referencia,
  })
    .from(flitoConciliacionBoletas)
    .where(and(
      eq(flitoConciliacionBoletas.archivoHash, hash),
      // El índice único es PARCIAL sobre `<> 'descartada'`, así que el filtro tiene que serlo
      // también: descartar una boleta libera su archivo para poder rehacerla (AC6).
      ne(flitoConciliacionBoletas.estado, 'descartada'),
    ))
    .limit(1);
  if (previa) {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.BOLETA_DUPLICADA,
      `Este mismo archivo ya se cargó como ${previa.referencia}.`,
      { boletaId: previa.id, referencia: previa.referencia },
    );
  }

  const parseada = await parsearBoleta(archivo.buffer, datos.maxFilas);

  return await db.transaction(async (tx) => {
    let boleta: FilaBoletaDb;
    try {
      const [creada] = await tx.insert(flitoConciliacionBoletas).values({
        companiaId: datos.companiaId,
        archivoNombre: archivo.nombre.slice(0, 300),
        archivoHash: hash,
        filas: parseada.filas.length,
        totalDeclarado: parseada.totalDeclarado.toFixed(2),
        fechaPago: datos.fechaPago,
        cargadaPorId: ctx.userId,
        cargadaPorNombre: ctx.nombre,
      }).returning(SELECCION_BOLETA);
      boleta = creada as FilaBoletaDb;
    } catch (e) {
      // Dos cargas del mismo archivo a la vez: la que pierde la carrera cae aquí, no en el chequeo
      // de arriba. Se responde lo mismo, sin el id —para saberlo habría que consultar de nuevo
      // dentro de una transacción que ya está abortada—.
      if (esClaveDuplicada(e)) {
        throw new ConciliacionError(
          409, CodigoErrorConciliacion.BOLETA_DUPLICADA, 'Este mismo archivo ya se cargó.',
        );
      }
      throw e;
    }

    const { lineas, totalCruzado } = await cruzarYGuardar(
      tx, boleta.id, datos.companiaId, parseada.filas,
    );

    await tx.update(flitoConciliacionBoletas)
      .set({ totalCruzado: totalCruzado.toFixed(2), updatedAt: new Date() })
      .where(eq(flitoConciliacionBoletas.id, boleta.id));

    const [conCliente] = await tx.select({ nombre: clients.name })
      .from(clients).where(eq(clients.id, datos.companiaId)).limit(1);

    return {
      ...resumenDto(
        { ...boleta, totalCruzado: totalCruzado.toFixed(2) },
        conCliente?.nombre ?? null,
        conteoDe(lineas.map((l) => l.resultado)),
      ),
      lineas,
      filasOmitidas: parseada.filasOmitidas,
      // Una boleta recién cargada está en `cargada`, y el comprobante solo se admite sobre una
      // conciliada (HU #11678): aquí nunca puede haber uno, y consultarlo sería un SELECT que
      // siempre devuelve vacío dentro de la transacción que acaba de escribir 500 líneas.
      comprobante: null,
    };
  });
}

/**
 * Cruza las filas recién leídas e inserta sus líneas. Devuelve los DTO ya compuestos para no volver
 * a leer de la base lo que se acaba de escribir.
 */
async function cruzarYGuardar(
  tx: Tx,
  boletaId: string,
  companiaId: number,
  filas: FilaBoleta[],
): Promise<{ lineas: LineaBoletaDto[]; totalCruzado: number }> {
  const ctx = await contextoDe(
    tx, [...new Set(filas.map((f) => f.numeroPolizaNorm))], boletaId, companiaId,
  );

  const evaluadas = filas.map((f) => ({ fila: f, ev: evaluarFila(f, ctx, companiaId) }));

  const insertadas = await tx.insert(flitoConciliacionLineas).values(
    evaluadas.map(({ fila, ev }) => ({
      boletaId,
      filaNumero: fila.filaNumero,
      numeroPolizaNorm: fila.numeroPolizaNorm,
      valorDeclarado: fila.valorDeclarado.toFixed(2),
      soatId: ev.soatId,
      resultado: ev.resultado,
      detalle: ev.detalle,
    })),
  ).returning(SELECCION_LINEA) as FilaLinea[];

  const ordenadas = [...insertadas].sort((a, b) => a.filaNumero - b.filaNumero);
  return {
    lineas: ordenadas.map((l) => lineaDto(l, ctx)),
    totalCruzado: totalCruzadoDe(ordenadas, ctx),
  };
}

/**
 * Lo que FLITO cree que se pagó: la suma de `flito_soat.valor_pagado` de las líneas que cruzaron
 * con un SOAT. NUNCA la columna del Excel — esa es `total_declarado`, y la gracia de tener las dos
 * es poder compararlas (RN-03).
 */
function totalCruzadoDe(lineas: FilaLinea[], ctx: ContextoCruce): number {
  let total = 0;
  for (const l of lineas) {
    const soat = l.soatId ? ctx.porSoatId.get(l.soatId) : null;
    if (soat?.valorPagado) total = redondear(total + soat.valorPagado);
  }
  return total;
}

// ───────────────────────────── Re-cruce y descarte ───────────────────────────

/** Boleta bloqueada para escritura, con el estado ya comprobado. */
async function boletaEditable(tx: Tx, id: string): Promise<FilaBoletaDb> {
  const [fila] = await tx.select(SELECCION_BOLETA)
    .from(flitoConciliacionBoletas)
    .where(eq(flitoConciliacionBoletas.id, id))
    .limit(1)
    .for('update');
  if (!fila) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.BOLETA_NO_EXISTE, 'Esa boleta no existe o se descartó.',
    );
  }
  return fila as FilaBoletaDb;
}

/**
 * Vuelve a cruzar una boleta `cargada` contra el estado de HOY (AC5).
 *
 * Es la salida del callejón que documenta la UX: el AC de la pantalla exige que «Conciliar» esté
 * deshabilitado mientras haya líneas sin cuadrar, y volver a subir el mismo archivo choca con el
 * índice único del hash. Sin esto, comprobar si el gestor ya pagó el SOAT que faltaba obligaría a
 * descartar un documento contable.
 *
 * **No toca el archivo ni el hash**: la boleta sigue siendo la misma prueba del mismo pago. Solo se
 * reescriben `resultado`, `detalle` y `soat_id` de las líneas que CAMBIARON — una boleta de 500
 * líneas de las que se arregló una no tiene por qué producir 500 UPDATE.
 */
export async function recruzarBoleta(
  id: string,
): Promise<{ detalle: BoletaDetalleDto; cambiadas: number }> {
  return await db.transaction(async (tx) => {
    const recruce = await recruzarEnTx(tx, id);
    return { detalle: detalleDesde(recruce), cambiadas: recruce.cambiadas };
  });
}

/**
 * El re-cruce, sobre una transacción YA ABIERTA y con la boleta bloqueada.
 *
 * Existe separado de `recruzarBoleta` porque `conciliar()` (HU #11677) tiene que volver a cruzar
 * DENTRO de la misma transacción en la que mueve el dinero: entre la carga y el clic pueden haber
 * pasado días, y un SOAT pudo salir de `pagado`, cambiar de valor o conciliarse en otra boleta. Un
 * re-cruce en su propia transacción no daría esa garantía —la ventana entre las dos es exactamente
 * donde cabe el cambio que el re-cruce venía a detectar—.
 *
 * Devuelve el estado en memoria además del DTO para que quien concilia no tenga que releer de la
 * base lo que acaba de resolver: `ctx.porSoatId` ya trae el valor pagado y el organismo de cada SOAT,
 * que es lo que el asiento necesita.
 */
export interface RecruceEnTx {
  boleta: FilaBoletaDb;
  companiaNombre: string | null;
  /** Líneas con el resultado de HOY, ya persistido. */
  lineas: FilaLinea[];
  ctx: ContextoCruce;
  totalCruzado: number;
  /** Cuántas líneas cambiaron de veredicto respecto del cruce anterior. */
  cambiadas: number;
}

export async function recruzarEnTx(tx: Tx, id: string): Promise<RecruceEnTx> {
  const boleta = await boletaEditable(tx, id);
  exigirCargada(boleta);

  const lineas = await lineasDe(tx, id);
  const ctx = await contextoDe(
    tx, [...new Set(lineas.map((l) => l.numeroPolizaNorm))], id, boleta.companiaId,
  );
  await completarPorSoatId(
    tx, ctx, lineas.map((l) => l.soatId).filter((s): s is string => s !== null),
  );

  const actualizadas: FilaLinea[] = [];
  let cambiadas = 0;
  for (const linea of lineas) {
    const ev = evaluarFila(
      { numeroPolizaNorm: linea.numeroPolizaNorm, valorDeclarado: num(linea.valorDeclarado) },
      ctx,
      boleta.companiaId,
    );
    const cambio = ev.resultado !== linea.resultado
      || ev.soatId !== linea.soatId
      || ev.detalle !== linea.detalle;
    if (cambio) {
      cambiadas += 1;
      await tx.update(flitoConciliacionLineas)
        .set({ resultado: ev.resultado, detalle: ev.detalle, soatId: ev.soatId })
        .where(eq(flitoConciliacionLineas.id, linea.id));
    }
    actualizadas.push({ ...linea, resultado: ev.resultado, detalle: ev.detalle, soatId: ev.soatId });
  }

  const totalCruzado = totalCruzadoDe(actualizadas, ctx);
  await tx.update(flitoConciliacionBoletas)
    .set({ totalCruzado: totalCruzado.toFixed(2), updatedAt: new Date() })
    .where(eq(flitoConciliacionBoletas.id, id));

  const [conCliente] = await tx.select({ nombre: clients.name })
    .from(clients).where(eq(clients.id, boleta.companiaId)).limit(1);

  return {
    boleta,
    companiaNombre: conCliente?.nombre ?? null,
    lineas: actualizadas,
    ctx,
    totalCruzado,
    cambiadas,
  };
}

/**
 * Compone el detalle a partir de un estado ya resuelto en memoria, sin volver a consultar.
 *
 * `filasOmitidas` sale como 0 por el mismo motivo que en `detalleBoleta`: solo se conoce al leer el
 * Excel y no hay columna que lo guarde.
 */
export function detalleDesde(r: Omit<RecruceEnTx, 'cambiadas'>): BoletaDetalleDto {
  return {
    ...resumenDto(
      { ...r.boleta, totalCruzado: r.totalCruzado.toFixed(2) },
      r.companiaNombre,
      conteoDe(r.lineas.map((l) => l.resultado)),
    ),
    lineas: r.lineas.map((l) => lineaDto(l, r.ctx)),
    filasOmitidas: 0,
    // `null` y no una consulta: los tres llamadores parten de una boleta en `cargada` —el re-cruce
    // lo exige, y la que se acaba de conciliar lo estaba un instante antes—, y el comprobante solo
    // existe sobre una boleta ya conciliada (HU #11678). Cuando la ficha necesita el comprobante
    // pide el detalle, que sí lo trae.
    comprobante: null,
  };
}

/** Los dos estados que no admiten ni re-cruce ni descarte, con su código propio. */
function exigirCargada(boleta: FilaBoletaDb): void {
  if (boleta.estado === 'conciliada') {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.BOLETA_YA_CONCILIADA,
      'Esta boleta ya se concilió: su dinero salió de la bolsa y no se deshace desde aquí.',
    );
  }
  if (boleta.estado === 'descartada') {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.BOLETA_DESCARTADA,
      'Esta boleta está descartada. Vuelve a cargar el archivo si la necesitas.',
    );
  }
}

/**
 * Descarta una boleta cargada por error (AC6).
 *
 * Es un `UPDATE estado='descartada'` y NO un DELETE: la HU anterior no concedió `DELETE` sobre esta
 * tabla a propósito. Lo que libera el archivo para poder rehacer la boleta no es borrar nada, es que
 * `idx_flito_concil_boleta_hash` sea un índice PARCIAL sobre `estado <> 'descartada'`: en cuanto la
 * boleta sale de la bandeja activa, su hash deja de estar reservado.
 *
 * Descartar una ya descartada no es un error: el estado final es el que se pedía. Descartar una
 * CONCILIADA sí lo es, y es 409: es un documento contable con dinero movido detrás.
 */
export async function descartarBoleta(id: string): Promise<BoletaResumenDto> {
  return await db.transaction(async (tx) => {
    const boleta = await boletaEditable(tx, id);
    if (boleta.estado === 'conciliada') {
      throw new ConciliacionError(
        409, CodigoErrorConciliacion.BOLETA_YA_CONCILIADA,
        'Una boleta conciliada no se descarta: su dinero ya salió de la bolsa.',
      );
    }

    if (boleta.estado !== 'descartada') {
      await tx.update(flitoConciliacionBoletas)
        .set({ estado: 'descartada', updatedAt: new Date() })
        .where(eq(flitoConciliacionBoletas.id, id));
    }

    const lineas = await lineasDe(tx, id);
    const [conCliente] = await tx.select({ nombre: clients.name })
      .from(clients).where(eq(clients.id, boleta.companiaId)).limit(1);

    return resumenDto(
      { ...boleta, estado: 'descartada' },
      conCliente?.nombre ?? null,
      conteoDe(lineas.map((l) => l.resultado)),
    );
  });
}
