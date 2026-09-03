// FLITO — topes de la carga masiva de facturas SOAT y recibos de impuestos (HU #12050 / #12051).
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

/** Tope del picker / lote completo. El tope HTTP por petición es `CARGA_MASIVA_ARCHIVOS_POR_PETICION`. */
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
