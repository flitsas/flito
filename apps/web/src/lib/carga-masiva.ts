// FLITO — topes, apertura del ZIP y tandas de la carga masiva SOAT / Impuestos
// (HU #12050 / #12051 / #12056).
//
// Un solo sitio para peso, copy de validación, 413/504, la lectura del ZIP y el envío de 5 en 5.
// Los dos modales importan de aquí; no se extrae un modal compartido (Impuestos tiene el checkbox).
//
// Desde la HU #12056 el ZIP se abre AQUÍ, en el navegador, y sus entradas viajan por las mismas
// tandas de 5 que ya existían. Tres cosas que hay que leer juntas:
//
//   · **El sujeto cambia.** Lo que se cuenta, se pesa, se valida y se envía son las ENTRADAS del
//     ZIP, no el ZIP. Por eso los 15 MB por archivo dejan de tumbar un ZIP de 40 MB —que es la
//     suma de todos los comprobantes— y pasan a medirse contra cada comprobante.
//   · **Índice primero, descompresión por tanda.** Al elegir se lee solo el índice (nombre y
//     tamaño descomprimido declarado): con eso ya se cuenta, se valida y se nombran los
//     descartes, sin gastar RAM. Cada entrada se descomprime DENTRO de su tanda (`ItemCarga.abrir`)
//     y se suelta cuando la tanda termina: nunca hay 300 copias en memoria al lado del ZIP.
//   · **El índice es un DICHO, no un hecho.** El tamaño descomprimido lo escribe quien fabrica el
//     ZIP, así que miente si el atacante quiere: con deflate a ~1000:1 un `.zip` de 60 MB puede
//     declarar entradas de 1 KB y traer decenas de GB. El índice sigue sirviendo para contar y
//     validar barato al elegir, pero la descompresión de verdad lleva SU PROPIO presupuesto
//     (`inflarConPresupuesto`) y corta en cuanto se pasa de los 15 MB por archivo. Es el mismo
//     patrón —cabeceras para descartar barato, presupuesto duro para inflar— que `xlsx-zip.ts` en
//     el API; aquí el daño se quedaría en la pestaña del operador, pero es el mismo agujero.
//   · **El criterio de qué se ignora es del API.** Directorios, `__MACOSX/` y todo base que
//     empiece por punto, y el mimetype por extensión, son los MISMOS de `expandir()` en
//     `flito-recibos.service.ts`. Si cambia allá, cambia acá.
//
// Los números viven en `@operaciones/shared-types`. El copy es UX
// (`docs/ux/flito-soat-impuestos-zip-navegador.md`, sobre `…-carga-topes.md` y `…-carga-tandas.md`)
// y no se publica en el paquete: `File` es DOM.

import {
  CARGA_MASIVA_ARCHIVOS_POR_PETICION,
  CARGA_MASIVA_MAX_ARCHIVOS,
  CARGA_MASIVA_MAX_BYTES_ARCHIVO,
  CARGA_MASIVA_MAX_BYTES_CRUDOS,
  CARGA_MASIVA_MAX_BYTES_CUERPO,
  CARGA_MASIVA_MAX_ENTRADAS_ZIP,
  partirCargaMasivaEnTandas,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from './api';

/** Tope por tanda: por debajo del corte del proxy (~120 s). No toca `REQUEST_TIMEOUT_MS` (90 s). */
export const TIMEOUT_TANDA_CARGA_MS = 115_000;

const BYTES_EN_MB = 1024 * 1024;

const COPY_413 =
  'Esta carga pesa más de lo que el servidor admite. Pártala: quite archivos y sube el resto en otra carga.';
const COPY_504 =
  'El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.';
const COPY_HTML = 'No se pudo completar la carga. Vuelve a intentar.';

const mbUnDecimal = (bytes: number): string => (bytes / BYTES_EN_MB).toFixed(1);

const topeMbEntero = (bytes: number): number => bytes / BYTES_EN_MB;

const plural = (n: number, uno: string, varios: string): string => (n === 1 ? uno : varios);

function textoError(e: unknown): string {
  const partes: string[] = [];
  if (e instanceof ApiError) {
    partes.push(e.message);
    if (typeof e.rawDetails === 'string') partes.push(e.rawDetails);
  } else if (e instanceof Error) {
    partes.push(e.message);
  }
  return partes.join(' ');
}

function pareceHtmlProxy(texto: string): boolean {
  const t = texto.toLowerCase();
  return (
    t.includes('<!doctype')
    || t.includes('<html')
    || t.includes('<center')
    || t.includes('request entity too large')
    || t.includes('413 request entity')
    || t.includes('gateway time-out')
    || t.includes('gateway timeout')
  );
}

// ───────────────────────────── Selección: ZIP leído o archivos sueltos ──────────────────────────

/**
 * Un archivo tal como va a viajar.
 *
 * `nombre` es siempre el nombre BASE: es el `originalname` que ve multer, y multer no puede recibir
 * un nombre con «/». La ruta dentro del ZIP viaja aparte, en el campo `rutas` del multipart, que es
 * lo único con lo que el API sigue deduciendo la marca de agua por carpeta.
 *
 * `abrir()` produce el `File`. Para una entrada de ZIP descomprime EN SU TANDA, no al elegir.
 */
export type ItemCarga = {
  nombre: string;
  size: number;
  /** Ruta relativa dentro del ZIP (`SIN MARCA/ABC123.pdf`). Ausente en la selección manual. */
  ruta?: string;
  /** Nombre del ZIP del que salió; los mensajes de tope lo nombran. Ausente en lo suelto. */
  zip?: string;
  abrir: () => Promise<File>;
};

/** Lo que el operador escogió, ya traducido a lo que se va a enviar. */
export type SeleccionCarga = {
  items: ItemCarga[];
  /** Nombres de los ZIP abiertos. Vacío = selección manual. */
  zips: string[];
  /** Nombres base descartados por no ser PDF ni imagen. No incluye carpetas, `__MACOSX/` ni ocultos. */
  descartados: string[];
};

export const SELECCION_CARGA_VACIA: SeleccionCarga = { items: [], zips: [], descartados: [] };

/** `true` en cuanto la selección trae al menos un ZIP: manda otros topes y otro copy. */
export function vieneDeZip(seleccion: SeleccionCarga): boolean {
  return seleccion.zips.length > 0;
}

/** Mismo criterio que `expandir()` del API: por mimetype o por extensión. */
export function esZipCargaMasiva(archivo: File): boolean {
  return archivo.type.includes('zip') || archivo.name.toLowerCase().endsWith('.zip');
}

/**
 * Mimetype por extensión, igual que `expandir()` del API. `null` = tipo no soportado: el API lo
 * dejaría en `application/octet-stream` y el OCR no haría nada con él, así que se descarta antes de
 * gastarle una tanda. Un ZIP dentro del ZIP también cae aquí: no se abre en cascada.
 */
function mimePorExtension(base: string): string | null {
  const lower = base.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (/\.(jpg|jpeg)$/.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return null;
}

/**
 * Ruido del sistema de archivos, con el MISMO criterio del API: directorios, `__MACOSX/` y todo
 * base que empiece por punto. Ni se cuenta, ni se nombra, ni se menciona en los descartes: un ZIP
 * hecho en macOS no tiene por qué verse como un ZIP sucio.
 */
function entradaEsRuido(ruta: string, dir: boolean): boolean {
  if (dir) return true;
  if (ruta.startsWith('__MACOSX/')) return true;
  const base = ruta.split('/').pop() || ruta;
  return base.startsWith('.');
}

/**
 * Tamaño DESCOMPRIMIDO **declarado** en el índice del ZIP. JSZip no lo publica en sus tipos, pero
 * lo lleva en `_data` de toda entrada leída con `loadAsync`; con él se cuenta y se valida sin
 * descomprimir nada. `null` si no está: esa entrada se mide descomprimiéndola (ver `leerZip`).
 *
 * Es lo que el ZIP DICE de sí mismo —JSZip lo copia del directorio central tal cual—, no lo que
 * trae. Sirve para descartar barato y para el contador; NO sirve como permiso para inflar sin
 * mirar. Quien infla pone su propio tope (`inflarConPresupuesto`).
 */
function tamanoDeclarado(entrada: unknown): number | null {
  const datos = (entrada as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof datos?.uncompressedSize === 'number' ? datos.uncompressedSize : null;
}

/**
 * El trozo a trozo de JSZip. `internalStream` existe en `ZipObject` desde siempre (es lo que usan
 * por dentro `async` y `nodeStream`) pero no está en el `index.d.ts` del paquete, igual que
 * `_data`. Se declara aquí el mínimo que se usa, no la API entera.
 */
type StreamEntrada = {
  // `Uint8Array<ArrayBuffer>`, no `Uint8Array` a secas: desde TS 5.7 el tipo es genérico y el de
  // por defecto (`ArrayBufferLike`) admitiría un `SharedArrayBuffer`, que no es `BlobPart`. En el
  // navegador JSZip siempre emite sobre un `ArrayBuffer` normal.
  on(evento: 'data', cb: (trozo: Uint8Array<ArrayBuffer>) => void): StreamEntrada;
  on(evento: 'end', cb: () => void): StreamEntrada;
  on(evento: 'error', cb: (e: Error) => void): StreamEntrada;
  pause(): StreamEntrada;
  resume(): StreamEntrada;
};

/**
 * Descomprime UNA entrada con presupuesto duro y devuelve sus trozos.
 *
 * `entrada.async('blob')` acumula hasta el final y solo entonces JSZip compara con el tamaño
 * declarado («Bug : uncompressed data size mismatch»): para cuando avisa, los bytes ya están en
 * el heap. Medido contra este mismo jszip 3.10.1, una entrada de 400 MB reales que declara 1 KB
 * pasa la validación de la selección, se infla entera —RSS 81 → 497 MB, 1,75 s de event loop
 * bloqueado— y recién ahí falla. Con `internalStream` los trozos llegan incrementalmente: se
 * cuentan y se corta EN EL ACTO, sin esperar a que JSZip note el desajuste.
 *
 * Al cortar se suelta lo acumulado y se pausa el flujo (la pausa sube hasta el `DataWorker`, que
 * deja de programar ticks). Los trozos que pako ya tenga en vuelo dentro del tick en curso se
 * descartan sin acumularse: el pico queda acotado al tope más un tick.
 */
function inflarConPresupuesto(entrada: unknown, tope: number, mensajeAlPasarse: string): Promise<Uint8Array<ArrayBuffer>[]> {
  const stream = (entrada as { internalStream(tipo: 'uint8array'): StreamEntrada }).internalStream('uint8array');
  return new Promise<Uint8Array<ArrayBuffer>[]>((resolve, reject) => {
    const trozos: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    let cerrado = false;
    const fallar = (e: Error): void => {
      cerrado = true;
      trozos.length = 0;
      reject(e);
    };
    stream
      .on('data', (trozo) => {
        if (cerrado) return;
        bytes += trozo.length;
        if (bytes > tope) {
          fallar(new EntradaDesbordadaError(mensajeAlPasarse));
          stream.pause();
          return;
        }
        trozos.push(trozo);
      })
      // Aquí sigue llegando el desajuste que JSZip sí detecta: el de la entrada que miente por
      // debajo del tope. Deja de ser la ÚNICA defensa, no deja de existir.
      .on('error', (e) => { if (!cerrado) fallar(e); })
      .on('end', () => { if (!cerrado) { cerrado = true; resolve(trozos); } })
      .resume();
  });
}

function fraseZipDanado(zip: string): string {
  return `No se pudo abrir «${zip}»: está dañado o no es un ZIP. Vuelve a comprimirlo y elígelo otra vez.`;
}

function fraseZipConClave(zip: string): string {
  return `«${zip}» está protegido con contraseña y FLITO no puede abrirlo. Comprímelo sin contraseña y elígelo otra vez.`;
}

/** Un solo copy para el ZIP vacío y para el ZIP en el que todo era descarte: el operador hace lo mismo. */
function fraseZipSinComprobantes(zip: string): string {
  return `«${zip}» no trae PDF ni imágenes. Revisa el ZIP o elige los archivos sueltos.`;
}

function fraseEntradaIlegible(ruta: string, zip: string): string {
  return `No se pudo leer «${ruta}» dentro de «${zip}». Vuelve a comprimirlo y elígelo otra vez.`;
}

/**
 * La entrada que revienta el presupuesto al descomprimirla. No es «ilegible»: se lee perfectamente,
 * lo que pasa es que trae mucho más de lo que su índice decía. Por eso el copy no manda «volver a
 * intentar» a secas —volvería a pasar lo mismo— sino que nombra el archivo, dice que el ZIP no es
 * de fiar y ofrece la salida que sí funciona.
 *
 * La segunda frase es cierta en los dos casos que llegan aquí: el índice declaró un tamaño pequeño
 * (ZIP hostil) o no declaró ninguno (la rama de `leerZip` que mide descomprimiendo). En ninguno de
 * los dos lo declaraba como algo de más de 15 MB.
 */
function fraseEntradaDesbordada(ruta: string, zip: string): string {
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  return `«${ruta}», dentro de «${zip}», trae más de ${tope} MB descomprimido y el índice del ZIP no lo declaraba así. FLITO paró de descomprimirlo ahí: ese ZIP no es de fiar. Vuelve a comprimirlo y elígelo otra vez, o sube los archivos sueltos.`;
}

/** Error de apertura con copy de producto. El mensaje crudo de JSZip nunca llega a pantalla. */
class ZipIlegibleError extends Error {}

/**
 * Subclase para que `abrir()` distinga «se pasó del presupuesto» de «no se pudo leer» y no lo
 * tape con el copy genérico. Hereda de `ZipIlegibleError` a propósito: así viaja por el mismo
 * camino que el resto del copy de ZIP —el `catch` de `enviarCargaEnTandas` y
 * `mensajeErrorCargaMasiva`— y una entrada que se desborda a mitad de las tandas conserva lo ya
 * cargado, como cualquier otro fallo parcial (AC6).
 */
class EntradaDesbordadaError extends ZipIlegibleError {}

/**
 * Lee el ÍNDICE de un ZIP y devuelve un `ItemCarga` por entrada útil. No descomprime nada: cada
 * `abrir()` descomprime su entrada cuando le toca la tanda y suelta el `Blob` al terminar.
 *
 * El ZIP comprimido sí queda en RAM mientras dura la selección —lo retienen los `abrir()`—, y eso
 * es justamente lo barato: un ZIP de 40 MB en vez de los 118 MB que ocuparían sus 90 comprobantes
 * descomprimidos a la vez.
 */
async function leerZip(zipFile: File): Promise<{ items: ItemCarga[]; descartados: string[] }> {
  const { default: JSZip } = await import('jszip');
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(zipFile);
  } catch (e) {
    const crudo = e instanceof Error ? e.message : '';
    throw new ZipIlegibleError(
      /encrypt|password|contrase/i.test(crudo) ? fraseZipConClave(zipFile.name) : fraseZipDanado(zipFile.name),
    );
  }

  const items: ItemCarga[] = [];
  const descartados: string[] = [];
  for (const entrada of Object.values(zip.files)) {
    if (entradaEsRuido(entrada.name, entrada.dir)) continue;
    const base = entrada.name.split('/').pop() || entrada.name;
    const mime = mimePorExtension(base);
    if (mime === null) { descartados.push(base); continue; }

    const ruta = entrada.name;
    let cache: File | null = null;
    const abrir = async (): Promise<File> => {
      if (cache) return cache;
      try {
        // El tope va sobre los bytes REALES, no sobre los declarados: es lo único que no hereda
        // la mentira del índice. Ver `inflarConPresupuesto`.
        const trozos = await inflarConPresupuesto(
          entrada, CARGA_MASIVA_MAX_BYTES_ARCHIVO, fraseEntradaDesbordada(ruta, zipFile.name),
        );
        return new File(trozos, base, { type: mime });
      } catch (e) {
        // El desbordado ya trae su copy y su porqué; taparlo con «no se pudo leer» dejaría al
        // operador reintentando un ZIP que va a volver a hacer lo mismo.
        if (e instanceof EntradaDesbordadaError) throw e;
        throw new ZipIlegibleError(fraseEntradaIlegible(ruta, zipFile.name));
      }
    };

    let size = tamanoDeclarado(entrada);
    if (size === null) {
      // Sin tamaño en el índice no hay forma de aplicar los 15 MB sin descomprimir: se descomprime
      // esta entrada (y solo esta) y se guarda, para no hacerlo dos veces. Sigue costando lo
      // mismo que antes —solo que ahora acotado—: si esa entrada se pasa del presupuesto, el
      // desbordado sube tal cual y bloquea la selección con su copy, en vez de inflar sin fin.
      cache = await abrir();
      size = cache.size;
    }
    items.push({ nombre: base, size, ruta, zip: zipFile.name, abrir });
  }

  if (items.length === 0) throw new ZipIlegibleError(fraseZipSinComprobantes(zipFile.name));
  return { items, descartados };
}

/**
 * Traduce lo que salió del `<input type="file">` a la lista que se va a enviar: los ZIP se leen
 * aquí y todo lo demás pasa tal cual.
 *
 * `error` es BLOQUEANTE (ZIP dañado, con contraseña o sin comprobantes): la selección vuelve vacía
 * y no sale ninguna tanda, tampoco «lo que sí se pudo». `descartados` no bloquea: es un aviso.
 */
export async function seleccionCargaMasiva(
  archivos: readonly File[],
): Promise<{ seleccion: SeleccionCarga; error: string | null }> {
  const items: ItemCarga[] = [];
  const zips: string[] = [];
  const descartados: string[] = [];

  for (const archivo of archivos) {
    if (!esZipCargaMasiva(archivo)) {
      items.push({ nombre: archivo.name, size: archivo.size, abrir: async () => archivo });
      continue;
    }
    try {
      const leido = await leerZip(archivo);
      zips.push(archivo.name);
      items.push(...leido.items);
      descartados.push(...leido.descartados);
    } catch (e) {
      return {
        seleccion: SELECCION_CARGA_VACIA,
        error: e instanceof ZipIlegibleError ? e.message : fraseZipDanado(archivo.name),
      };
    }
  }

  return { seleccion: { items, zips, descartados }, error: null };
}

const deZip = (item: ItemCarga): boolean => item.zip !== undefined;

// ─────────────────────────────── Peso, contador y línea de descartes ────────────────────────────

/** Suma de bytes crudos de lo que se va a subir (sin empaque multipart). */
export function pesoCargaMasiva(items: readonly ItemCarga[]): number {
  return items.reduce((suma, item) => suma + item.size, 0);
}

/** Peso en pantalla: `12.3 MB` (punto, un decimal), el mismo criterio que `soatCliente`. */
export function formatearPesoCargaMasiva(bytes: number): string {
  return `${mbUnDecimal(bytes)} MB`;
}

/**
 * Contador. Cuenta LO QUE SE VA A SUBIR, no lo que se señaló en el disco: un ZIP de 40 MB con 90
 * comprobantes dice «90 archivos … 118.4 MB», no «1 archivo … 40.0 MB». Denominador = techo nginx
 * (250 MB), no el corte de envío (200 MB).
 */
export function textoContadorCargaMasiva(seleccion: SeleccionCarga): string {
  const total = seleccion.items.length;
  const entradas = seleccion.items.filter(deZip).length;
  const peso = `${formatearPesoCargaMasiva(pesoCargaMasiva(seleccion.items))} de ${topeMbEntero(CARGA_MASIVA_MAX_BYTES_CUERPO)} MB`;

  if (seleccion.zips.length === 0) return `${total} ${plural(total, 'archivo', 'archivos')} · ${peso}`;
  if (seleccion.zips.length === 1) {
    return entradas === total
      ? `${total} ${plural(total, 'archivo', 'archivos')} de «${seleccion.zips[0]}» · ${peso}`
      : `${total} ${plural(total, 'archivo', 'archivos')} (${entradas} de «${seleccion.zips[0]}») · ${peso}`;
  }
  return `${total} ${plural(total, 'archivo', 'archivos')} (${entradas} de ${seleccion.zips.length} ZIP) · ${peso}`;
}

/** Hasta tres, y «y k más», el patrón que ya usaba `fraseVariosArchivosGrandes`. */
function hastaTres(textos: readonly string[]): string {
  const mostrados = textos.slice(0, 3).join(', ');
  const resto = textos.length - 3;
  return resto > 0 ? `${mostrados} y ${resto} más` : mostrados;
}

const conPeso = (nombre: string, size: number): string => `«${nombre}» (${mbUnDecimal(size)} MB)`;

/**
 * Lo que el ZIP traía y NO se va a enviar. Muted, no rojo: nada está mal, la carga sí sale.
 * `null` si no se descartó nada — un ZIP de macOS con 90 PDF no dice nada de descartes.
 */
export function textoDescartadosZip(seleccion: SeleccionCarga): string | null {
  const m = seleccion.descartados.length;
  if (m === 0) return null;
  const origen = seleccion.zips.length > 1 ? 'De los ZIP' : 'Del ZIP';
  const verbo = m === 1 ? 'se ignoró 1 archivo que no es' : `se ignoraron ${m} archivos que no son`;
  return `${origen} ${verbo} PDF ni imagen: ${hastaTres(seleccion.descartados.map((n) => `«${n}»`))}.`;
}

/** `Abriendo «x.zip»…` / `Abriendo 2 ZIP…`. `null` si no hay ZIP en lo que se acaba de elegir. */
export function textoAbriendoZip(nombres: readonly string[]): string | null {
  if (nombres.length === 0) return null;
  return nombres.length === 1 ? `Abriendo «${nombres[0]}»…` : `Abriendo ${nombres.length} ZIP…`;
}

/**
 * `enviando 46 de 90 archivos`. `desde` es el primer archivo de la tanda en curso.
 * `null` con una sola tanda: misma regla que el `tanda k de n` que esto sustituye (HU #12051),
 * que no se pintaba cuando no había nada que seguir. Sin «tanda», sin «%», sin `46/90`.
 */
export function textoProgresoCarga(desde: number, total: number): string | null {
  if (total <= CARGA_MASIVA_ARCHIVOS_POR_PETICION) return null;
  return `enviando ${desde} de ${total} archivos`;
}

// ───────────────────────────────────────── Validación ───────────────────────────────────────────

function fraseCantidad(n: number): string {
  const exceso = n - CARGA_MASIVA_MAX_ARCHIVOS;
  return `Seleccionaste ${n} archivos y el máximo son ${CARGA_MASIVA_MAX_ARCHIVOS} (${exceso} de más). Quite archivos.`;
}

function fraseEntradasZip(entradas: number, zips: readonly string[]): string {
  const exceso = entradas - CARGA_MASIVA_MAX_ENTRADAS_ZIP;
  return zips.length === 1
    ? `«${zips[0]}» trae ${entradas} archivos y el máximo son ${CARGA_MASIVA_MAX_ENTRADAS_ZIP} (${exceso} de más). Divide el ZIP en partes y sube una por una.`
    : `Los ZIP traen ${entradas} archivos y el máximo son ${CARGA_MASIVA_MAX_ENTRADAS_ZIP} (${exceso} de más). Sube menos ZIP a la vez o divídelos.`;
}

function fraseUnArchivoGrande(item: ItemCarga): string {
  const x = mbUnDecimal(item.size);
  const exceso = mbUnDecimal(item.size - CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  return `«${item.nombre}» pesa ${x} MB y el máximo por archivo son ${tope} MB (${exceso} MB de más). Quite ese archivo o súbelo aparte.`;
}

function fraseVariosArchivosGrandes(items: readonly ItemCarga[]): string {
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  const mostrados = hastaTres(items.map((i) => conPeso(i.nombre, i.size)));
  return `${items.length} archivos pesan más de ${tope} MB: ${mostrados}. El máximo por archivo son ${tope} MB. Quítalos o súbelos aparte.`;
}

/**
 * Una entrada del ZIP que no cabe. Se nombra por su RUTA interna, que es lo que deja encontrarla, y
 * el remedio dice la verdad: desde el modal no se puede quitar, y «súbelo aparte» sería mentira
 * porque suelto tampoco cabría. No se salta la entrada para subir el resto: un comprobante que se
 * cae en silencio es peor que una carga que no sale.
 */
function fraseUnaEntradaGrande(item: ItemCarga): string {
  const x = mbUnDecimal(item.size);
  const exceso = mbUnDecimal(item.size - CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  return `«${item.ruta}», dentro de «${item.zip}», pesa ${x} MB y el máximo por archivo son ${tope} MB (${exceso} MB de más). Desde aquí no se puede quitar: sácalo del ZIP, vuelve a comprimir y elige el ZIP otra vez.`;
}

function fraseVariasEntradasGrandes(items: readonly ItemCarga[]): string {
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  const mostrados = hastaTres(items.map((i) => conPeso(i.ruta ?? i.nombre, i.size)));
  return `${items.length} archivos del ZIP pesan más de ${tope} MB: ${mostrados}. El máximo por archivo son ${tope} MB. Desde aquí no se pueden quitar: sácalos del ZIP, vuelve a comprimir y elige el ZIP otra vez.`;
}

function frasePesoEnvio(peso: number): string {
  const x = mbUnDecimal(peso);
  const exceso = mbUnDecimal(peso - CARGA_MASIVA_MAX_BYTES_CRUDOS);
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_CRUDOS);
  return `Esta carga pesa ${x} MB y el máximo de un envío son ${tope} MB (${exceso} MB de más). Quite archivos.`;
}

/**
 * Cortes en el cliente, **antes** de armar el FormData. `null` si cabe (también si no hay nada).
 * Si fallan varios topes, las frases van en este orden: cantidad de sueltos (50) → entradas del ZIP
 * (300) → sueltos > 15 MB → entradas > 15 MB → peso.
 *
 * Los dos techos de cantidad son distintos A PROPÓSITO y su remedio también: 50 es lo que se señala
 * a mano («quite archivos»), 300 es lo que trae un ZIP («divide el ZIP»).
 *
 * El presupuesto de peso (200 MB) se aplica **solo a la selección manual**. Con ZIP ninguna
 * petición pasa de 5 × 15 = 75 MB, así que ese número dejó de ser la pared de nginx y pasó a ser
 * un presupuesto heredado de cuando todo iba en una sola petición: mantenerlo sobre un ZIP
 * bloquearía 300 recibos de 1 MB con un «quite archivos» que es justo el trabajo que esta HU vino
 * a quitar. Ver el comentario de cabecera de `@operaciones/shared-types/carga-masiva`.
 */
export function validarCargaMasiva(seleccion: SeleccionCarga): string | null {
  const frases: string[] = [];
  const sueltos = seleccion.items.filter((item) => !deZip(item));
  const entradas = seleccion.items.filter(deZip);

  if (sueltos.length > CARGA_MASIVA_MAX_ARCHIVOS) frases.push(fraseCantidad(sueltos.length));
  if (entradas.length > CARGA_MASIVA_MAX_ENTRADAS_ZIP) frases.push(fraseEntradasZip(entradas.length, seleccion.zips));

  const gordo = (item: ItemCarga): boolean => item.size > CARGA_MASIVA_MAX_BYTES_ARCHIVO;
  const sueltosGordos = sueltos.filter(gordo);
  if (sueltosGordos.length === 1) frases.push(fraseUnArchivoGrande(sueltosGordos[0]));
  else if (sueltosGordos.length > 1) frases.push(fraseVariosArchivosGrandes(sueltosGordos));

  const entradasGordas = entradas.filter(gordo);
  if (entradasGordas.length === 1) frases.push(fraseUnaEntradaGrande(entradasGordas[0]));
  else if (entradasGordas.length > 1) frases.push(fraseVariasEntradasGrandes(entradasGordas));

  const peso = pesoCargaMasiva(seleccion.items);
  if (!vieneDeZip(seleccion) && peso > CARGA_MASIVA_MAX_BYTES_CRUDOS) frases.push(frasePesoEnvio(peso));

  return frases.length === 0 ? null : frases.join(' ');
}

// ────────────────────────────────────── Envío en tandas ──────────────────────────────────────────

/**
 * Solo para el `catch` de `CargaMasiva` / `CargaRecibos`. No toca `statusToMessage` de `api.ts`.
 */
export function mensajeErrorCargaMasiva(e: unknown): string {
  const status = e instanceof ApiError ? e.status : undefined;
  const texto = textoError(e);

  if (status === 413 || /request entity too large/i.test(texto)) return COPY_413;
  if (status === 504 || status === 502 || /gateway time-?out/i.test(texto)) return COPY_504;
  if (pareceHtmlProxy(texto)) return COPY_HTML;
  if (e instanceof ZipIlegibleError) return e.message;
  return errorMessage(e);
}

/**
 * Concatena, por clave, los arreglos de dos DTO de OCR. Las claves que no son arreglo
 * se quedan con el valor de `a`.
 */
export function fusionarResultadoCarga<T extends object>(a: T, b: T): T {
  const fusionado = { ...a };
  for (const clave of Object.keys(b) as Array<keyof T & string>) {
    const der = b[clave];
    if (!Array.isArray(der)) continue;
    const izq = fusionado[clave];
    (fusionado as Record<string, unknown>)[clave] = Array.isArray(izq) ? izq.concat(der) : der.slice();
  }
  return fusionado;
}

export type ResultadoTandasCarga<T> = { resultado: T | null; error: string | null };

/**
 * Envía el lote en tandas de 5, una POST a la vez (`for` + `await`).
 * Si la tanda k falla, `resultado` es la fusión de 1..k-1 y no reenvía esa tanda.
 * `campos` (p. ej. `sinMarcaDeAgua`) viaja igual en cada tanda. `onProgreso` recibe el PRIMER
 * archivo de la tanda en curso y el total de archivos: la unidad que trajo el operador son
 * archivos, no tandas.
 *
 * Cuando los ítems traen `ruta` —salieron de un ZIP leído aquí— cada tanda lleva además un campo
 * `rutas` por archivo, EN EL MISMO ORDEN Y CON LA MISMA CARDINALIDAD que `archivos`. Es lo único
 * con lo que el API puede seguir deduciendo la marca de agua por carpeta: el `originalname` ya no
 * trae carpeta. Y es un contrato que hay que respetar mirando: un desajuste de cardinalidad NO da
 * error —el API descarta la lista entera, responde 200 y archiva todo con el defecto del
 * checkbox—, así que la única defensa es que esta función empareje bien.
 *
 * **Un archivo SUELTO manda cadena vacía, nunca su nombre.** En una selección mixta la tanda lleva
 * entradas de ZIP y sueltos a la vez, y omitir el valor del suelto rompería la cardinalidad. Pero
 * mandar su nombre sería peor que no mandar nada: `esSinMarcaDeAgua` lo pasaría por sus regex y un
 * archivo llamado `pagado.pdf` se archivaría CON marca de agua aunque el operador hubiera marcado
 * «Archivos sueltos sin marca de agua». Sería una regresión muda —cambia dónde queda el
 * comprobante, responde 200 y el operador ve que todo salió bien— contra el AC3: el checkbox es el
 * defecto de lo que NO trae carpeta, y un suelto no trae carpeta. Con `''` ninguna regex casa y el
 * API cae al defecto, que es exactamente lo que hacía antes de esta HU.
 *
 * `opciones.conRutas: false` lo apaga para quien no lo usa: SOAT no lee `req.body` y el campo solo
 * sería peso muerto en cada tanda.
 */
export async function enviarCargaEnTandas<T extends object>(
  path: string,
  items: readonly ItemCarga[],
  onProgreso: (desde: number, total: number) => void,
  campos?: Record<string, string>,
  opciones?: { conRutas?: boolean },
): Promise<ResultadoTandasCarga<T>> {
  const conRutas = (opciones?.conRutas ?? true) && items.some((item) => item.ruta !== undefined);
  const tandas = partirCargaMasivaEnTandas(items);
  let acc: T | null = null;
  let enviados = 0;

  for (const tanda of tandas) {
    onProgreso(enviados + 1, items.length);
    try {
      const form = new FormData();
      // Un `append` por archivo y, pegado, su ruta: la cardinalidad sale de recorrer la MISMA
      // lista una sola vez. Las entradas se descomprimen aquí, no al elegir, y se sueltan al
      // salir de la tanda.
      for (const item of tanda) {
        form.append('archivos', await item.abrir());
        // El suelto va con `''`: ocupa su sitio en la lista sin decirle nada al API sobre la marca.
        if (conRutas) form.append('rutas', item.ruta ?? '');
      }
      if (campos) {
        for (const [clave, valor] of Object.entries(campos)) form.append(clave, valor);
      }
      const r = await api.postConTimeout<T>(path, form, TIMEOUT_TANDA_CARGA_MS);
      acc = acc === null ? r : fusionarResultadoCarga(acc, r);
    } catch (e) {
      return { resultado: acc, error: mensajeErrorCargaMasiva(e) };
    }
    enviados += tanda.length;
  }

  return { resultado: acc, error: null };
}
