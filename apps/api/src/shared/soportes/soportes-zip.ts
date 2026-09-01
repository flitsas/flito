// FLITO — el ZIP de soportes de las tres superficies (Feature #11908, HU #11910).
//
// Tres pantallas —SOAT, Impuestos y Gestión de trámites— marcan registros y se llevan sus
// documentos en un solo archivo. Lo que cambia entre ellas es QUIÉN entra, QUÉ ids son y QUÉ tipos
// se pueden pedir; eso vive en cada módulo y no aquí. Lo que NO puede cambiar es cómo se resuelven
// las entradas, cómo se nombran, cómo se desempatan y cuándo se decide que no hay nada que entregar:
// tres copias de eso divergen en el primer cambio y el síntoma sería que el mismo botón produce
// nombres distintos según la pantalla.
//
// ── El orden es el contrato, y es lo que corrige el molde heredado ───────────────────────────────
//
// El zip anterior (`POST /flito/impuestos/facturas-venta/zip`, retirado por esta HU) escribía las
// cabeceras y hacía `pipe(res)` ANTES del bucle. Consecuencia: el archivo empezaba a salir sin saber
// si iba a contener algo, y una selección sin soportes producía un ZIP VÁLIDO Y VACÍO de 22 bytes
// que el usuario abre y no entiende. Aquí el orden está invertido y no es una preferencia de estilo:
//
//   1. resolver las entradas (consultas por LOTE, ninguna por id)
//   2. si no hay ninguna → 409 (AC6). Si la suma de bytes se pasa → 422
//   3. rastro PII + bitácora
//   4. recién entonces cabeceras, `archiver` y `pipe`
//
// `resolverEntradasZip()` o devuelve entradas o lanza; quien escriba una ruta no puede invertirlo
// aunque quiera, porque `emitirZipSoportes()` necesita una lista que solo existe si el paso 2 pasó.
//
// ── Lo que NO vive aquí ──────────────────────────────────────────────────────────────────────────
//
// La FRONTERA. Cada módulo entrega una lista de registros YA AUTORIZADA (`RegistroZip[]`) porque las
// tres fronteras son distintas —proveedor, organismo, nada— y reimplementarlas fuera de
// `condicionesCola` / `condicionesColaImpuestos` es la vía por la que un gestor acaba descargando lo
// de otro. Este archivo no sabe quién pidió el ZIP y no recibe `req`.

import archiver from 'archiver';
import rateLimit from 'express-rate-limit';
import { Readable } from 'node:stream';
import type { Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import {
  CABECERAS_ZIP_SOPORTES, CODIGO_ZIP_DEMASIADO_GRANDE, CODIGO_ZIP_DEMASIADOS_REGISTROS,
  CODIGO_ZIP_SIN_SOPORTES, ORDEN_TIPOS_SOPORTE_ZIP, TipoSoporte, TipoSoporteZip,
  ZIP_SOPORTES_MAX_REGISTROS,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSoportes } from '../../db/schema.js';
import { env } from '../../config/env.js';
// **Se IMPORTA y no se modifica.** `organismoParaExport` alimenta la columna `ORGANISMO DE TRANSITO`
// del `.xlsx` de la HU #11909 —el eslabón anterior de esta misma cadena—, así que ponerle allí el
// `toUpperCase()` que el AC5 pide aquí cambiaría el contenido de aquel archivo: regresión sobre una
// HU ya cerrada. Lo que hace falta para el nombre se compone ENCIMA, en `normalizar()`.
import { organismoParaExport } from '../export/cola-flito-excel.js';
import { loggerFor } from '../logger.js';
import { logPiiAccess } from '../pii-audit.js';
import { makeStore, userOrIpKey } from '../middleware/rateLimiter.js';
import { getEntityDocumentStream } from '../../services/storage.js';
import { getFlitAdapter } from '../../modules/flito-sync/flit.adapter.js';
import { TZ_COLOMBIA } from '../utils/fecha-rango.js';

const log = loggerFor('soportes-zip');

/**
 * Cuántos registros admite UNA petición de ZIP.
 *
 * No es el presupuesto —ese va en bytes, `FLITO_ZIP_SOPORTES_MAX_BYTES`— sino la forma del cuerpo:
 * un array sin cota se convierte en un `IN (…)` sin cota. El 422 por bytes decide si el lote CABE;
 * esto decide si la petición es razonable antes de tocar la base.
 *
 * El número vive en shared-types desde que la pantalla tiene que poder avisar antes de mandar nada;
 * aquí se reexporta con el nombre corto que ya usan las tres rutas.
 */
export const TOPE_IDS_ZIP = ZIP_SOPORTES_MAX_REGISTROS;

/**
 * Un registro YA AUTORIZADO por su módulo, con lo que hace falta para nombrar y para anclar.
 *
 * `placa` y los dos campos del organismo son lo que construye el nombre del AC5. Las tres anclas son
 * lo que dice DÓNDE están sus documentos; lo que venga en `null` simplemente no aporta entradas, y
 * eso es correcto y silencioso: el ZIP no responde por id (ver `resolverEntradasZip`).
 */
export interface RegistroZip {
  /** El id de la superficie (SOAT, impuesto o trámite). Ordena y desempata; no se publica. */
  registroId: string;
  placa: string | null;
  organismoAlias: string | null;
  organismoCodigo: string | null;
  /** Para el orden determinista entre registros. */
  createdAt: Date;
  /** Ancla de `factura_soat` (`flito_soportes.soat_id`). */
  soatId?: string | null;
  /** Ancla del recibo (`flito_soportes.impuesto_id`). */
  impuestoId?: string | null;
  /** Ancla de la factura de venta de FLIT (`flito_tramites.factura_venta_flit_id`, S3 de FLIT). */
  facturaVentaFlitId?: string | null;
}

/**
 * Todo desenlace del ZIP que la PANTALLA tiene que saber distinguir.
 *
 * Existe la clase base por un motivo concreto y ya vivido en este archivo: los tres códigos se
 * mapean a HTTP en el `catch` de CADA una de las tres rutas, y con `instanceof` uno por uno, añadir
 * un cuarto obligaba a acordarse en tres sitios. La consecuencia de olvidarse en uno no es un 500:
 * es que ese error cae en la rama genérica, sale SIN `codigo`, y la pantalla enseña «no se pudo
 * generar el archivo, avisa a soporte». Eso ya pasó —es el defecto que trae el tope de registros a
 * esta ronda—, y con un solo `instanceof ZipError` no puede volver a pasar.
 *
 * `status` y `codigo` son del error y no de la ruta: el mismo desenlace no puede ser 409 en SOAT y
 * 422 en Impuestos.
 */
export abstract class ZipError extends Error {
  abstract readonly codigo: string;
  abstract readonly status: number;
}

/**
 * Ninguno de los registros marcados tiene el tipo pedido (AC6).
 *
 * **409 y no 200 con un ZIP vacío**, que es lo que hacía el molde: un archivo válido de 22 bytes no
 * es una respuesta, es un usuario abriendo una carpeta vacía sin saber por qué. Y **no dice cuántos
 * quedaron fuera ni por qué**: publicar «3 de 40 no eran tuyos» convertiría el ZIP en un oráculo de
 * pertenencia. El mensaje es el mismo tanto si el registro no existe, como si no es de este actor,
 * como si simplemente no tiene ese documento.
 */
export class ZipSinSoportesError extends ZipError {
  readonly codigo = CODIGO_ZIP_SIN_SOPORTES;
  readonly status = 409;

  constructor() {
    super('Ninguno de los registros seleccionados tiene el documento que pediste. '
      + 'Revisa la selección o el tipo de documento y vuelve a intentarlo.');
    this.name = 'ZipSinSoportesError';
  }
}

/**
 * La suma de bytes del lote se pasa del presupuesto. Es el error **POR PESO**.
 *
 * Mismo gesto que `ExportColaDemasiadoGrandeError`: 422 porque la petición está bien formada y el
 * filtro es legítimo —lo que no cabe es el RESULTADO—, y el mensaje dice el TOPE y no cuánto pesaba
 * la selección, que sería un contador de bytes por filtro.
 *
 * ⚠️ **Distinto de {@link ZipDemasiadosRegistrosError}, y el mensaje lo dice.** Aquí el usuario puede
 * tener marcadas tres filas y chocar igual porque sus documentos son enormes; la salida es quitar
 * esos, no «marcar menos». Decirle «marca menos registros» sería mandarle a probar a ciegas.
 */
export class ZipDemasiadoGrandeError extends ZipError {
  readonly codigo = CODIGO_ZIP_DEMASIADO_GRANDE;
  readonly status = 422;

  constructor(topeBytes: number) {
    super(`Los documentos seleccionados pesan más de los ${Math.floor(topeBytes / 1024 / 1024)} MB `
      + 'que admite una descarga. Quita de la selección los registros con documentos más pesados '
      + 'y vuelve a intentarlo.');
    this.name = 'ZipDemasiadoGrandeError';
  }
}

/**
 * Se marcaron más registros de los que admite una petición. Es el error **POR CANTIDAD**.
 *
 * ── Por qué 400 y no 422 ─────────────────────────────────────────────────────────────────────────
 *
 * El 422 de arriba dice «tu petición es legítima y el resultado no cabe». Este dice «esta petición
 * no se debe intentar», que es el mismo criterio con el que `TOPE_LOTE_CERTIFICACION` eligió su 400.
 * La diferencia importa: el 422 se descubre después de consultar la base, y este se decide antes de
 * tocarla.
 *
 * ── Por qué no basta con el `.max()` de Zod ──────────────────────────────────────────────────────
 *
 * Porque un 400 de Zod sale sin `codigo` y la pantalla no puede distinguirlo de «el cuerpo está mal
 * formado»: el usuario que marca 120 filas —lo más fácil de hacer sin querer en una tabla con
 * «seleccionar todo»— recibía «no se pudo generar el archivo, avisa a soporte». El tope se
 * comprueba a mano justo después del parseo para poder responder con código y con el número dentro.
 *
 * El TOPE viaja en el mensaje para que el cliente lo haga eco sin estar compilado contra la misma
 * versión de shared-types. Lo que NO viaja es cuántos mandó: eso ya lo sabe él.
 */
export class ZipDemasiadosRegistrosError extends ZipError {
  readonly codigo = CODIGO_ZIP_DEMASIADOS_REGISTROS;
  readonly status = 400;

  constructor(tope: number) {
    super(`Solo se pueden descargar los documentos de ${tope} registros a la vez. `
      + 'Marca menos filas y vuelve a intentarlo.');
    this.name = 'ZipDemasiadosRegistrosError';
  }
}

/**
 * El tope de registros, comprobado en un solo sitio para las tres rutas.
 *
 * Se llama desde la ruta y no desde `resolverEntradasZip` a propósito: tiene que decidir **antes de
 * la consulta de frontera**, que es la primera que toca la base. Metido dentro del resolutor, un
 * lote de 100 000 ids ya habría emitido su `IN (…)`.
 */
export function comprobarTopeRegistrosZip(ids: readonly unknown[]): void {
  if (ids.length > TOPE_IDS_ZIP) throw new ZipDemasiadosRegistrosError(TOPE_IDS_ZIP);
}

/** Un documento listo para entrar en el archivo, con su nombre ya desempatado. */
export interface EntradaZip {
  /**
   * `PLACA-ORGANISMO`, ya con el sufijo `-2`/`-3` si hubo colisión. **Sin extensión**: la de la
   * factura de FLIT no se sabe hasta abrir la respuesta, y el desempate no puede depender de eso.
   */
  nombreBase: string;
  tipo: TipoSoporteZip;
  /**
   * De QUÉ registro marcado salió este documento.
   *
   * No se publica en el archivo: sirve para contar cuántos de los marcados aportaron algo, que es la
   * cifra honesta del aviso parcial. Contar documentos daría «6 de 5» en el ZIP mixto de Trámites,
   * donde un trámite aporta hasta tres (ver `CABECERAS_ZIP_SOPORTES`).
   */
  registroId: string;
  /** Lo que se presupuestó para este documento. Ver `FLITO_ZIP_FACTURA_CUPO_BYTES` para la factura. */
  bytes: number;
  /** Abre el contenido EN STREAMING. No se llama hasta que le toca su turno en el archivo. */
  abrir: () => Promise<{ stream: Readable; extension: string }>;
}

// ── El nombre (AC5) ──────────────────────────────────────────────────────────────────────────────

/**
 * Mayúsculas, sin tildes y sin nada que no sea A-Z0-9.
 *
 * El `normalize('NFD')` + el rango de diacríticos combinantes es el mismo gesto de
 * `certificacion-runt.ts:normalizarTexto`, y aquí hace falta por dos motivos distintos: `Medellín`
 * tiene que dar `MEDELLIN` (AC5, y una tilde dentro del nombre de una entrada de ZIP se ve distinta
 * según quién lo descomprima) y el resultado va a un nombre de fichero, así que los separadores de
 * ruta, las comillas y los saltos de línea no pueden sobrevivir.
 */
function normalizar(valor: string): string {
  return valor
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * `PLACA-ORGANISMO` (AC5), sin extensión.
 *
 * Sin alias y sin código el organismo es `SIN-ORGANISMO`, **nunca `null` ni la cadena `"null"`**:
 * `null` reventaría el nombre de la entrada y `"null"` produciría un fichero llamado `ABC123-NULL`
 * que parece un dato. Lo mismo con la placa: si un registro no la tiene, `SIN-PLACA` — el documento
 * SALE igual, porque un soporte que existe no puede desaparecer del archivo porque le falte un campo
 * al vehículo.
 */
export function nombrePlacaOrganismo(
  placa: string | null, organismoAlias: string | null, organismoCodigo: string | null,
): string {
  const p = normalizar(placa ?? '') || 'SIN-PLACA';
  const o = normalizar(organismoParaExport(organismoAlias, organismoCodigo) ?? '') || 'SIN-ORGANISMO';
  return `${p}-${o}`;
}

// ── La extensión ─────────────────────────────────────────────────────────────────────────────────

/** Extensión por MIME, para el soporte cuyo `nombre_archivo` llegó sin ella. */
const EXTENSION_POR_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

/** La extensión de un soporte de MinIO: la de su nombre, o la que se deduzca de su content-type. */
function extensionDeSoporte(nombreArchivo: string, contentType: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(nombreArchivo.trim());
  if (m) return m[1]!.toLowerCase();
  return EXTENSION_POR_MIME[contentType.toLowerCase()] ?? 'bin';
}

/**
 * Qué es realmente un fichero, mirando sus primeros bytes.
 *
 * Vive aquí —y no en el router de Impuestos, de donde viene— porque ahora lo usan los DOS caminos de
 * la factura de venta de FLIT: la descarga individual (que bufferiza) y el ZIP (que va en
 * streaming). Se mira el contenido y no la cabecera del origen porque S3 rotula todo como
 * octet-stream. El default es PDF: es lo que FLIT emite, y ante la duda vale más un `.pdf` que un
 * archivo sin extensión que no abre con doble clic.
 */
export function tipoPorBytes(buf: Buffer): { contentType: string; extension: string } {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf', extension: 'pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  return { contentType: 'application/pdf', extension: 'pdf' };
}

/**
 * El primer trozo de un stream, DEVUELTO AL STREAM (`unshift`) para poder mirarlo sin consumirlo.
 *
 * Es lo que permite seguir decidiendo la extensión por los bytes —como hace la descarga individual—
 * sin volver a hacer `arrayBuffer()`, que traería el archivo entero al heap y anularía el motivo de
 * pasar a streaming. Un stream que termina sin datos devuelve `null` y la extensión cae al default.
 */
function asomarse(s: Readable): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const limpiar = (): void => {
      s.off('readable', enReadable); s.off('end', enEnd); s.off('error', enError);
    };
    const enReadable = (): void => {
      const c = s.read() as Buffer | null;
      if (c === null) return; // aún no hay bytes; 'readable' vuelve a saltar
      limpiar(); s.unshift(c); resolve(c);
    };
    const enEnd = (): void => { limpiar(); resolve(null); };
    const enError = (e: unknown): void => { limpiar(); reject(e); };
    s.on('readable', enReadable); s.on('end', enEnd); s.on('error', enError);
  });
}

// ── Resolución de las entradas ───────────────────────────────────────────────────────────────────

/**
 * Los tipos de `flito_soportes` que resuelven cada tipo del catálogo del ZIP.
 *
 * `RECIBO_IMPUESTO` mapea a DOS y el orden importa: **solo el limpio**
 * (`recibo_impuesto_sin_marca_agua`, que es con el que se concilia) y, si ese impuesto no lo tiene,
 * el marcado. **Nunca los dos**: son el mismo pago y el ZIP los llamaría igual, así que el archivo
 * traería dos copias del mismo recibo con sufijos `-2` que el AC5 no reserva para eso.
 *
 * `FACTURA_VENTA` no está: no vive en `flito_soportes`.
 */
const TIPOS_BD_POR_TIPO_ZIP: Record<string, readonly string[]> = {
  [TipoSoporteZip.RECIBO_IMPUESTO]: [
    TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, TipoSoporte.RECIBO_IMPUESTO,
  ],
  [TipoSoporteZip.FACTURA_SOAT]: [TipoSoporte.FACTURA_SOAT],
};

/** Una fila de `flito_soportes` proyectada a lo que el ZIP necesita. */
interface SoporteZip {
  id: string;
  ancla: string;
  tipo: string;
  nombreArchivo: string;
  contentType: string;
  storageKey: string;
  tamanoBytes: number;
  subidoEn: Date;
}

/**
 * Los soportes de un LOTE de anclas, en UNA consulta.
 *
 * `inArray` y no una consulta por id: el zip anterior llamaba a `buscarConAcceso` id a id (N×2
 * consultas para 100 ids), y en el ZIP mixto de Trámites eso serían tres rondas de cien.
 *
 * El recorte por `tipo` va **en la consulta** y no en un filtro posterior, por lo mismo que
 * `soportes-consulta.ts`: no se lee lo que no se va a devolver. Es además lo que sostiene el AC2 de
 * forma comprobable —un `where tipo = 'factura_soat'` no puede traer un `comprobante_pse`— sin
 * añadir un filtro defensivo redundante: el CHECK `flito_soportes_factura_excluyente_chk` ya obliga
 * a que un soporte con `conciliacion_boleta_id` tenga `soat_id` NULL, así que el PSE tampoco entra
 * por el ancla.
 */
async function soportesDeLote(
  columna: typeof flitoSoportes.soatId | typeof flitoSoportes.impuestoId,
  anclas: string[],
  tiposBd: readonly string[],
): Promise<SoporteZip[]> {
  if (anclas.length === 0) return [];
  const filas = await db.select({
    id: flitoSoportes.id,
    ancla: columna,
    tipo: flitoSoportes.tipo,
    nombreArchivo: flitoSoportes.nombreArchivo,
    contentType: flitoSoportes.contentType,
    storageKey: flitoSoportes.storageKey,
    tamanoBytes: flitoSoportes.tamanoBytes,
    subidoEn: flitoSoportes.subidoEn,
  }).from(flitoSoportes).where(and(
    inArray(columna, anclas),
    inArray(flitoSoportes.tipo, [...tiposBd]),
    // Un soporte descartado en la cola de revisión no es evidencia de nada.
    eq(flitoSoportes.descartado, false),
  ));
  return filas as SoporteZip[];
}

/**
 * Dentro de un registro y un tipo, el orden es `subido_en ASC, id ASC`.
 *
 * **El `id` no es adorno.** `subido_en` empata de verdad: la carga masiva de recibos inserta varios
 * en la misma transacción y `defaultNow()` les da el mismo instante. Sin el segundo criterio, quién
 * se lleva el nombre limpio y quién el `-2` lo decidiría PostgreSQL, y dos descargas del mismo lote
 * podrían repartirlo al revés.
 */
function ordenarSoportes(a: SoporteZip, b: SoporteZip): number {
  return (a.subidoEn.getTime() - b.subidoEn.getTime()) || a.id.localeCompare(b.id);
}

/**
 * Las entradas del ZIP, o el 409/422. **No entrega nunca una lista vacía.**
 *
 * ── El orden de iteración es de SERVIDOR, no el del array que mandó la pantalla ───────────────────
 *
 * Los ids llegan en el orden en que el usuario fue haciendo clic. Iterar por ahí haría que el mismo
 * lote, marcado en otro orden, repartiera los sufijos `-2`/`-3` de otra manera —dos ZIP distintos
 * del mismo contenido—. El orden es: registro por `createdAt ASC, registroId ASC`; dentro de un
 * registro, tipo por {@link ORDEN_TIPOS_SOPORTE_ZIP}; dentro de un tipo, `subido_en ASC, id ASC`.
 *
 * ── Las colisiones son el caso NORMAL, no el raro ────────────────────────────────────────────────
 *
 * Todas las entradas de un registro se llaman `PLACA-ORGANISMO`, así que en el ZIP mixto de Trámites
 * (factura + recibo + comprobante del mismo trámite) se llega a `-3` sin que pase nada anormal. Y
 * `flito_soportes` solo tiene índice único de `factura_venta` sobre `soat_id`: dos `factura_soat`
 * vivos del mismo SOAT son posibles y colisionan igual.
 *
 * @throws ZipSinSoportesError  ninguno de los registros tiene el tipo pedido (AC6).
 * @throws ZipDemasiadoGrandeError  la suma de bytes se pasa del presupuesto.
 */
export async function resolverEntradasZip(
  registros: RegistroZip[],
  tipos: readonly TipoSoporteZip[],
): Promise<EntradaZip[]> {
  const pedidos = ORDEN_TIPOS_SOPORTE_ZIP.filter((t) => tipos.includes(t));

  const ordenados = [...registros].sort(
    (a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.registroId.localeCompare(b.registroId),
  );

  // Un ancla puede repetirse entre registros (varios trámites comparten un SOAT por VIN), así que
  // se deduplica antes del `IN`.
  const anclas = (leer: (r: RegistroZip) => string | null | undefined): string[] =>
    [...new Set(ordenados.map(leer).filter((v): v is string => !!v))];

  const quiereRecibo = pedidos.includes(TipoSoporteZip.RECIBO_IMPUESTO);
  const quiereSoat = pedidos.includes(TipoSoporteZip.FACTURA_SOAT);

  const [recibos, comprobantes] = await Promise.all([
    quiereRecibo
      ? soportesDeLote(flitoSoportes.impuestoId, anclas((r) => r.impuestoId),
        TIPOS_BD_POR_TIPO_ZIP[TipoSoporteZip.RECIBO_IMPUESTO]!)
      : Promise.resolve([] as SoporteZip[]),
    quiereSoat
      ? soportesDeLote(flitoSoportes.soatId, anclas((r) => r.soatId),
        TIPOS_BD_POR_TIPO_ZIP[TipoSoporteZip.FACTURA_SOAT]!)
      : Promise.resolve([] as SoporteZip[]),
  ]);

  const porAncla = (filas: SoporteZip[]): Map<string, SoporteZip[]> => {
    const m = new Map<string, SoporteZip[]>();
    for (const f of filas) {
      const arr = m.get(f.ancla) ?? [];
      arr.push(f); m.set(f.ancla, arr);
    }
    return m;
  };
  const recibosPorImpuesto = porAncla(recibos);
  const comprobantesPorSoat = porAncla(comprobantes);

  /**
   * El recibo de UN impuesto: los `sin_marca_agua` si los hay, y si no, los marcados.
   *
   * La caída se decide POR IMPUESTO y no para el lote entero: un lote donde la mitad tiene el limpio
   * y la otra mitad solo el marcado tiene que entregar el mejor de cada uno.
   */
  const recibosDe = (impuestoId: string): SoporteZip[] => {
    const todos = recibosPorImpuesto.get(impuestoId) ?? [];
    const limpios = todos.filter((s) => s.tipo === TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA);
    return (limpios.length > 0 ? limpios : todos).sort(ordenarSoportes);
  };

  const cupoFactura = env.FLITO_ZIP_FACTURA_CUPO_BYTES;
  const entradas: EntradaZip[] = [];
  const vistos = new Map<string, number>();

  /** Aplica el desempate `-2`, `-3`… sobre el nombre base y registra la ocurrencia. */
  const nombrar = (base: string): string => {
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  for (const reg of ordenados) {
    const base = nombrePlacaOrganismo(reg.placa, reg.organismoAlias, reg.organismoCodigo);

    for (const tipo of pedidos) {
      if (tipo === TipoSoporteZip.FACTURA_VENTA) {
        if (!reg.facturaVentaFlitId) continue;
        const facturaId = reg.facturaVentaFlitId;
        entradas.push({
          nombreBase: nombrar(base),
          tipo,
          registroId: reg.registroId,
          // Cupo declarado: el tamaño real de la factura de FLIT no se conoce sin ir a buscarla, y
          // para cuando llega el 422 ya no se podría emitir (ver `FLITO_ZIP_FACTURA_CUPO_BYTES`).
          bytes: cupoFactura,
          abrir: () => abrirFacturaFlit(facturaId),
        });
        continue;
      }

      const soportes = tipo === TipoSoporteZip.RECIBO_IMPUESTO
        ? (reg.impuestoId ? recibosDe(reg.impuestoId) : [])
        : (reg.soatId ? [...(comprobantesPorSoat.get(reg.soatId) ?? [])].sort(ordenarSoportes) : []);

      for (const s of soportes) {
        entradas.push({
          nombreBase: nombrar(base),
          tipo,
          registroId: reg.registroId,
          bytes: Number(s.tamanoBytes) || 0,
          abrir: async () => ({
            stream: await getEntityDocumentStream(s.storageKey) as unknown as Readable,
            extension: extensionDeSoporte(s.nombreArchivo, s.contentType),
          }),
        });
      }
    }
  }

  // AC6: el 409 se decide AQUÍ, con la respuesta todavía sin empezar.
  if (entradas.length === 0) throw new ZipSinSoportesError();

  const topeBytes = env.FLITO_ZIP_SOPORTES_MAX_BYTES;
  const total = entradas.reduce((t, e) => t + e.bytes, 0);
  if (total > topeBytes) throw new ZipDemasiadoGrandeError(topeBytes);

  return entradas;
}

/**
 * La factura de venta de FLIT, EN STREAMING.
 *
 * Antes se hacía `arrayBuffer()` y se metía un `Buffer` en el archivo, o sea el fichero entero en el
 * heap por cada factura del lote. `Readable.fromWeb` la pasa por la misma vía que los soportes de
 * MinIO; la extensión se sigue decidiendo por los bytes, pero mirando solo el primer trozo
 * (`asomarse`) en vez de traerlo todo.
 */
async function abrirFacturaFlit(facturaId: string): Promise<{ stream: Readable; extension: string }> {
  const url = await getFlitAdapter().obtenerUrlFactura(facturaId);
  if (!url) throw new Error('La factura de venta no está disponible en FLIT');
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`FLIT respondió ${r.status} al pedir la factura de venta`);
  const stream = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
  const cabeza = await asomarse(stream);
  return { stream, extension: tipoPorBytes(cabeza ?? Buffer.alloc(0)).extension };
}

// ── El archivo ───────────────────────────────────────────────────────────────────────────────────

const FORMATO_SELLO = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_COLOMBIA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * `soportes_YYYYMMDD-HHmm.zip`, en hora de Colombia.
 *
 * **El nombre EXTERNO no lleva la placa**, y es deliberado: es la misma razón por la que el `.xlsx`
 * de la HU #11909 tampoco lleva nada del filtro. El nombre de un fichero descargado acaba en el
 * sistema de archivos de quien descarga, en el historial del navegador y en cualquier adjunto que
 * reenvíe. La placa va DENTRO, en los nombres de las entradas, que es exactamente lo que pide el AC5.
 */
export function nombreArchivoZipSoportes(ahora: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_SELLO.formatToParts(ahora)) p[parte.type] = parte.value;
  return `soportes_${p.year}${p.month}${p.day}-${p.hour}${p.minute}.zip`;
}

/**
 * Añade UNA entrada y espera a que el archivador la haya consumido.
 *
 * `archive.append()` **encola**: devuelve al momento y el trabajo se hace después. El bucle del zip
 * anterior parecía ir a un archivo por vuelta, pero solo se pacía porque esperaba a la red en cada
 * iteración —efecto colateral, no backpressure—. Con los soportes de MinIO abriéndose en microsegundos
 * ese freno desaparece y las 300 entradas del ZIP mixto se encolarían de golpe. Esperar el evento
 * `entry` mantiene exactamente una entrada en vuelo.
 */
function anexar(archive: archiver.Archiver, stream: Readable, name: string): Promise<void> {
  const consumida = new Promise<void>((resolve, reject) => {
    const limpiar = (): void => { archive.off('entry', ok); archive.off('error', fallo); };
    const ok = (): void => { limpiar(); resolve(); };
    const fallo = (e: unknown): void => { limpiar(); reject(e); };
    archive.once('entry', ok);
    archive.once('error', fallo);
  });
  archive.append(stream, { name });
  return consumida;
}

/**
 * Escribe el ZIP en la respuesta. **Solo se llama con entradas ya resueltas** (ver la cabecera).
 *
 * Un documento que falle al abrirse se omite y **se registra en el log**: el molde heredado tenía un
 * `catch {}` mudo, así que un soporte que no llegaba desaparecía del archivo sin dejar rastro en
 * ninguna parte y nadie podía saber por qué el ZIP traía nueve de diez.
 *
 * @returns cuántas entradas entraron DE VERDAD.
 */
export async function emitirZipSoportes(
  res: Response, entradas: EntradaZip[], ahora: Date = new Date(),
): Promise<number> {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoZipSoportes(ahora)}"`);

  // ── Las cifras del aviso parcial ───────────────────────────────────────────────────────────────
  //
  // «Marqué 5 y solo 2 tenían soporte» se descarga y SE AVISA CON CIFRAS. El cuerpo es el archivo,
  // así que la cabecera es el único sitio donde caben. **Poder ponerlas aquí es consecuencia directa
  // del orden invertido del AC6**: `entradas` ya está resuelto antes del primer byte, así que no hay
  // que adivinar nada ni usar trailers.
  //
  // Van las DOS porque no significan lo mismo y la pantalla necesita la segunda: `incluidos` cuenta
  // DOCUMENTOS y `registros` cuenta REGISTROS que aportaron al menos uno. Componer «2 de las 5 que
  // marcaste» con la primera daría «6 de 5» en el ZIP mixto de Trámites, donde un trámite aporta
  // hasta tres documentos — una cifra falsa con aspecto de cierta.
  //
  // Ninguna dice POR QUÉ los otros no aportaron: no existe, no es de este actor y no tiene ese
  // documento son el mismo silencio, igual que en el 409 (ver `ZipSinSoportesError`).
  res.setHeader(CABECERAS_ZIP_SOPORTES.incluidos, String(entradas.length));
  res.setHeader(CABECERAS_ZIP_SOPORTES.registros, String(new Set(entradas.map((e) => e.registroId)).size));

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (e) => {
    log.error({ err: (e as Error).message }, 'fallo del archivador; se corta la respuesta a medias');
    try { res.destroy(); } catch { /* ya cerrado */ }
  });
  archive.pipe(res);

  let incluidas = 0;
  for (const e of entradas) {
    try {
      const { stream, extension } = await e.abrir();
      await anexar(archive, stream, `${e.nombreBase}.${extension}`);
      incluidas += 1;
    } catch (err) {
      // Sin la placa ni el nombre de la entrada: este log no es sitio para un dato personal.
      log.error({ err: (err as Error).message, tipo: e.tipo }, 'documento omitido del zip');
    }
  }

  await archive.finalize();
  return incluidas;
}

/**
 * La cuota del ZIP de soportes: 5 por minuto y usuario, en UNA bolsa para las TRES rutas.
 *
 * ── Por qué es propia y NO `exportColaLimiter` ───────────────────────────────────────────────────
 *
 * Aquella raciona heap: `sendExcel` construye el workbook ENTERO en memoria y ADR-0004 midió que
 * cinco exports simultáneos suman +239 MB de los 262 que hay hasta el `max_memory_restart`. Esto
 * raciona otra cosa: I/O de MinIO y de FLIT más compresión síncrona en el mismo hilo, con los
 * archivos pasando en streaming y sin quedarse en el heap. Meterlas en la misma bolsa haría que
 * descargar comprobantes consumiera el presupuesto de un recurso que este endpoint no toca —y al
 * revés—, y ninguna de las dos mediciones diría ya nada sobre la otra.
 *
 * Hasta esta HU el zip de facturas no tenía limitador NINGUNO, así que esto no relaja nada.
 *
 * ── Por qué es UNA INSTANCIA y no tres `rateLimit()` con la misma llave ──────────────────────────
 *
 * Es el mismo hecho que corrigió el eslabón anterior: `makeStore` devuelve `undefined` cuando no hay
 * Redis (desarrollo, CI, tests) y entonces `express-rate-limit` crea un `MemoryStore` **por
 * llamada**. Tres llamadas con el mismo `keyGenerator` compartirían el nombre de la llave y NO el
 * contador: el código se leería idéntico y el freno valdría el triple. Por eso se construye aquí una
 * vez y los tres routers importan el MISMO objeto.
 *
 * `userOrIpKey` y no la IP pelada: varios usuarios de Operaciones salen por la misma IP corporativa.
 */
export const zipSoportesLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-soportes-zip'),
  message: { error: 'Demasiadas descargas seguidas, espera 1 minuto' },
  store: makeStore('rl:flito-soportes-zip:'),
});

/**
 * Campos personales que el ZIP entrega, con el nombre que tienen en la BASE (Ley 1581 art. 17).
 *
 * Es una lista CORTA a propósito y describe lo que este archivo publica: la PLACA viaja en el nombre
 * de cada entrada, y el contenido de los documentos lleva el nombre y el documento del titular
 * —están impresos en el recibo del organismo y en la factura—. No están `correo`, `celular` ni
 * `direccion`: eso es del `.xlsx`, no de aquí, y declarar de más hace que `campos_accedidos` deje de
 * decir la verdad, que es lo único que ese registro tiene que hacer.
 */
export const CAMPOS_PII_ZIP_SOPORTES = ['placa', 'nombre_completo', 'numero_documento'] as const;

/**
 * Deja constancia del ZIP de **Gestión de trámites** (Ley 1581 art. 17).
 *
 * SOAT e Impuestos registran cada uno con el suyo (`flito-soat.pii.ts`, `flito-impuestos.pii.ts`,
 * que dejó listos la HU #11909). Trámites no tiene módulo de PII propio y **no se le inventa uno
 * entero para una línea**; tampoco se le hace pasar por los de las otras dos colas, que escribirían
 * un `resource_tipo` que no es el suyo —o dos filas para una sola lectura—.
 *
 * `flito_tramite` es el MISMO literal con el que `audit()` anota las escrituras de ese router, que es
 * lo que permite cruzar las dos tablas. Y `accion: 'export'` y no `search`: los agregados de
 * `/api/privacy/pii-access/stats` distinguen «alguien miró una pantalla» de «alguien se llevó
 * archivos fuera del perímetro», y esto es lo segundo.
 *
 * `resourceId` va en `null` por lo mismo que en los otros dos módulos: la columna es `integer` y los
 * ids de FLITO son uuid. No se ponen los ids en el motivo —son hasta cien— ni la placa, que es justo
 * uno de los campos que este registro protege.
 */
export async function registrarAccesoZipTramites(
  req: import('express').Request, entradas: number,
): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: 'flito_tramite',
    resourceId: null,
    accion: 'export',
    camposAccedidos: [...CAMPOS_PII_ZIP_SOPORTES],
    motivo: `Lectura de trámites — archivo=zip_soportes · filas=${entradas}`,
  });
}
