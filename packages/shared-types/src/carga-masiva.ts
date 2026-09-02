// FLITO — topes de la carga masiva de facturas SOAT y recibos de impuestos (HU #12050).
//
// Viven aquí y no en cada módulo porque los leen tres sitios que tienen que decir el mismo número:
//
//   · multer en `flito-soat.routes` y `flito-impuestos.routes` (`limits.fileSize` / `limits.files`);
//   · nginx del contenedor web (`client_max_body_size` = `CARGA_MASIVA_MAX_BYTES_CUERPO`);
//   · el cliente de tandas (HU #12051), que aún no consume `CARGA_MASIVA_ARCHIVOS_POR_PETICION`.
//
// Los valores de archivo (50 × 15 MB) no cambian en esta HU: solo dejan de estar copiados a mano.
// El cuerpo HTTP (250 MB) y el presupuesto de bytes crudos (200 MB) son el techo real del lote;
// 50 × 15 MB = 750 MB es el producto teórico de multer, no lo que nginx deja pasar.

/** Tope de archivos que multer acepta en una sola petición (`limits.files` + `upload.array`). */
export const CARGA_MASIVA_MAX_ARCHIVOS = 50;

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
 * Archivos por petición del cliente de tandas (HU #12051). Se exporta ya para no partir el contrato;
 * esta HU no lo usa en el send.
 */
export const CARGA_MASIVA_ARCHIVOS_POR_PETICION = 5;

/**
 * Tope de tiempo del CLIENTE para la carga masiva (`postConTimeout` en las dos pantallas).
 *
 * No es un tope de tamaño como los de arriba: mide cuánto tarda el TRABAJO. `cargarFacturasMasivo`
 * procesa los comprobantes EN SERIE, con una llamada al motor de OCR de ~3,4 s por cada uno (medido
 * en producción el 2026-09-02), así que una tanda llena ronda los tres minutos. Con el tope
 * compartido de `api.ts` (90 s) el navegador abortaba y nginx registraba un 499 mientras el
 * servidor seguía trabajando.
 *
 * **Acoplado a la infraestructura**, y por eso vive junto a los demás topes: este valor debe quedar
 * por debajo de `TIMEOUT_MAX_MS` de `apps/web/src/lib/api.ts` (600 s), que a su vez debe quedar por
 * debajo del `proxy_read_timeout` de `apps/web/nginx.conf.template` (900 s). Si nginx corta primero,
 * el cliente recibe un 504 en vez de su propio abort. Mover uno obliga a revisar los tres.
 *
 * Si algún día el OCR se procesa en paralelo, este valor puede bajar.
 */
export const CARGA_MASIVA_OCR_TIMEOUT_MS = 300_000;
