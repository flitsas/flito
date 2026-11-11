# UX full: Finanzas › Reporte de costos, rediseño de tabla y filtros (Épica #13763)

Mockup: `docs/ux/mockups/flito-reporte-costos.html` (enlaza `flito-reporte-costos.css`, que compila el hilo).
Las vistas se eligen con `?vista=lleno|cargando|error|vacio|filtros|periodo|columnas|consolidado`.

**Estado:** el humano eligió la dirección «Esencial + desglose», con dos grupos de dinero. Esta spec
**absorbe** el delta slim de las columnas de costo de proveedor, así que no hay un
`flito-reporte-costos-proveedor.md` aparte.

- **Público:** operador interno. `financiera` y `admin` operan; `auditor` solo lee.
- **Slug:** `finanzas_reporte_costos`, el mismo de hoy. No hay página ni permiso nuevos.
- **Tono:** la pantalla tutea, como hoy («Prueba otro periodo», «Desmarca…»). La ficha de Ayuda trata de **usted**.

---

## 1. Diagnóstico (breve)

Medido en la pantalla real (local, octubre de 2026, 2.216 trámites, ventana de 1366 px) y leído en
`FinanzasReporteCostos.tsx`, `TablaReporteCostos.tsx`, `FiltrosReporteCostos.tsx`,
`ConsolidadoReporteCostos.tsx`, `ExportarReporteCostos.tsx`, `tiposReporteCostos.ts` y
`finanzas.reporte-columnas.ts`.

| # | Problema | Principio que falla |
|---|---|---|
| D-1 | En la vista ampliada hay 30 columnas que suman ~3.800 px en una ventana de 1.250 px, y los valores llegan después del titular, la marca y la línea. El conmutador es binario: compacta (9) o todas (30). Para ver el SOAT hay que abrirlas todas. | Qué se ve primero · densidad |
| D-2 | Las filas miden ~225 px porque las acciones envuelven (hasta 7 botones, el campo de motivo del reverso en línea, «Falta:») y algunas celdas tienen dos renglones. | Densidad · lo que no es de esa visita |
| D-3 | «Valores» mezcla reintegro, servicio, un conteo (Viajes) y un estado (Liquidación). No hay sitio para el costo de proveedor sin confundirlo con lo cobrado. | Agrupación |
| D-4 | Los filtros ocupan 3 renglones con 3 alturas de control (pastillas de ~32 px, controles de 40 px, casillas sueltas). El periodo está **duplicado**: el selector Mes/Trimestre rellena el rango «Aprobación», que también está a la vista, y de ahí sale «Personalizado». | Una altura por barra · claridad |
| D-5 | «Exportar a Excel» queda suelto en la cabecera junto al conmutador de vista. Con selección hay 3 primarias a la vez (Liquidar n, Enviar n del lote y Enviar n de la tarjeta) y hay un botón con gradiente por fila. | Una primaria |
| D-6 | El error de la página y el del consolidado usan `text-red-600`, que no da el contraste en tema oscuro. El consolidado envuelve `FlitTable` en un segundo `overflow-x-auto`, así que tiene dos regiones de scroll. | Tema oscuro · responsive |
| D-7 | El subtítulo dice «Costos reales por trámite» y hoy nombra **lo cobrado**. Con «costo de proveedor», la palabra «costo» tendría dos sentidos en la misma pantalla. | Copy |

Los bloques de **facturación electrónica** (contadores y tarjeta de envío) y la banda de **total
incompleto** **se conservan en su función**. Solo se compactan a un renglón cada uno (§3.2).

---

## 2. Qué se ve / qué se calla

**Qué vino a hacer quien abre esto:** cerrar el periodo. Ver en una línea por trámite qué se le
cobra al cliente y qué se le paga al proveedor, qué falta, y liquidar, facturar o enviar.

| Siempre visible | A un clic | Fuera de la vista por defecto (disponible en «Columnas» y siempre en el Excel) |
|---|---|---|
| Lo **esencial** (trámite FLIT, placa, empresa, tipo, aprobación, liquidación, qué falta) y los bloques **Cobro al cliente** y **Costo de proveedor** | ⋮ de la fila: Soporte, Servicios, Viajes, Aceptar diferencia, Reversar, ¿Por qué no? · «Más filtros» · «Columnas» · periodo personalizado | VIN, Nombres, Apellidos, Razón social, Tipo de documento, Documento, Marca, Línea, OT, Estado, Creación, Mes, Trimestre, Factura DIAN, Viajes, Total reintegro, Servicio |

**Una primaria por superficie:**

| Situación | Primaria | Lo demás |
|---|---|---|
| Hay selección | «Liquidar n» de la barra de lote (o «Enviar n a facturación electrónica» si la selección solo tiene enviables) | Mientras hay selección la tarjeta de envío **se oculta**, porque la barra ya lleva su acción. La otra acción del lote pasa a secundaria. |
| No hay selección | «Enviar n a facturación electrónica» de la tarjeta de envío, cuando se monta | — |
| En las filas | — | La acción de la fila (Liquidar / Facturar / Enviar a facturación) es **secundaria**: la masiva es la de esta visita. |
| En la cabecera | — | Ninguna primaria: «Exportar a Excel» baja a la barra de la tabla como secundario. |
| Vista Consolidado | «Exportar consolidado» | Como hoy. |

---

## 3. Pantalla: Detalle

### 3.1 Wireframe (≥ lg, 1366 px)

```
┌ PageHeaderCard ──────────────────────────────────────────────────────────────────────────┐
│ Reporte de costos                                                   [Detalle|Consolidado] │
│ Lo que se cobra al cliente y lo que se paga al proveedor, trámite por trámite.            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌ Filtros (FlitCard, UNA barra, todo h-10, flex-wrap) ─────────────────────────────────────┐
│ (Todos 2.216)(Listos para liquidar 41)(Incompletos 12)(Por facturar 7)(Facturados 2.156)  │
│ [▦ Octubre 2026 ▾]  [🔍 Placa, VIN o trámite FLIT      ]  [Más filtros · 1 ▾]             │
│ Filtros: (Estado: Aprobado ✕) (Con diferencias ✕)                         Limpiar filtros │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌ Factura electrónica: (Sin enviar 18)(En cola 2)(Aceptada 2.130)(Requiere revisión 6) ─────┐  ← ContadoresFacturacion, 1 renglón
┌ ⓘ El total está incompleto: 12 de 2.216 trámites tienen un concepto sin resolver. Ver cuáles┐ ← 1 renglón, sin rojo
┌ 7 facturados se pueden enviar a facturación electrónica.  [Enviar 7 a facturación electr.] ┐ ← TarjetaEnvio, 1 renglón (PRIMARIA)
┌ Tabla (FlitCard) ────────────────────────────────────────────────────────────────────────┐
│ 2.216 trámites · página 1 de 222               [Columnas ▾] [Exportar a Excel]  [←] [→]   │
│┌FlitTable (scroll del kit) ──────────────────────────────────────────────────────────────┐│
││   ║FLIT  │PLACA ║ESENCIAL                          │COBRO AL CLIENTE    …     │COSTO DE PROVEEDOR …         ║   ││
││ ☐ ║Trám. │Placa ║Empresa│Tipo│Aprob.│Liquid.│Falta  │SOAT│Imp.│Der.│Log.│Dig.│Adic.│GMF│Total│C.SOAT│Prov.SOAT│C.Log.│Prov.log.│Total costos║ ⋯ ││
││ ☐ ║10231 │ZZA101║Demo Uno│Trasp│03-oct│Liquid.│—     │$512.300 … $1.095.218│$48.000│Seguros Demo│$35.000│Transp. Demo N.│$83.000║[Facturar]⋮││
││   ║Totales del filtro  ║                              │$ …  sumas por columna    │$ … sumas propias            ║   ││
│└────────────────────────────────────────────────────────────────────────────────────────┘│
│ 2.216 trámites · página 1 de 222                                                [←] [→]   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
 ║ = columna fija (sticky). Izquierda: casilla, Trámite y Placa. Derecha: acciones (solo ≥ lg).
```

### 3.2 Grupos y columnas (orden exacto)

La cabecera tiene dos filas: arriba el grupo (`scope="colgroup"`), debajo la columna. Todas las
celdas son de **un renglón** (`whitespace-nowrap`, `py-2`); la fila mide unos 40 px. Los montos van
a la derecha y en `tabular-nums`. Los textos largos se recortan con su `title`.

| # | Grupo | Columna (título) | Por defecto | Celda |
|---|---|---|---|---|
| 1 | — (fija) | casilla | sí (con `liquidar`) | solo en filas accionables, como hoy |
| 2 | — (fija) | **Trámite** | sí, fija | `idFlit`, semibold, tabular |
| 3 | — (fija) | **Placa** | sí, fija (≥ sm) | mono |
| 4 | Esencial | Empresa | sí | recortada, máx. 9rem |
| 5 | Esencial | Tipo | sí | tipo de trámite, recortado, máx. 7rem |
| 6 | Esencial | Aprobación | sí | `03-oct-26` o «Sin aprobar» (cursiva tenue) |
| 7 | Esencial | Liquidación | sí | `StatusChip`: Estimado (`draft`) / Liquidado (`active`) / Facturado (`success`) |
| 8 | Esencial | Falta | sí | `faltantes(f).join(', ')` recortado, o «—». Es lo que **bloquea** liquidar. El costo de proveedor nunca aparece aquí. |
| 9–16 | **Cobro al cliente** | SOAT · Impuesto · Derecho · Logística · Trámite digital · Adicionales · GMF · **Total** | sí | `Monto` de hoy, con los motivos de hoy. Total en semibold con `--flit-blue-text`. |
| 17–21 | **Costo de proveedor** | Costo SOAT · Proveedor SOAT · Costo logística · Proveedor logística · **Total costos** | sí | estados C1–C8 (§3.3). Total costos en semibold con `--flit-text-primary`, **sin** azul, para no confundirlo con el Total cobrado. |
| 22 | — (fija ≥ lg) | acciones | sí | un botón secundario (la acción que toca) más el ⋮ `MenuFila` |
| — | Más del trámite | Creación · Estado · OT · Mes · Trimestre · Factura DIAN · Marca · Línea · VIN | no | las celdas de hoy. Factura DIAN sigue abriendo su detalle. |
| — | Titular | Nombres · Apellidos · Razón social · Tipo de documento · Documento | no | las de hoy |
| — | Cobro al cliente (extra) | Total reintegro · Servicio · Viajes | no | se insertan en su sitio del grupo: Total reintegro tras GMF, Servicio y Viajes antes de Total |

**Separación visual de los grupos:** un borde izquierdo de 1 px `--flit-border-input` en la primera
celda de cada grupo, y el rótulo del grupo en la fila de grupos, como hoy (`ThGrupo`). Sin fondos de
color por grupo ni chips nuevos.

**Pie de totales:** «Totales del filtro» en las columnas fijas. Cada columna de dinero lleva su suma
del servidor. Total costos de proveedor tiene su propio pie, en su grupo, y **no** se suma a nada del
cobro.

**Lo que cambia en «Adicionales»:** antes se titulaba «Serv. adic.». La celda pierde el segundo
renglón (cuántos son); el número pasa al `aria-label` y al botón «Servicios · n» del ⋮.

### 3.3 Celda de costo de proveedor: estados C1–C8 (copy exacto)

> Numeración de esta spec. El coordinador citó «C1–C8», pero solo me llegaron seis estados por
> escrito. C7 (autogestión) y C8 (total) los completo yo por coherencia: hay que **confirmarlos**.

| Estado | Cuándo | Columna «Costo» | Columna «Proveedor» | `title` / `aria-label` |
|---|---|---|---|---|
| **C1** valor sellado | liquidado después de este cambio | `$ 48.000` | `Seguros Demo` | «Costo proveedor SOAT: $ 48.000, Seguros Demo» |
| **C2** valor estimado | sin liquidar (cálculo en vivo) **o** liquidado antes de este cambio | `$ 48.000` + `estimado` (xs, cursiva, `--flit-text-muted`, en el mismo renglón) | `Seguros Demo` | «…estimado: puede cambiar hasta que se liquide» / «…estimado: el trámite se liquidó antes de que FLITO guardara este costo» |
| **C3** sin configurar | el proveedor no tiene valor para ese concepto | `Sin configurar` (cursiva tenue, como `Monto`) | `Seguros Demo` | «El proveedor no tiene costo configurado. No impide liquidar.» |
| **C4** sin proveedor | logística sin entrega con proveedor | `Sin proveedor` | `—` | «Este trámite no tuvo entrega con proveedor.» |
| **C5** gestionado por Operaciones | SOAT en contingencia | `Gestionado por Operaciones` | `—` | «SOAT en contingencia: lo gestiona Operaciones.» |
| **C6** ya contado | SOAT compartido: el costo se carga solo al primer trámite | `Ya contado en el trámite 10234` | `—` | «El SOAT es compartido y su costo se cargó al trámite 10234.» |
| **C7** no aplica | la compañía autogestiona el concepto | `—` | `—` | «La compañía lo gestiona: no hay costo de proveedor.» |
| **C8** total | Total costos de proveedor | suma de los costos con valor. Si alguno es **C3**, añade `parcial` (xs, cursiva, tenue). Si alguno es **C2**, añade `estimado`. Si no hay ningún valor: el texto del estado (`Sin configurar` si alguno es C3; si no, `—`). | — | «Total costos de proveedor: $ 35.000, parcial: falta el costo SOAT (sin configurar)» |

- **Logística:** es un valor fijo por trámite, no por viaje, del proveedor que hizo la **primera** entrega.
- **Sin rojo:** todos los estados usan la tinta tenue de `Monto`. Ningún estado lleva color de alarma porque ninguno bloquea; el texto dice lo que pasa.
- **El cobro no cambia de copy, salvo una cosa:** «No configurado» pasa a **«Sin configurar»**, para que el mismo hecho se diga igual en los dos grupos (`TEXTO_FALTA.tarifa`). → **Confirmar con el humano** (Q1).

### 3.4 Filtros: antes → después (no se pierde ninguno)

| Antes | Después | Dónde |
|---|---|---|
| Pastillas de etapa con cuenta (5) | igual, h-10 | barra, primer control: **el filtro principal** |
| Selector de periodo Mes/Trimestre + año + índice | **un solo control «Periodo»** (`<details>`, patrón de `RangoFechas` y `FiltrosInteligentes`). El resumen dice «Octubre 2026» / «T4 2026» / «1 oct – 15 oct 2026». Dentro: [Mes \| Trimestre], año, mes o trimestre, y «Rango personalizado» con desde y hasta. | barra |
| Rango «Aprobación» (visible, duplicado) | **desaparece como control suelto**: es el «Rango personalizado» del Periodo. Mismo campo (`aprobadoDesde/Hasta`). | dentro de Periodo |
| Buscar (placa, VIN o trámite) | igual, h-10 | barra |
| Empresa | select | Más filtros |
| Tipo de trámite | select | Más filtros |
| Estado (multi, por defecto Aprobado) | `FiltroMulti` | Más filtros. Su valor por defecto se ve **siempre** como chip «Estado: Aprobado». |
| OT (multi) | `FiltroMulti` | Más filtros |
| Rango «Creación» | `RangoFechas` | Más filtros |
| ☐ Solo con soportes completos | casilla | Más filtros |
| ☐ Con diferencias (`?conDiferencias=si`) | casilla, y la URL se conserva | Más filtros |
| — (nuevo) | ☐ **Costo de proveedor sin configurar** (al menos un C3). Viaja como booleano, sin PII. | Más filtros |
| Contadores FE (filtran `estadoFe`) | igual, compactados a 1 renglón; siguen siendo un filtro | bloque propio, como hoy |
| «Ver cuáles» (total incompleto) · «Ver por facturar» (tarjeta) | iguales: ponen la etapa | sus bandas |
| Limpiar filtros | enlace-botón al final de la fila de chips, solo si hay algo distinto del punto de partida | fila de chips |

- **Más filtros:** `<details>` con resumen «Más filtros · n», donde n cuenta los filtros puestos dentro. El panel es una rejilla `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` de 40 px por control, con las tres casillas juntas abajo y un botón «Cerrar». **Sin «Aplicar»:** cada cambio filtra al momento, como hoy, y no añade una segunda primaria.
- **Chips de filtros activos:** uno por filtro con valor, por ejemplo «Empresa: Compañía Demo Uno ✕», «Con diferencias ✕» o «Creación: 1 oct – 15 oct ✕». La ✕ quita ese filtro. La etapa y el periodo no van como chip porque ya se leen en su control. El «Estado: Aprobado» por defecto sí sale como chip, para que un valor por defecto oculto no recorte la tabla sin que se note.
- **Limpiar filtros** vuelve a Aprobado más el mes en curso, como hoy.

### 3.5 Barra de la tabla

`2.216 trámites · página 1 de 222` · `[Columnas ▾]` · `[Exportar a Excel]` · `[← Anterior] [Siguiente →]`.

- **Columnas** (`<details>`) tiene casillas por grupo: Esencial, Cobro al cliente, Costo de proveedor, Más del trámite, Titular. Trámite y Placa no se pueden ocultar. Abajo, «Restablecer columnas».
  - La preferencia se guarda en una clave nueva, `flito.reporteCostos.columnas.v2` (la lista de columnas visibles). La clave vieja `flito.reporteCostos.columnas` se ignora.
  - Al cambiar se anuncia por la región `role="status"`: «Columnas: 21 de 39 visibles.» (cifras calculadas, nunca escritas a mano).
- **Exportar a Excel** es secundario y conserva el `id="exportar-excel"`. Su ayuda («Todo el filtro con todas sus columnas, no solo esta página.») pasa al `title` y a la ficha. La banda del resultado del export no cambia.

### 3.6 Acciones de fila

Hoy la fila tiene hasta 7 botones. Pasa a **un botón secundario y el ⋮** (`MenuFila`, el del kit):

| Estado de la fila | Botón visible | Menú ⋮ |
|---|---|---|
| Estimado y liquidable | Liquidar | Soporte · Servicios · n · Viajes · n · Aceptar diferencia (si hay pendientes y hay permiso) |
| Estimado con Falta | Liquidar, desactivado, con `title` «Falta: Impuesto». El motivo ya se lee en la columna Falta. | igual |
| Liquidado | Facturar | igual + Reversar… (abre `FlitModal` con el motivo; ya no es un campo en línea) |
| Facturado y candidato FE | Enviar a facturación | igual + ¿Por qué no? (si no es elegible) |
| Facturado sin acción | — | Soporte · Servicios · Viajes |

Sin el permiso correspondiente, la opción **no se pinta**: es la misma regla de hoy, aplicada al menú.

### 3.7 Estados (4)

| Estado | Qué se ve | Copy |
|---|---|---|
| Cargando | Barra de filtros activa. En la barra de la tabla, «Cargando trámites…». 8 filas de esqueleto **con las mismas columnas y grupos**, con barras `--flit-bg-app`. El pie no se muestra. Los contadores FE dicen lo de hoy. | «Cargando trámites…» |
| Error | En la tarjeta de la tabla, un aviso `role="alert"` con tinta primaria, borde `--flit-border-input` e icono de información. **Sin rojo.** Los filtros siguen usables. | «No se pudo cargar el reporte. Revisa tu conexión y vuelve a intentarlo.» · **[Reintentar]** |
| Vacío (genérico) | `FlitEmpty` en la tarjeta de la tabla | «No hay trámites que coincidan con los filtros en octubre 2026.» · «Prueba otro periodo o quita un filtro.» · **[Limpiar filtros]** |
| Vacío con «Con diferencias» | igual | el `VACIO_CON_DIFERENCIAS` de hoy |
| Vacío con «Costo de proveedor sin configurar» | igual | «Todos los trámites de este filtro tienen su costo de proveedor configurado.» · «Desmarca «Costo de proveedor sin configurar» para verlos todos.» |
| Lleno | §3.1 | — |

El error de una **acción** (liquidar, facturar, reversar) sigue en el aviso de página de hoy, pero
pasa de `text-red-600` a la tinta `--flit-danger-ink` del kit (D-6).

### 3.8 Copy (resumen)

| Lugar | Texto |
|---|---|
| Subtítulo | «Lo que se cobra al cliente y lo que se paga al proveedor, trámite por trámite.» |
| Grupos | «Cobro al cliente» · «Costo de proveedor» |
| Columnas nuevas | «Costo SOAT» · «Proveedor SOAT» · «Costo logística» · «Proveedor logística» · «Total costos» |
| Columna Falta (`title` de la cabecera) | «Lo que impide liquidar el trámite.» |
| Cabecera del grupo Costo de proveedor (`title`) | «Lo que FLITO le paga al proveedor. No se suma al cobro.» |
| Estados de costo | §3.3 |
| Más filtros | «Más filtros» · «Más filtros · 2» · casilla «Costo de proveedor sin configurar» (`title`: «Trámites con al menos un costo de proveedor sin configurar. No impide liquidar.») |
| Periodo | «Periodo» · «Mes» · «Trimestre» · «Rango personalizado» · «Desde» · «Hasta» |
| Chips | «Filtros:» · «Quitar filtro Empresa: Compañía Demo Uno» (`aria-label`) · «Limpiar filtros» |
| Columnas | «Columnas» · «Restablecer columnas» |
| Total incompleto | «El total está incompleto: 12 de 2.216 trámites tienen un concepto sin resolver.» · «Ver cuáles» |

---

## 4. Pantalla: Consolidado

- **Columnas:** Cliente · Periodo · Trámites, luego el grupo **Cobro al cliente** (las columnas de hoy: SOAT, Impuesto, Trámite, GMF, Logística, Total reintegro, Trámite digital, Servicio, Total), luego el grupo **Costo de proveedor** (Costo SOAT, Costo logística, Total costos) y al final Incompletos.
- **Cabecera:** dos filas con los grupos, como el detalle.
- **Sin margen ni resta** cobro − costo: no se pidió. Si se quiere, es una HU aparte (Q3).
- **Pie** «Totales del filtro» con las sumas de cada grupo por separado.
- **Correcciones:** se quita el `div.overflow-x-auto` que envuelve a `FlitTable` (D-6) y el error pasa de `text-red-600` a aviso sin rojo, con «No se pudo calcular el consolidado. Vuelve a intentarlo.» y [Reintentar].
- Cargando y vacío, como hoy.

## 5. Excel

- **Detalle:** las 32 columnas de Financiero **no se mueven ni se renombran**. Al final se añaden 5: «Proveedor SOAT», «Costo proveedor SOAT», «Proveedor logística», «Costo proveedor logística» y «Total costos de proveedor».
  - Las celdas de costo son **numéricas o vacías**. El motivo de una celda vacía (Sin configurar, Sin proveedor, Gestionado por Operaciones, Ya contado en el trámite N, estimado) va en una 6.ª columna, «Estado costo de proveedor», que los junta por concepto. Por ejemplo: «SOAT: sin configurar · Logística: estimado».
  - Así no hay texto en una columna que Excel tiene que sumar. → Confirmar (Q2).
- **Consolidado:** al final, «Costo proveedor SOAT», «Costo proveedor logística» y «Total costos de proveedor».
- Las columnas visibles de la pantalla **no** afectan al Excel, como hoy.

## 6. Responsive (< lg)

| Superficie | Comportamiento |
|---|---|
| Cabecera | El conmutador Detalle/Consolidado se apila bajo el título. |
| Barra de filtros | Envuelve. Las pastillas de etapa ocupan su propio renglón y envuelven. Periodo, Buscar y Más filtros van a ancho completo (`w-full sm:w-auto`). El panel de Más filtros es de 1 columna (`sm:` 2). Los chips envuelven. |
| Bloques FE, total incompleto y tarjeta de envío | Envuelven: el texto arriba y el botón debajo, a ancho completo. |
| Barra de la tabla | El conteo en un renglón; Columnas, Exportar y la paginación envuelven debajo. |
| Tabla | El scroll del kit (`FlitTable`), **nunca** el de la página. Solo **Trámite** queda fijo; Placa deja de serlo por debajo de `sm`. Las acciones dejan de ser fijas por debajo de `lg` y quedan al final de la fila. |
| Consolidado | El scroll del kit, sin columnas fijas. |

## 7. Interacción y notificaciones

- **Feedback:**
  - Pastillas, chips, ✕, summary de Periodo, Más filtros y Columnas, ⋮, botones de fila y paginación: hover con velo `--flit-bg-hover` y `transition-colors`, foco `flit-focus`.
  - Las filas **no** son clicables, así que no llevan hover de fila más allá del de `FlitTr`.
  - Las celdas fijas conservan el fondo de la tarjeta (`bg-flit-card`) para que el contenido no se transparente al desplazar, y su borde derecho es de 1 px `--flit-border-input`.
- **Toast o aviso:**

| Evento | Patrón |
|---|---|
| Liquidar, facturar, reversar, aceptar diferencia | Aviso de página, como hoy, con frases pulidas («10231 liquidado.»). Nunca el error crudo del API. |
| Filtros, columnas, cambio de vista | No llevan toast: los chips y los controles son el estado persistente. El cambio de columnas se anuncia por `role="status"`. |
| Export | La banda de hoy (`AvisoVisible`), sin cambios. |

## 8. Accesibilidad

- **Tabla:** la fila de grupos usa `scope="colgroup"` con su `colSpan` contado de las columnas visibles. La tabla conserva el `aria-label` «Reporte de costos, detalle».
- **Celdas de costo:** `aria-label` completo, con el concepto, el valor o el estado, el «estimado» o «parcial» y el proveedor. El texto del estado nunca depende del color.
- **Controles plegables:** Periodo, Más filtros y Columnas son `<details>`/`<summary>` con nombre visible. El panel se cierra con Esc y devuelve el foco al summary, como `FiltrosInteligentes`.
- **Chips:** son botones con `aria-label` «Quitar filtro …». Al quitar uno, el foco pasa al chip siguiente o a «Limpiar filtros».
- **Menú de fila:** el ⋮ es `MenuFila`, con teclado WAI-ARIA y `aria-label` «Más acciones de 10231».
- **Contraste y orden:** las celdas fijas no tapan el anillo de foco (`flit-focus-inset` en la región). El contraste es ≥ 4.5:1 en claro y oscuro con los tokens actuales; no hay tokens nuevos.

## 9. Datos: lo que pide el contrato (sin endpoints nuevos)

Mismos endpoints: `GET /finanzas/reporte-costos`, `/consolidado`, `/facetas` y el `POST` del export.
Cambian estos campos, a confirmar con `architecture-agent`/`backend-agent` de la épica:

- **`Fila`:** `costoProveedorSoat` y `costoProveedorLogistica`, cada uno `{ valor: number|null, estado: 'valor'|'sin_configurar'|'sin_proveedor'|'gestionado_operaciones'|'ya_contado'|'no_aplica', estimado: boolean, proveedorNombre: string|null, tramiteReferencia: string|null /* idFlit, C6 */ }`, más `totalCostosProveedor: { valor: number|null, parcial: boolean, estimado: boolean }`. La pantalla **no** suma nada.
- **`Totales` y `FilaConsolidado`:** `costoProveedorSoat`, `costoProveedorLogistica` y `totalCostosProveedor` (number).
- **Filtro:** `sinCostoProveedor=si` en los GET y `sinCostoProveedor: true` en el cuerpo del export, calcado de `conDiferencias`. Es un booleano, sin PII.
- **Etapa:** el Resumen de etapas no cambia, porque el costo de proveedor no bloquea.

### 9.1 Qué cambia por archivo

- **`apps/api/src/modules/finanzas/finanzas.reporte-columnas.ts`:** hoy **no** decide qué columnas se ven por defecto ni sus grupos (eso vive en `TablaReporteCostos.tsx`). Proyecta el titular, la OT, el periodo y los subtotales.
  - Aquí cambia: si backend decide componer el costo de proveedor en `SELECT_FILA` por este archivo, se añaden sus `SELECT_*`, su `*DeFila` y los campos a `ConceptosDeFila`/`ColumnasDeFila`.
  - También aquí: las etiquetas de `CONCEPTO` (líneas 142–143) suman «Costo proveedor SOAT» y «Costo proveedor logística» si se usan para nombrar pendientes.
  - El orden del Excel (las 32 más 6) vive en el módulo del export, no en este archivo.
- **`apps/web/src/components/finanzas/TablaReporteCostos.tsx`:**
  - `Grupo` pasa a `'fija'|'esencial'|'cobro'|'costo'|'tramite'|'titular'`.
  - `COLUMNAS` se reordena según §3.2, y `compacta` se sustituye por `porDefecto`.
  - El binario compacta/ampliada da paso al panel «Columnas», con la clave `v2`.
  - Se añaden las columnas fijas y las celdas C1–C8.
- **`tiposReporteCostos.ts`:** los tipos nuevos, `TEXTO_FALTA.tarifa = 'Sin configurar'` (si Q1 = sí) y `FiltrosDetalle.sinCostoProveedor`.
- **`FiltrosReporteCostos.tsx`:** la barra única, Periodo con el rango personalizado, Más filtros y los chips.
- **`ConsolidadoReporteCostos.tsx`:** los grupos, el bloque de costo, un solo scroll y el error sin rojo.

## 10. Delta de la ficha `finanzas_reporte_costos.md` (versión 2.0)

| Sección | Cambio |
|---|---|
| frontmatter | `version: 2.0` y la fecha. Consultas: «cuánto le pago al proveedor por un trámite», «qué es costo de proveedor sin configurar». |
| Qué es | Una frase: el reporte muestra lo que se **cobra al cliente** y, aparte, el **costo de proveedor**, que es lo que FLITO le paga y no se suma al cobro. |
| Pasos 1–2 | Se reescriben: una barra con la etapa, el **Periodo** (que incluye el rango personalizado), la búsqueda y **Más filtros**, que contiene empresa, tipo, estado, OT, creación y las tres casillas, incluida **Costo de proveedor sin configurar**. Los chips muestran lo puesto. Desaparece la explicación de «Personalizado». |
| Paso 3 | Se reescribe: lo esencial, los grupos **Cobro al cliente** y **Costo de proveedor**, las columnas fijas, el botón **Columnas** (sustituye a Mostrar todas / Compactar) y el Excel siempre completo. «No configurado» pasa a «Sin configurar». |
| Paso 4 | Se añade la lista de los estados de costo (§3.3) y la frase «El costo de proveedor no impide liquidar.». Se quita la mención a la compacta. |
| Paso 5 | Las acciones de fila pasan a un botón más el menú **⋮** (Soporte, Servicios, Viajes, Aceptar diferencia, Reversar). Reversar pide el motivo en un diálogo. |
| Paso 6 | El Consolidado lleva el bloque **Costo de proveedor** aparte. |
| Paso 7 | Excel: las 32 columnas de siempre más 6 al final. |
| Estados | Error sin «en rojo». Vacío con la casilla nueva. Lleno: una línea por trámite. |
| Qué no hace | «El costo de proveedor no se edita aquí: se configura en **Tarifas › Proveedores**.» · «No calcula margen.» |
| Capturas | Se regeneran 01, 02 y 03 y se añade `05-costo-proveedor.png`. |

## 11. Notas para QA

1. A 1366×768 no hay scroll horizontal de **página**. La tabla desplaza dentro de `FlitTable` y Trámite y Placa siguen visibles al desplazar.
2. Toda fila mide un renglón. Ninguna celda del cuerpo hace salto de línea, ni siquiera C6 con un `idFlit` largo.
3. Cada estado C1–C8 se pinta con su copy exacto y su `aria-label`, y ninguno usa rojo.
4. Total costos no cambia el Total cobrado ni Total reintegro/Servicio, en la fila, en el pie ni en el consolidado.
5. Un trámite liquidado antes del cambio muestra «estimado» en el costo aunque su chip diga Liquidado.
6. «Costo de proveedor sin configurar» filtra, se suma al contador de Más filtros, sale como chip, viaja al export y tiene su vacío propio.
7. Periodo: elegir mes o trimestre rellena el rango, y el personalizado se muestra en el resumen. No hay segundo control de Aprobación.
8. Ningún filtro de antes falta (tabla §3.4). «Limpiar filtros» vuelve a Aprobado más el mes en curso.
9. Hay una primaria visible a la vez. Con selección, la tarjeta de envío se oculta.
10. Las opciones del ⋮ respetan los permisos: el auditor no ve Liquidar, Facturar, Reversar, Enviar ni Aceptar.
11. Columnas: la preferencia `v2` persiste, la clave vieja se ignora, y Trámite y Placa no se pueden ocultar.
12. Las 4 vistas (cargando, error, vacío y lleno) y el consolidado se revisan en los temas claro y oscuro.

## 12. Decisiones y descartes

- **El proveedor en columna propia, no en un segundo renglón:** el humano pidió filas de una línea.
- **No hay chips ni fondos nuevos por grupo:** basta un borde de grupo y el rótulo `ThGrupo` que ya existe.
- **Reutilizado del kit:** `<details>` (lo usan `RangoFechas`, `ThFiltroMulti` y `FiltrosInteligentes`), `MenuFila`, `FlitTable`, `StatusChip`, `Monto` y `FlitEmpty`.
- **Lo único nuevo:** `sticky` en tres celdas, que el kit no da. Va con clases en las celdas, sin tocar `FlitTable`.
- **Descartado:** el panel lateral de detalle (D2 del diagnóstico) y las pestañas Cobro/Costo (D3). El humano eligió «Esencial + desglose».
- **Subtotales fuera de la vista por defecto:** Total reintegro y Servicio pasan a «Columnas», y siguen en el Excel y en el consolidado, porque el humano no los incluyó en el desglose. → Confirmar (Q4).
- **Sin margen:** no se pidió.

## 13. Preguntas abiertas (no bloquean la maqueta, sí la implementación)

- **Q1.** ¿Unificar «No configurado» → «Sin configurar» en el cobro? Propuesta: sí.
- **Q2.** Excel: ¿celdas de costo numéricas más una columna «Estado costo de proveedor»? Propuesta: sí.
- **Q3.** ¿Margen cobro − costo en el consolidado? Propuesta: no, sería otra HU.
- **Q4.** ¿Total reintegro y Servicio fuera de la vista por defecto del detalle? Propuesta: sí, en «Columnas».
- **Q5.** C7 y C8 (§3.3) ¿se aceptan como los escribí?

## 14. Brief de mockup

- **Archivo:** `docs/ux/mockups/flito-reporte-costos.html`. Usa solo utilidades estándar de Tailwind, sin CDN, sin HEX ni rojo, y enlaza `flito-reporte-costos.css`. Lleva un script mínimo que lee `?vista=` y muestra la sección correspondiente.
- **Vistas:** `lleno` (por defecto), `cargando`, `error`, `vacio`, `filtros` (Más filtros abierto, con chips), `periodo` (panel de Periodo abierto), `columnas` (panel Columnas abierto) y `consolidado`.
- **Datos ficticios:**
  - Placas `ZZA101`–`ZZA108`, trámites `10231`–`10238`.
  - Compañías «Compañía Demo Uno/Dos/Tres S.A.S.».
  - Proveedores «Seguros Demo», «Transportes Demo Norte» y «Transportes Demo Sur».
  - Los NIT `999…` solo aparecerían en la columna Titular, que está oculta.
- **Las 8 filas cubren:**
  - C1 sellado.
  - C2 estimado.
  - C3 Sin configurar (con total parcial).
  - C4 Sin proveedor.
  - C5 Gestionado por Operaciones, en una fila con Falta: Impuesto.
  - C6 Ya contado en el trámite 10234.
  - Liquidado antes del cambio, con estimado y Facturado.
  - C7 autogestiona, con logística Sin configurar y total Sin configurar.
- **Paleta del mockup → token en producto:**

| Mockup | Token en producto |
|---|---|
| `slate-50` | `--flit-bg-app` |
| `white` | `bg-flit-card` |
| `slate-200`/`300` | `--flit-border-soft`/`--flit-border-input` |
| `slate-500` | `--flit-text-muted` |
| `slate-600` | `--flit-text-secondary` |
| `slate-900` | `--flit-text-primary` |
| `blue-700` | `--flit-blue-text` / CTA |

  El mockup no cubre el tema oscuro. Esa verificación se hace con tokens al implementar.
- **Qué NO se muestra:** titular, VIN, marca, línea, OT, mes, trimestre, Factura DIAN y viajes (solo como casillas sin marcar en el panel Columnas).

## Retoques del humano al aprobar la maqueta (2026-11-11) — MANDAN sobre lo anterior

Aprobada con estos cambios:

1. **No recortar** el nombre de la empresa ni el de los proveedores (sin `truncate`/elipsis): la columna crece o el texto envuelve dentro de la celda; la fila puede pasar de una línea solo por eso.
2. **«Exportar a Excel» vuelve arriba**, en la cabecera de la página, donde estaba (junto a Detalle/Consolidado), no en la barra de la tabla.
3. **Columna «Liquidación»: vacía mientras el trámite no esté liquidado o facturado.** Se elimina la etiqueta «Estimado» de esa columna: solo muestra «Liquidado» o «Facturado» cuando aplica.
4. **Sin etiquetas pegadas al valor** en las celdas de importe (p. ej. «estimado» o «parcial» junto al precio): la celda muestra solo el valor. Los estados sin valor («Sin configurar», «Sin proveedor», «Gestionado por Operaciones», «Ya contado en el trámite N») siguen siendo el contenido de la celda cuando no hay importe.

Decisiones de la misma ronda: Total reintegro y Servicio salen de la vista por defecto (quedan en «Columnas» y en el Excel); el consolidado lleva un grupo «Costo de proveedor» aparte, sin margen; «Sin configurar» reemplaza a «No configurado» también en el cobro al cliente.
