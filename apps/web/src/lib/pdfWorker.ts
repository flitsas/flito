// HU #11775 — el worker de pdf.js sale del bundler, no de una copia a mano en `public/`.
//
// ── Qué se rompía ─────────────────────────────────────────────────────────────────────────────
//
// Hasta esta HU, `apps/web/public/pdf.worker.min.js` era una copia manual de 1.087.212 bytes
// versionada en git, sacada de pdfjs-dist 3.11.174, y los cinco visores la referenciaban por la
// cadena literal `'/pdf.worker.min.js'`. Que esa copia coincidiera con `node_modules` era
// COINCIDENCIA: ningún script, gate ni paso de build lo garantizaba.
//
// pdf.js valida el handshake API↔worker en runtime (`Setting up fake worker failed` / «The API
// version does not match the Worker version») y lanza si las versiones no casan. Como la referencia
// era una cadena, subir `pdfjs-dist` sin acordarse de recopiar el fichero a `public/` compilaba,
// pasaba lint y pasaba el CI entero — y degradaba los cuatro visores a «No se pudo abrir el
// documento» en el navegador del usuario. El fallo no tenía ningún guardián estático.
//
// ── Por qué `?url` y no `new URL(..., import.meta.url)` ───────────────────────────────────────
//
// Medido, no supuesto: con el especificador roto a propósito, `vite build` con
// `new URL(spec, import.meta.url)` sale **exit 0** (sólo un `warnOnce`) y deja el string crudo en el
// bundle → el fallo reaparece en el navegador, que es justo lo que esta HU viene a cerrar. Con el
// sufijo `?url` sale **exit 1** por `handleInvalidResolvedId` de Rollup: el build se niega a emitir
// un worker que no existe. Esa diferencia es la red que protegerá a la HU #11289 cuando el salto a
// pdfjs v6 renombre `pdf.worker.min.js` → `pdf.worker.min.mjs`.
//
// Efecto colateral buscado: Vite emite el worker como asset CON HASH DE CONTENIDO, así que un
// cambio de versión cambia el nombre del fichero y ninguna caché (navegador, CDN o el service
// worker de `public/sw.js`) puede servir el worker viejo contra la API nueva.
//
// ── Cómo se sube la versión de pdfjs a partir de ahora ────────────────────────────────────────
//
// `npm i pdfjs-dist@<nueva>` y nada más: el worker emitido sale siempre del mismo `node_modules` que
// la API, por construcción. No hay fichero que recopiar. (Si el major renombra la extensión, el
// build falla en rojo aquí mismo — que es el comportamiento correcto.)
//
// Este módulo es el ÚNICO sitio del front autorizado a nombrar el fichero del worker; lo vigila
// `npm run check:pdf-worker`.

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

/** URL del worker de pdf.js emitida por el bundler, con hash de contenido, desde `node_modules`. */
export const PDF_WORKER_SRC = workerUrl;
