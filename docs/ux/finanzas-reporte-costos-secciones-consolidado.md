# UX slim — Reporte de costos por secciones, organismo, periodo y vista consolidada (HU #12434, Feature #12404)

> **Ajuste del hilo (2026-09-10, AC1 de la HU #12434):** las tres secciones arrancan **expandidas** (todas
> las columnas visibles al cargar); «Compactar» por sección es una preferencia del usuario que se
> persiste en `localStorage`. Donde este documento dice «compacto por defecto», léase «expandido por
> defecto, compactable».

> Modo **slim**: la pantalla existe (`apps/web/src/pages/FinanzasReporteCostos.tsx`) y gana cuatro piezas.
> Todo lo que no se nombra aquí **no cambia**: liquidar/facturar/reversar por fila y en lote, la barra de
> selección, la tarjeta y el diálogo de envío a facturación electrónica, los contadores FE, la ficha
> «Factura DIAN», el visor de soportes, el aviso de totales incompletos y «Exportar CSV» del detalle.
> Tono de la pantalla: **tutea** («No cierres esta ventana», «Ver cuáles»). Se calca.

## Superficie tocada

| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, **sin cambios**. `admin` y `financiera` operan; `auditor` lee (ve las cuatro piezas nuevas: son lectura) |
| Bloque 1 · filtros | `FlitCard` de filtros: entra **OT** (2.ª banda) y **Periodo** (3.ª banda, junto a «Aprobación») |
| Bloque 2 · tabla detalle | `thead` pasa a **dos filas** (grupo `<th colSpan>` + columnas); columna «Flit» fija; dos subtotales nuevos en fila y en `tfoot` |
| Bloque 3 · consolidado | **Vista alterna** de la misma página: conmutador «Detalle \| Consolidado» en el slot `actions` del `PageHeaderCard`, a la izquierda del botón de exportar |
| Kit | `FlitPillGroup role="tablist"` + `FlitPillButton`, `<details>` (mismo `FiltroEstados`), `FlitTh`, `FlitEmpty`, `PageContentSkeleton`, `Monto` con `TEXTO_FALTA`. **Cero patrones nuevos** |

## Delta de claridad (qué se ve / qué se calla)

**A qué se entra:** a cerrar el mes — «qué aprobamos este mes por cliente y cuánto vale». Por eso **al
entrar el periodo ya está puesto** (Aprobado + mes en curso): la pregunta del día no se arma a mano.

**Se ve primero (detalle):** Flit, Placa, Empresa, OT, Estado, la sección **Valores** entera y la acción de
fila. **Se calla, a un clic** («Mostrar todas» de la sección): VIN, Nombres, Apellidos, Razón social, Tipo y
Documento del titular; Marca, Línea, Fecha creación, Mes y Trimestre. Ninguno decide «abro esta fila / no»;
Mes y Trimestre además ya los dice el selector. **Nunca** se pinta $0 por un subtotal que no existe.

**Se ve primero (consolidado):** Cliente, Periodo, Trámites, **Total**, e Incompletos cuando > 0. Sin casillas,
sin acciones de fila, sin contadores FE ni tarjeta de envío: aquí no se opera, se lee y se exporta.

**Primaria:** detalle → **Liquidar** (fila / `Liquidar N`), como hoy; «Exportar CSV» sigue secundario.
Consolidado → **Exportar consolidado** con peso primario: es la única acción de esa vista y para eso se entra.

**Densidad:** 13 columnas apiladas hoy → 30 planas posibles. Con las secciones en compacto quedan **~18 visibles**
(3 + 5 + 10) en una sola línea por fila, más selección y acciones; el scroll horizontal existe ya y sigue,
con «Flit» fija para no perder de qué fila se lee. Se declara: **abrir las tres secciones es denso a
propósito** (es el Excel en pantalla) y es opción del usuario, no el estado inicial.

## Disposición

```
┌ Reporte de costos ──────────── ( Detalle | Consolidado )  [Exportar CSV] ┐
├ Filtros ─────────────────────────────────────────────────────────────────┤
│ (Todos)(Listos 12)(Incompletos 3)(Por facturar 9)(Facturados 41)  ☐ Solo con soportes completos  [Limpiar filtros] │
│ [Placa, VIN o trámite FLIT…] [Todas las empresas▾] [Todos los tipos▾] [Estado  Aprobado▾] [OT  Todos▾]          │
│ [Periodo (Mes|Trimestre) [2026▾] [septiembre▾]]  [Aprobación  1 sep 2026 → 30 sep 2026▾]  [Creación  Cualquier fecha▾] │
└──────────────────────────────────────────────────────────────────────────┘
```

**Selector de periodo** — un bloque rotulado «Periodo» con tres controles: `FlitPillGroup` (Mes | Trimestre),
`<select>` año (del año más antiguo con aprobaciones al actual) e índice (enero…diciembre / T1…T4). Elegir
rellena «Aprobación» con el rango cerrado del periodo. Si el usuario toca el rango a mano, el bloque muestra
**«Personalizado»** en lugar del índice (los tres controles siguen habilitados; elegir uno vuelve a mandar).
«Limpiar filtros» → Aprobado + mes en curso (ya no es «rango vacío»), y `hayFiltros` se calcula contra ese
punto de partida. `RangoFechas` de Aprobación no cambia; el atajo «Este mes» que ya trae equivale a Mes/actual.

**Filtro OT** — `<details>` idéntico a `FiltroEstados`, rótulo «OT», opciones `{valor, nombre}` de la faceta,
casillas por `valor`, texto `nombre`. Resumen cerrado: «Todos» / «Envigado» / «2 organismos». Pie del
desplegable: «Cualquier organismo». Sin faceta: «Sin organismos que ofrecer». Va después de Estado: filtra
sobre *qué* trámites, no *cuándo*.

**Cabecera de la tabla en dos filas:**

```
│☐│ IDENTIFICACIÓN · 3 de 9 [Mostrar todas] │ DATOS DEL TRÁMITE · 5 de 11 [Mostrar todas] │ VALORES                                                              │       │
│ │ Flit* │ Empresa │ Placa │              │ Tipo trámite │ OT │ Estado │ F. aprobación │ Factura DIAN │ SOAT │ Impuesto │ Trámite │ GMF │ Logística │ Total reintegro │ Trámite digital │ Servicio │ Total │ Liquidación │ Acciones │
```

- Fila 1: `<th colSpan>` por sección (`scope="colgroup"`), con contador «n de m» y un botón de texto
  «Mostrar todas» / «Compactar» (`aria-expanded`, `aria-controls` no aplica: controla columnas, no un panel).
- Fila 2: un `FlitTh scope="col"` por columna. Compacto oculta columnas enteras (`hidden`), no las apila.
- Ampliado, en el orden de la HU: Identificación = Empresa, Flit, Placa, VIN, Nombres, Apellidos, Razón social,
  Tipo, Documento; Datos = Tipo trámite, Marca, Línea, OT, Estado, F. creación, F. aprobación, Mes, Trimestre,
  Factura DIAN. **Valores no se compacta** (es lo que se vino a ver). Liquidación (chip) cierra Valores.
- **Columna fija:** «Flit» (`position: sticky; left: 0`, fondo de tarjeta) y la casilla de selección a su
  izquierda cuando existe. Las dos filas de cabecera también fijas arriba dentro del `overflow-x-auto`.
- El estado compacto/ampliado se guarda en `localStorage` por sección: quien trabaja con el Excel abierto lo
  quiere ampliado siempre; quien concilia, no.
- «Exportar CSV» sigue sacando **las 30 columnas** siempre: compactar es de pantalla, no del archivo.

**Subtotales** — celdas «Total reintegro» y «Servicio» en fila y `tfoot`, `Monto` como el resto. Null en fila →
texto en cursiva del motivo que manda el servidor, misma familia `TEXTO_FALTA` («No configurado», «Sin pagar»,
«Sin recibo»), con `title="Falta: <conceptos>"`. Null en el `tfoot` → **«Incompleto»** en cursiva; el aviso
«El total mostrado está incompleto… Ver cuáles» que ya existe es el siguiente paso, no se duplica.

## Vista consolidada

```
┌ Reporte de costos ───────── ( Detalle | Consolidado )  [Exportar consolidado] ┐
│ (filtros: los mismos; las etapas y OT también acotan el consolidado)          │
│ 8 clientes · 3 periodos                                                       │
│ Cliente        Periodo     Trámites  SOAT  Impuesto  Trámite  GMF  Logística  Total reintegro  Trámite digital  Servicio  Total       Incompletos │
│ Transp. Andes  sep 2026        41    …      …         …       …     …          $ 12.300.000     $ 2.050.000     $ 2.050.000  $ 14.350.000     0 │
│ Logicargo      sep 2026        17    …                                                                                        $ 6.100.000   ⚠ 3 │
│ Logicargo      Sin aprobar      4    …                                                                                        Incompleto    ⚠ 4 │
│ Totales (62 trámites del filtro)     …                                                                                        $ 20.450.000     7 │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Agrupa por **cliente × periodo**; el tipo de periodo (mes / trimestre) es el del selector. Con
  «Personalizado» sigue agrupando por el tipo elegido y puede haber varios periodos por cliente.
- Periodo null → **«Sin aprobar»** (mismo texto que `CeldaFechas`). Va al final del cliente.
- Incompletos > 0 → la celda lleva `StatusChip tone="draft"` con el número y `aria-label="N trámites con
  conceptos sin resolver"`; la fila **no** cambia de color (el chip ya lo dice; no se apoya en color, regla 12).
  Total de esa fila con subtotal null → «Incompleto» como en el detalle. Primera columna «Cliente» fija.
- Sin casillas, sin selección, sin acciones de fila, sin contadores FE ni tarjeta de envío; `Paginacion`
  solo si el servidor pagina el consolidado (si devuelve todo, no se pinta).
- Al cambiar de vista **los filtros se conservan** y la página vuelve a 1. El conmutador lleva la vista en la
  URL (`?vista=consolidado`) para que un enlace del cierre de mes abra donde toca. La selección de filas del
  detalle se vacía al salir (no hay nada seleccionable al volver).

## Estados (4) + copy

| Superficie | Cargando | Error | Vacío | Lleno |
|---|---|---|---|---|
| **Consolidado** | `PageContentSkeleton` en el sitio de la tabla + `role="status"` «Calculando el consolidado…» | Banda `role="alert"`: «No se pudo calcular el consolidado: `<mensaje del servidor>`.» + **[Reintentar]**. El conmutador sigue vivo (volver a Detalle no está bloqueado) | `FlitEmpty`: **«No hay trámites que coincidan con los filtros.»** + «Cambia el periodo o limpia los filtros.» con el botón **[Limpiar filtros]** debajo | Tabla + pie «Totales (N trámites del filtro)» + resumen «n clientes · m periodos» |
| **Selector de periodo** | Sin carga propia; al elegir, la tabla recarga | El de la tabla | No existe: siempre hay un periodo (o «Personalizado») | «Mes · 2026 · septiembre» / «Trimestre · 2026 · T3» / «Personalizado» |
| **Filtro OT** | Faceta llegando → resumen «Todos», lista vacía «Cargando organismos…» | Faceta falla → «Sin organismos que ofrecer» (mismo trato que Estado hoy) | «Todos» | «Envigado» / «2 organismos» |
| **Secciones / subtotales** | Los del detalle (hoy sin esqueleto; **deuda declarada, no se paga aquí**) | El del detalle | El vacío del detalle, sin cambios | Fila en una línea; subtotal null → motivo en cursiva |

Copys fijos: rótulos «Periodo», «Mes», «Trimestre», «Año», «OT»; botones «Mostrar todas» / «Compactar»,
«Exportar consolidado», «Reintentar», «Limpiar filtros»; celda «Sin aprobar», «Incompleto»; resumen del
selector «Personalizado»; `title` del subtotal «Falta: SOAT, Impuesto».

## Accesibilidad

- Conmutador: `FlitPillGroup role="tablist" label="Vista del reporte"`, cada pastilla `aria-pressed`
  (patrón de las etapas). Al cambiar, el foco se queda en la pastilla y la región `role="status"` de la
  página anuncia «Vista consolidada» / «Vista de detalle».
- Selector: `fieldset` con `<legend>` «Periodo»; pastillas `aria-label="Tipo de periodo"`; selects
  `aria-label="Año"` y `aria-label="Mes"` / `"Trimestre"` según el tipo. «Personalizado» se anuncia porque
  vive en el mismo `role="status"`.
- OT: `summary aria-label="Organismo de tránsito"`; el resumen visible dice «OT». Igual que Estado.
- Cabecera: `scope="colgroup"` en la fila de grupos, `scope="col"` en la de columnas (`FlitTh` ya lo pone).
  El botón de compactar es un `<button>` con `aria-expanded`; al compactar, el foco sigue en él.
- Columna fija: el `overflow-x-auto` de `FlitTable` ya es enfocable cuando desborda; no se añade nada.
- Contraste: chips y cursivas con tokens ya usados; `--flit-text-muted` solo para «—» y motivos cortos, como hoy.

## Datos (confirmar contra la HU backend hermana del Feature #12404 antes de codear)

Hoy `GET /finanzas/reporte-costos` **no** sirve nada de esto (medido en `finanzas.routes.ts` y `finanzas.service.ts`):
(1) faceta `organismos: {valor, nombre}[]` en `/facetas` y parámetro `organismos=`; (2) campos de fila
`nombres, apellidos, razonSocial, tipoDocumento, documento, organismoCodigo, organismoNombre, mes, trimestre,
totalReintegro, servicio` + `motivoTotalReintegro` / `motivoServicio` (`Falta` o null); (3) `totales.totalReintegro`
/ `totales.servicio` nullable; (4) `GET /finanzas/reporte-costos/consolidado?agrupar=mes|trimestre&<filtros>` y
`…/consolidado/export`. **El selector de periodo no necesita backend**: rellena `aprobadoDesde/aprobadoHasta`.
**PII (Ley 1581):** Documento, Nombres y Apellidos solo en la sección ampliada y en el CSV; **no entran en
`buscar`** ni en la URL. Si el PO no los necesita en pantalla, se quedan solo en el archivo (ver dudas).

## Partición en componentes (solo bloques)

`components/finanzas/`: **FiltrosReporteCostos** (la tarjeta entera, recibe y emite el estado de filtros) ·
**SelectorPeriodo** (Mes/Trimestre + año + índice ↔ `Rango`; sabe decir «Personalizado») · **FiltroMulti**
(generaliza `FiltroEstados` para Estado y OT: `opciones {valor, nombre}`, rótulo, resumen) ·
**CabeceraSecciones** (las dos filas del `thead`, estado compacto/ampliado, `localStorage`) ·
**TablaDetalleCostos** (`tbody` + `tfoot` con `Monto`, casillas y `Acciones`, sin cambios de conducta) ·
**TablaConsolidado** (sus 4 estados, chip de incompletos, pie) · la página queda con el estado, los efectos y
el conmutador. `Acciones`, `Paginacion` y `Monto` se mueven tal cual, no se reescriben.

## Notas para QA (≤10)

1. Al entrar sin filtros: «Aprobación» ya trae el mes en curso y el selector dice «Mes · <año> · <mes>». *Mutante:* rango vacío al arrancar.
2. Tocar el rango a mano → «Personalizado»; volver a elegir un mes lo sustituye. *Mutante:* selector que no escucha al rango.
3. «Limpiar filtros» deja Aprobado + mes en curso, y con eso puesto el botón queda `disabled`. *Mutante:* `hayFiltros` comparando contra rango vacío.
4. Trimestre T3 2026 → `aprobadoDesde=2026-07-01&aprobadoHasta=2026-09-30` en la petición. *Mutante:* fin de mes con 30/31 mal.
5. OT con dos marcados → resumen «2 organismos» y `organismos=<valor1>,<valor2>` (valores, no nombres). *Mutante:* mandar `nombre`.
6. `thead` con dos filas: 3 `th[scope=colgroup]` y, en compacto, exactamente las 18 columnas listadas; «Mostrar todas» en Identificación añade 6 `th[scope=col]`. *Mutante:* apilar en vez de ocultar.
7. Fila con `totalReintegro: null, motivoTotalReintegro: 'pago'` → celda «Sin pagar», nunca «$ 0». `tfoot` null → «Incompleto». *Mutante:* `?? 0`.
8. Consolidado: `role="status"` «Calculando…» → tabla; con 500 → alerta + «Reintentar» que repite la petición; con `[]` → el vacío con «Limpiar filtros». Los cuatro, con la petición mockeada en **todos** los casos.
9. Consolidado con `periodo: null` → «Sin aprobar»; `incompletos: 3` → chip «3» con su `aria-label`; el botón del header dice «Exportar consolidado» y llama a `/consolidado/export` con los mismos filtros.
10. `auditor`: ve conmutador, selector, OT, secciones y consolidado; sigue sin casillas, sin Liquidar ni tarjeta de envío. `?vista=consolidado` abre directo en consolidado.

## Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| 1 | Secciones **compactas por defecto**, Valores siempre completa, «Flit» fija | 30 columnas planas siempre: el analista pierde el total a la derecha del scroll |
| 2 | El detalle **deja `columnasComunes`** (celdas apiladas) por columnas planas: el contrato de la HU es el Excel | Mantener apilado y añadir 17 columnas al lado: dos lenguajes en la misma fila. Las otras 4 tablas no se tocan |
| 3 | Consolidado = vista alterna con los **mismos filtros**, en la misma URL | Página/slug nuevo: duplica filtros y permisos para un dato que es el mismo reporte plegado |
| 4 | Conmutador en el `PageHeaderCard`, junto al export, que **cambia de rótulo y de peso** con la vista | Dos botones de exportar a la vez (dos CTA) |
| 5 | El selector rellena el rango; «Personalizado» es un estado del selector, no un cuarto tipo | Parámetro de periodo en el backend: sería una segunda forma de decir lo mismo que `aprobadoDesde/Hasta` |
| 6 | Subtotal null → motivo del servidor con `TEXTO_FALTA`; `tfoot` → «Incompleto» + aviso existente | Sumar lo que hay y callar el hueco |
| 7 | Sin color de fila para Incompletos: chip con número y `aria-label` | Fila teñida (efecto que además no pasa la regla 12) |

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /tmp/claude-1000/-home-david-flit-flito/dad351e5-7599-40a3-8dd3-fcf24299696d/scratchpad/docs-ux/finanzas-reporte-costos-secciones-consolidado.md → docs/ux/
  Oficio: primaria única (Liquidar en detalle; Exportar consolidado en consolidado) | jerarquía dicha | vacío con siguiente paso | sin efectos
  Densidad: empeora solo si el usuario amplía las secciones (opción, no estado inicial); compacto ≈ 18 columnas en una línea
  Pantallas: 1 (2 vistas) | Requerimientos nuevos de datos: 4 (faceta+param OT, campos y subtotales de fila, totales nullable, consolidado + export)
  Siguiente: confirmar con tech-lead que la HU backend del Feature #12404 cubre los 4 puntos de «Datos» (si no → architecture-agent), luego frontend-agent.
  Dudas que el frontend-agent NO resuelve solo:
    a) ¿Documento, Nombres y Apellidos del titular deben verse en pantalla (aunque sea ampliado) o basta el CSV? Hoy la fila no trae PII y el auditor la lee sin registro de acceso.
    b) ¿El AC exige las 30 columnas visibles de entrada? Si sí, es una decisión del PO sobre densidad, no un default a cambiar en código.
    c) Composición exacta de «Total reintegro» y «Servicio» (qué concepto suma a cuál): la define el backend; el front solo pinta lo que llega.
```
