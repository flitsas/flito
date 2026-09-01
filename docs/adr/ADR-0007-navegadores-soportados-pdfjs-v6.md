# ADR-0007 — Navegadores soportados por FLITO: la matriz que el salto a pdf.js v6 obliga a fijar

## Estado

**Aprobado** — 2026-08-25. Aprobador: **David Chica**. HU [#11289](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11289) («Visor PDF – Actualizar pdfjs-dist a v6»), Feature #11274.

Este ADR existe porque el AC1 de esa HU lo exige literalmente: *«Given la matriz de navegadores soportados con VERSIONES, no familias / When se consulta la documentacion del repositorio / Then existe el registro fechado de la decision y su aprobador»*. Antes de hoy no existía: `grep` sobre `docs/` y sobre los `package.json` no devuelve ninguna matriz ni ningún campo `browserslist`.

## Decisión

| Navegador | Versión mínima soportada |
|---|---|
| Chrome / Edge | **126** |
| Safari (macOS / iOS) | **18** |
| Firefox | **126** |

Por debajo de esos números, **el visor de documentos de FLITO no funciona**. El resto de la aplicación no se ha medido contra esa frontera y no se declara aquí.

## Contexto: por qué hay que decidirlo, y por qué ahora

`pdfjs-dist` está en 3.11.174. La v6 es el fix upstream de `GHSA-wgrm-67xf-hhpq` (CVE-2024-4367, CVSS 8.8), hoy **mitigado por configuración** con `isEvalSupported: false` en las 5 llamadas a `getDocument` y **exento** en `scripts/dependency-audit-exemptions.mjs`. Retirar esa exención es el cierre real de la HU #11289.

El obstáculo nunca fue el código. La única ruptura de tipos es `canvasContext` → `canvas` en los 5 puntos de `render`. Lo que bloquea es que **v6 sube el suelo de navegador**, y eso deja gente fuera sin aviso.

### Corrección de la premisa que traía la HU

La HU #11289 afirmaba que la API que sube el mínimo es `AbortSignal.any()` y fijaba **Chrome 125**. Verificado contra el tarball real de `pdfjs-dist@6.2.108` descargado de npm el 2026-08-25, **ambos datos son imprecisos**:

| API usada **sin** feature-detect | usos en `pdf.mjs` | usos en `pdf.worker.mjs` | Chrome | Safari | Firefox |
|---|---|---|---|---|---|
| `AbortSignal.any` | 4 | 0 | 116 | 17.4 | 124 |
| `Promise.withResolvers` | 27 | 13 | 119 | 17.4 | 121 |
| **`URL.parse`** | **8** | **3** | **126** | **18** | **126** |

> **Corrección del recuento (2026-08-25, misma jornada).** La primera versión de esta tabla decía
> **8** usos de `AbortSignal.any` en `pdf.mjs`. Son **4**. El 8 salía de contar sobre *todos* los
> `.mjs` de `build/` — 4 en `pdf.mjs` y 4 en `pdf.min.mjs`, que es el mismo código minificado — y
> se atribuyó por error a un solo fichero. Las demás filas sí se midieron fichero a fichero y están
> bien. **La conclusión no cambia**, porque `AbortSignal.any` nunca fue la API que ata.

La que ata es **`URL.parse`**, no `AbortSignal.any` — que es tres años más vieja. Y el mínimo de Chrome es **126, no 125**.

`URL.parse` se usa directamente en `createValidAbsoluteUrl` (la validación de URLs de anotaciones y enlaces) y en `updateUrlHash`, **y también dentro del worker**. No hay guard: `grep` de `URL.parse ?` / `typeof URL.parse` / `URL.parse &&` sobre `pdf.mjs` devuelve **0 coincidencias**. En un navegador sin esa API, abrir un PDF con enlaces lanza `TypeError`.

El paquete no declara la restricción: su `engines` es `{ node: '>=22.13.0 || >=24' }` y no trae `browserslist`. Es decir, **el suelo no está documentado por upstream**: hay que leerlo del código, que es lo que se hizo.

### Por qué el que duele es Safari

Chrome, Edge y Firefox se autoactualizan: exigir 126 es, en la práctica, exigir «no llevar dos años sin abrir el navegador». **Safari solo sube con el sistema operativo.** Safari 18 significa **macOS 15 Sequoia** o **iOS 18**, así que un usuario con un equipo que no admite esa versión de macOS —o que no puede actualizar— pierde el visor. No hay transpilado ni build *legacy* que lo salve: `URL.parse`, `Promise.withResolvers` y `AbortSignal.any` son APIs de runtime, no sintaxis.

## Consecuencias

**Se acepta** que los usuarios por debajo de la matriz pierdan el visor de documentos. La contrapartida es retirar una exención de seguridad **high** que hoy se sostiene sobre una mitigación por configuración, no sobre el fix upstream.

**Lo que este ADR no resuelve:** nadie ha medido el parque real de navegadores de los usuarios de FLITO. Se sabe qué familias usa el equipo —Chrome, Edge, Safari, Brave, Firefox— pero no las versiones, y no hay analítica en el repositorio que lo diga. La decisión se toma **sin ese dato**, asumiendo el riesgo conscientemente. Si aparece telemetría que muestre un porcentaje relevante bajo Safari 18, este ADR debe revisarse antes de que el salto llegue a producción.

**Degradación sin aviso.** Hoy un navegador por debajo del suelo no recibe ningún mensaje: el visor simplemente falla. Dar un aviso explícito («tu navegador no soporta el visor de documentos, actualiza a…») **no** entra en la HU #11289 y queda como trabajo separado. Conviene decirlo porque un fallo silencioso es peor que uno explicado.

## Precondición técnica heredada de la HU #11775

`apps/web/Dockerfile` corre sobre `nginx:1.27-alpine`, cuyo `mime.types` **no incluye `mjs`**. Con v6 el worker se emite como `/assets/pdf.worker.min-<hash>.mjs` y pdf.js v6 lo instancia como **módulo** (`new Worker(workerSrc, { type: "module" })`), donde el navegador aplica MIME checking estricto. Servido como `application/octet-stream`, **queda bloqueado**.

**La E2E no lo vería:** `visor-pdf-real.spec.ts` corre contra el dev server de Vite, que sirve el MIME correcto. Es decir, este fallo llegaría a producción con el CI entero en verde — exactamente la clase de fallo que la cadena #11774 → #11775 → #11289 vino a cerrar.

Mitigación obligatoria dentro de la #11289, en `apps/web/nginx.conf.template`. **La forma importa, y la obvia rompe la aplicación entera:**

```nginx
location /assets/ {
    include /etc/nginx/mime.types;   # <- NO es decorativo
    types { text/javascript mjs; }
    ...
}
```

`types` **no se fusiona** con el nivel superior: lo **reemplaza** («inherited from the previous level if and only if there are no types directives defined on the current level»). Un `types { text/javascript mjs; }` a secas deja la tabla de tipos reducida a esa única entrada, y entonces `/assets/index-*.js` pasa a servirse como `application/octet-stream`. Como el bundle se carga con `<script type="module">`, el navegador lo **bloquea**: pantalla en blanco. Medido sobre `nginx:1.27-alpine` sirviendo el `dist` real:

| Plantilla | worker `.mjs` | `index-*.js` | `index-*.css` |
|---|---|---|---|
| Sin arreglo | `application/octet-stream` ← el fallo original | `application/javascript` | `text/css` |
| **La forma ingenua** | `text/javascript` | **`application/octet-stream`** ← rompe todo | **`application/octet-stream`** |
| Con el `include` delante | `text/javascript` | `application/javascript` | `text/css` |

Dos bloques `types` en el mismo nivel **sí** acumulan, y por eso el `include` de la tabla por defecto delante resuelve el problema sin efectos colaterales.

Segundo detalle de la misma familia: `gzip_types` toma **MIME types, no extensiones**. Añadir `mjs` ahí no habría hecho nada; lo que hay que añadir es `text/javascript`.

> **Corrección del 2026-08-25.** La primera versión de este ADR prescribía la forma ingenua, y era peligrosa: habría cambiado un worker bloqueado por una aplicación entera en blanco. Lo detectó la implementación de la #11289 midiendo contra la imagen de producción construida de verdad, no razonando sobre la config. Se deja escrito en vez de corregirlo en silencio, porque el modo de fallo es contraintuitivo y volverá a tentar a quien lea solo la directiva.

No se hizo en la #11775 porque allí sería código muerto: entonces no había ningún `.mjs` en `dist`, así que nada lo probaría.

## Alternativas descartadas

**Quedarse en la v3 indefinidamente.** Mantiene el soporte de navegadores viejos, pero deja viva una exención de advisory *high* sostenida por configuración. Además `check:exemptions` está diseñado para ponerse **rojo** cuando el advisory desaparezca del audit, así que la deuda tiene fecha de caducidad forzada por el propio CI.

**Build *legacy* con transpilado.** No sirve: lo que falta son APIs de runtime, no sintaxis. `@vitejs/plugin-legacy` no inventa `URL.parse`.

**Polyfill de `URL.parse`, `Promise.withResolvers` y `AbortSignal.any`.** Técnicamente posible y no descabellado —los tres son polyfilleables—, pero habría que inyectarlos también **dentro del worker**, sin ningún test que cubra ese camino y sobre el punto del sistema cuyo fallo es invisible. Se descarta por relación riesgo/beneficio, no por imposibilidad. Si el parque real obligara a soportar Safari 17, es la vía a reconsiderar.
