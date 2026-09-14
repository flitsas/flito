# UX slim — Reporte de costos: tabla compacta por defecto (HU FRONTEND del Feature #12530, épica #12243)

> Modo **slim**: la pantalla existe (`apps/web/src/pages/FinanzasReporteCostos.tsx`, tabla en
> `apps/web/src/components/finanzas/TablaReporteCostos.tsx`; specs previas en
> `docs/ux/finanzas-reporte-costos-secciones-consolidado.md` y `…-exportar-excel.md`) y cambia **qué
> columnas se ven al entrar y con qué control se amplían**. Todo lo que no se nombra aquí **no cambia**:
> filtros, selector de periodo, OT, consolidado, casillas y acciones de fila y de lote, contadores FE,
> tarjeta y diálogo de envío, ficha «Factura DIAN», exportar a Excel y su banda de resultado.
> Tono de la pantalla: **tutea** («No cierres esta ventana», «Ver cuáles»). Se calca. La ficha de Ayuda
> trata de **usted**, como todas.

**Palabras del PO (2026-09-14, en DEV):** «La tabla es extremadamente grande y toca hacer muchísimo
scroll para ver los valores. Es más prioritario que el Excel se exporte con los campos solicitados a que
se muestren en la tabla del sistema.» Esto invierte el AC1 de la HU #12434 (arrancar ampliada).

## Superficie tocada

| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, **sin cambios**. `admin` y `financiera` operan; `auditor` lee. El control de columnas lo ven los tres (es lectura) |
| Tabla del detalle | `thead` de dos filas: la fila de grupos **pierde** sus tres botones y los contadores «n de m»; entra **un** control global en la línea del conteo (encima de la tabla). Valores pasa a ser compactable. Arranque **compacto** |
| Almacén | `localStorage`: una clave nueva; las tres por sección se retiran |
| Anuncio | La región `role="status"` sr-only que la página ya tiene (`anuncio`) recibe el cambio de columnas |
| Ficha de ayuda | `apps/web/src/content/ayuda/finanzas_reporte_costos.md`: paso 3 y viñeta «Lleno» |
| Kit | `FlitTable`, `FlitTh`, el `ThGrupo` local, botón de texto con `flit-focus`, tokens. **Cero patrones nuevos** |

## Delta de claridad (qué se ve / qué se calla)

**A qué se entra:** a operar el mes —ver qué está **Estimado / Liquidado / Facturado**, cuánto vale cada
trámite y pulsar **Liquidar**, **Facturar** o **Enviar a facturación**— en un portátil, sin buscar la
acción de la fila al otro lado de un scroll horizontal. Consultar los 36 campos es trabajo del Excel.

| | Antes (DEV hoy) | Después |
|---|---|---|
| Al entrar | 28 columnas de datos + casilla + acciones. El Total y las acciones quedan fuera de la pantalla en 1366 px | **12 columnas** + casilla + acciones. Total, Liquidación y las acciones mucho más cerca; medido al implementar: 1628 px de contenido frente a 1258 px de contenedor, también con D-10 (1523 px), así que sigue habiendo desplazamiento residual hasta que el PO decida qué columnas caen (registrado en la HU #12537) |
| Identificación | 9 (compacta: Empresa, Flit, Placa) | Compacta **Empresa, Flit, Placa**. Se callan VIN y el titular (Nombres, Apellidos, Razón social, Tipo, Documento) |
| Datos del trámite | 9 (compacta: Tipo trámite, OT, Estado, Fechas, Factura DIAN) | Compacta **Tipo trámite, OT, Estado, Fechas, Factura DIAN**. Se callan Marca, Línea, Mes, Trimestre |
| Valores | 10, **no compactable** | Compacta **Total reintegro, Servicio, Total, Liquidación**. Se callan los conceptos: SOAT (con su marca de conciliado), Impuesto, Trámite, GMF, Logística, Trámite digital |
| Cómo se amplía | Tres botones «Compactar / Mostrar todas» en la fila de grupos, uno por sección, más «3 de 9» | **Un** botón de texto en la línea del conteo: «Mostrar todas las columnas» / «Compactar columnas». La fila de grupos solo titula |
| Dónde está «todo» | Implícito | Junto al control, solo en compacta: «Las demás van en el Excel · Exportar a Excel» (enlace al botón de la cabecera) |
| Memoria | Tres claves, por sección; ausencia = ampliada | Una clave; ausencia = compacta |

**Se ve primero:** Flit, Placa, Empresa, Tipo trámite, Fechas (aprobación), Factura DIAN, Total, el
chip de **Liquidación** y la acción de la fila. Eso decide «abro esta fila / liquido / no». **Se calla, a
un clic:** los conceptos sueltos, el titular, VIN, Marca, Línea, Mes y Trimestre — se consultan, no se
operan; lo que hace falta para decidir ya está dicho en la fila (`Falta: SOAT, Impuesto` junto a
Liquidar y en el `title` del subtotal). **Se calla del todo:** nada; lo ampliado sigue siendo lo mismo de
la #12434.

**Primaria:** **Liquidar** (fila / `Liquidar N`), sin cambio. El control de columnas es un botón de texto
(`flit-focus`, subrayado, `--flit-blue-text`), como lo eran los tres de sección: no compite.

**Densidad:** **aliviada**. 28 → 12 columnas de datos al entrar (era 18 en la compacta anterior). Solo
`Fechas` sigue a dos líneas. Ampliar es opción, y ahora también compacta Valores, así que «todo» en
pantalla es más denso que antes solo por decisión del usuario.

## Línea del conteo y control (lo único que se dibuja)

Compacta (arranque):

```
312 trámites · página 1 de 7 · 12 de 28 columnas · [Mostrar todas las columnas]      [← Anterior] [Siguiente →]
Las demás van en el Excel · Exportar a Excel
```

Ampliada:

```
312 trámites · página 1 de 7 · 28 columnas · [Compactar columnas]                    [← Anterior] [Siguiente →]
```

- Todo en la línea de `Paginacion` **superior** (la inferior queda como está: solo conteo y botones).
  `flex-wrap`, así que en una ventana estrecha la segunda frase baja de línea sola.
- «Las demás van en el Excel · Exportar a Excel» es **una** frase `text-xs` con `--flit-text-secondary`
  y **solo** existe en compacta: en ampliada no hay nada oculto que explicar.
- «Exportar a Excel» ahí es `<a href="#exportar-excel">` que lleva el foco al botón de la cabecera
  (`id="exportar-excel"`), **no** un segundo disparador: un solo botón, un solo estado «Generando…»,
  una sola banda de resultado (D-05 de la spec de exportar). El botón ya tiene debajo «Todo el filtro con
  todas sus columnas, no solo esta página.»; las dos frases dicen cosas distintas (columnas vs páginas).
- La fila de grupos conserva **Identificación · Datos del trámite · Valores** con `scope="colgroup"` y
  `colSpan` = columnas visibles del grupo (ya se calcula así con `delGrupo`); pierde botones y «n de m».

## Estados (4) + copy

| Estado | Qué se ve | Cambio en esta HU |
|---|---|---|
| **Cargando** | Como hoy: sin esqueleto del detalle (deuda declarada en la #12434, no se paga aquí). La preferencia se lee de `localStorage` **en el `useState` inicial**, así que no hay parpadeo ampliada → compacta | Ninguno. Si el frontend-agent decide pagar la deuda, el esqueleto lleva las **12** columnas de la compacta, no 28 |
| **Error** | Banda roja del detalle + «Reintentar» de los contadores, como hoy. La tabla no se monta, así que no hay control | Ninguno |
| **Vacío** | `FlitEmpty` **«No hay trámites que coincidan con los filtros.»** (el siguiente paso —cambiar filtro o periodo— lo da la tarjeta de filtros justo encima, con «Limpiar filtros»). La tabla no se monta; sin control ni frase del Excel | Ninguno |
| **Lleno · compacta** (por defecto) | 12 columnas, línea «12 de 28 columnas · Mostrar todas las columnas» y «Las demás van en el Excel · Exportar a Excel». Pie con «Totales (N trámites del filtro)» bajo Empresa y los totales de **Total reintegro, Servicio y Total** | **Nuevo estado inicial** |
| **Lleno · ampliada** | 28 columnas, línea «28 columnas · Compactar columnas», sin frase del Excel. Pie con los diez totales de Valores | Antes era el inicial; ahora es opción recordada |

Copys fijos: **«Mostrar todas las columnas»**, **«Compactar columnas»**, «12 de 28 columnas» /
«28 columnas» (cifras calculadas de `COLUMNAS`, nunca escritas), **«Las demás van en el Excel»**,
enlace **«Exportar a Excel»**. Anuncios (`role="status"`): **«Vista compacta: 12 de 28 columnas.»** /
**«Todas las columnas: 28.»**

## Pie de totales (confirmado)

`TotalesReporteCostos columnas={visibles}` recorre la **misma lista** que la cabecera y el cuerpo: en
compacta el pie trae solo Total reintegro, Servicio y Total; los siete conceptos aparecen al ampliar. El
rótulo «Totales (N trámites del filtro)» cae en la primera columna visible (Empresa) en los dos modos.
**No se toca.** El aviso «El total mostrado está incompleto… Ver cuáles» sigue encima de la tabla y no
depende de qué columnas haya.

## Accesibilidad

- Control: `<button type="button" aria-expanded={ampliada}>` con texto visible («Mostrar todas las
  columnas» → `aria-expanded="false"`; «Compactar columnas» → `"true"`). Sin `aria-controls`: controla
  columnas, no un panel (misma razón que en la #12434).
- Al pulsar, **el foco se queda en el botón**; solo cambia su texto. Sin `scrollIntoView` ni mover nada.
- Anuncio por la región `role="status"` **existente** de la página (`anuncio`): «Vista compacta: 12 de
  28 columnas.» / «Todas las columnas: 28.» El estado de columnas vive en la página (o la tabla recibe
  `onCambio`), lo que haga falta para no montar una segunda región (D-08 de la spec de exportar).
- Cabecera: fila 1 con tres `th[scope="colgroup"]` cuyo `colSpan` cambia con el modo (3/5/4 en compacta,
  9/9/10 en ampliada); fila 2 con un `th[scope="col"]` por columna visible (`FlitTh` lo pone). La casilla
  y Acciones siguen con `rowSpan={2}`.
- Enlace «Exportar a Excel»: `<a href="#exportar-excel">`, texto visible igual al del botón al que lleva;
  el botón de la cabecera recibe `id="exportar-excel"` solo en Detalle. Al activarlo, el foco cae en el
  botón (el navegador desplaza); si está `disabled` por «Generando…», el foco cae igual y el rótulo ya
  lo explica.
- Contraste: botón de texto y enlace con `--flit-blue-text`; frase con `--flit-text-secondary`. Sin
  animación, sin transición al cambiar el número de columnas.

## Copy propuesto para la ficha de ayuda (`finanzas_reporte_costos.md`, usted)

**Paso 3** — sustituir entero por:

> 3. Lea la tabla en tres secciones: **Identificación**, **Datos del trámite** y **Valores**. Arranca en
> **vista compacta** —empresa, **Flit** y placa; tipo, **OT**, estado, fechas y **Factura DIAN**;
> **Total reintegro**, **Servicio**, **Total** y **Liquidación**— para que quepa en la pantalla sin
> desplazarse. **Mostrar todas las columnas**, sobre la tabla, enseña las 28: VIN, el titular con su
> **Tipo** y **Documento**, marca, línea, **Mes**, **Trimestre** y cada concepto (SOAT, impuesto,
> **Trámite**, GMF, logística y trámite digital). **Compactar columnas** vuelve a la vista corta. La
> elección se recuerda en este navegador. Para ver todos los campos a la vez, **Exportar a Excel** trae
> siempre las columnas completas, tenga la tabla como la tenga. Un concepto vacío se nombra: **No
> configurado**, **Sin recibo**, **Sin pagar**, **Autogestiona** o **No aplica**; nunca se pinta $0.

**Sección «Estados», viñeta «Lleno»** — sustituir «tabla en tres secciones con **Liquidación**
(**Estimado** / **Liquidado** / **Facturado**), conceptos, **Total reintegro**, **Servicio**, **Factura
DIAN** y acciones.» por «tabla compacta en tres secciones con **Liquidación** (**Estimado** /
**Liquidado** / **Facturado**), **Total reintegro**, **Servicio**, **Total**, **Factura DIAN** y
acciones; los conceptos, al pulsar **Mostrar todas las columnas**.»

El paso 4 («En **Valores**, **Total reintegro** suma…») y el paso 7 (exportar) no cambian.
Comprobar con `rg -n "Mostrar todas\b|Compactar\b" apps/web/src/content/ayuda/finanzas_reporte_costos.md`
que no queda el copy viejo sin «columnas».

## Notas para QA (≤10)

1. Sin nada en `localStorage`: al cargar, `thead tr:nth-child(2)` tiene exactamente **12** `th[scope=col]` en este orden: Empresa, Flit, Placa, Tipo trámite, OT, Estado, Fechas, Factura DIAN, Total reintegro, Servicio, Total, Liquidación. Los tres `th[scope=colgroup]` tienen `colSpan` 3, 5 y 4. *Mutante:* Valores con `compactable: false`.
2. El botón «Mostrar todas las columnas» tiene `aria-expanded="false"`; hay **uno**, no tres (`getByRole('button', {name: /columnas/})` → 1). *Mutante:* dejar los botones de sección.
3. Pulsarlo → 28 `th[scope=col]`, texto «Compactar columnas», `aria-expanded="true"`, `colSpan` 9/9/10, `document.activeElement` sigue siendo el botón, y `role="status"` dice «Todas las columnas: 28.».
4. Tras ampliar y `reload`: sigue ampliada (clave `flito.reporteCostos.columnas` = `todas`). Con la clave borrada → compacta. Con las claves viejas `flito.reporteCostos.seccion.*` en `ampliada` y la nueva ausente → **compacta** (se ignoran). *Mutante:* leer las claves viejas.
5. En compacta se ve «12 de 28 columnas» y «Las demás van en el Excel · Exportar a Excel»; en ampliada, «28 columnas» y **no** está la frase. Las cifras salen de `COLUMNAS.length`: añadir una columna al array las mueve solas. *Mutante:* `28` escrito.
6. El enlace «Exportar a Excel» de la línea del conteo es `a[href="#exportar-excel"]`; activarlo lleva el foco al botón de la cabecera y **no** dispara ningún `POST …/export` (contar en red). *Mutante:* segundo disparador.
7. Pie en compacta: celdas con total bajo Total reintegro, Servicio y Total; ninguna bajo Empresa…Factura DIAN salvo el rótulo «Totales (N trámites del filtro)» en la primera. Al ampliar aparecen los siete totales de conceptos. *Mutante:* pie recorriendo `COLUMNAS` en vez de `visibles`.
8. Fila con `soatConciliado: true`: la marca de conciliado **no** se ve en compacta y sí en ampliada (vive en la celda SOAT). Fila bloqueada: «Falta: SOAT» sigue junto a Liquidar en compacta.
9. Viewport 1366×768 con el menú lateral abierto, 10 filas con acciones (Soporte + Liquidar + Enviar): `overflow-x-auto` **sin** desplazamiento (`scrollWidth === clientWidth`). Si lo hay, aplica D-10 y se vuelve a medir.
10. `auditor`: ve el control, amplía y compacta, ve la frase y el enlace; sigue sin casillas ni acciones. El e2e «AC1» de la #12434 (`finanzas-reporte-costos.spec.ts:1463-1481`) asume arranque ampliado y tres botones: se reescribe con los puntos 1-4, no se «arregla» a medias.

## Decisiones (D-nn) para el frontend-agent

| # | Decisión | Descarte |
|---|---|---|
| D-01 | **Arranque compacto** en las tres secciones; **Valores pasa a ser compactable**. Ausencia de preferencia = compacta | Mantener Valores siempre entera: son 10 columnas y es donde más scroll pedía el PO |
| D-02 | Conjuntos compactos: Identificación = Empresa, Flit, Placa · Datos = Tipo trámite, OT, Estado, Fechas, Factura DIAN · Valores = Total reintegro, Servicio, Total, Liquidación (**12**) | Titular en compacta; conceptos en compacta; quitar Factura DIAN (es la ficha de emisión, se opera desde ahí) |
| D-03 | **Un** control global sustituye a los tres de sección y a los contadores «n de m» de la fila de grupos. La fila de grupos solo titula | Cuatro controles (tres + global): tres decisiones que el operador no vino a tomar, y estados intermedios (Identificación abierta, Valores cerrada) que no responden a ninguna visita |
| D-04 | El control va en la línea de `Paginacion` **superior**, tras el conteo: «12 de 28 columnas · Mostrar todas las columnas». No se repite abajo. Copys exactos: «Mostrar todas las columnas» / «Compactar columnas» | En la fila de grupos (ya no hay sección que lo ancle); en la cabecera de la página (compite con el conmutador y el export); «Mostrar todas» a secas (ya no dice todas *qué*) |
| D-05 | Frase «Las demás van en el Excel · Exportar a Excel» bajo el control, `text-xs`, **solo en compacta**; el enlace es `href="#exportar-excel"` al botón de la cabecera, que recibe ese `id` | Segundo botón o segundo disparador del export; frase permanente en ampliada; frase en el vacío (no hay tabla ni columnas ocultas) |
| D-06 | `localStorage`: **una** clave `flito.reporteCostos.columnas` con valor `todas`; cualquier otra cosa = compacta. Las tres `flito.reporteCostos.seccion.*` se ignoran (no se migran ni se borran). Sin almacenamiento (modo privado): compacta y no se recuerda | Honrar «ampliada» de las claves viejas: el PO pide que **todos** arranquen compactos una vez; quien quiera ampliado lo pulsa y queda recordado |
| D-07 | `aria-expanded` en el control; foco quieto; anuncio por la región `role="status"` existente («Vista compacta: 12 de 28 columnas.» / «Todas las columnas: 28.»); `scope="colgroup"` + `colSpan` de visibles por grupo (ya calculado) | Segunda región de estado; mover el foco a la tabla; `aria-controls` |
| D-08 | Pie de totales: **sin cambio**, `columnas={visibles}` ya recorre solo lo visible | Pie fijo con los diez totales aunque las columnas estén ocultas (total sin su cabecera) |
| D-09 | Titular: **no** se fusiona en una columna «Titular» ni entra en compacta. Ampliada conserva Nombres, Apellidos, Razón social, Tipo, Documento (orden de la #12434) | Columna «Titular» = nombre + documento en compacta: PII en cada fila para los tres roles sin que la visita lo pida (Ley 1581); quien factura lo resuelve la ficha «Factura DIAN» / «¿Por qué no?». Rehacer la ampliada es alcance no pedido |
| D-10 | Si en 1366×768 con menú abierto la compacta desborda (nota QA 9), se quita **Estado** de la compacta (el filtro ya acota a Aprobado y `Fechas` dice «Sin aprobar»); nada más se quita sin PO | Quitar OT (entró por AC explícito de la #12434) o Empresa (a quién se cobra); añadir columna fija |
| D-11 | No se añade columna «Flit» fija (`sticky`): la spec de la #12434 la pedía, nunca se implementó, y con 12 columnas ya no hace falta. En ampliada el scroll es opción del usuario | Pagar ahora ese `sticky`: patrón que la tabla no tiene y que solo serviría al modo que deja de ser el inicial |
| D-12 | Ficha de ayuda: paso 3 y viñeta «Lleno» con el copy de arriba | Dejar «Compactar / Mostrar todas … de una sección» |
| D-13 | Lo que no cambia y se prueba que no cambia: filtros, periodo, OT, consolidado, casillas, Liquidar/Facturar/Reversar/Soporte/Enviar/¿Por qué no?, contadores FE, tarjeta de envío, exportar y su banda, `Paginacion` inferior | — |

Nada de lo anterior requiere componente nuevo. Cómo se comparte el estado de columnas entre la tabla y
la región `anuncio` de la página (levantar el `useState` o pasar `onCambio`) lo decide el
frontend-agent; lo que **no** se decide en código es nada de esta tabla.

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /tmp/claude-1000/-home-david-flit-flito/fbc41387-2d4d-46ce-85fb-a9a4fbb234f8/scratchpad/docs-ux/finanzas-reporte-costos-tabla-compacta.md → docs/ux/ (lo traslada el hilo al worktree de la HU)
  Oficio: primaria única (Liquidar; el control es botón de texto) | jerarquía dicha (12 columnas de operar; 16 al Excel o a un clic) | vacío y error sin cambio y con su siguiente paso ya existente | sin efectos
  Densidad: aliviada (28 → 12 columnas de datos al entrar; ampliar es opción recordada)
  Pantallas: 1 (1 vista, 1 control) | Requerimientos nuevos de datos: ninguno (todo es de pantalla; el Excel ya trae las 36 desde la HU #12532)
  Siguiente: frontend-agent con D-01..D-13; QA reescribe el e2e AC1 de la #12434 (nota 10). Sin pregunta al PO salvo que la nota 9 falle tras aplicar D-10.
```
