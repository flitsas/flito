// FLITO Derechos de tránsito — carga de recibos y cruce con el trámite (HU #10950).
//
// El derecho de tránsito es lo que el organismo cobra por radicar. Hasta esta HU era una constante
// quemada en el reporte de costos; aquí se convierte en un dato leído del recibo del organismo.
//
// El pipeline es hermano del de recibos de impuestos (flito-recibos.service.ts): expandir → dedup por
// hash → OCR → cruce por placa → registrar o mandar a revisión. Dos diferencias que importan:
//
//  1. NO hay máquina de estados. El recibo llega ya pagado; no existe un "solicitado" contra el que
//     conciliar. Por eso el cruce es contra cualquier trámite vivo de esa placa, no contra un estado.
//  2. Una placa puede tener varios trámites. El concepto del recibo ("MATRICULA INICIAL", "PRENDA")
//     desempata; si aun así quedan varios, decide Operaciones en la cola de revisión — nunca el
//     sistema por su cuenta, porque asociar el pago al trámite equivocado descuadra la liquidación.

import { createHash } from 'crypto';
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  CampoDerechoTramite, CAMPOS_REQUERIDOS_DERECHO,
  FlujoRevision, MotivoRevision, type ExtraccionDerechoTramite,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoDerechosTramite, flitoRevisiones, flitoSoportes,
  flitoTramites, organismosTransitoConfig, procesamientoCuentas, vehicles,
} from '../../db/schema.js';
import { extraerDerechoTramite, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { expandirZips, type ArchivoPlano } from '../../shared/archivos/expandir-zip.js';
import { separarPaginas, nombrePagina, PdfDemasiadoGrandeError } from '../../shared/pdf/separar-paginas.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-derechos');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TIPO_SOPORTE_DERECHO = 'derecho_tramite';

/** Carpeta de los soportes que aún no cuelgan de una compañía (sin trámite o en revisión). */
const CARPETA_SIN_ASOCIAR = '_derechos-sin-asociar';

export type OrigenDerecho = 'manual' | 'drive';

export interface DerechoCtx { userId: number; username: string; role: string }

export class DerechoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ItemDerecho {
  archivo: string;
  placa: string | null;
  idFlit: string | null;
  registroId: string | null;
  valor: string | null;
  detalle: string;
}

export interface ResultadoDerechos {
  registrados: ItemDerecho[];
  enRevision: ItemDerecho[];
  duplicados: ItemDerecho[];
  pendientes: ItemDerecho[];
  /** Páginas que no eran una cuenta individual (portadas, resúmenes, hojas en blanco). */
  omitidas: ItemDerecho[];
  /** Archivos que no se pudieron procesar (corruptos, ilegibles). Nunca tumban el lote. */
  fallidos: ItemDerecho[];
}

const vacio = (): ResultadoDerechos => ({
  registrados: [], enRevision: [], duplicados: [], pendientes: [], omitidas: [], fallidos: [],
});

const item = (archivo: string, extra: Partial<ItemDerecho> = {}): ItemDerecho => ({
  archivo, placa: null, idFlit: null, registroId: null, valor: null, detalle: '', ...extra,
});

/** Comparación de llaves de texto: sin tildes, sin separadores, en mayúsculas. */
export function normalizarTexto(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * ¿Se leyó lo suficiente para registrar el pago? La placa es la llave del cruce y el valor es el
 * dato que va a la liquidación: ambos deben superar el umbral. Radicado, organismo y tipo se
 * extraen pero no bloquean — varían de formato entre organismos y su ausencia no impide saber
 * cuánto se pagó.
 */
export function evaluarDerecho(extraccion: ExtraccionDerechoTramite, umbral: number): Veredicto {
  const placa = extraccion[CampoDerechoTramite.PLACA];
  if (!placa?.valor || placa.confianza < umbral) {
    return {
      aprobada: false,
      motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La placa se leyó con confianza ${placa?.confianza ?? 0}, bajo el umbral de ${umbral}.`,
    };
  }
  const dudosos = CAMPOS_REQUERIDOS_DERECHO.filter((c) => {
    const e = extraccion[c];
    return !e || e.valor === null || e.confianza < umbral;
  });
  if (dudosos.length > 0) {
    return {
      aprobada: false,
      motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La lectura no superó el umbral de ${umbral} en: ${dudosos.join(', ')}.`,
    };
  }
  return { aprobada: true };
}

/**
 * ¿La página era una cuenta de cobro individual? El prompt devuelve todo en null ante un resumen o
 * una portada; sin placa NI valor no hay nada que registrar y tampoco es un error del usuario.
 */
function esPaginaSinContenido(e: ExtraccionDerechoTramite): boolean {
  return !e[CampoDerechoTramite.PLACA]?.valor && !e[CampoDerechoTramite.VALOR_TOTAL]?.valor;
}

// ─────────────────────────── Cruce con el trámite ────────────────────────────

export interface CandidatoTramite {
  tramiteId: string;
  idFlit: string;
  tipoTramite: string | null;
  organismoCodigo: string | null;
  companiaId: number | null;
  document: string | null;
  carpeta: string | null;
  yaTieneDerecho: boolean;
  // Los tres siguientes solo se usan para componer el nombre del archivo (ver `nombreArchivoDerecho`).
  placa: string | null;
  ciudad: string | null;
  companiaNombre: string | null;
}

/**
 * Estado de FLIT en el que un trámite PUEDE tener un derecho de tránsito pagado.
 *
 * Es una lista blanca, no de exclusión, y esa dirección es deliberada: `flitEstado` es texto libre
 * que llega de FLIT y su catálogo es ABIERTO (el propio contrato lo documenta como "Borrador,
 * Asignado, Aprobado, …"). Con una lista de exclusión, un estado nuevo de pre-radicación entraría
 * por defecto como válido y podría colgarle un derecho pagado a un trámite que nunca se radicó:
 * un dato financiero incorrecto escrito en silencio. Con lista blanca el fallo se invierte y se
 * vuelve visible — el recibo cae en la bandeja de pendientes, que se reintenta sola.
 *
 * Solo `Aprobado`: es cuando el organismo genera el derecho de tránsito (regla de negocio), y es
 * además el estado final del flujo (Asignado → Entregado → Aprobado), así que un trámite no se
 * "sale" de la lista más adelante. Un recibo que llegue antes de la aprobación espera en
 * pendientes y se asocia solo en cuanto el trámite llega a Aprobado.
 */
const FLIT_ESTADOS_CON_DERECHO = ['aprobado'] as const;

/** Lista para un `IN (...)`, con cada estado como parámetro propio. */
function sqlEstadosConDerecho() {
  return sql.join(FLIT_ESTADOS_CON_DERECHO.map((e) => sql`${e}`), sql`, `);
}

/** Trámites de esa placa que pueden tener un derecho pagado (aprobados por el organismo). */
export async function buscarCandidatos(placa: string): Promise<CandidatoTramite[]> {
  return db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId,
    document: clients.document,
    carpeta: clients.flitoCarpetaStorage,
    yaTieneDerecho: sql<boolean>`${flitoDerechosTramite.id} is not null`,
    placa: vehicles.plate,
    ciudad: flitoTramites.ciudad,
    companiaNombre: clients.name,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(and(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarTexto(placa)}`,
      // No se filtra además por el enum interno `estado`: es redundante (Aprobado siempre mapea a
      // 'aprobado') y excluiría de más las filas donde el enum quedó NULL por datos antiguos.
      sql`LOWER(COALESCE(${flitoTramites.flitEstado}, '')) IN (${sqlEstadosConDerecho()})`,
    ))
    .orderBy(desc(flitoTramites.createdAt));
}

/**
 * Desempata por el concepto del recibo cuando la placa tiene varios trámites. La comparación es por
 * contención en cualquier sentido porque el rótulo del organismo ("INSCRIPCION DE PRENDA") rara vez
 * coincide literal con el tipo que reporta FLIT ("PRENDA"). Si el concepto no discrimina —no está,
 * no casa con ninguno o casa con varios— devuelve la lista entera: decidirá una persona.
 */
export function desempatarPorTipo(candidatos: CandidatoTramite[], tipoRecibo: string | null): CandidatoTramite[] {
  const tipo = normalizarTexto(tipoRecibo);
  if (!tipo || candidatos.length <= 1) return candidatos;
  const casan = candidatos.filter((c) => {
    const t = normalizarTexto(c.tipoTramite);
    return t.length > 0 && (t.includes(tipo) || tipo.includes(t));
  });
  return casan.length === 1 ? casan : candidatos;
}

// ─────────────────────────── Carga ───────────────────────────────────────────

export interface OpcionesCarga {
  /** Organismo declarado por quien carga. Fija el umbral y la pista de prompt. Opcional. */
  organismoCodigo?: string | null;
  origen: OrigenDerecho;
  /**
   * De qué documento salió el recibo. `origen` dice el CANAL ('manual' | 'drive'); esto dice el
   * PAPEL. Con los consolidados del Drive —un PDF de trece páginas por día— saber que vino «del
   * Drive» no permite volver al documento, que es lo que hace falta cuando alguien reclama.
   *
   * En carga manual solo hay nombre. En el Drive hay además el barrido que lo produjo y las páginas
   * del consolidado que correspondían a esta placa.
   */
  archivoOrigen?: string | null;
  procesamientoId?: number | null;
  paginas?: number[] | null;
}

/**
 * Carga masiva de recibos de derecho de tránsito. Un archivo que falla no tumba el lote: se reporta
 * y se sigue con el resto (AC8).
 */
export async function cargarDerechos(
  archivos: ArchivoPlano[],
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<ResultadoDerechos> {
  const res = vacio();
  const { umbral, promptHint } = await parametrosOrganismo(opciones.organismoCodigo ?? null);

  const expandidos = await expandirZips(archivos);
  for (const archivo of expandidos) {
    // El archivo de origen es el que subió la persona —o el que venía dentro del ZIP—, NO el `doc`
    // que sale de partir un PDF de varias páginas: ese se llama «pagina-3.pdf» y no lleva a ninguna
    // parte. Se fija aquí, en el bucle exterior, que es donde todavía se sabe cuál era.
    const opcionesArchivo: OpcionesCarga = { ...opciones, archivoOrigen: opciones.archivoOrigen ?? archivo.originalname };
    try {
      for (const doc of await documentosDe(archivo)) {
        try {
          await procesarDocumento(doc, umbral, promptHint, opcionesArchivo, ctx, res);
        } catch (e) {
          res.fallidos.push(item(doc.originalname, { detalle: (e as Error).message }));
        }
      }
    } catch (e) {
      const detalle = e instanceof PdfDemasiadoGrandeError
        ? e.message
        : `No se pudo leer el archivo: ${(e as Error).message}`;
      res.fallidos.push(item(archivo.originalname, { detalle }));
    }
  }
  return res;
}

/** Umbral y pista de prompt del organismo. Sin organismo declarado, los valores por defecto. */
async function parametrosOrganismo(codigo: string | null): Promise<{ umbral: number; promptHint: string | null }> {
  if (!codigo) return { umbral: umbralPara(null), promptHint: null };
  const [o] = await db.select({
    umbral: organismosTransitoConfig.flitoUmbralOcr,
    hint: organismosTransitoConfig.flitoOcrPromptHint,
  }).from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  return { umbral: umbralPara(o?.umbral ?? null), promptHint: o?.hint ?? null };
}

/** Un PDF consolidado se parte en páginas; lo demás viaja como un único documento. */
async function documentosDe(archivo: ArchivoPlano): Promise<ArchivoPlano[]> {
  if (!archivo.mimetype.includes('pdf')) return [archivo];
  const paginas = await separarPaginas(archivo.buffer);
  if (paginas.length <= 1) return [archivo];
  return paginas.map((p) => ({
    originalname: nombrePagina(archivo.originalname, p.numero),
    mimetype: 'application/pdf',
    buffer: p.buffer,
    size: p.buffer.length,
    rutaEnZip: archivo.rutaEnZip,
  }));
}

/** ¿Este archivo, byte por byte, ya está cargado y sin descartar? Devuelve el derecho al que fue. */
async function duplicadoPorHash(hash: string): Promise<{ derechoId: string | null } | null> {
  const [dup] = await db.select({ derechoId: flitoSoportes.derechoId })
    .from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.hash, hash),
      eq(flitoSoportes.tipo, TIPO_SOPORTE_DERECHO),
      eq(flitoSoportes.descartado, false),
    )).limit(1);
  return dup ?? null;
}

async function procesarDocumento(
  archivo: ArchivoPlano,
  umbral: number,
  promptHint: string | null,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
  res: ResultadoDerechos,
): Promise<void> {
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');

  const dupHash = await duplicadoPorHash(hash);
  if (dupHash) {
    res.duplicados.push(item(archivo.originalname, {
      registroId: dupHash.derechoId,
      detalle: 'Ese recibo ya está cargado: el archivo es idéntico a uno registrado antes.',
    }));
    return;
  }

  const doc: DocumentoAAnalizar = {
    nombreArchivo: archivo.originalname,
    contentType: archivo.mimetype,
    contenido: archivo.buffer,
    umbral,
  };
  const extraccion = await extraerDerechoTramite(doc, promptHint);
  await procesarExtraccion(archivo, hash, extraccion, umbral, opciones, ctx, res);
}

/**
 * Registra una lectura YA hecha, sin volver a pasar por el OCR.
 *
 * La usa el procesador de cuentas de cobro de Drive, que tiene su propio OCR página a página (y
 * genera además el Excel y los PDF por placa que Operaciones usa hoy): re-analizar cada página con
 * el extractor de este módulo duplicaría el gasto de OCR para llegar al mismo dato.
 */
export async function registrarDesdeExtraccion(
  archivo: ArchivoPlano,
  extraccion: ExtraccionDerechoTramite,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<ResultadoDerechos> {
  const res = vacio();
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');

  const dupHash = await duplicadoPorHash(hash);
  if (dupHash) {
    res.duplicados.push(item(archivo.originalname, {
      registroId: dupHash.derechoId,
      detalle: 'Ese recibo ya está cargado: el archivo es idéntico a uno registrado antes.',
    }));
    return res;
  }

  const { umbral } = await parametrosOrganismo(opciones.organismoCodigo ?? null);
  await procesarExtraccion(archivo, hash, extraccion, umbral, opciones, ctx, res);
  return res;
}

async function procesarExtraccion(
  archivo: ArchivoPlano,
  hash: string,
  extraccion: ExtraccionDerechoTramite,
  umbral: number,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
  res: ResultadoDerechos,
): Promise<void> {
  // Portada, resumen o página en blanco: no es un error, simplemente no hay recibo que registrar.
  if (esPaginaSinContenido(extraccion)) {
    res.omitidas.push(item(archivo.originalname, {
      detalle: 'La página no es una cuenta de cobro individual (portada, resumen o en blanco).',
    }));
    return;
  }

  const placa = extraccion[CampoDerechoTramite.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);
  const valor = extraccion[CampoDerechoTramite.VALOR_TOTAL]?.valor ?? null;

  // Sin placa no hay llave de cruce y tampoco se puede dejar en pendientes (la placa es su índice):
  // el documento se archiva y se manda a revisión para que una persona diga a qué trámite pertenece.
  if (!placa) {
    const soporteId = await archivarSuelto(archivo, opciones, hash, ctx);
    await aRevision(soporteId, extraccion, {
      aprobada: false,
      motivo: MotivoRevision.SIN_LLAVE_DE_CRUCE,
      detalle: 'El recibo no permitió leer la placa, así que no se pudo asociar a ningún trámite.',
    }, null, null, ctx);
    res.enRevision.push(item(archivo.originalname, { valor, detalle: 'Sin placa legible: enviado a revisión.' }));
    return;
  }

  const candidatos = await buscarCandidatos(placa);

  // Sin trámite: se DESCARTA. No se sube el archivo ni se deja registro.
  //
  // Antes se archivaba en una bandeja y un reintento lo cruzaba solo cuando el trámite apareciera
  // desde FLIT. Se retira por decisión de negocio: la bandeja acumulaba recibos que en la práctica
  // no llegaban a cruzar nunca, y mantener archivos huérfanos en el almacenamiento tenía más coste
  // que valor. Lo que sí queda es el aviso: quien cargó sabe qué recibo no se pudo asociar y con qué
  // placa, y puede volver a subirlo cuando el trámite exista.
  if (candidatos.length === 0) {
    res.pendientes.push(item(archivo.originalname, {
      placa, valor,
      detalle: `El recibo dice placa ${placa}, que no corresponde a ningún trámite. Se descarta: vuelve a cargarlo cuando el trámite exista en FLITO.`,
    }));
    return;
  }

  const veredicto = evaluarDerecho(extraccion, umbral);
  const finalistas = desempatarPorTipo(candidatos, extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null);

  if (!veredicto.aprobada) {
    const unico = finalistas.length === 1 ? finalistas[0] : null;
    const soporteId = unico
      ? await archivar(unico, archivo, hash, extraccion, ctx)
      : await archivarSuelto(archivo, opciones, hash, ctx);
    await aRevision(soporteId, extraccion, veredicto, unico?.tramiteId ?? null, placa, ctx);
    res.enRevision.push(item(archivo.originalname, {
      placa, valor, idFlit: unico?.idFlit ?? null, detalle: veredicto.detalle ?? 'En revisión.',
    }));
    return;
  }

  if (finalistas.length > 1) {
    const soporteId = await archivarSuelto(archivo, opciones, hash, ctx);
    const lista = finalistas.map((c) => c.idFlit).join(', ');
    await aRevision(soporteId, extraccion, {
      aprobada: false,
      motivo: MotivoRevision.CRUCE_AMBIGUO,
      detalle: `La placa ${placa} tiene ${finalistas.length} trámites vivos (${lista}) y el concepto del recibo no permite decidir cuál. Elige a cuál corresponde el pago.`,
    }, null, placa, ctx);
    res.enRevision.push(item(archivo.originalname, {
      placa, valor,
      detalle: `Varios trámites con la placa ${placa}: requiere que Operaciones elija.`,
    }));
    return;
  }

  const elegido = finalistas[0];

  // El derecho es uno por trámite: si ya tiene, este recibo es una segunda copia del mismo pago.
  if (elegido.yaTieneDerecho) {
    res.duplicados.push(item(archivo.originalname, {
      placa, valor, idFlit: elegido.idFlit,
      detalle: `El trámite ${elegido.idFlit} ya tiene registrado su derecho de tránsito.`,
    }));
    return;
  }

  const advertencias = advertenciasDe(elegido, extraccion);
  const soporteId = await archivar(elegido, archivo, hash, extraccion, ctx);
  const derechoId = await registrar(elegido, extraccion, soporteId, advertencias, opciones, ctx);

  res.registrados.push(item(archivo.originalname, {
    placa, valor, idFlit: elegido.idFlit, registroId: derechoId,
    detalle: advertencias.length > 0
      ? `Registrado con advertencias: ${advertencias.join(' ')}`
      : 'Registrado y asociado al trámite.',
  }));
}

/**
 * Discrepancias que no impiden registrar pero deben quedar trazadas. El tipo de trámite advierte y
 * no bloquea a propósito: los conceptos varían tanto entre organismos que exigir coincidencia
 * mandaría a revisión asociaciones que son correctas.
 */
export function advertenciasDe(cand: CandidatoTramite, extraccion: ExtraccionDerechoTramite): string[] {
  const out: string[] = [];
  const tipoRecibo = extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor;
  const t = normalizarTexto(tipoRecibo);
  const tc = normalizarTexto(cand.tipoTramite);
  if (t && tc && !t.includes(tc) && !tc.includes(t)) {
    out.push(`El concepto del recibo dice "${tipoRecibo}" y el trámite es "${cand.tipoTramite}".`);
  }
  const organismoRecibo = extraccion[CampoDerechoTramite.ORGANISMO]?.valor;
  if (organismoRecibo && cand.organismoCodigo === null) {
    out.push(`El recibo lo emite "${organismoRecibo}" y el trámite no tiene organismo emparejado.`);
  }
  return out;
}

// ─────────────────────────── Nombre del archivo ──────────────────────────────

/**
 * Mayúsculas sin tildes, CONSERVANDO los espacios. No sirve `normalizarTexto`, que los quita: eso
 * está bien para comparar llaves, pero aquí «LEASING BANCOLOMBIA» quedaría pegado en una palabra.
 */
function paraNombre(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** yyyy-mm-dd. Acepta también dd/mm/yyyy, que es como lo imprimen varios organismos. */
function diaIso(v: string | null): string {
  const s = (v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/** `.pdf` de «recibo.pdf». Vacío si el nombre no tiene extensión reconocible. */
function extensionDe(nombre: string): string {
  const m = /(\.[A-Za-z0-9]{1,5})$/.exec(nombre);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Nombre del archivo del recibo, en el formato que ya se usa con el Drive:
 *
 *   `2026-07-07 ESQ911 ENVIGADO LEASING TRASPASO TRASPASO UNILATERAL.pdf`
 *    fecha      placa  ciudad   cliente tipo     tipo específico
 *
 * La fecha y el tipo específico salen del propio recibo (OCR); la ciudad, el cliente y el tipo, del
 * trámite con el que cruzó. Un componente que no se pudo extraer se OMITE en vez de dejar un hueco
 * o un marcador: el nombre queda más corto, pero nunca miente ni deja separadores sueltos.
 *
 * Si no se pudo componer nada, se conserva el nombre original: un archivo con nombre feo es
 * recuperable, uno sin nombre no.
 */
export function nombreArchivoDerecho(
  cand: CandidatoTramite,
  extraccion: ExtraccionDerechoTramite,
  nombreOriginal: string,
): string {
  const partes = [
    diaIso(extraccion[CampoDerechoTramite.FECHA_PAGO]?.valor ?? null),
    paraNombre(cand.placa),
    paraNombre(cand.ciudad),
    paraNombre(cand.companiaNombre),
    paraNombre(cand.tipoTramite),
    paraNombre(extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null),
  ].filter((p) => p.length > 0);

  if (partes.length === 0) return nombreOriginal;
  return `${partes.join(' ')}${extensionDe(nombreOriginal)}`;
}

// ─────────────────────────── Persistencia ────────────────────────────────────

async function archivar(
  cand: CandidatoTramite,
  archivo: ArchivoPlano,
  hash: string,
  extraccion: ExtraccionDerechoTramite,
  ctx: DerechoCtx,
): Promise<string> {
  const carpeta = cand.companiaId !== null
    ? carpetaDe({ id: cand.companiaId, document: cand.document, flitoCarpetaStorage: cand.carpeta }, 'derechos-tramite')
    : `${CARPETA_SIN_ASOCIAR}/sin-compania`;
  // El nombre se compone solo cuando el recibo ya cruzó con un trámite: antes de eso faltan la
  // ciudad, el cliente y el tipo, y quedaría un nombre a medias.
  const nombre = nombreArchivoDerecho(cand, extraccion, archivo.originalname);
  const storageKey = await uploadEntityDocument(carpeta, cand.tramiteId, nombre, archivo.buffer, archivo.mimetype);
  return insertarSoporte(archivo, storageKey, hash, ctx, nombre);
}

/** Soporte que aún no cuelga de un trámite (pendiente o en revisión). */
async function archivarSuelto(archivo: ArchivoPlano, opciones: OpcionesCarga, hash: string, ctx: DerechoCtx): Promise<string> {
  const carpeta = `${CARPETA_SIN_ASOCIAR}/${opciones.organismoCodigo ?? 'sin-organismo'}`;
  const storageKey = await uploadEntityDocument(carpeta, opciones.origen, archivo.originalname, archivo.buffer, archivo.mimetype);
  return insertarSoporte(archivo, storageKey, hash, ctx);
}

async function insertarSoporte(
  archivo: ArchivoPlano, storageKey: string, hash: string, ctx: DerechoCtx, nombre?: string,
): Promise<string> {
  const [s] = await db.insert(flitoSoportes).values({
    tipo: TIPO_SOPORTE_DERECHO,
    // El nombre compuesto, cuando lo hay: es el que ve Operaciones al descargar el soporte, y de
    // nada sirve renombrar en el almacenamiento si la pantalla sigue mostrando «pagina-3.pdf».
    nombreArchivo: nombre ?? archivo.originalname,
    contentType: archivo.mimetype,
    storageKey,
    hash,
    tamanoBytes: archivo.size,
    subidoPorId: ctx.userId,
    subidoPorNombre: ctx.username,
  }).returning({ id: flitoSoportes.id });
  return s.id;
}

async function registrar(
  cand: CandidatoTramite,
  extraccion: ExtraccionDerechoTramite,
  soporteId: string,
  advertencias: string[],
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<string> {
  const valor = extraccion[CampoDerechoTramite.VALOR_TOTAL]?.valor ?? null;
  const fechaPago = extraccion[CampoDerechoTramite.FECHA_PAGO]?.valor ?? null;
  const radicado = extraccion[CampoDerechoTramite.NUMERO_RADICADO]?.valor ?? null;
  const tipoRecibo = extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null;

  return db.transaction(async (tx) => {
    const [d] = await tx.insert(flitoDerechosTramite).values({
      tramiteId: cand.tramiteId,
      organismoCodigo: cand.organismoCodigo,
      companiaId: cand.companiaId,
      valor,
      fechaPago,
      numeroRadicado: radicado,
      tipoTramiteRecibo: tipoRecibo,
      origen: opciones.origen,
      // En la carga manual el nombre del fichero subido es lo único que identifica el papel, y se
      // captura ANTES de que `nombreArchivoDerecho()` lo renombre al nombre compuesto.
      archivoOrigen: opciones.archivoOrigen ?? null,
      procesamientoId: opciones.procesamientoId ?? null,
      paginas: opciones.paginas ?? null,
      soporteId,
      extraccion,
      advertencias: advertencias.length > 0 ? advertencias : null,
      registradoPorId: ctx.userId,
    }).returning({ id: flitoDerechosTramite.id });

    await tx.update(flitoSoportes).set({ derechoId: d.id }).where(eq(flitoSoportes.id, soporteId));
    await auditEnTx(tx, ctx, d.id,
      `Derecho de tránsito registrado (${opciones.origen}) para ${cand.idFlit}. Valor ${valor ?? '—'}, ` +
      `fecha ${fechaPago ?? '—'}, radicado ${radicado ?? '—'}. Soporte ${soporteId}.` +
      (advertencias.length > 0 ? ` Advertencias: ${advertencias.join(' ')}` : ''));
    return d.id;
  });
}


async function aRevision(
  soporteId: string,
  extraccion: ExtraccionDerechoTramite,
  veredicto: Veredicto,
  registroId: string | null,
  placa: string | null,
  ctx: DerechoCtx,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(flitoRevisiones).values({
      modulo: FlujoRevision.DERECHOS,
      motivo: veredicto.motivo!,
      detalle: veredicto.detalle!,
      registroId,
      soporteId,
      placaSugerida: placa,
      extraccion,
      resuelto: false,
    });
    await auditEnTx(tx, ctx, registroId ?? soporteId,
      `Recibo de derecho de tránsito a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
  });
}

async function auditEnTx(tx: Tx, ctx: DerechoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update',
    resource: 'flito_derecho_tramite', resourceId, detail,
  });
}

// ─────────────────────────── Pendientes ──────────────────────────────────────

/** Un pendiente que sí encontró su trámite en este reintento. */



// ─────────────────────────── Consultas ───────────────────────────────────────

export interface FiltrosDerechos {
  buscar?: string;
  /** Secretarías cuyo recibo se quiere ver. Vacío = todas. */
  organismos?: string[];
  /** De dónde salió el recibo: cargado a mano o leído del Drive de la secretaría. */
  origenes?: string[];
  /** Rango de fecha de pago del recibo, inclusivo por día. */
  pagadoDesde?: string; pagadoHasta?: string;
  page?: number; pageSize?: number;
}

/** Facetas del listado: solo lo que de verdad hay, para no ofrecer filtros que no devuelven nada. */
export async function facetasDerechos(): Promise<{ organismos: string[]; origenes: string[] }> {
  const orgs = await db.selectDistinct({ v: flitoDerechosTramite.organismoCodigo })
    .from(flitoDerechosTramite).orderBy(flitoDerechosTramite.organismoCodigo);
  const origs = await db.selectDistinct({ v: flitoDerechosTramite.origen })
    .from(flitoDerechosTramite).orderBy(flitoDerechosTramite.origen);
  return {
    organismos: orgs.map((o) => o.v).filter((v): v is string => Boolean(v)),
    origenes: origs.map((o) => o.v).filter((v): v is string => Boolean(v)),
  };
}

export async function listarDerechos(f: FiltrosDerechos = {}) {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
  const texto = f.buscar?.trim();
  const conds: SQL[] = [];
  if (texto) {
    conds.push(or(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${`%${normalizarTexto(texto)}%`}`,
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${`%${texto.toUpperCase()}%`}`,
    )!);
  }
  if (f.organismos?.length) conds.push(inArray(flitoDerechosTramite.organismoCodigo, f.organismos));
  if (f.origenes?.length) {
    conds.push(inArray(
      flitoDerechosTramite.origen,
      f.origenes as Array<(typeof flitoDerechosTramite.origen.enumValues)[number]>,
    ));
  }
  // `fecha_pago` es una columna `date`: se compara contra fechas, sin intervalos ni horas.
  if (f.pagadoDesde) conds.push(sql`${flitoDerechosTramite.fechaPago} >= ${f.pagadoDesde}::date`);
  if (f.pagadoHasta) conds.push(sql`${flitoDerechosTramite.fechaPago} <= ${f.pagadoHasta}::date`);
  const where = conds.length ? and(...conds) : undefined;

  const base = db.select({
    id: flitoDerechosTramite.id,
    tramiteId: flitoDerechosTramite.tramiteId,
    idFlit: flitoTramites.idFlit,
    placa: vehicles.plate,
    organismoCodigo: flitoDerechosTramite.organismoCodigo,
    empresa: clients.name,
    valor: flitoDerechosTramite.valor,
    fechaPago: flitoDerechosTramite.fechaPago,
    numeroRadicado: flitoDerechosTramite.numeroRadicado,
    tipoTramiteRecibo: flitoDerechosTramite.tipoTramiteRecibo,
    origen: flitoDerechosTramite.origen,
    // De qué papel salió. `archivoOrigen` está en los dos canales; el resto solo en el del Drive.
    archivoOrigen: flitoDerechosTramite.archivoOrigen,
    paginas: flitoDerechosTramite.paginas,
    procesamientoId: flitoDerechosTramite.procesamientoId,
    // Se lee del registro del barrido y no de la columna, para que siga siendo cierto si alguien
    // renombra el fichero en el Drive: el registro guarda el nombre que tenía al procesarse.
    procesamientoArchivo: procesamientoCuentas.nombreArchivo,
    procesamientoEn: procesamientoCuentas.createdAt,
    advertencias: flitoDerechosTramite.advertencias,
    soporteId: flitoDerechosTramite.soporteId,
    createdAt: flitoDerechosTramite.createdAt,
  }).from(flitoDerechosTramite)
    .innerJoin(flitoTramites, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoDerechosTramite.companiaId, clients.id))
    .leftJoin(procesamientoCuentas, eq(flitoDerechosTramite.procesamientoId, procesamientoCuentas.id));

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(flitoDerechosTramite)
    .innerJoin(flitoTramites, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .where(where);

  const items = await base.where(where)
    .orderBy(desc(flitoDerechosTramite.createdAt))
    .limit(pageSize).offset((page - 1) * pageSize);

  return { items, total: Number(total ?? 0), page, pageSize };
}

/** Trámites candidatos de una placa, para que la cola de revisión ofrezca entre cuáles elegir. */
export async function candidatosDePlaca(placa: string) {
  const candidatos = await buscarCandidatos(placa);
  return candidatos.map((c) => ({
    tramiteId: c.tramiteId, idFlit: c.idFlit, tipoTramite: c.tipoTramite,
    organismoCodigo: c.organismoCodigo, yaTieneDerecho: c.yaTieneDerecho,
  }));
}

/** Registro de un trámite, si ya lo tiene. Lo usa la cola de revisión para no duplicar. */
export async function derechoDeTramite(tramiteId: string) {
  const [d] = await db.select().from(flitoDerechosTramite)
    .where(eq(flitoDerechosTramite.tramiteId, tramiteId)).limit(1);
  return d ?? null;
}

/** Alta desde la cola de revisión: una persona ya decidió a qué trámite pertenece el recibo. */
export async function registrarDesdeRevision(
  tramiteId: string,
  extraccion: ExtraccionDerechoTramite,
  soporteId: string,
  ctx: DerechoCtx,
): Promise<string> {
  const [cand] = await db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId,
    document: clients.document,
    carpeta: clients.flitoCarpetaStorage,
    yaTieneDerecho: sql<boolean>`${flitoDerechosTramite.id} is not null`,
    placa: vehicles.plate,
    ciudad: flitoTramites.ciudad,
    companiaNombre: clients.name,
  }).from(flitoTramites)
    .leftJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);

  if (!cand) throw new DerechoError(404, 'El trámite indicado no existe');
  if (cand.yaTieneDerecho) throw new DerechoError(400, 'Ese trámite ya tiene registrado su derecho de tránsito');

  const derechoId = await registrar(
    cand, extraccion, soporteId, advertenciasDe(cand, extraccion),
    { origen: 'manual', organismoCodigo: cand.organismoCodigo }, ctx,
  );
  // El soporte pudo cargarse sin saber a qué trámite pertenecía; al resolver, queda atado.
  await db.update(flitoSoportes).set({ derechoId }).where(eq(flitoSoportes.id, soporteId));
  return derechoId;
}
