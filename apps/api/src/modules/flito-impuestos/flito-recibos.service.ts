// FLITO Impuestos — carga de recibos de pago → Pagado (Fase 4 P3). Porta procesarRecibo/conciliar/
// evaluarExtraccion de impuestos.servicio.ts sobre drizzle + OCR Anthropic (extraerReciboImpuesto).
//
// El recibo validado por OCR es la vía a PAGADO. Dedup CA-08 en dos frentes: por hash (mismo archivo)
// y por número de recibo (mismo pago, PDF reexportado). El cruce es SOLO contra EN_GESTION de los
// organismos del gestor (CA-07/CA-10). Recibos con/sin marca de agua: el limpio (sin marca) concilia;
// el de marca "PAGADO" se adjunta como comprobante al pago ya hecho.
//
// ── Qué cambió en la HU #12053 ───────────────────────────────────────────────────────────────────
// El gestor está atado a VARIOS organismos (`flito_gestor_organismos`), así que `ctx.organismos` es
// una lista y hace falta separar las dos cosas que antes decidía un único código:
//
//   · **El filtro de candidatos**: `inArray(organismo_codigo, ctx.organismos)`. Y con la lista VACÍA
//     el gestor no cruza con NADA. Antes, «sin código» significaba «sin acotar» —el agujero por el
//     que un gestor sin organismo conciliaba contra impuestos de cualquier organismo, incluidos los
//     asumidos por Operaciones (la cola le salía vacía; la conciliación, no).
//   · **El umbral de OCR**: es propiedad del organismo que EMITE el documento, así que sale del
//     organismo del impuesto candidato y no de quién sube el archivo. El mapa código→umbral se carga
//     UNA vez por lote. Para `admin` NO cambia nada: sigue el umbral por defecto, como hoy (el
//     Feature deja «rediseñar las colas» fuera de alcance y ningún AC pide tocárselo).
//
// El umbral se conoce DESPUÉS de extraer (hace falta el candidato para saber su organismo), y eso no
// es un problema: el umbral no cambia lo que el OCR lee, solo marca `confiable`. Por eso la
// extracción se hace con el umbral por defecto y `confiable` se RE-MARCA antes de persistir — sin
// esa remarca, `FlitoRevisiones.tsx` pintaría «confiable» sobre el mismo campo que mandó el recibo a
// revisión. Cero llamadas de OCR adicionales.

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoImpuestos, flitoRevisiones, flitoSoportes, flitoTramites,
  organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { registrarCambio } from '../../shared/historial/estado-historial.js';
import {
  CampoImpuesto, CARGA_MASIVA_ARCHIVOS_POR_PETICION, EstadoImpuesto, FlujoRevision, MotivoRevision,
  type ExtraccionImpuesto,
} from '@operaciones/shared-types';
import { extraerReciboImpuesto, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import type { ArchivoSubido, ImpuestoCtx } from './flito-factura-venta.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TIPO_RECIBO = 'recibo_impuesto';
const TIPO_RECIBO_SIN_MARCA = 'recibo_impuesto_sin_marca';
const TIPOS_RECIBO = [TIPO_RECIBO, TIPO_RECIBO_SIN_MARCA];
/** Concurrencia del OCR en la carga masiva. Detalle de ejecución: no vive en shared-types. */
const OCR_CONCURRENCIA_CARGA_MASIVA = 5;

/** Solo el valor total bloquea (la placa se valida aparte, es la llave). Nº recibo/fecha/año no. */
const CAMPOS_REQUERIDOS_RECIBO: readonly CampoImpuesto[] = [CampoImpuesto.VALOR_TOTAL];

const normalizarLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');
const docDe = (a: ArchivoSubido, umbral: number): DocumentoAAnalizar => ({ nombreArchivo: a.originalname, contentType: a.mimetype, contenido: a.buffer, umbral });

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * Decide si el recibo cruza y se lee bien para pagar solo: placa sobre umbral (llave) + valorTotal
 * sobre umbral. El año gravable/nº recibo/fecha se extraen pero NO bloquean (a pedido del negocio).
 */
export function evaluarReciboImpuesto(extraccion: ExtraccionImpuesto, umbral: number): Veredicto {
  const placa = extraccion[CampoImpuesto.PLACA];
  if (!placa || placa.confianza < umbral) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La placa se leyó con confianza ${placa?.confianza ?? 0}, bajo el umbral de ${umbral}.` };
  }
  const dudosos = CAMPOS_REQUERIDOS_RECIBO.filter((c) => { const e = extraccion[c]; return !e || e.valor === null || e.confianza < umbral; });
  if (dudosos.length > 0) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE, detalle: `La lectura no superó el umbral de ${umbral} en: ${dudosos.join(', ')}.` };
  }
  return { aprobada: true };
}

async function auditEnTx(tx: Tx, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail });
}

const aNumero = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);

export interface ItemRecibo { archivo: string; placa: string | null; idFlit: string | null; registroId: string | null; detalle: string }
export interface ResultadoRecibos { conciliados: ItemRecibo[]; enRevision: ItemRecibo[]; duplicados: ItemRecibo[]; complementos: ItemRecibo[]; noAsociados: ItemRecibo[] }

// Datos de un impuesto candidato para conciliar/archivar.
interface Candidato {
  impuestoId: string; estado: string; organismoCodigo: string; tramiteIdFlit: string; tramiteId: string;
  // `document` NO se trae (HU #11770): la carpeta se nombra con el id de la compañía, no con su NIT.
  placa: string | null; companiaId: number; carpeta: string | null; valorLiquidado: string | null;
  // D-5 (Fase 7): activación de diferencia de valor por organismo + tolerancia de la compañía.
  diferenciaActiva: boolean; tolerancia: string;
}
const SELECT_CAND = {
  impuestoId: flitoImpuestos.id, estado: flitoImpuestos.estado, organismoCodigo: flitoImpuestos.organismoCodigo,
  tramiteIdFlit: flitoTramites.idFlit, tramiteId: flitoTramites.id, placa: vehicles.plate, companiaId: clients.id,
  carpeta: clients.flitoCarpetaStorage, valorLiquidado: flitoImpuestos.valorLiquidado,
  diferenciaActiva: organismosTransitoConfig.flitoDiferenciaValorActiva,
  tolerancia: clients.flitoToleranciaValorImpuesto,
} as const;
function fromCandidatos() {
  return db.select(SELECT_CAND).from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo));
}

/**
 * Carga masiva de recibos. `sinMarcaDeAgua` es el interruptor por defecto para archivos sueltos; en
 * un ZIP la copia (con/sin marca) se deduce de la carpeta. El limpio se procesa primero (concilia);
 * el de marca se adjunta al pago. Un archivo que falla no tumba el lote.
 *
 * `rutas` (HU #12056) es la ruta relativa DENTRO del ZIP de cada archivo, para las tandas que el
 * navegador arma abriendo el ZIP él mismo. Sin ella, la deducción por carpeta moriría en silencio y
 * todo caería al defecto del checkbox. Es opcional y solo informativa: quien decide la marca sigue
 * siendo `esSinMarcaDeAgua`, una sola vez, dentro de `expandir`.
 */
export async function cargarRecibos(archivos: ArchivoSubido[], sinMarcaDeAgua: boolean, ctx: ImpuestoCtx, rutas?: readonly string[]): Promise<ResultadoRecibos> {
  const res: ResultadoRecibos = { conciliados: [], enRevision: [], duplicados: [], complementos: [], noAsociados: [] };
  const expandidos = await expandir(archivos, sinMarcaDeAgua, rutas);
  // El SIN marca primero: es el limpio con el que se concilia; el de marca se adjunta después.
  expandidos.sort((a, b) => Number(b.sinMarca) - Number(a.sinMarca));

  const lote = await abrirLote(ctx);

  type Expandido = typeof expandidos[number];
  const pendientes: { archivo: Expandido; hash: string }[] = [];
  const hashesVistos = new Set<string>();
  for (const archivo of expandidos) {
    try {
      const hash = createHash('sha256').update(archivo.buffer).digest('hex');
      const dupId = hashesVistos.has(hash) ? 'lote' : await hashReciboYaCargado(hash);
      if (dupId) {
        res.duplicados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: dupId === 'lote' ? null : dupId, detalle: 'Ese pago ya está registrado: el archivo es idéntico a uno cargado antes.' });
        continue;
      }
      hashesVistos.add(hash);
      pendientes.push({ archivo, hash });
    } catch (e) {
      res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: (e as Error).message });
    }
  }

  // Se extrae con el umbral por defecto: el que de verdad aplica sale del organismo del candidato,
  // que todavía no se conoce. No cambia NADA de lo que el OCR lee —solo el flag `confiable`, que se
  // re-marca dentro de `procesarRecibo`, ya con el candidato en la mano (HU #12053)—.
  const extraidos = await conConcurrencia(pendientes, OCR_CONCURRENCIA_CARGA_MASIVA, async (item) => {
    try {
      return { ...item, extraccion: await extraerReciboImpuesto(docDe(item.archivo, lote.porDefecto)) };
    } catch (error) {
      return { ...item, error };
    }
  });

  for (const item of extraidos) {
    try {
      if ('error' in item && item.error) throw item.error;
      const extraido = 'extraccion' in item ? item.extraccion : undefined;
      if (!extraido) throw new Error('Error procesando el archivo.');
      await procesarRecibo(item.archivo, item.archivo.sinMarca, lote, ctx, res, extraido, item.hash);
    } catch (e) {
      res.noAsociados.push({ archivo: item.archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: (e as Error).message });
    }
  }
  return res;
}

/**
 * Lo que vale para TODO el lote: la frontera del actor y los umbrales de sus organismos. El mapa se
 * carga con UNA consulta, no una por archivo.
 */
interface LoteRecibos {
  esGestor: boolean;
  organismos: string[];
  /** El umbral con el que se EXTRAE siempre (y el que aplica a Operaciones, sin cambios). */
  porDefecto: number;
  /** código de organismo → su umbral. Solo se consulta para el gestor. */
  umbrales: Map<string, number>;
}

async function abrirLote(ctx: ImpuestoCtx): Promise<LoteRecibos> {
  const esGestor = ctx.role === 'gestor_impuestos';
  const organismos = esGestor ? ctx.organismos : [];
  const umbrales = new Map<string, number>();
  if (organismos.length > 0) {
    const filas = await db.select({ codigo: organismosTransitoConfig.codigo, u: organismosTransitoConfig.flitoUmbralOcr })
      .from(organismosTransitoConfig).where(inArray(organismosTransitoConfig.codigo, organismos));
    for (const f of filas) umbrales.set(f.codigo, umbralPara(f.u));
  }
  return { esGestor, organismos, porDefecto: umbralPara(null), umbrales };
}

/**
 * El umbral que aplica a ESTE impuesto: el de su organismo cuando quien carga es el gestor. Para
 * Operaciones, el de siempre.
 */
function umbralDelCandidato(lote: LoteRecibos, organismoCodigo: string): number {
  if (!lote.esGestor) return lote.porDefecto;
  return lote.umbrales.get(organismoCodigo) ?? lote.porDefecto;
}

/**
 * Vuelve a marcar `confiable` con el umbral que de verdad aplica. Es recorrer campos ya extraídos
 * recalculando un booleano: no vuelve a llamar al OCR ni cambia ningún valor ni ninguna confianza.
 */
function remarcarConfiable(extraccion: ExtraccionImpuesto, umbral: number): ExtraccionImpuesto {
  const salida: ExtraccionImpuesto = {};
  for (const [campo, dato] of Object.entries(extraccion) as [CampoImpuesto, ExtraccionImpuesto[CampoImpuesto]][]) {
    salida[campo] = dato ? { ...dato, confiable: dato.confianza >= umbral } : dato;
  }
  return salida;
}

/** CA-08 (1): el mismo archivo, byte por byte, ya está cargado. */
async function hashReciboYaCargado(hash: string): Promise<string | null> {
  const [dup] = await db.select({ impuestoId: flitoSoportes.impuestoId }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.hash, hash), inArray(flitoSoportes.tipo, TIPOS_RECIBO), eq(flitoSoportes.descartado, false))).limit(1);
  return dup?.impuestoId ?? null;
}

/**
 * Recibe la extracción YA hecha (el OCR corre en tandas, fuera) y el `lote`, que trae la frontera del
 * actor y sus umbrales. `extraido` viene marcado con el umbral por defecto: se re-marca abajo, con el
 * organismo del candidato ya conocido.
 */
async function procesarRecibo(
  archivo: ArchivoSubido & { sinMarca: boolean },
  sinMarca: boolean,
  lote: LoteRecibos,
  ctx: ImpuestoCtx,
  res: ResultadoRecibos,
  extraido: ExtraccionImpuesto,
  hash: string,
): Promise<void> {
  const tipo = sinMarca ? TIPO_RECIBO_SIN_MARCA : TIPO_RECIBO;
  const placa = extraido[CampoImpuesto.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);
  if (!placa) {
    // Sin placa no hay llave de cruce. Se descarta con el aviso: el fichero original sigue en manos
    // de quien lo cargó, así que se puede reintentar con una copia legible.
    res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null,
      detalle: 'El recibo no permitió leer la placa, así que no se pudo asociar. Se descarta: vuelve a cargarlo con una copia legible.' });
    return;
  }

  // Cruce SOLO contra EN_GESTION de los organismos del gestor (CA-07/CA-10).
  const candidato = await buscarCandidato(placa, EstadoImpuesto.SOLICITADO, lote);
  if (!candidato) {
    // ¿Es la segunda copia (la otra marca) de un pago ya conciliado? Se adjunta, no se rechaza.
    if (await adjuntarComplemento(archivo, placa, tipo, lote, hash, ctx, res)) return;
    // Se descarta con el aviso. La bandeja de pendientes que antes lo guardaba se retiró: acumulaba
    // recibos que no llegaban a cruzar, y el fichero original sigue en manos de quien lo cargó.
    res.noAsociados.push({ archivo: archivo.originalname, placa, idFlit: null, registroId: null,
      detalle: `El recibo dice placa ${placa}, pero no hay ningún impuesto en gestión con esa placa en este organismo. Se descarta: vuelve a cargarlo cuando el impuesto esté en gestión.` });
    return;
  }

  // Ya se conoce el organismo del impuesto: el umbral es el SUYO, y `confiable` se re-marca con él
  // ANTES de persistir. Sin esta línea, la pantalla de revisión puede decir «confiable» sobre el
  // mismo campo que mandó el recibo a revisión.
  const umbral = umbralDelCandidato(lote, candidato.organismoCodigo);
  const extraccion = remarcarConfiable(extraido, umbral);

  // CA-08 (2): mismo número de recibo en otro impuesto (PDF reexportado, bytes distintos).
  const numeroRecibo = extraccion[CampoImpuesto.NUMERO_RECIBO]?.valor ?? null;
  if (numeroRecibo) {
    const [mismoNumero] = await db.select({ id: flitoImpuestos.id }).from(flitoImpuestos)
      .where(and(sql`${flitoImpuestos.extraccion} -> 'numeroRecibo' ->> 'valor' = ${numeroRecibo}`, ne(flitoImpuestos.id, candidato.impuestoId))).limit(1);
    if (mismoNumero) {
      res.duplicados.push({ archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: mismoNumero.id, detalle: `El recibo número ${numeroRecibo} ya está registrado en otro impuesto.` });
      return;
    }
  }

  const veredicto = evaluarReciboImpuesto(extraccion, umbral);
  const storageKey = await archivar(candidato, archivo);

  await db.transaction(async (tx) => {
    const soporteId = await insertarSoporte(tx, candidato.impuestoId, archivo, tipo, ctx, storageKey, hash);
    if (veredicto.aprobada) await conciliar(tx, candidato, extraccion, soporteId, ctx);
    else await aRevision(tx, soporteId, extraccion, veredicto, candidato.impuestoId, placa, ctx);
  });

  const item: ItemRecibo = { archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: candidato.impuestoId,
    detalle: veredicto.aprobada ? 'Conciliado y pagado sin intervención.' : (veredicto.detalle ?? 'En revisión.') };
  (veredicto.aprobada ? res.conciliados : res.enRevision).push(item);
}

async function buscarCandidato(placa: string, estado: EstadoImpuesto, lote: LoteRecibos): Promise<Candidato | null> {
  const conds = [
    eq(flitoImpuestos.estado, estado),
    // Misma frontera que la cola: la autogestión deja fuera, salvo el desbloqueo excepcional
    // (HU #10980). Si no, un recibo de un trámite desbloqueado no cruzaría con su impuesto.
    sql`(NOT COALESCE(${clients.impuestosAutogestionable}, false) OR ${flitoImpuestos.excepcionAutogestion})`,
    sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarLlave(placa)}`,
  ];
  // La frontera solo la tiene el gestor; para Operaciones no se acota nada, igual que hoy. Añadir
  // aquí la bandera cubre de una vez los dos usos de esta función: la conciliación de un recibo
  // limpio y el complemento con marca de agua sobre un pagado.
  //
  // Y con la lista VACÍA el gestor no cruza con NADA (HU #12053). Es el cambio que cierra el
  // agujero: antes «sin código» era «sin acotar», así que un gestor sin organismo —el que producía
  // la pantalla, porque la API le prohibía tener `transito_codigo`— conciliaba contra impuestos de
  // cualquier organismo, incluidos los asumidos por Operaciones. Dinero real, dos veces.
  if (lote.esGestor) {
    if (lote.organismos.length === 0) return null;
    conds.push(inArray(flitoImpuestos.organismoCodigo, lote.organismos));
    conds.push(eq(flitoImpuestos.gestionOperaciones, false));
  }
  const [r] = await fromCandidatos().where(and(...conds)).orderBy(desc(flitoImpuestos.pagadoEn)).limit(1);
  return r ?? null;
}

/**
 * La factura de venta ya no cruza con un EN_GESTION: puede ser la segunda copia (otra marca) de un
 * pago ya conciliado. Se adjunta al PAGADO si ese impuesto no tiene ya esa misma copia. Devuelve
 * true si se adjuntó.
 */
async function adjuntarComplemento(archivo: ArchivoSubido, placa: string, tipo: string, lote: LoteRecibos, hash: string, ctx: ImpuestoCtx, res: ResultadoRecibos): Promise<boolean> {
  const pagado = await buscarCandidato(placa, EstadoImpuesto.PAGADO, lote);
  if (!pagado) return false;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(flitoSoportes).where(and(eq(flitoSoportes.impuestoId, pagado.impuestoId), eq(flitoSoportes.tipo, tipo), eq(flitoSoportes.descartado, false)));
  if (Number(n) > 0) return false; // ya tiene esa copia: es duplicado, no complemento
  const cual = tipo === TIPO_RECIBO_SIN_MARCA ? 'sin' : 'con';
  const storageKey = await archivar(pagado, archivo);
  await db.transaction(async (tx) => {
    const soporteId = await insertarSoporte(tx, pagado.impuestoId, archivo, tipo, ctx, storageKey, hash);
    await auditEnTx(tx, ctx, pagado.impuestoId, `Comprobante complementario (${cual} marca de agua) adjuntado al pago de ${pagado.tramiteIdFlit}. Soporte ${soporteId}.`);
  });
  res.complementos.push({ archivo: archivo.originalname, placa, idFlit: pagado.tramiteIdFlit, registroId: pagado.impuestoId, detalle: `Comprobante ${cual} marca de agua adjuntado al pago de ${pagado.tramiteIdFlit}.` });
  return true;
}

/**
 * Conciliación → PAGADO. La diferencia de valor (CA-09) está APAGADA por defecto (D-5): el
 * valorLiquidado de FLIT no siempre es fiable y el total pagado incluye el servicio de FLITO. Se
 * ACTIVA por organismo (`flitoDiferenciaValorActiva`, Fase 7) donde la fuente sí lo es: si el
 * |pagado - liquidado| supera la tolerancia de la compañía, se MARCA para revisión (marcadoPorDiferencia)
 * pero NO bloquea el pago. El valor se guarda siempre (lo consume Liquidaciones).
 */
async function conciliar(tx: Tx, cand: Candidato, extraccion: ExtraccionImpuesto, soporteId: string, ctx: ImpuestoCtx): Promise<void> {
  const valorPagado = aNumero(extraccion[CampoImpuesto.VALOR_TOTAL]?.valor);
  const marcadoPorDiferencia = evaluarDiferencia(cand, valorPagado);
  await tx.update(flitoImpuestos).set({
    estado: EstadoImpuesto.PAGADO, extraccion, valorPagado, marcadoPorDiferencia,
    pagadoEn: new Date(), motivoRechazo: null, updatedAt: new Date(),
  }).where(eq(flitoImpuestos.id, cand.impuestoId));
  const notaDiferencia = marcadoPorDiferencia
    ? ` MARCADO por diferencia de valor: pagado ${valorPagado ?? '—'} vs liquidado ${cand.valorLiquidado ?? '—'} supera la tolerancia ${cand.tolerancia}.`
    : '';
  await auditEnTx(tx, ctx, cand.impuestoId,
    `Pago conciliado (solicitado→pagado). Valor pagado ${valorPagado ?? '—'}, liquidado ${cand.valorLiquidado ?? '—'}, ` +
    `recibo ${extraccion[CampoImpuesto.NUMERO_RECIBO]?.valor ?? '—'}. Soporte ${soporteId}. Trámite ${cand.tramiteIdFlit}.${notaDiferencia}`);

  // El estado de partida sale del candidato, no se asume `solicitado`: la conciliación también
  // alcanza a los que estaban `con_novedad`, y el historial debe decir de dónde vino de verdad.
  await registrarCambio(tx, {
    concepto: 'impuesto', registroId: cand.impuestoId,
    estadoAnterior: cand.estado, estadoNuevo: EstadoImpuesto.PAGADO,
    motivo: `Pago conciliado. Valor ${valorPagado ?? '—'}.${notaDiferencia}`,
    usuarioId: ctx.userId, usuarioEmail: ctx.username,
  });
}

/**
 * D-5: ¿hay que marcar diferencia de valor? Solo si el organismo la tiene activa, hay valor
 * liquidado (fuente fiable) y pagado, y su diferencia absoluta excede la tolerancia de la compañía.
 * No bloquea el pago; solo levanta la marca para que Operaciones la revise.
 */
export function evaluarDiferencia(cand: Pick<Candidato, 'diferenciaActiva' | 'valorLiquidado' | 'tolerancia'>, valorPagado: string | null): boolean {
  if (!cand.diferenciaActiva || cand.valorLiquidado === null || valorPagado === null) return false;
  const liquidado = Number(cand.valorLiquidado);
  const pagado = Number(valorPagado);
  const tolerancia = Number(cand.tolerancia) || 0;
  if (!Number.isFinite(liquidado) || !Number.isFinite(pagado)) return false;
  return Math.abs(pagado - liquidado) > tolerancia;
}

async function aRevision(tx: Tx, soporteId: string, extraccion: ExtraccionImpuesto, veredicto: Veredicto, impuestoId: string, placa: string | null, ctx: ImpuestoCtx): Promise<void> {
  await tx.insert(flitoRevisiones).values({
    modulo: FlujoRevision.IMPUESTOS, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
    registroId: impuestoId, soporteId, placaSugerida: placa, extraccion, resuelto: false,
  });
  await auditEnTx(tx, ctx, impuestoId, `Recibo a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
}

async function insertarSoporte(tx: Tx, impuestoId: string, archivo: ArchivoSubido, tipo: string, ctx: ImpuestoCtx, storageKey: string, hash: string): Promise<string> {
  const [s] = await tx.insert(flitoSoportes).values({
    tipo, nombreArchivo: archivo.originalname, contentType: archivo.mimetype, storageKey, hash, tamanoBytes: archivo.size,
    impuestoId, subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
  }).returning({ id: flitoSoportes.id });
  return s.id;
}

async function archivar(cand: Candidato, archivo: ArchivoSubido): Promise<string> {
  const carpeta = carpetaDe({ id: cand.companiaId, flitoCarpetaStorage: cand.carpeta }, 'impuestos/recibos');
  return uploadEntityDocument(carpeta, cand.impuestoId, archivo.originalname, archivo.buffer, archivo.mimetype);
}

/** Tope defensivo de la ruta declarada por el cliente. Un valor más largo no es una ruta de ZIP. */
const RUTA_MAX_LONGITUD = 1024;

/**
 * Normaliza el campo `rutas` del multipart (HU #12056). multer entrega un `string` cuando viaja un
 * solo valor y un `string[]` cuando viajan varios, así que las dos formas valen.
 *
 * Cualquier otra cosa —objeto, número, un elemento que no sea texto, una ruta absurdamente larga, o
 * más rutas de las que caben archivos en una petición— descarta la lista ENTERA: emparejar a medias
 * es peor que caer al defecto del checkbox, y un cliente viejo o un proxy que reordene es un caso
 * real, no una hipótesis. El emparejamiento por cardinalidad se comprueba después, en `expandir`.
 */
export function normalizarRutas(valor: unknown): string[] | undefined {
  const lista = typeof valor === 'string' ? [valor] : Array.isArray(valor) ? valor : undefined;
  if (!lista || lista.length === 0 || lista.length > CARGA_MASIVA_ARCHIVOS_POR_PETICION) return undefined;
  if (!lista.every((v) => typeof v === 'string' && v.length <= RUTA_MAX_LONGITUD)) return undefined;
  return lista as string[];
}

/**
 * Expande ZIP marcando cada recibo con/sin marca de agua por su carpeta; sueltos usan la ruta
 * declarada por el cliente (tandas de ZIP abierto en el navegador) y, a falta de ella, el defecto.
 *
 * La ruta declarada es TEXTO DEL CLIENTE y no sale de aquí: solo alimenta `esSinMarcaDeAgua`. El
 * nombre con el que se archiva y se persiste sigue siendo el `originalname` de multer.
 */
async function expandir(archivos: ArchivoSubido[], defectoSinMarca: boolean, rutasCrudas?: readonly string[]): Promise<Array<ArchivoSubido & { sinMarca: boolean }>> {
  // Cardinalidad que no cuadra → como si no hubieran llegado rutas. Sin excepción y sin a medias.
  const rutas = rutasCrudas && rutasCrudas.length === archivos.length ? rutasCrudas : undefined;
  const salida: Array<ArchivoSubido & { sinMarca: boolean }> = [];
  for (const [i, archivo] of archivos.entries()) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    // El ZIP subido al API se sigue expandiendo aquí (AC7): sus entradas traen su propia ruta y
    // cualquier `rutas` que viniera para él se ignora.
    if (!esZip) { salida.push({ ...archivo, sinMarca: esSinMarcaDeAgua(rutas?.[i] ?? '', defectoSinMarca) }); continue; }
    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf' : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg' : lower.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length, sinMarca: esSinMarcaDeAgua(entrada.name, defectoSinMarca) });
    }
  }
  return salida;
}

/** Copia sin marca de agua a partir de la ruta dentro del ZIP; si nada lo indica, el defecto. */
function esSinMarcaDeAgua(ruta: string, defecto: boolean): boolean {
  const t = ruta.toLowerCase();
  if (/sin[\s_-]*marca|sin[\s_-]*agua|limpi|original/.test(t)) return true;
  if (/con[\s_-]*marca|marca[\s_-]*de[\s_-]*agua|con[\s_-]*agua|pagad/.test(t)) return false;
  return defecto;
}

// ─────────────────────────── Reintento de pendientes ─────────────────────────

