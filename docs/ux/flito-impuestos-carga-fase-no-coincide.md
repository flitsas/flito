# UX slim — Carga masiva de recibos: «Fase no coincide», aviso de carpetas y copy (HU #12615)

Feature #12589 · Épica #12585. Delta sobre `docs/ux/flito-impuestos-fases-y-recibo-caja.md` (modal «Carga masiva de recibos de impuesto»). Público: operador interno (gestor de impuestos / Operaciones). Tono del modal: **tú** (se calca; los `detalle` del servidor ya tutean: «súbelo con la fase…»). El intro nuevo se escribe **impersonal** para no mezclar. Ficha de ayuda: **usted**.
API (tip ecd4eb0): `POST /flito/impuestos/recibos` devuelve además `faseNoCoincide: ItemRecibo[]` (con `detalle`) y `carpetasSinFase: string[]` (primer segmento de carpeta) por tanda. AC1 (orden liquidaciones→pagos) es del servidor: sin UI.

## Superficie tocada

`apps/web/src/components/flito/CargaRecibosImpuestos.tsx`, cuatro sitios; ninguna ruta, slug ni columna nueva. `RanuraCargaMasiva` gana una prop opcional para el aviso (SOAT no la pasa). La ficha `content/ayuda/flito_impuestos.md`, paso 6.

| Sitio | Se quita | Se añade |
|---|---|---|
| Intro (L56-58) | Todo el párrafo (ZIP en el computador, 5 en 5, OCR, cruce por placa) | Párrafo de 3 frases: qué se puede subir y qué hace cada fase |
| Ayuda del ZIP (L72-74) | «sin marca» / «con marca» o «pagado» | Vocabulario real de las carpetas del organismo |
| Bajo la ranura de archivos | — | Aviso por carpeta no reconocida, en la misma región `status` del contador |
| Resumen (L92-100) + `TablaResultadoOcr` | — | Chip «Fase no coincide N» al final; filas con el `detalle` tal cual; nota de carpetas sin fase |

## Delta de claridad (qué se ve / qué se calla)

- Quien abre el modal viene a **declarar qué sube y subirlo**. Se ve primero: el selector de fase y la caja de archivos. El intro deja de contar el mecanismo (se calla: tandas, ZIP en el navegador, OCR, cruce por placa; eso vive en el código y en el resultado) y dice solo lo que decide la carga: qué cabe y qué hace cada fase.
- Quien mira el resumen viene a **saber qué quedó y qué debe rehacer**. Los seis chips no se mueven; el séptimo va al final, junto a «Sin asociar»: la cola de la fila es «nada se guardó, vuelve a subirlo» y el orden de los chips es el orden de las filas, así que las filas por rehacer quedan juntas al final de la tabla. Insertarlo tras «En revisión» desplazaría tres chips que el operador ya lee de memoria y mezclaría «lo resuelve Revisiones OCR» con «lo rehaces tú».
- Densidad: intro más corto (−2 frases), +1 línea condicional por carpeta, +1 chip condicional → **aliviada**.
- Primaria: «Subir y procesar» / «Listo». Sin cambio. El aviso no trae botón.

## Copy exacto

**Intro del modal** (sustituye íntegro al párrafo actual):
> Se admiten PDF, imágenes (JPG, PNG) o un ZIP: hasta 150 archivos sueltos o 300 dentro de un ZIP, de máximo 15 MB cada uno. Con la fase **Liquidación** el impuesto queda liquidado (valor y fecha) sin pagarlo. Con la fase **Pago** el recibo con sello PAGADO lo deja en Pagado.

**Ayuda del ZIP** (bajo el selector, mismo `<p id={idAyudaZip}>`):
> En un ZIP manda la carpeta de cada recibo: «liquidaciones_originales» o «sin marca» → Liquidación; «liquidaciones_pagadas», «pagadas» o «con marca» → Pago. La fase elegida aplica a los archivos sueltos y a las carpetas que no digan ninguna de las dos.

**Aviso pre-envío** (una línea por carpeta raíz no reconocida; `{fase}` = rótulo del selector):
> La carpeta «{carpeta}» no dice si son liquidaciones o pagos: sus recibos tomarán la fase seleccionada ({fase}).

**Nota post-envío** (una sola línea, bajo los chips y sobre la tabla; `hastaTres` de `carga-masiva.ts`):
> La carpeta «{X}» no decía si eran liquidaciones o pagos: sus recibos se cargaron con la fase {fase}.
> Las carpetas «{X}», «{Y}» y 2 más no decían si eran liquidaciones o pagos: sus recibos se cargaron con la fase {fase}.

**Chip y fila:** «Fase no coincide N» · fila «Fase no coincide». Columna «Detalle del análisis OCR»: el `detalle` del servidor **sin tocar**, con su punto final («No se ve el sello PAGADO; súbelo con la fase Liquidación.» / «Tiene sello PAGADO; súbelo con la fase Pago.» / «Dos documentos de ABC123 y no se distingue cuál es el pago.»). Ahí está el siguiente paso: cerrar con «Listo», volver a abrir el modal, elegir la otra fase y subir solo esos archivos. No se añade texto propio ni botón de «reintentar con la otra fase»: el modal ya se cerró y la selección no se conserva.

## Forma de cada pieza

**Aviso de carpetas.** Dentro del `role="status" aria-live="polite"` que ya pinta el contador y los descartes (regla de `RanuraCargaMasiva`: una sola región `status`, para que nada se anuncie huérfano). Un `<p>` por carpeta, después de la línea de descartes, `text-xs` en `--flit-text-muted` como los descartes: nada está mal y la carga sale. Se calcula en el cliente por `seleccion.items`: carpeta raíz de cada `ruta` cuya ruta completa no declara fase; se deduplica por raíz (dos ZIP con «2026/» → una línea); sueltos y entradas en la raíz del ZIP no avisan. Es puro estado derivado (`useMemo` de `seleccion` + `fase`): al cambiar el radio, el texto de cada línea cambia y el lector anuncia solo ese nodo (`aria-atomic` por defecto). No roba foco, no bloquea «Subir y procesar», no cambia el color del contador.

**Nota post-envío.** `<p>` estático `text-sm` secundario bajo los chips. Sin `role`: el cuerpo entero se reemplaza al terminar y `FlitModal` ya lleva el foco al título. `carpetasSinFase` viene por tanda y `fusionarResultadoCarga` concatena arreglos: **deduplicar** antes de pintar. Sin carpetas → no se pinta nada.

**Chip.** `<StatusChip tone="warning">Fase no coincide {n}</StatusChip>` como séptimo, tras «Sin asociar». Filas `tono: 'warning'`, al final de `filas` en `TablaResultadoOcr`; `resultado.faseNoCoincide ?? []` como `liquidados`. `enviarCargaEnTandas` ya lo acumula por clave-arreglo.

## Estados (4) del modal tras el cambio

1. **Cargando** — «Abriendo «x.zip»…» y «enviando k de N archivos» sin cambio. Mientras se abre el ZIP no hay aviso (no hay `items`).
2. **Error** — validación/413/504/ZIP dañado sin cambio (`role="alert"`). Un error de validación **no oculta** el aviso de carpetas: son mensajes distintos (el rojo dice qué quitar; el aviso dice qué fase tomará lo que sí cabe).
3. **Vacío** — sin selección: intro + selector + caja, primaria deshabilitada, sin aviso. Resumen sin filas: «No se procesó ningún archivo.» sin cambio.
4. **Lleno** — selección: contador (+ descartes) (+ aviso por carpeta). Resumen: siete chips, nota de carpetas si aplica, tabla con las filas nuevas al final, «Listo».

## Ficha de ayuda — paso 6 (sustituye íntegro al actual)

> 6. El recibo del organismo se carga en **dos fases**. La **liquidación** es el documento de la hacienda sin sello: deja el impuesto **Solicitado** con su valor y su fecha de liquidación, sin pagarlo. El **pago** es el mismo documento con el sello de pagado: es la única vía a **Pagado**. En el encabezado, **Cargar recibos (masivo)** admite PDF, imágenes o un ZIP: hasta **150 archivos sueltos** o **300 dentro de un ZIP**, de máximo **15 MB** cada uno. Elija la **Fase del recibo** (**Pago** viene marcado). Dentro de un ZIP manda la carpeta de cada recibo: **liquidaciones_originales** o **sin marca** es Liquidación; **liquidaciones_pagadas**, **pagadas** o **con marca** es Pago. Si una carpeta no dice ninguna de las dos, FLITO se lo avisa antes de enviar y esos recibos toman la fase que usted eligió. FLITO no adivina la fase por el documento. Al terminar, el resumen dice cuántos quedaron **Liquidados**, **Conciliados**, **En revisión**, **Complementos**, **Duplicados**, **Sin asociar** y **Fase no coincide**, y la lista indica el resultado de cada archivo. **Fase no coincide** significa que el sello del documento contradice la fase elegida (un pago sin sello, una liquidación con sello, o dos documentos de la misma placa que no se distinguen): esos recibos **no se guardaron**; vuelva a subirlos con la fase que el detalle le indica.

Las viñetas de «Qué no hace» (L41-42) se mantienen: no son proceso, son límites.

## Permiso/slug

Página `impuestos` y función `impuestos.recibos.cargar` sin cambio. Ninguna migración.

## Requerimiento (no es endpoint nuevo)

El aviso pre-envío necesita `faseDeCarpeta` y `carpetaRaiz` en el navegador con **las mismas regex** del servidor (`apps/api/src/modules/flito-impuestos/flito-recibos.fase.ts` L112-129). Moverlas a `@operaciones/shared-types` (donde ya vive `partirCargaMasivaEnTandas`) y que el API las importe de ahí; duplicarlas es garantía de que el aviso mienta cuando cambie una. Para frontend-agent; no requiere architecture-agent.

## Accesibilidad

- Aviso: dentro de la región `status` existente, `polite`; sin `alert`, sin foco, sin `aria-atomic`. Cambiar el radio re-anuncia solo las líneas del aviso.
- Chip nuevo: `StatusChip warning` cumple contraste del kit; el texto manda («Fase no coincide»), no el color.
- Tabla: `detalle` en celda de texto; sin `title`, sin truncar (el motivo es el siguiente paso).
- Intro: `<p>` plano; las negritas de fase con `<strong>` (énfasis real: nombran el valor del selector).

## Notas para QA

1. Intro sin «computador», «5 en 5», «tanda», «OCR» ni «placa»; ayuda del ZIP con los cinco tokens del AC4.
2. ZIP con carpetas `liquidaciones_originales/`, `liquidaciones_pagadas/` y `2026/` → una sola línea de aviso, por «2026», con «(Pago)»; cambiar a Liquidación → la línea dice «(Liquidación)» sin tocar el archivo.
3. Dos ZIP con carpeta `2026/` → una línea. Entrada en raíz del ZIP y sueltos → sin aviso. Carpeta `SIN MARCA DE AGUA/` → sin aviso (negación gana).
4. Aviso presente + error de validación (151 sueltos) → los dos se ven; primaria deshabilitada por el error, no por el aviso.
5. Respuesta con `faseNoCoincide` de 2 → chip «Fase no coincide 2» séptimo, tono warning; filas al final con el `detalle` literal con punto.
6. `carpetasSinFase: ['2026']` en dos tandas → una nota, no dos; `[]` → sin nota.
7. Resumen con `faseNoCoincide` ausente (API viejo) → 0 y sin filas, sin crash.
8. Lector de pantalla: elegir ZIP anuncia contador + aviso en una sola pasada; cambiar radio anuncia solo el aviso; el foco no se mueve.
9. Ficha: paso 6 sin «de 5 en 5», «lo abre en su computador» ni el peso del comprimido; nombra «Fase no coincide» y «vuelva a subirlos».
10. Regla compartida: mutar una regex en shared-types cambia a la vez el aviso del cliente y `carpetasSinFase` del servidor.

## Decisiones y descartes

- Intro impersonal y no «usted»: el AC pide usted, pero la pantalla tutea y los `detalle` del servidor («súbelo») son fijos; usted en el intro mezclaría tratamientos en la misma pantalla (regla 7). Impersonal no choca con nadie.
- Chip al final y no tras «En revisión»: memoria de posición de los seis existentes y agrupación por «qué hago yo ahora».
- Aviso muted en la región `status`, no chip `warning` ni `alert`: nada falló, la carga sale; un `alert` por cada carpeta haría ruido al lector y un chip competiría con el resumen.
- Sin botón «Volver a subir con la otra fase» en el resumen: la selección ya se soltó (las entradas del ZIP se descomprimen por tanda) y reabrir el modal es un clic; el detalle ya dice la fase.
- No se renombra la cabecera «Detalle del análisis OCR»: fuera del AC; se anota para una HU de copy.
