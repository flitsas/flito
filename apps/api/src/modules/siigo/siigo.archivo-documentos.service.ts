// Siigo — archivar el PDF y el XML de la factura como soporte del trámite (HU #11335, Feature #11243).
//
// El enlace que devuelve Siigo (`public_url`) no es un archivo nuestro. El día que Siigo deje de
// servirlo —contrato terminado, empresa migrada, documento reorganizado— la prueba se va con él, y
// lo que se necesita ante una glosa de la DIAN es un archivo en el almacenamiento de FLITO. Por eso
// se descargan los dos documentos y se guardan como un soporte más del trámite.
//
// Cinco decisiones que sostienen este archivo:
//
//   1. **Se comprueba lo que ya está ANTES de descargar.** Las dos descargas gastan cuota de la
//      misma ventana de 100 peticiones por minuto y por empresa que usa la EMISIÓN. Un barrido que
//      volviera a bajar el PDF de cada factura archivada en cada ciclo se comería la cuota de lo que
//      de verdad importa: emitir. Por eso la consulta local va primero y la red solo se toca por lo
//      que falta.
//   2. **El PDF y el XML se guardan por separado, no en una transacción común.** Es antinatural y es
//      deliberado (AC5). Si el XML falla después de haber subido el PDF al almacenamiento, deshacer
//      el registro del PDF no borra el objeto: dejaría un archivo huérfano en el bucket Y obligaría
//      a volver a descargarlo, gastando cuota por un documento que ya estaba. Se registra lo que sí
//      se logró, la factura queda `parcial` —que NO es «archivada»— y el siguiente ciclo baja solo
//      lo que falta.
//   3. **La factura no gana ninguna columna** (AC7). Que una factura esté archivada es una
//      consecuencia de que existan sus dos soportes, no un estado que alguien tenga que mantener en
//      `siigo_facturas`. Un `archivada boolean` habría que sincronizarlo, y un flag que miente es
//      justo el «soporte mentiroso» que el AC5 prohíbe.
//   4. **Lo descargado se verifica antes de guardarse.** Siigo puede responder 200 con algo que no
//      es el documento; guardarlo produciría un soporte que dice ser la factura y no lo es.
//   5. **La deduplicación mira el CONTENIDO, no el nombre** (AC3), y la garantía final es del
//      índice único de la base: entre el «¿ya está?» y el INSERT cabe otro ciclo del barrido.

import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm';
import {
  SIIGO_DOCUMENTOS_FACTURA,
  SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE,
  SIIGO_DOCUMENTO_FACTURA_FIRMA,
  TIPO_SOPORTE_FACTURA,
  type SiigoArchivoDocumento,
  type SiigoArchivoResumen,
  type SiigoDocumentoFactura,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoSoportes, flitoTramites, siigoFacturaTramites, siigoFacturas } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia } from './siigo.catalogos.service.js';
import { modoSiigo } from './siigo.mock.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { motivoLegible } from './siigo.productos.service.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.archivo');

/** Subcarpeta dentro de la carpeta de la compañía. Igual de explícita que `soat/facturas`. */
const SUBCARPETA = 'facturacion-electronica';

/** Quién figura como autor del soporte. La columna es NOT NULL y aquí no hay una persona. */
const AUTOR_AUTOMATICO = 'Facturación electrónica (automático)';

/**
 * Timeout de la descarga.
 *
 * Más largo que la consulta de un producto (15 s) porque aquí viaja un documento entero, y muy por
 * debajo de los 120 s del cliente, que están pensados para la CREACIÓN de comprobantes: nadie está
 * esperando delante de una pantalla, pero un barrido colgado dos minutos por factura no barre nada.
 */
export const TIMEOUT_DESCARGA_DOCUMENTO_MS = 30_000;

/** Cuántas facturas mira un ciclo. Cada una puede costar dos peticiones de la cuota compartida. */
export const TOPE_POR_CICLO = 25;

/** Fallo con nombre propio del archivo. La ruta —cuando exista— lo traduce a HTTP. */
export class SiigoArchivoError extends Error {
  readonly codigo: 'no_existe' | 'sin_documento_en_siigo';

  constructor(codigo: SiigoArchivoError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoArchivoError';
    this.codigo = codigo;
  }
}

/**
 * Circuito propio del archivo de documentos.
 *
 * Separado del de productos y del de catálogos por la razón de siempre: la cuota es de la EMPRESA y
 * se comparte, pero la salud es del ENDPOINT. Que `/pdf` esté caído no puede dejar sin emitir.
 */
export function claveCortacircuitosArchivo(ambiente: string): string {
  return `siigo:archivo:${ambiente}`;
}

/** Lo que hace falta saber de una factura para archivarla. */
interface FacturaAArchivar {
  id: string;
  ambiente: string;
  siigoInvoiceId: string | null;
  numero: string | null;
  cufe: string | null;
  estado: string;
  companiaId: number | null;
  document: string | null;
  carpeta: string | null;
}

/**
 * ¿La DIAN la aceptó? (AC2)
 *
 * **Criterio provisional y ÚNICO PUNTO donde cambiarlo.** El historial de estado ante la DIAN es la
 * HU #11330 y todavía no existe; mientras tanto, la prueba disponible es el CUFE: Siigo lo devuelve
 * cuando el documento quedó aceptado, y sin él lo que hay es un comprobante enviado, no aceptado.
 * Es el criterio conservador —no archiva de más—, y como el barrido vuelve a mirar cada ciclo, una
 * factura que se acepte más tarde se archiva sola, sin que nadie intervenga.
 *
 * Cuando llegue la #11330 esta función se reescribe contra el historial y no hay que tocar nada más.
 */
export function facturaAceptadaPorLaDian(f: Pick<FacturaAArchivar, 'estado' | 'cufe'>): boolean {
  return f.estado === 'emitida' && f.cufe !== null && f.cufe.trim() !== '';
}

async function cargarFactura(facturaId: string): Promise<FacturaAArchivar | null> {
  // La compañía sale del trámite que la factura cubre. Con `por_tramite` hay exactamente uno; con
  // la consolidada que la Feature deja preparada serían varios, pero todos del MISMO cliente —es lo
  // que significa consolidar—, así que el primero basta para resolver la carpeta.
  const [fila] = await db.select({
    id: siigoFacturas.id,
    ambiente: siigoFacturas.ambiente,
    siigoInvoiceId: siigoFacturas.siigoInvoiceId,
    numero: siigoFacturas.numero,
    cufe: siigoFacturas.cufe,
    estado: siigoFacturas.estado,
    companiaId: clients.id,
    document: clients.document,
    carpeta: clients.flitoCarpetaStorage,
  }).from(siigoFacturas)
    .leftJoin(
      siigoFacturaTramites,
      and(eq(siigoFacturaTramites.facturaId, siigoFacturas.id), eq(siigoFacturaTramites.activo, true)),
    )
    .leftJoin(flitoTramites, eq(flitoTramites.id, siigoFacturaTramites.tramiteId))
    .leftJoin(clients, eq(clients.id, flitoTramites.companiaId))
    .where(eq(siigoFacturas.id, facturaId))
    .limit(1);

  return fila ?? null;
}

/**
 * Carpeta destino (AC4).
 *
 * `carpetaDe` ya resuelve la carpeta de excepción cuando la compañía no tiene ninguna
 * parametrizada, así que aquí no se inventa nada. El caso extra que sí hay que cubrir es que la
 * factura no llegue a ninguna compañía —un trámite sin empresa vinculada—: se le da al helper una
 * identidad derivada de la propia factura para que el documento acabe en la carpeta de excepción
 * con un nombre que dice de qué es, en vez de en una carpeta llamada `null`.
 */
function carpetaDestino(f: FacturaAArchivar): { carpeta: string; excepcion: boolean } {
  const carpeta = carpetaDe(
    f.companiaId === null
      ? { id: -1, document: `factura-${f.id}`, flitoCarpetaStorage: null }
      : { id: f.companiaId, document: f.document, flitoCarpetaStorage: f.carpeta },
    SUBCARPETA,
  );
  return { carpeta, excepcion: carpeta.startsWith('_sin-carpeta-configurada/') };
}

/**
 * Extrae el contenido binario de lo que responde Siigo.
 *
 * Siigo sirve estos dos documentos como JSON con el archivo en base64 (`{ "base64": "…" }`), que es
 * lo que el cliente HTTP del módulo ya sabe leer. Se aceptan además dos formas más —el campo con
 * otro nombre y el cuerpo como cadena suelta— porque la documentación no fija el contrato del XML,
 * y una respuesta legible que se rechaza por el nombre de un campo es una factura sin soporte.
 *
 * Lo que NO se acepta es una respuesta que no contenga el documento: eso lanza, y el fallo queda en
 * la bitácora. Ver la decisión 4 de la cabecera.
 */
export function contenidoDeRespuesta(datos: unknown, documento: SiigoDocumentoFactura): Buffer {
  const crudo = ((): string | null => {
    if (typeof datos === 'string') return datos;
    if (datos === null || typeof datos !== 'object') return null;
    const obj = datos as Record<string, unknown>;
    for (const clave of ['base64', 'Base64', 'content', 'file', 'xml', 'pdf']) {
      const v = obj[clave];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  })();

  if (crudo === null) {
    throw new SiigoArchivoError('sin_documento_en_siigo',
      `Siigo respondió sin el contenido del ${documento.toUpperCase()} de la factura.`);
  }

  const firma = SIIGO_DOCUMENTO_FACTURA_FIRMA[documento];
  // Puede venir ya en claro (el XML sobre todo) o en base64. Se decide por lo que se ve, no por el
  // nombre del campo: decodificar un XML en claro produce basura binaria que además pasaría el
  // `putObject` sin una queja.
  // El BOM va como escape y no como carácter: literal es un espacio invisible en el código fuente.
  const enClaro = crudo.replace(/^\uFEFF/, '').trimStart().startsWith(firma);
  const buffer = enClaro ? Buffer.from(crudo, 'utf8') : Buffer.from(crudo, 'base64');

  // El BOM de un XML firmado es parte del archivo y no se toca; solo se salta para reconocerlo. En
  // `latin1` esos tres bytes se leen como `ï»¿`.
  const cabecera = buffer.subarray(0, 16).toString('latin1')
    .replace(/^ï»¿/, '').trimStart();
  if (buffer.length === 0 || !cabecera.startsWith(firma)) {
    throw new SiigoArchivoError('sin_documento_en_siigo',
      `Lo que Siigo devolvió como ${documento.toUpperCase()} de la factura no parece ese documento `
      + `(no empieza por «${firma}»), así que no se archiva.`);
  }
  return buffer;
}

/**
 * Descarga un documento de la factura.
 *
 * Gasta cuota de la MISMA ventana que la emisión —`claveResiliencia(ambiente)`—, y es deliberado:
 * Siigo cuenta las 100 peticiones por minuto por empresa, no por flujo. Un limitador propio para el
 * archivo sería contarlas dos veces y superar el tope creyendo respetarlo.
 */
export async function descargarDocumento(
  invoiceId: string, documento: SiigoDocumentoFactura, ambiente: SiigoAmbiente,
): Promise<Buffer> {
  const datos = await ejecutarConResiliencia(
    () => siigoRequestOrThrow<unknown>({
      metodo: 'GET',
      ruta: `/v1/invoices/${encodeURIComponent(invoiceId)}/${documento}`,
      ambiente,
      timeoutMs: TIMEOUT_DESCARGA_DOCUMENTO_MS,
    }),
    {
      clave: claveResiliencia(ambiente),
      claveCortacircuitos: claveCortacircuitosArchivo(ambiente),
    },
  );
  return contenidoDeRespuesta(datos, documento);
}

/** Soporte ya archivado de ese tipo para esa factura, si lo hay. Evita gastar cuota (decisión 1). */
async function soporteExistente(facturaId: string, tipo: string): Promise<string | null> {
  const [fila] = await db.select({ id: flitoSoportes.id }).from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.siigoFacturaId, facturaId),
      eq(flitoSoportes.tipo, tipo),
      eq(flitoSoportes.descartado, false),
    ))
    .limit(1);
  return fila?.id ?? null;
}

/**
 * Duplicado por CONTENIDO (AC3), no por nombre.
 *
 * Es la segunda red, después de la comprobación por (factura, tipo): cubre el caso de un ciclo que
 * llegó a subir el archivo y no alcanzó a registrarlo con el mismo tipo, y es el mismo criterio que
 * `facturaDuplicada` usa en el SOAT desde la HU de conciliación. La tercera y definitiva es el
 * índice único de la migración 0139, que es la única que cierra la carrera entre dos ciclos.
 */
async function soportePorContenido(hash: string, tipo: string): Promise<string | null> {
  const [fila] = await db.select({ id: flitoSoportes.id }).from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.hash, hash),
      eq(flitoSoportes.tipo, tipo),
      eq(flitoSoportes.descartado, false),
    ))
    .limit(1);
  return fila?.id ?? null;
}

/** Violación de unicidad: otro ciclo lo archivó entre nuestro «¿ya está?» y nuestro INSERT. */
function esLlaveDuplicada(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

function nombreArchivo(f: FacturaAArchivar, documento: SiigoDocumentoFactura): string {
  const identificacion = f.numero?.trim() || f.siigoInvoiceId || f.id;
  return `factura-${identificacion}.${documento}`;
}

/** Archiva UN documento. Nunca lanza: devuelve el desenlace para que el otro pueda seguir (AC5). */
async function archivarDocumento(
  f: FacturaAArchivar, documento: SiigoDocumentoFactura, carpeta: string,
): Promise<SiigoArchivoDocumento> {
  const tipo = TIPO_SOPORTE_FACTURA[documento];
  const arranque = Date.now();
  const ruta = `/v1/invoices/${f.siigoInvoiceId ?? ''}/${documento}`;

  const bitacora = (
    resultado: 'ok' | 'error_negocio' | 'error_tecnico', mensaje: string, extra: Record<string, unknown> = {},
  ) => registrarOperacion({
    operacion: 'siigo.factura.archivar',
    metodo: 'GET',
    ruta,
    entidadTipo: 'siigo_factura',
    entidadId: f.id,
    ambiente: f.ambiente,
    modo: modoSiigo(),
    // El documento NO viaja a la bitácora: son cientos de kilobytes por fila en una tabla que
    // prohíbe DELETE. Lo que hace falta para reconstruir qué pasó es el tamaño y la huella.
    responseBody: extra,
    resultado,
    mensaje,
    duracionMs: Date.now() - arranque,
  });

  const yaEstaba = await soporteExistente(f.id, tipo);
  if (yaEstaba !== null) {
    return { documento, desenlace: 'ya_archivado', soporteId: yaEstaba, motivo: null };
  }

  if (f.siigoInvoiceId === null) {
    // Una factura `emitida` sin identificador en Siigo no puede existir —lo impide un CHECK de la
    // migración 0135— pero el tipo lo admite y descargar `/v1/invoices//pdf` sería una petición
    // desperdiciada contra una URL sin sentido.
    const motivo = 'La factura no tiene identificador de Siigo, así que no hay nada que descargar.';
    await bitacora('error_negocio', motivo);
    return { documento, desenlace: 'fallido', soporteId: null, motivo };
  }

  let contenido: Buffer;
  try {
    contenido = await descargarDocumento(f.siigoInvoiceId, documento, f.ambiente as SiigoAmbiente);
  } catch (e) {
    const motivo = e instanceof SiigoArchivoError
      ? e.message
      : `No se pudo descargar el ${documento.toUpperCase()} de la factura: ${motivoLegible(e)}.`;
    await bitacora('error_tecnico', motivo);
    return { documento, desenlace: 'fallido', soporteId: null, motivo };
  }

  const hash = createHash('sha256').update(contenido).digest('hex');
  const porContenido = await soportePorContenido(hash, tipo);
  if (porContenido !== null) {
    await bitacora('ok', `El ${documento.toUpperCase()} ya estaba archivado (mismo contenido).`,
      { bytes: contenido.length, hash });
    return { documento, desenlace: 'ya_archivado', soporteId: porContenido, motivo: null };
  }

  const nombre = nombreArchivo(f, documento);
  try {
    // El objeto se sube ANTES de tocar la base, igual que en la carga de facturas del SOAT: un
    // registro sin archivo es un enlace roto en la pantalla; un archivo sin registro es, como mucho,
    // un objeto de más que el siguiente ciclo reemplaza.
    const storageKey = await uploadEntityDocument(
      carpeta, f.id, nombre, contenido, SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE[documento],
    );

    const [soporte] = await db.insert(flitoSoportes).values({
      tipo,
      nombreArchivo: nombre,
      contentType: SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE[documento],
      storageKey,
      hash,
      tamanoBytes: contenido.length,
      siigoFacturaId: f.id,
      subidoPorNombre: AUTOR_AUTOMATICO,
    }).returning({ id: flitoSoportes.id });

    await bitacora('ok', `${documento.toUpperCase()} de la factura archivado.`,
      { bytes: contenido.length, hash, storageKey });
    return { documento, desenlace: 'archivado', soporteId: soporte?.id ?? null, motivo: null };
  } catch (e) {
    if (esLlaveDuplicada(e)) {
      // Otro ciclo ganó la carrera. No es un fallo: el documento está archivado, que es lo que se
      // quería. Se relee para devolver el soporte que sí quedó.
      const ganador = await soporteExistente(f.id, tipo);
      return { documento, desenlace: 'ya_archivado', soporteId: ganador, motivo: null };
    }
    const motivo = `El ${documento.toUpperCase()} se descargó pero no se pudo archivar.`;
    log.error({ err: e, facturaId: f.id, documento }, 'archivo de documento de factura falló');
    await bitacora('error_tecnico', motivo, { bytes: contenido.length, hash });
    return { documento, desenlace: 'fallido', soporteId: null, motivo };
  }
}

/**
 * Archiva el PDF y el XML de una factura (AC1-AC5).
 *
 * Idempotente: llamarla dos veces no crea soportes de más y, salvo carrera, no gasta cuota la
 * segunda vez. `parcial` y `completa` son estados distintos a propósito — ver la decisión 2.
 */
export async function archivarFactura(facturaId: string): Promise<SiigoArchivoResumen> {
  const f = await cargarFactura(facturaId);
  if (!f) throw new SiigoArchivoError('no_existe', 'La factura no existe.');

  // AC2 — solo se archiva lo que la DIAN aceptó. No se descarga nada y no se marca ningún fallo:
  // no es un error, es que todavía no toca.
  if (!facturaAceptadaPorLaDian(f)) {
    return {
      facturaId: f.id,
      estado: 'pendiente_dian',
      documentos: SIIGO_DOCUMENTOS_FACTURA.map((documento) => ({
        documento, desenlace: 'omitido' as const, soporteId: null, motivo: null,
      })),
      carpetaDeExcepcion: false,
    };
  }

  const { carpeta, excepcion } = carpetaDestino(f);
  if (excepcion) {
    // AC4 — que la compañía no tenga carpeta no puede quedarse solo en la ruta del objeto: se dice.
    log.warn({ facturaId: f.id, companiaId: f.companiaId, carpeta },
      'factura archivada en la carpeta de excepción: la compañía no tiene carpeta parametrizada');
  }

  // En serie y no en paralelo: son dos peticiones a la misma cuota, y el limitador las encolaría de
  // todos modos. En serie el fallo del primero se ve antes de gastar el segundo.
  const documentos: SiigoArchivoDocumento[] = [];
  for (const documento of SIIGO_DOCUMENTOS_FACTURA) {
    documentos.push(await archivarDocumento(f, documento, carpeta));
  }

  const completa = documentos.every((d) => d.desenlace === 'archivado' || d.desenlace === 'ya_archivado');
  return {
    facturaId: f.id,
    estado: completa ? 'completa' : 'parcial',
    documentos,
    carpetaDeExcepcion: excepcion,
  };
}

/**
 * Facturas aceptadas a las que les falta algún documento.
 *
 * El filtro por lo que FALTA va en la consulta y no en el bucle: con el histórico de facturación
 * creciendo, traerse todas las emitidas para descartar las ya archivadas convierte un barrido de
 * cinco filas en una lectura de la tabla entera cada pocos minutos.
 */
async function facturasPendientesDeArchivo(limite: number): Promise<string[]> {
  const falta = (documento: SiigoDocumentoFactura) => sql`NOT EXISTS (
    SELECT 1 FROM ${flitoSoportes}
     WHERE ${flitoSoportes.siigoFacturaId} = ${siigoFacturas.id}
       AND ${flitoSoportes.tipo} = ${TIPO_SOPORTE_FACTURA[documento]}
       AND ${flitoSoportes.descartado} = false
  )`;

  const filas = await db.select({ id: siigoFacturas.id }).from(siigoFacturas)
    .where(and(
      eq(siigoFacturas.estado, 'emitida'),
      isNotNull(siigoFacturas.cufe),
      isNotNull(siigoFacturas.siigoInvoiceId),
      or(...SIIGO_DOCUMENTOS_FACTURA.map(falta)),
    ))
    // Las más antiguas primero: son las que llevan más tiempo sin prueba archivada.
    .orderBy(asc(siigoFacturas.enviadaEn))
    .limit(limite);

  return filas.map((f) => f.id);
}

export interface ResumenCiclo {
  revisadas: number;
  completas: number;
  parciales: number;
}

/**
 * Un ciclo del barrido (AC2, AC5): archiva lo que falte de las facturas ya aceptadas.
 *
 * El tope por ciclo es lo que impide que una puesta en marcha con mil facturas históricas agote la
 * cuota compartida y deje sin emitir al resto del día. Lo que no entre en este ciclo entra en el
 * siguiente: no se pierde nada, solo tarda.
 */
export async function archivarFacturasPendientes(limite = TOPE_POR_CICLO): Promise<ResumenCiclo> {
  const ids = await facturasPendientesDeArchivo(limite);
  const resumen: ResumenCiclo = { revisadas: 0, completas: 0, parciales: 0 };

  for (const id of ids) {
    resumen.revisadas += 1;
    try {
      const r = await archivarFactura(id);
      if (r.estado === 'completa') resumen.completas += 1;
      else if (r.estado === 'parcial') resumen.parciales += 1;
    } catch (e) {
      // Una factura que revienta no puede llevarse por delante a las demás del ciclo.
      resumen.parciales += 1;
      log.error({ err: e, facturaId: id }, 'archivo de factura falló');
    }
  }

  return resumen;
}
