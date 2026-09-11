// FLITO — topes de la carga masiva de facturas SOAT y recibos de impuestos
// (HU #12050 / #12051 / #12056).
//
// Viven aquí y no en cada módulo porque los leen tres sitios que tienen que decir el mismo número:
//
//   · multer en `flito-soat.routes` y `flito-impuestos.routes` (`limits.fileSize` /
//     `CARGA_MASIVA_ARCHIVOS_POR_PETICION` en `limits.files` y `upload.array`);
//   · nginx del contenedor web (`client_max_body_size` = `CARGA_MASIVA_MAX_BYTES_CUERPO`);
//   · el cliente de tandas (HU #12051), que parte el lote con `partirCargaMasivaEnTandas`.
//
// Los valores de archivo (50 × 15 MB) no cambian: el 50 es el techo del picker; el HTTP por
// petición es 5. El cuerpo HTTP (250 MB) y el presupuesto de bytes crudos (200 MB) son el techo
// real del lote; 50 × 15 MB = 750 MB es el producto teórico, no lo que nginx deja pasar.
//
// Desde la HU #12056 el navegador ABRE el ZIP y manda sus entradas por esas mismas tandas de 5, así
// que hay DOS cantidades distintas a propósito y ninguna sustituye a la otra:
//
//   · `CARGA_MASIVA_MAX_ARCHIVOS` (50) — lo que el operador escoge a mano en el picker;
//   · `CARGA_MASIVA_MAX_ENTRADAS_ZIP` (300) — lo que puede traer DENTRO un ZIP.
//
// El 300 es más alto porque el ZIP ya no viaja en una sola petición: sus entradas se reparten en
// tandas de 5 y cada una tiene su propio presupuesto de tiempo (`TIMEOUT_TANDA_CARGA_MS`).
//
// Y por el mismo motivo `CARGA_MASIVA_MAX_BYTES_CRUDOS` (200 MB) NO se aplica a lo que viene de un
// ZIP. No es una inconsistencia que haya que «arreglar»: ese presupuesto es de cuando el lote
// entero iba en un solo POST y había que caber en el cuerpo de nginx. Con tandas, ninguna petición
// pasa de 5 × 15 = 75 MB, así que la pared ya no existe; mantenerlo sobre un ZIP bloquearía 300
// recibos de 1 MB con un «quite archivos» que es exactamente el trabajo que la HU #12056 vino a
// quitar. La selección MANUAL sí lo conserva sin cambio, igual que conserva su techo de 50: en los
// dos casos el sujeto que se mide es otro. Un ZIP se limita por sus 300 entradas y por los 15 MB de
// CADA entrada extraída (nunca por el peso del `.zip`, que es la suma de todos los comprobantes).
//
// Los 15 MB por archivo, en cambio, sí valen para todo: suelto o entrada de ZIP, es lo que multer
// acepta por archivo.

/** Tope del picker / lote completo. El tope HTTP por petición es `CARGA_MASIVA_ARCHIVOS_POR_PETICION`. */
export const CARGA_MASIVA_MAX_ARCHIVOS = 50;

/**
 * Tope de entradas útiles DENTRO de un ZIP que el navegador abre (HU #12056). Distinto —y mayor—
 * que `CARGA_MASIVA_MAX_ARCHIVOS` porque el ZIP se envía en tandas de
 * `CARGA_MASIVA_ARCHIVOS_POR_PETICION`, no en una sola petición.
 */
export const CARGA_MASIVA_MAX_ENTRADAS_ZIP = 300;

/** Tope por archivo que multer acepta (`limits.fileSize`). 15 MiB. */
export const CARGA_MASIVA_MAX_BYTES_ARCHIVO = 15 * 1024 * 1024;

/**
 * Tope del cuerpo HTTP de la carga masiva. Mismo número que `client_max_body_size 250m`
 * en `apps/web/nginx.conf.template` y en el reverse-proxy del HOST.
 */
export const CARGA_MASIVA_MAX_BYTES_CUERPO = 250 * 1024 * 1024;

/** Presupuesto de bytes crudos del lote (antes de tandas). 200 MiB. */
export const CARGA_MASIVA_MAX_BYTES_CRUDOS = 200 * 1024 * 1024;

/**
 * Archivos por petición del cliente de tandas (HU #12051). Lo leen multer
 * (`limits.files` + `upload.array`) y `partirCargaMasivaEnTandas`.
 */
export const CARGA_MASIVA_ARCHIVOS_POR_PETICION = 5;

/**
 * Tope de tiempo del CLIENTE para un POST de carga masiva (llegó en develop con HU #12050).
 * La HU #12051 parte de a 5 y usa `TIMEOUT_TANDA_CARGA_MS` (115 s) por tanda; este 300 s
 * queda como techo documentado frente a `TIMEOUT_MAX_MS` / nginx.
 */
export const CARGA_MASIVA_OCR_TIMEOUT_MS = 300_000;

/**
 * Parte `items` en tandas de `size` (por defecto 5), en el mismo orden.
 * 12 → [5, 5, 2]; 7 → [5, 2]; 5 → una tanda; 0 → [].
 */
export function partirCargaMasivaEnTandas<T>(
  items: readonly T[],
  size: number = CARGA_MASIVA_ARCHIVOS_POR_PETICION,
): T[][] {
  const paso = size > 0 ? size : CARGA_MASIVA_ARCHIVOS_POR_PETICION;
  const tandas: T[][] = [];
  for (let i = 0; i < items.length; i += paso) {
    tandas.push(items.slice(i, i + paso));
  }
  return tandas;
}
