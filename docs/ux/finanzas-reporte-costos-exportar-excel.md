# UX slim — Reporte de costos: exportar a Excel con la sesión del usuario (HU #12532, Feature #12530, épica #12243)

> Modo **slim**: la pantalla existe (`apps/web/src/pages/FinanzasReporteCostos.tsx`, spec previa en
> `docs/ux/finanzas-reporte-costos-secciones-consolidado.md`) y cambia **una acción** en cada vista: los
> dos botones de exportar. Todo lo que no se nombra aquí **no cambia**: filtros, selector de periodo,
> secciones, liquidar/facturar/reversar, contadores FE, tarjeta y diálogo de envío, consolidado.
> Tono de la pantalla: **tutea** («No cierres esta ventana», «Ver cuáles»). Se calca. La ficha de Ayuda
> trata de **usted**, como todas.

## Superficie tocada

| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, **sin cambios**. Exportan los tres roles que leen la página (`admin`, `financiera`, `auditor`): hoy el endpoint es `LECTURA` y la ficha ya dice que el Auditor «puede exportar». No se crea función nueva en el catálogo |
| Cabecera | Slot `actions` del `PageHeaderCard`: el conmutador Detalle \| Consolidado **no cambia**; cambia el botón a su derecha (rótulo, estado ocupado, mecanismo) |
| Banda de resultado | **Nueva línea debajo de la cabecera y encima de los filtros**, en las dos vistas: la tarjeta `AvisoVisible` de `components/flito/ExportarCola.tsx` (ya exportada para eso desde la HU #11910) |
| Anuncio | La región `role="status"` sr-only que la página ya tiene (`anuncio`, línea 359) recibe también «generando» y «descargado» |
| Ficha de ayuda | `apps/web/src/content/ayuda/finanzas_reporte_costos.md`: línea 7 (Para quién) y paso 7 (Exporte); cero «CSV» |
| Kit | `flitBtnPrimary` / `flitBtnSecondary`, `AvisoVisible`, `avisoDeError`, `esNombreDeExport` de `ExportarCola.tsx`. **Cero patrones nuevos** |

## Delta de claridad (qué ve el operador antes / después)

**A qué se entra a exportar:** a llevarse el mes cerrado a Excel —el detalle con las 36 columnas para
contabilidad, o el consolidado por cliente para el cobro— con **los mismos filtros que tiene en pantalla**.

| | Antes (hoy) | Después |
|---|---|---|
| Detalle | «Exportar CSV», secundario. Abre una pestaña nueva que muestra `{"error":"Token requerido"}`. Nadie ha podido exportar desde el 2026-08-13 | **«Exportar a Excel»**, secundario. Descarga `reporte-costos_AAAAMMDD-HHmm.xlsx` sin salir de la pantalla; el botón dice **«Generando…»** mientras tanto y una línea bajo la cabecera confirma el nombre del archivo o dice qué falló y qué hacer |
| Consolidado | «Exportar consolidado», primario. Mismo 401 en pestaña nueva | **«Exportar consolidado»** (sin cambio de rótulo), primario. Descarga `consolidado-costos_AAAAMMDD-HHmm.xlsx`; mismos estados |
| Sesión vencida | Pestaña con JSON de error; el usuario no sabe si fue él o el sistema | Comportamiento habitual de FLITO: fin de sesión y vuelta a Login con su motivo. No hay banda propia porque la página deja de existir |
| Archivo con más filas de las que admite | CSV truncado en silencio con una cabecera `X-Export-Truncado` que nadie lee | **No se guarda nada.** Aviso «acota el filtro» sin botón de reintento (repetir daría lo mismo) |

**Se ve primero:** no cambia —Flit, Placa, Empresa, Estado y Valores en Detalle; Cliente, Periodo, Total en
Consolidado. El botón de exportar sigue donde estaba y con el mismo peso. **Se calla:** la mecánica (POST,
sesión, `Content-Disposition`); el nombre del archivo solo se enseña cuando ya está guardado. **Densidad:**
sin cambio en la cabecera; entra **una** tarjeta de una línea bajo ella, y solo mientras hay algo que decir
(se cierra con «Cerrar el aviso» y se vacía sola al lanzar otra descarga).

## Jerarquía y primaria por vista

- **Detalle:** la primaria sigue siendo **Liquidar** (fila / `Liquidar N`). «Exportar a Excel» es
  `flitBtnSecondary`, como hoy y como en SOAT/Impuestos. Bajo el botón, **una línea `text-xs`** con
  `--flit-text-secondary`: «Todo el filtro con todas sus columnas, no solo esta página.» Es lo único que el
  usuario no puede deducir del botón (la tabla pagina y se puede tener secciones compactadas; el archivo no).
- **Consolidado:** «Exportar consolidado» es la **única** acción de la vista y conserva `flitBtnPrimary`.
  Sin línea de ayuda: el consolidado no pagina ni compacta, así que no hay nada que aclarar.
- Nunca dos primarias: al conmutar de vista el botón se sustituye, no se apila (como hoy).

## Dónde vive el aviso y por qué

**Bajo la cabecera, encima de `FiltrosReporteCostos`, en las dos vistas**, con `AvisoVisible` de
`ExportarCola.tsx` (tarjeta de una línea: texto + «Reintentar la descarga» si aplica + «Cerrar el aviso»).

Se descarta el contenedor de `ejecutar` (`aviso` / `error` en `FlitCard`, líneas 381-382) por tres razones
que se ven en el código, no por gusto: (1) solo se monta en la rama de Detalle, y el consolidado también
exporta; (2) comparte `error` con el fallo de carga del reporte, así que un 429 del export se pintaría igual
que «no se pudo cargar la tabla» y ambos se pisarían; (3) no tiene «Reintentar» ni «Cerrar», y el 429 lo
necesita. Además `ejecutar` enciende `enProceso`, que **deshabilita Liquidar en toda la tabla**: exportar
no puede bloquear la liquidación. El export lleva su propio `ocupado`.

Se descarta meter el aviso dentro del slot `actions`: el texto del 422 es una frase larga y aplastaría el
título en cuanto la ventana se estreche (misma razón escrita en `AvisoExportCola`).

## Estados (4) + copy exacto

| Estado | Botón (Detalle / Consolidado) | Banda bajo la cabecera | Región `role="status"` (sr-only, ya montada) |
|---|---|---|---|
| **Reposo** | «Exportar a Excel» (secundario) / «Exportar consolidado» (primario), habilitados | Ausente (o la del resultado anterior hasta que se cierre) | Lo que ya tuviera («Vista consolidada», etc.) |
| **Generando** | Rótulo **«Generando…»**, `disabled`, `aria-busy="true"`. **Los dos botones** comparten el candado: si se conmuta de vista con una descarga en vuelo, el otro también sale «Generando…» | Ausente (se vacía al pulsar) | «Generando el archivo del reporte de costos.» / «Generando el archivo del consolidado.» |
| **Éxito** | Vuelve a reposo; el foco sigue en el botón | Tono `ok`: **«Archivo descargado: reporte-costos_20260914-1532.xlsx»** (nombre real del `Content-Disposition`) + [Cerrar el aviso] | El mismo texto de la banda |
| **Error** | Vuelve a reposo; el foco sigue en el botón | Tono `error`, `role="alert"` (ver tabla siguiente) | Vacía: el `alert` ya se anuncia; dicho dos veces se oye dos veces |

**Copy de error — se decide por `status` y `codigo`, nunca por el texto.** Eco del servidor solo en los dos
mensajes fijos (422 y 429), respaldo propio si no viene texto. Un 500 lleva copy propio siempre.

| Caso | Condición | Texto | Reintentar |
|---|---|---|---|
| Tope de filas | `422` y `codigo === 'export_demasiado_grande'` | Texto del servidor; respaldo: «El filtro que tienes puesto trae más filas de las que admite un archivo. Acota el periodo o el filtro y vuelve a exportar.» **Sin cifra compilada**: el tope es del entorno del API y el número lo trae el 422 | No |
| Límite de descargas | `429` | Texto del servidor; respaldo: «Se descargaron demasiados archivos seguidos. Espera 1 minuto y vuelve a intentarlo.» | Sí |
| Sesión vencida | `401` | Sin banda: el cliente global cierra la sesión y lleva a Login con el motivo, como en toda la app | — |
| Sin permiso | `403` | «Tu usuario ya no puede exportar el reporte de costos. Habla con un administrador.» | No |
| Tiempo agotado / red | `status === 0` | «El archivo tardó demasiado en generarse. Vuelve a intentarlo con un periodo más corto.» | Sí |
| Cualquier otro | resto | «No se pudo generar el archivo. Vuelve a intentarlo; si sigue fallando, avisa a soporte.» | Sí |

**Nunca se guarda un archivo con el error dentro:** `downloadPostNamed` mira `res.ok` antes de entregar y
lanza `errorVestidoDeArchivo` (`lib/api.ts:486`). Es un guardia del cliente que ya existe; la pantalla solo
tiene que usar ese método y no `window.open`.

**Vacío del reporte:** si el filtro no trae filas, el botón **sigue habilitado** y el servidor decide (un
archivo con solo cabecera es un resultado válido para «este mes no hubo nada»). No se inventa un aviso
«no hay nada que exportar» que el backend no manda.

## Datos (contrato a confirmar contra la HU backend del Feature #12530)

Hoy `develop` solo tiene `GET /finanzas/reporte-costos/export` y `GET …/consolidado/export` en **CSV**, con
`X-Export-Truncado` en lugar de 422 (`finanzas.routes.ts:106-136`). La pantalla se diseña contra el contrato
que describe la HU y que debe entregar el backend **antes o en la misma rama**:

- `POST /finanzas/reporte-costos/export` y `POST /finanzas/reporte-costos/consolidado/export`, cuerpo JSON
  con **los mismos criterios que hoy arma `params()`** (buscar, empresas, tipos, etapa, desde/hasta,
  aprobadoDesde/Hasta, estados, organismos, documentacionCompleta, estadoFacturacion) y, en consolidado,
  `periodo`. **Sin `page`.** Un solo constructor de criterios en la página: el que ya existe, vertido al cuerpo.
- Respuesta `.xlsx` con `Content-Disposition: attachment; filename="reporte-costos_AAAAMMDD-HHmm.xlsx"` /
  `"consolidado-costos_AAAAMMDD-HHmm.xlsx"` (sello en hora de Colombia). El cliente valida la forma con
  `esNombreDeExport('reporte-costos' | 'consolidado-costos', nombre)` y cae al respaldo `reporte-costos.xlsx`
  / `consolidado-costos.xlsx` si no encaja.
- `422 { error, codigo: 'export_demasiado_grande' }` sobre el tope (20.000 filas, del entorno);
  `429 { error }` por el limitador de exports (5 por minuto y usuario, cuota aparte del listado).
- El `registrarAccesoPii(req, 'export')` que hoy hace el GET del detalle **se mantiene en el POST**: el
  archivo lleva documento, nombres y apellidos del titular. El consolidado no lleva PII y no lo necesita.
- **PII (§14):** todo el criterio viaja en el cuerpo; ninguna clave del filtro va a la URL de la descarga.
  El buscador de esta pantalla admite placa, VIN y trámite (no documento), pero la regla es la misma que en
  SOAT: al cuerpo, sin variante GET.

Si el backend no está mergeado al empezar el front, el frontend-agent **no** cablea contra el GET CSV
«mientras tanto»: sería volver a un archivo que la HU retira.

## Accesibilidad

- Botón: `disabled` + `aria-busy="true"` mientras genera; el rótulo «Generando…» es texto visible, no
  `aria-label`. El candado real del doble clic es una `ref` síncrona, no el `disabled` (lección de la
  HU #11562, escrita en `useExportCola`).
- Anuncio de «generando» y «descargado» por la región `role="status"` **ya montada** de la página
  (`anuncio`): una región polite que se monta ya rellena no se anuncia en varios lectores. No se crea
  una segunda región de estado en la misma página.
- Error por `role="alert"` en la banda visible (lo pone `AvisoVisible`), y **no** se repite en el `status`.
- El foco **no se mueve** ni al empezar ni al terminar: se queda en el botón, que sigue existiendo. La
  banda es una región anunciada, no un diálogo. Si el usuario conmuta de vista durante la descarga el foco
  está en la pastilla, y ahí se queda.
- Nombres accesibles distintos de los que ya hay en pantalla: «Reintentar la descarga» (no «Reintentar»,
  que ya lo usan los contadores FE, la tarjeta de envío y el consolidado) y «Cerrar el aviso».
- Contraste: tinta `--flit-danger-ink` para el error (no `--flit-danger`, que se queda en 4,19:1 a 14 px,
  Bug #11604). Todo con tokens; sin animación ni spinner.

## Copy propuesto para la ficha de ayuda (`finanzas_reporte_costos.md`, usted)

**Línea 7, «Para quién»** — sustituir «y puede exportar;» por «y puede **exportar a Excel**;». El resto de
la frase no cambia.

**Paso 7, «Pasos»** — sustituir entero por:

> 7. Exporte a Excel. En **Detalle**, **Exportar a Excel** descarga un archivo `.xlsx` con **todos** los
> trámites del filtro y del periodo puestos —no solo la página que ve— y con las tres secciones completas,
> aunque en pantalla tenga alguna compactada. En **Consolidado**, **Exportar consolidado** descarga el
> agrupado por cliente y periodo con su fila de totales. Mientras se genera, el botón dice **Generando…**
> y no admite otro clic; al terminar, un aviso bajo la cabecera dice **Archivo descargado:** con el nombre
> (`reporte-costos_AAAAMMDD-HHmm.xlsx` o `consolidado-costos_AAAAMMDD-HHmm.xlsx`, hora de Colombia). Si el
> filtro supera el número de filas que admite un archivo, no se descarga nada y el aviso le pide acotar el
> periodo o el filtro. Si descarga varios archivos seguidos, espere un minuto y use **Reintentar la
> descarga**. Si la sesión venció, FLITO lo lleva a ingresar de nuevo; vuelva a la pantalla y exporte otra vez.

**Sección «Estados», viñeta «Error»** — añadir al final: «Al exportar, el aviso bajo la cabecera dice qué
falló y ofrece **Reintentar la descarga** cuando repetir tiene sentido; **Cerrar el aviso** lo quita.»

Comprobar con `rg -n "CSV" apps/web/src/content/ayuda/finanzas_reporte_costos.md` que no queda ninguna.

## Notas para QA (≤10)

1. Detalle: el botón dice «Exportar a Excel» (secundario) y al pulsar sale **un** `POST /api/finanzas/reporte-costos/export` con `Authorization` y el cuerpo igual a los filtros en pantalla, **sin `page`** y sin nada en la query. *Mutante:* `window.open` o GET.
2. Consolidado: «Exportar consolidado» (primario) → `POST …/consolidado/export` con `periodo` en el cuerpo. Con `?vista=consolidado` de entrada, igual.
3. Durante la petición: `disabled`, `aria-busy="true"`, rótulo «Generando…», y un segundo `click()` **no** genera una segunda petición (contar en red, no mirar el atributo). *Mutante:* quitar la `ref` y dejar solo `disabled`.
4. `200` con `Content-Disposition: attachment; filename="reporte-costos_20260914-1532.xlsx"` → se guarda con ese nombre y la banda dice «Archivo descargado: reporte-costos_20260914-1532.xlsx». Con `filename="reporte-costos_900123456.xlsx"` → se guarda como `reporte-costos.xlsx` (respaldo). *Mutante:* aceptar cualquier nombre.
5. `422 { codigo: 'export_demasiado_grande', error: '…' }` con `content-type` de xlsx → **no** aparece nada en descargas, banda `role="alert"` con el texto del servidor y **sin** «Reintentar la descarga». *Mutante:* decidir por `status` solo, o por el texto.
6. `429` → banda con «Reintentar la descarga»; pulsarlo repite el mismo POST con los mismos filtros. `403` → sin reintento. `status 0` → con reintento y copy de tiempo agotado.
7. `401` → no hay banda: la app cierra sesión y navega a Login (mismo comportamiento que cualquier `api.get` de la página).
8. Exportar **no** enciende `enProceso`: con una descarga en vuelo, «Liquidar» de la fila sigue habilitado. *Mutante:* reutilizar `ejecutar`.
9. Conmutar de vista con una descarga en vuelo: el botón de la otra vista también sale «Generando…»; al terminar, la banda se ve en la vista que esté activa.
10. `auditor` ve el botón y exporta; la banda solo se monta donde se monta el botón. Ficha de ayuda: `rg CSV` devuelve 0 líneas; el paso 7 y la viñeta «Error» traen el copy de arriba.

## Decisiones (D-nn) para el frontend-agent

| # | Decisión | Descarte |
|---|---|---|
| D-01 | Rótulos: Detalle **«Exportar a Excel»**, Consolidado **«Exportar consolidado»** (sin cambio); en vuelo los dos dicen **«Generando…»** | «Preparando el archivo…» de SOAT: la HU fija el texto y es de este público; la diferencia se declara aquí |
| D-02 | Peso: Detalle secundario, Consolidado primario. **No cambia** respecto a la spec de la HU #12434 | Subir el de Detalle a primario «porque ahora funciona»: Liquidar sigue siendo la acción de esa visita |
| D-03 | Descarga con `api.downloadPostNamed(ruta, respaldo, cuerpo, (n) => esNombreDeExport(prefijo, n))`, prefijos `reporte-costos` y `consolidado-costos`, respaldos `reporte-costos.xlsx` / `consolidado-costos.xlsx` | `window.open`, `<a download>`, GET con query, nombre fabricado en el cliente |
| D-04 | El cuerpo del POST se arma **del mismo `params()`** de la página (vertido a objeto), más `periodo` en consolidado; nunca `page` | Segundo constructor de criterios para el export |
| D-05 | Estado propio del export (`ocupado`, `aviso`, `enVuelo` ref), **compartido por los dos botones**; independiente de `enProceso` | Reutilizar `ejecutar`: bloquearía Liquidar y mezclaría el error con el de carga |
| D-06 | Banda: `AvisoVisible` de `ExportarCola.tsx` **bajo el `PageHeaderCard` y encima de los filtros**, en las dos vistas | `FlitCard` de `aviso`/`error` (solo Detalle, sin botones); banda dentro de `actions` |
| D-07 | Errores por `avisoDeError` de `ExportarCola.tsx` (status + `codigo`), con el 403 y el `status 0` redactados para esta pantalla (tabla de arriba). Eco del servidor solo en 422/429; sin cifra del tope compilada | Copy por texto; número «20.000» escrito en el front |
| D-08 | «Generando…» y «Archivo descargado: …» se anuncian por la región `role="status"` **existente** (`anuncio`); el error solo por el `role="alert"` de la banda | Segunda región de estado; anunciar el error dos veces |
| D-09 | Foco quieto en el botón al terminar; `aria-busy` + `disabled` en vuelo; candado real en `ref` | Mover el foco a la banda; fiarse del `disabled` |
| D-10 | Línea `text-xs` bajo el botón **solo en Detalle**: «Todo el filtro con todas sus columnas, no solo esta página.» | Repetirla en Consolidado (no pagina ni compacta); meterla en el subtítulo |
| D-11 | Con el reporte vacío el botón sigue habilitado; no se inventa aviso de «nada que exportar» | Deshabilitar por `filas.length === 0`: el archivo cubre el filtro, no la página |
| D-12 | El 401 lo resuelve el gancho global del cliente; sin banda propia | Copy «tu sesión venció» en la banda: la página ya no está |
| D-13 | Ficha de ayuda: línea 7 y paso 7 con el copy de arriba; viñeta «Error» ampliada; **cero «CSV»** | Dejar «CSV» en la ficha «hasta la próxima HU» |
| D-14 | Sin cambio de slug, de función del catálogo ni de roles: exportan los que leen (incluido `auditor`), como hoy y como dice la ficha | Ocultar al auditor calcando SOAT (allí lo decidió otra HU con otro AC) |

Nada de lo anterior requiere componente nuevo. Si `useExportCola` no encaja por su tipo `ColaExportable`
(prefijo cerrado a `'soat' | 'impuestos'`), el frontend-agent decide entre ampliar ese tipo o escribir el
hook local con la misma `ref`; lo que **no** se decide en código es nada de esta tabla.

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /tmp/claude-1000/-home-david-flit-flito/fbc41387-2d4d-46ce-85fb-a9a4fbb234f8/scratchpad/docs-ux/finanzas-reporte-costos-exportar-excel.md → docs/ux/ (lo traslada el hilo al worktree de la HU)
  Oficio: primaria única (Liquidar en Detalle; Exportar consolidado en Consolidado) | jerarquía dicha | error con siguiente paso en los 6 casos | sin efectos
  Densidad: sin cambio en cabecera; una tarjeta de una línea bajo ella solo mientras hay resultado que decir
  Pantallas: 1 (2 vistas, 2 botones) | Requerimientos nuevos de datos: 1 (contrato POST .xlsx + 422/429 de la HU backend hermana del Feature #12530; hoy develop solo tiene GET CSV)
  Siguiente: tech-lead confirma que la HU backend del #12530 entrega los dos POST con Content-Disposition, `codigo` y limitador antes del front → frontend-agent con D-01..D-14
```
