// FLITO Impuestos — carga de recibos por fase (Fase 4 P3 + HU #12590). Porta procesarRecibo/
// conciliar/evaluarExtraccion de impuestos.servicio.ts sobre drizzle + OCR Anthropic
// (extraerReciboImpuesto).
//
// Dos fases, y la declara quien carga (o la carpeta del ZIP). La marca de agua del documento NO la
// decide: la VIGILA (HU #12614, reglas puras en `flito-recibos.fase.ts`): el sello PAGADO que lee el
// OCR rechaza un pago sin sello o una liquidación con sello ANTES de escribir nada; ante la duda se
// respeta lo declarado. Y si dos archivos de la misma placa vienen en el lote con la misma fase, el
// sello dice cuál es la liquidación y cuál el pago (AC5).
//   · **Liquidación del impuesto** (`FaseRecibo.LIQUIDACION`): el documento de la hacienda sin marca.
//     Deja el impuesto `solicitado` con la marca `liquidado_en` y, si el OCR lo leyó con confianza,
//     el `valorLiquidado`. No cambia el estado y NUNCA abre revisión. No es la «Liquidación» de FLITO
//     (`flito_liquidaciones`, el total a cobrar).
//   · **Pago con marca** (`FaseRecibo.PAGO`): el mismo documento con el sello PAGADO. Es la ÚNICA vía
//     a `pagado`: validado por OCR concilia; con lectura dudosa va a revisión.
// Dedup CA-08 en dos frentes y para las dos fases: por hash (mismo archivo) y por número de recibo
// (mismo pago, PDF reexportado). El cruce es SOLO contra EN_GESTION de los organismos del gestor
// (CA-07/CA-10). Sobre un impuesto ya PAGADO cualquiera de las dos copias se adjunta como complemento.
//
// ── Recibo de caja (HU #12591) ───────────────────────────────────────────────────────────────────
// La segunda vía a `pagado`: el comprobante de la ventanilla, cargado UNO A UNO desde el detalle del
// impuesto (`cargarReciboCaja`). No cruza por placa —el impuesto ya viene identificado por id, con la
// frontera de `buscarConAcceso`— y solo se admite sobre un `solicitado` con liquidación registrada
// (`liquidado_en`). Reutiliza `conciliar`/`aRevision`/`insertarSoporte`/`archivar` tal cual; lo que
// cambia es el veredicto (`evaluarReciboCaja`: solo el valor, no hay placa) y `pagadoEn`, que sale de
// la fecha leída del recibo cuando es confiable. El dedup por número de recibo de la masiva NO aplica:
// el consecutivo de caja es otro espacio y ningún AC lo pide. El hash sí cruza contra los TRES tipos.
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
  CampoImpuesto, CARGA_MASIVA_ARCHIVOS_POR_PETICION, CodigoErrorReciboCaja, EstadoImpuesto, ESTADO_IMPUESTO_LABEL,
  FaseRecibo, FlujoRevision, MotivoRevision, TipoSoporte, type ExtraccionImpuesto, type ResultadoReciboCaja,
} from '@operaciones/shared-types';
import {
  extraerReciboCaja, extraerReciboImpuesto, placaDesdeNombre, type DocumentoAAnalizar,
} from '../flito-ocr/flito-ocr.service.js';
import { buscarConAcceso } from './flito-impuestos.service.js';
import {
  carpetaRaiz, faseDeCarpeta, leerSello, liquidacionPrimero, resolverPlacaRepetida, vigilarFase, type EntradaPlaca,
} from './flito-recibos.fase.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import type { ArchivoSubido, ImpuestoCtx } from './flito-factura-venta.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Los dos tipos de soporte, uno por fase, y SIEMPRE desde el catálogo compartido: hasta la HU #12590
 * aquí vivía el literal `'recibo_impuesto_sin_marca'` mientras `soportes-zip.ts` buscaba
 * `recibo_impuesto_sin_marca_agua`, y el ZIP no encontraba la copia limpia (la 0196 renombró lo ya
 * escrito). El hash se evalúa contra los DOS, antes de bifurcar por fase (AC7).
 */
const TIPO_POR_FASE: Record<FaseRecibo, TipoSoporte> = {
  [FaseRecibo.LIQUIDACION]: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA,
  [FaseRecibo.PAGO]: TipoSoporte.RECIBO_IMPUESTO,
};
/** Los tipos contra los que cruza el hash (AC7 de la #12590 y AC6 de la #12591): las dos fases y la caja. */
const TIPOS_RECIBO: readonly TipoSoporte[] = [
  TipoSoporte.RECIBO_IMPUESTO, TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, TipoSoporte.RECIBO_CAJA_IMPUESTO,
];
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

/**
 * Veredicto del recibo de caja (HU #12591): SOLO el valor total, presente, no nulo y sobre el umbral.
 * No se reutiliza `evaluarReciboImpuesto` porque exige la placa como llave y el recibo de caja no la
 * trae (el impuesto ya está identificado por id). Devuelve el mismo `Veredicto`: `aRevision` no cambia.
 */
export function evaluarReciboCaja(extraccion: ExtraccionImpuesto, umbral: number): Veredicto {
  const total = extraccion[CampoImpuesto.VALOR_TOTAL];
  if (!total || total.valor === null || total.confianza < umbral) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE, detalle: `La lectura no superó el umbral de ${umbral} en: ${CampoImpuesto.VALOR_TOTAL}.` };
  }
  return { aprobada: true };
}

/**
 * Error de negocio de la carga puntual del recibo de caja: lleva `codigo` porque la pantalla decide
 * por él (`ImpuestoError` solo lleva status + message y `handleError` responde `{ error }`).
 */
export class ReciboCajaError extends Error {
  constructor(public status: number, public codigo: CodigoErrorReciboCaja, message: string) { super(message); }
}

/** Escribe en `audit_logs` con la tx abierta o, para un rechazo que no abre ninguna, con `db` directo. */
async function auditEnTx(escritor: Pick<typeof db, 'insert'>, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await escritor.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail });
}

const aNumero = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);

export interface ItemRecibo { archivo: string; placa: string | null; idFlit: string | null; registroId: string | null; detalle: string }
export interface ResultadoRecibos {
  conciliados: ItemRecibo[]; enRevision: ItemRecibo[]; duplicados: ItemRecibo[]; complementos: ItemRecibo[]; noAsociados: ItemRecibo[];
  /** HU #12590: liquidaciones del impuesto registradas sobre un `solicitado` (marca, no transición). */
  liquidados: ItemRecibo[];
  /** HU #12614: rechazados porque el sello PAGADO contradice la fase declarada (nada escrito). */
  faseNoCoincide: ItemRecibo[];
  /** HU #12614 (AC6): primer segmento de las carpetas sin palabra de fase (sin repetidos, por tanda). */
  carpetasSinFase: string[];
}

// Datos de un impuesto candidato para conciliar/archivar.
export interface Candidato {
  impuestoId: string; estado: string; organismoCodigo: string; tramiteIdFlit: string; tramiteId: string;
  // `document` NO se trae (HU #11770): la carpeta se nombra con el id de la compañía, no con su NIT.
  placa: string | null; companiaId: number; carpeta: string | null; valorLiquidado: string | null;
  // D-5 (Fase 7): activación de diferencia de valor por organismo + tolerancia de la compañía.
  diferenciaActiva: boolean; tolerancia: string;
  /** HU #12590: cuándo se cargó la liquidación del impuesto; null = todavía no. */
  liquidadoEn: Date | null;
}
const SELECT_CAND = {
  impuestoId: flitoImpuestos.id, estado: flitoImpuestos.estado, organismoCodigo: flitoImpuestos.organismoCodigo,
  tramiteIdFlit: flitoTramites.idFlit, tramiteId: flitoTramites.id, placa: vehicles.plate, companiaId: clients.id,
  carpeta: clients.flitoCarpetaStorage, valorLiquidado: flitoImpuestos.valorLiquidado,
  liquidadoEn: flitoImpuestos.liquidadoEn,
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
 * Carga masiva de recibos. `fase` (HU #12590) es la fase por defecto para archivos sueltos; en un
 * ZIP la fase se deduce de la carpeta. Las liquidaciones del impuesto se procesan primero: así, si el
 * pago con marca del mismo impuesto viene en el mismo lote, ya encuentra `valorLiquidado` escrito y
 * la diferencia de valor (AC5) se evalúa contra él. Un archivo que falla no tumba el lote.
 *
 * `rutas` (HU #12056) es la ruta relativa DENTRO del ZIP de cada archivo, para las tandas que el
 * navegador arma abriendo el ZIP él mismo. Sin ella, la deducción por carpeta moriría en silencio y
 * todo caería a la fase por defecto. Es opcional y solo informativa: quien decide la fase sigue
 * siendo `faseDeCarpeta`, una sola vez, dentro de `expandir`.
 */
export async function cargarRecibos(archivos: ArchivoSubido[], fase: FaseRecibo, ctx: ImpuestoCtx, rutas?: readonly string[]): Promise<ResultadoRecibos> {
  const res: ResultadoRecibos = {
    conciliados: [], enRevision: [], duplicados: [], complementos: [], noAsociados: [], liquidados: [], faseNoCoincide: [], carpetasSinFase: [],
  };
  const { archivos: expandidos, carpetasSinFase } = await expandir(archivos, fase, rutas);
  res.carpetasSinFase = carpetasSinFase;
  // La liquidación primero: escribe `valorLiquidado` y el pago del mismo lote lo relee del candidato.
  liquidacionPrimero(expandidos, (a) => a.fase);

  const lote = await abrirLote(ctx);

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

  // AC5 (HU #12614): la misma placa dos veces en el lote con la misma fase declarada → el sello
  // reparte liquidación/pago (o rechaza si no se distingue). Se decide ANTES de cruzar y sin
  // consultas: la llave es la misma que usará `procesarRecibo` (placa del OCR, o del nombre a falta
  // de ella), y el `confiable` del sello es el del umbral por defecto del lote (ver `flito-recibos.fase.ts`).
  const aProcesar = await repartirPorSello(extraidos, ctx, res);

  for (const item of aProcesar) {
    try {
      if ('error' in item && item.error) throw item.error;
      const extraido = 'extraccion' in item ? item.extraccion : undefined;
      if (!extraido) throw new Error('Error procesando el archivo.');
      await procesarRecibo(item.archivo, lote, ctx, res, extraido, item.hash);
    } catch (e) {
      res.noAsociados.push({ archivo: item.archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: (e as Error).message });
    }
  }
  consolidarMismoLote(res);
  return res;
}

type Extraido = { archivo: Expandido; hash: string } & ({ extraccion: ExtraccionImpuesto } | { error: unknown });

/**
 * AC5: aplica `resolverPlacaRepetida` al lote ya leído. Devuelve los que siguen a `procesarRecibo`
 * —con la fase que dictó el sello y otra vez liquidaciones primero— y empuja al resumen los
 * rechazados (`faseNoCoincide`, auditados con la placa como recurso: no hubo cruce) y los
 * `duplicados` (mismo sello repetido; nada que auditar, no se escribió nada).
 */
async function repartirPorSello(extraidos: Extraido[], ctx: ImpuestoCtx, res: ResultadoRecibos): Promise<Extraido[]> {
  const entradas: EntradaPlaca[] = extraidos.map((item) => {
    const ex = 'extraccion' in item ? item.extraccion : undefined;
    const llave = ex ? normalizarLlave(ex[CampoImpuesto.PLACA]?.valor ?? placaDesdeNombre(item.archivo.originalname)) : '';
    return { archivo: item.archivo.originalname, llave: llave || null, fase: item.archivo.fase, sello: ex ? leerSello(ex) : null };
  });
  const decisiones = resolverPlacaRepetida(entradas);
  const siguen: Extraido[] = [];
  for (const [i, item] of extraidos.entries()) {
    const decision = decisiones[i]!;
    const placa = entradas[i]!.llave;
    if (decision.accion === 'procesar') { siguen.push({ ...item, archivo: { ...item.archivo, fase: decision.fase } }); continue; }
    const renglon: ItemRecibo = { archivo: item.archivo.originalname, placa, idFlit: null, registroId: null, detalle: decision.detalle };
    if (decision.accion === 'duplicado') { res.duplicados.push(renglon); continue; }
    res.faseNoCoincide.push(renglon);
    await auditEnTx(db, ctx, placa ?? '—',
      `Recibo rechazado por fase (declarada ${item.archivo.fase}; placa ${placa ?? '—'} repetida en el lote). ${decision.detalle} Archivo ${item.archivo.originalname}.`);
  }
  return liquidacionPrimero(siguen, (item) => item.archivo.fase);
}

/**
 * AC4: si la liquidación y el pago con marca del MISMO impuesto vinieron en el mismo lote, el
 * resumen cuenta ese impuesto una sola vez, en `conciliados`. La liquidación ya quedó escrita en BD
 * (se procesó primero); solo se pliega el renglón del resumen y se deja constancia en el detalle.
 */
function consolidarMismoLote(res: ResultadoRecibos): void {
  const pagados = new Map(res.conciliados.map((c) => [c.registroId, c]));
  res.liquidados = res.liquidados.filter((l) => {
    const c = l.registroId ? pagados.get(l.registroId) : undefined;
    if (!c) return true;
    c.detalle += ` Incluye la liquidación del mismo lote (${l.archivo}).`;
    return false;
  });
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
/** Reevalúa `confiable` de cada campo contra el umbral del organismo. Exportada para comprobantes (HU #12630). */
export function remarcarConfiable(extraccion: ExtraccionImpuesto, umbral: number): ExtraccionImpuesto {
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
 *
 * Lo común a las dos fases va primero (placa, candidato, remarca, dedup por número de recibo); la
 * bifurcación por `archivo.fase` es lo último, y cada fase escribe en su propia transacción.
 */
async function procesarRecibo(
  archivo: Expandido,
  lote: LoteRecibos,
  ctx: ImpuestoCtx,
  res: ResultadoRecibos,
  extraido: ExtraccionImpuesto,
  hash: string,
): Promise<void> {
  const tipo = TIPO_POR_FASE[archivo.fase];
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
    // ¿Es la otra fase (o una copia) de un pago ya conciliado? Se adjunta, no se rechaza (AC6).
    if (await adjuntarComplemento(archivo, placa, archivo.fase, lote, hash, ctx, res)) return;
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

  // HU #12614 (AC2/AC3): el sello PAGADO, ya `confiable` con el umbral del organismo, vigila la fase
  // declarada. El rechazo sale ANTES de archivar y de abrir transacción: nada en storage ni en BD
  // salvo la auditoría. Ante la duda (sello ilegible o bajo el umbral) se respeta lo declarado (AC4).
  const rechazo = vigilarFase(archivo.fase, leerSello(extraccion));
  if (rechazo) {
    const lectura = extraccion[CampoImpuesto.SELLO_PAGADO];
    await auditEnTx(db, ctx, candidato.impuestoId,
      `Recibo rechazado por fase (declarada ${archivo.fase}; sello PAGADO leído ${lectura?.valor ?? '—'} con confianza ${lectura?.confianza ?? 0}, umbral ${umbral}). ` +
      `${rechazo.detalle} Archivo ${archivo.originalname}. Trámite ${candidato.tramiteIdFlit}.`);
    res.faseNoCoincide.push({ archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: candidato.impuestoId, detalle: rechazo.detalle });
    return;
  }

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

  if (archivo.fase === FaseRecibo.LIQUIDACION) {
    // Liquidación del impuesto (AC2/AC3): marca `liquidado_en` sobre el `solicitado`, sin veredicto
    // y sin revisión. Un valor dudoso simplemente no se escribe; el documento queda archivado igual.
    const storageKey = await archivar(candidato, archivo);
    const valorLiquidado = await db.transaction(async (tx) => {
      const soporteId = await insertarSoporte(tx, candidato.impuestoId, archivo, tipo, ctx, storageKey, hash);
      return marcarLiquidado(tx, candidato, extraccion, soporteId, ctx);
    });
    res.liquidados.push({ archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: candidato.impuestoId,
      detalle: valorLiquidado !== undefined
        ? `Liquidación del impuesto registrada. Valor liquidado ${valorLiquidado}; el impuesto sigue en gestión hasta el pago con marca.`
        : 'Liquidación del impuesto registrada; el valor no se leyó con confianza y no se escribió. El impuesto sigue en gestión hasta el pago con marca.' });
    return;
  }

  // Pago con marca (AC4): la única vía a PAGADO. Validado por OCR concilia; dudoso, a revisión.
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
 * El recibo ya no cruza con un EN_GESTION: puede ser la otra fase (o una copia) de un pago ya
 * conciliado. Se adjunta al PAGADO si ese impuesto no tiene ya esa misma copia. Devuelve true si se
 * adjuntó.
 *
 * AC6: una liquidación del impuesto que llega DESPUÉS del pago deja `liquidado_en` si estaba vacío
 * (el impuesto sí tiene su liquidación, aunque llegara tarde), pero NO toca el estado, el pago ni
 * `valorLiquidado`: el impuesto ya está pagado y la diferencia de valor ya se evaluó.
 */
async function adjuntarComplemento(archivo: ArchivoSubido, placa: string, fase: FaseRecibo, lote: LoteRecibos, hash: string, ctx: ImpuestoCtx, res: ResultadoRecibos): Promise<boolean> {
  const tipo = TIPO_POR_FASE[fase];
  const pagado = await buscarCandidato(placa, EstadoImpuesto.PAGADO, lote);
  if (!pagado) return false;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(flitoSoportes).where(and(eq(flitoSoportes.impuestoId, pagado.impuestoId), eq(flitoSoportes.tipo, tipo), eq(flitoSoportes.descartado, false)));
  if (Number(n) > 0) return false; // ya tiene esa copia: es duplicado, no complemento
  const cual = fase === FaseRecibo.LIQUIDACION ? 'la liquidación del impuesto (sin marca)' : 'el pago con marca';
  const marcaLiquidado = fase === FaseRecibo.LIQUIDACION && pagado.liquidadoEn === null;
  const storageKey = await archivar(pagado, archivo);
  await db.transaction(async (tx) => {
    const soporteId = await insertarSoporte(tx, pagado.impuestoId, archivo, tipo, ctx, storageKey, hash);
    if (marcaLiquidado) await tx.update(flitoImpuestos).set({ liquidadoEn: new Date(), updatedAt: new Date() }).where(eq(flitoImpuestos.id, pagado.impuestoId));
    await auditEnTx(tx, ctx, pagado.impuestoId, `Comprobante complementario (${cual}) adjuntado al pago de ${pagado.tramiteIdFlit}.${marcaLiquidado ? ' Queda marcado como liquidado.' : ''} Soporte ${soporteId}.`);
  });
  res.complementos.push({ archivo: archivo.originalname, placa, idFlit: pagado.tramiteIdFlit, registroId: pagado.impuestoId, detalle: `Comprobante de ${cual} adjuntado al pago de ${pagado.tramiteIdFlit}.` });
  return true;
}

/**
 * Liquidación del impuesto (HU #12590, AC2/AC3): la marca `liquidado_en` sobre un `solicitado`.
 * Escribe `valorLiquidado` SOLO si el OCR lo leyó con confianza (`confiable` ya re-marcado con el
 * umbral del organismo); si no, la clave no entra en el `set` y se conserva el anterior. No toca
 * `estado`, `pagadoEn`, `valorPagado`, `marcadoPorDiferencia`, `motivoRechazo` ni `extraccion` (esa
 * columna es la lectura del pago). El historial registra el hecho sin transición
 * (`estadoAnterior === estadoNuevo`), como `asumirEnOperaciones`. Devuelve el valor escrito, o
 * `undefined` si no se escribió.
 */
async function marcarLiquidado(tx: Tx, cand: Candidato, extraccion: ExtraccionImpuesto, soporteId: string, ctx: ImpuestoCtx): Promise<string | undefined> {
  const total = extraccion[CampoImpuesto.VALOR_TOTAL];
  const valorLiquidado = total?.confiable ? aNumero(total.valor) ?? undefined : undefined;
  await tx.update(flitoImpuestos).set({
    liquidadoEn: new Date(), ...(valorLiquidado !== undefined ? { valorLiquidado } : {}), updatedAt: new Date(),
  }).where(eq(flitoImpuestos.id, cand.impuestoId));
  const valorTexto = valorLiquidado ?? '— (OCR no confiable; se conserva el anterior)';
  await auditEnTx(tx, ctx, cand.impuestoId,
    `Liquidación del impuesto cargada (fase liquidacion). Valor liquidado ${valorTexto}, ` +
    `recibo ${extraccion[CampoImpuesto.NUMERO_RECIBO]?.valor ?? '—'}. Soporte ${soporteId}. Trámite ${cand.tramiteIdFlit}.`);
  await registrarCambio(tx, {
    concepto: 'impuesto', registroId: cand.impuestoId,
    estadoAnterior: cand.estado, estadoNuevo: cand.estado,
    motivo: `Liquidación del impuesto cargada. Valor ${valorLiquidado ?? '—'}.`,
    usuarioId: ctx.userId, usuarioEmail: ctx.username,
  });
  return valorLiquidado;
}

/**
 * Conciliación → PAGADO. La diferencia de valor (CA-09) está APAGADA por defecto (D-5): el
 * valorLiquidado de FLIT no siempre es fiable y el total pagado incluye el servicio de FLITO. Se
 * ACTIVA por organismo (`flitoDiferenciaValorActiva`, Fase 7) donde la fuente sí lo es: si el
 * |pagado - liquidado| supera la tolerancia de la compañía, se MARCA para revisión (marcadoPorDiferencia)
 * pero NO bloquea el pago. El valor se guarda siempre (lo consume Liquidaciones).
 */
/**
 * La ÚNICA vía a `pagado` de un impuesto por documento (ADR-0018 §4, D1 de la Épica #12245): carga
 * masiva, recibo de caja y comprobantes universales (HU #12630) pasan por aquí. Escribe estado,
 * `valor_pagado`, `marcado_por_diferencia` (D-5), la auditoría y la fila de `flito_estado_historial`.
 */
export async function conciliar(
  tx: Tx, cand: Candidato, extraccion: ExtraccionImpuesto, soporteId: string, ctx: ImpuestoCtx,
  // HU #12591: la carga masiva sigue pagando «hoy»; el recibo de caja pasa la fecha leída del recibo.
  pagadoEn: Date = new Date(),
): Promise<{ valorPagado: string | null; marcadoPorDiferencia: boolean }> {
  const valorPagado = aNumero(extraccion[CampoImpuesto.VALOR_TOTAL]?.valor);
  const marcadoPorDiferencia = evaluarDiferencia(cand, valorPagado);
  await tx.update(flitoImpuestos).set({
    estado: EstadoImpuesto.PAGADO, extraccion, valorPagado, marcadoPorDiferencia,
    pagadoEn, motivoRechazo: null, updatedAt: new Date(),
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
  return { valorPagado, marcadoPorDiferencia };
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

/** Devuelve el id de la revisión abierta (la carga masiva lo ignora; el recibo de caja lo responde). */
async function aRevision(tx: Tx, soporteId: string, extraccion: ExtraccionImpuesto, veredicto: Veredicto, impuestoId: string, placa: string | null, ctx: ImpuestoCtx): Promise<string> {
  const [r] = await tx.insert(flitoRevisiones).values({
    modulo: FlujoRevision.IMPUESTOS, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
    registroId: impuestoId, soporteId, placaSugerida: placa, extraccion, resuelto: false,
  }).returning({ id: flitoRevisiones.id });
  await auditEnTx(tx, ctx, impuestoId, `Recibo a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
  return r.id;
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

/** Un archivo del lote con su fase ya decidida (HU #12590). */
type Expandido = ArchivoSubido & { fase: FaseRecibo };

/**
 * Expande ZIP marcando cada recibo con su fase por la carpeta; sueltos usan la ruta declarada por el
 * cliente (tandas de ZIP abierto en el navegador) y, a falta de ella, la fase por defecto.
 *
 * La ruta declarada es TEXTO DEL CLIENTE y casi no sale de aquí: alimenta `faseDeCarpeta` (la regla
 * de carpetas: «sin marca»/«original»/«liquidac…» = liquidación; «con marca»/«pagad…» = pago, y el
 * pago manda si la carpeta dice las dos cosas) y, cuando la carpeta no nombra ninguna fase, su
 * PRIMER segmento se devuelve en `carpetasSinFase` para que quien cargó sepa que ahí aplicó la fase
 * por defecto (AC6). El nombre con el que se archiva y se persiste sigue siendo el `originalname`.
 */
async function expandir(archivos: ArchivoSubido[], faseDefecto: FaseRecibo, rutasCrudas?: readonly string[]): Promise<{ archivos: Expandido[]; carpetasSinFase: string[] }> {
  // Cardinalidad que no cuadra → como si no hubieran llegado rutas. Sin excepción y sin a medias.
  const rutas = rutasCrudas && rutasCrudas.length === archivos.length ? rutasCrudas : undefined;
  const sinFase = new Set<string>();
  const faseDe = (ruta: string): FaseRecibo => {
    const declarada = faseDeCarpeta(ruta);
    if (declarada) return declarada;
    const raiz = carpetaRaiz(ruta);
    if (raiz !== null) sinFase.add(raiz);
    return faseDefecto;
  };
  const salida: Expandido[] = [];
  for (const [i, archivo] of archivos.entries()) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    // El ZIP subido al API se sigue expandiendo aquí (AC7): sus entradas traen su propia ruta y
    // cualquier `rutas` que viniera para él se ignora.
    if (!esZip) { salida.push({ ...archivo, fase: faseDe(rutas?.[i] ?? '') }); continue; }
    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf' : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg' : lower.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length, fase: faseDe(entrada.name) });
    }
  }
  return { archivos: salida, carpetasSinFase: [...sinFase] };
}

// ─────────────────────────── Recibo de caja (HU #12591) ─────────────────────

/** Desplazamiento fijo de Bogotá (sin horario de verano): la fecha del recibo es un día civil colombiano. */
const OFFSET_BOGOTA = '-05:00';

/**
 * La fecha legal del pago: la que dice el recibo, anclada a medianoche de Bogotá, SOLO si el OCR la
 * leyó con confianza (`normalizarFecha` ya deja `yyyy-mm-dd`). Una fecha dudosa no se convierte en
 * fecha legal: se cae a la fecha de carga (AC4).
 */
function fechaDelRecibo(extraccion: ExtraccionImpuesto): Date | null {
  const fecha = extraccion[CampoImpuesto.FECHA_PAGO];
  if (!fecha || fecha.valor === null || !fecha.confiable) return null;
  const d = new Date(`${fecha.valor}T00:00:00${OFFSET_BOGOTA}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** El `Candidato` (datos para archivar y conciliar) de un impuesto concreto, por id. Exportado para comprobantes (HU #12630). */
export async function candidatoPorImpuestoId(id: string): Promise<Candidato | null> {
  const [cand] = await fromCandidatos().where(eq(flitoImpuestos.id, id)).limit(1);
  return cand ?? null;
}

/**
 * Carga puntual del recibo de caja desde el detalle del impuesto (HU #12591). Orden de decisión —
 * cada paso corta y hasta el OCR inclusive NO se escribe nada, ni en storage ni en base—:
 *
 *   404 no_encontrado        → id inexistente o fuera de la frontera del actor (`buscarConAcceso`)
 *   409 sin_liquidacion      → `liquidado_en` vacío: el recibo de caja se carga sobre una liquidación
 *   409 estado_no_permitido  → el impuesto no está en gestión (`solicitado`)
 *   409 duplicado            → el archivo es idéntico a un recibo ya cargado (de este impuesto o de otro)
 *   503 (OcrNoDisponibleError) → el OCR no respondió; reintentable, nada archivado
 *   200 pagado               → valor leído con confianza: `conciliar` con la fecha del recibo (o la de carga)
 *   200 en_revision          → lectura dudosa: soporte guardado y fila en `flito_revisiones`; el impuesto no se toca
 *
 * El umbral es el del organismo del impuesto cuando quien carga es el gestor (si el reparto le da la
 * función algún día) y el de Operaciones para el resto: `abrirLote` + `umbralDelCandidato`, sin código nuevo.
 */
export async function cargarReciboCaja(impuestoId: string, archivo: ArchivoSubido, ctx: ImpuestoCtx): Promise<ResultadoReciboCaja> {
  const imp = await buscarConAcceso(impuestoId, ctx);
  if (!imp) throw new ReciboCajaError(404, CodigoErrorReciboCaja.NO_ENCONTRADO, 'El impuesto no existe');
  if (imp.liquidadoEn === null) {
    throw new ReciboCajaError(409, CodigoErrorReciboCaja.SIN_LIQUIDACION, 'Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación');
  }
  if (imp.estado !== EstadoImpuesto.SOLICITADO) {
    throw new ReciboCajaError(409, CodigoErrorReciboCaja.ESTADO_NO_PERMITIDO,
      `El recibo de caja solo se carga sobre un impuesto en gestión. Este está en "${ESTADO_IMPUESTO_LABEL[imp.estado as EstadoImpuesto] ?? imp.estado}".`);
  }
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  if (await hashReciboYaCargado(hash)) {
    throw new ReciboCajaError(409, CodigoErrorReciboCaja.DUPLICADO, 'Ese recibo ya está registrado: el archivo es idéntico a uno cargado antes.');
  }
  const cand = await candidatoPorImpuestoId(impuestoId);
  if (!cand) throw new ReciboCajaError(404, CodigoErrorReciboCaja.NO_ENCONTRADO, 'El impuesto no existe');

  const lote = await abrirLote(ctx);
  // El OCR va ANTES de archivar y de abrir la transacción: si no responde, el 503 sale limpio.
  const extraido = await extraerReciboCaja(docDe(archivo, lote.porDefecto));
  const umbral = umbralDelCandidato(lote, cand.organismoCodigo);
  const extraccion = remarcarConfiable(extraido, umbral);
  const veredicto = evaluarReciboCaja(extraccion, umbral);

  const storageKey = await archivar(cand, archivo);
  return db.transaction(async (tx): Promise<ResultadoReciboCaja> => {
    const soporteId = await insertarSoporte(tx, cand.impuestoId, archivo, TipoSoporte.RECIBO_CAJA_IMPUESTO, ctx, storageKey, hash);
    if (veredicto.aprobada) {
      const pagadoEn = fechaDelRecibo(extraccion) ?? new Date();
      const r = await conciliar(tx, cand, extraccion, soporteId, ctx, pagadoEn);
      return { resultado: 'pagado', valorPagado: r.valorPagado, pagadoEn: pagadoEn.toISOString(), marcadoPorDiferencia: r.marcadoPorDiferencia, soporteId };
    }
    const revisionId = await aRevision(tx, soporteId, extraccion, veredicto, cand.impuestoId, cand.placa, ctx);
    return { resultado: 'en_revision', soporteId, revisionId };
  });
}

// ─────────────────────────── Reintento de pendientes ─────────────────────────

