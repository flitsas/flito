# UX slim — Vistas flexibles de la Torre de Control (Épica #14590)

Modo **slim**. Extiende `docs/ux/flito-torre-control.md` (§4 barra) y `docs/ux/flito-torre-explorador-flexible.md` (§3 constructor, §5 resultado) sin reescribirlos: donde este doc no dice nada, mandan ellos. Origen: revisión del humano en DEV (F1, G1, V). Tono: **usted**, como el resto de la Torre.
Mockup: `docs/ux/mockups/torre-vistas-flexibles.html` (lo construye el hilo con el §8; aún no existe).

## 1. Superficie tocada y qué cambia por pestaña

| Pestaña | Barra de fechas (F1) | Eje legible (G1) | Controles de vista (V) |
|---|---|---|---|
| Resumen 360°, Comercial, Operativa, Financiera | Sí | Sí, en toda gráfica con eje de tiempo | **No** |
| Explorador | Sí. «Según la fecha de» sigue en el constructor, sin cambios | Sí, y la gráfica del resultado pasa a todo el ancho | Sí: Top, Absoluto/%, Comparar |

Componentes: `BarraFiltrosTorre` (todas), `LineaTendencia` / `BarrasGrupo` de `flit/Graficos.tsx` (todas), `ResultadoExplorador` y `TablaCruzadaTorre` (solo el Explorador). No hay ruta, slug ni pestaña nueva.

## 2. Delta de claridad

- **Qué vino a hacer:** leer una cifra en un periodo que él decide. Hoy el periodo exacto está en la opción 20 de un `<select>`. Con el cambio, las fechas reales del periodo se ven **siempre**, sea un atajo o un rango a mano.
- **Lo que se ve primero no cambia.** En los tableros sigue la cifra. En el Explorador siguen la pregunta, la cifra y el desglose. Los controles de vista son una sola fila **dentro** de la tarjeta de resultado, en peso secundario.
- **Lo que se calla:** desaparecen el `<select>` «Periodo» y el chip «Rango personalizado…». Los meses sueltos pasan a un select compacto «Mes». El periodo anterior solo aparece si el usuario activa «Comparar».
- **Densidad.** Los tableros ganan una fila (los atajos). El Explorador gana una fila de vista y, con «Comparar», 2 columnas en la tabla de una agrupación. Es la única carga nueva y es opcional: **sin cambio neto con los valores por defecto**.
- **Primaria:** no cambia. Los atajos y los controles de vista no son acciones: son secundarios (chips y selects del kit).

## 3. Barra de fechas (F1, las 5 pestañas)

**Kit.** `flit/RangoFechas` existe, pero resume el rango en un solo disparador, que es justo lo que el humano rechazó. Por eso no se usa aquí. Se compone así:
- Dos `<input type="date">` nativos. Traen el calendario del navegador y se escriben con teclado en formato dd/mm/aaaa. Llevan la clase de campo de `FlitSelect` (h-10, `bg-flit-card`, `--flit-border-input`, `flit-focus`). No se toma `RangoFechaFilter`, que usa `white` y h-8.
- `FiltroSegmentado` para los atajos: chips h-10 con `aria-pressed`. Por debajo de 768 px van en una sola fila con scroll; desde 768 px envuelven.
- `FlitSelect` «Mes» para los meses sueltos.
- La composición vive en `components/torre/` (`RangoTorre`). No es un componente nuevo del kit.

**1366**
```
┌ Filtros de la Torre ─────────────────────────────────────────────────────────────────────────┐
│ Compañía                     Desde              Hasta              Mes                       │
│ [Todas las compañías    ▾]   [01/11/2026  📅] → [18/11/2026  📅]   [Elegir un mes        ▾]  │
│ Atajos (Hoy) (Ayer) (Últimos 7 días) (●Este mes) (Mes anterior) (Últimos 6 meses) (Este año)│
│ [🔍 Buscar placa                                                     ] [⛛ Más filtros  2 ]   │
│ (OT: OT Demo Norte ✕) (Estado actual: Aprobado ✕)  Limpiar todo                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**375**
```
┌ Filtros ─────────────────────┐
│ Compañía                     │
│ [Todas las compañías     ▾]  │
│ Desde          Hasta         │
│ [01/11/2026📅] [18/11/2026📅]│  ← 2 columnas, sin la flecha
│ Mes                          │
│ [Elegir un mes           ▾]  │
│ Atajos (Hoy) (Ayer) (Últim…→ │  ← una fila con scroll y desvanecido (FiltroSegmentado)
│ [🔍 Buscar placa ] [⛛ Más 2] │
└──────────────────────────────┘
```
En `md` hay 2 columnas: Compañía y Mes arriba, Desde y Hasta abajo. Los atajos envuelven.

**Rango inválido (1366)**
```
│ Desde              Hasta                                                  │
│ [20/11/2026  📅]   [18/11/2026  📅]     ← ambos con borde --flit-danger-ink│
│ ⚠ La fecha «Desde» es posterior a «Hasta». Corrija una de las dos.        │
```

**Reglas**
1. **Un atajo llena los campos** con sus fechas reales («Este mes», un 18 nov: 01/11/2026 → 18/11/2026) y queda marcado. Hoy, «Últimos 6 meses» va alineado a mes (RN-TOR-F5): 01/06/2026 → 18/11/2026.
2. **Editar un campo a mano** desmarca el atajo y deja el periodo como rango propio. El atajo **no** se vuelve a marcar solo, aunque las fechas coincidan.
3. **«Mes»** llena el mes completo, o hasta hoy si es el mes en curso, y desmarca los atajos. Al elegir un atajo o editar un campo, «Mes» vuelve a «Elegir un mes».
4. **Se consulta en cuanto hay dos fechas válidas.** El `onChange` del date nativo solo dispara con la fecha completa, así que no hace falta debounce.
5. **Inválido o incompleto:** no se consulta y queda a la vista el último resultado válido. **No** se invierten las fechas solas: mientras se escribe, el estado intermedio engaña. Tope `max = hoy` en los dos campos.
6. Las fechas son siempre texto `yyyy-mm-dd` en hora de Bogotá, nunca `Date`. Ver la lección del commit ff5bb67b y la cabecera de `RangoFechas`.
7. **Persistencia:** el estado sigue en `sessionStorage['flito-torre-filtros']`, nunca en la URL. «Limpiar todo» conserva Compañía y fechas, como hoy. «Limpiar filtros» de un vacío vuelve a «Este mes».

## 4. Eje legible (G1, todas las gráficas con eje de tiempo)

**Gráfica a todo el ancho:** con eje temporal, la cifra (`KpiCard`) va arriba y la gráfica debajo, al 100 % de la tarjeta. Sale de la rejilla `lg:grid-cols-[18rem_1fr]`. El ranking por categoría no cambia: no tiene eje y su lado a lado funciona.

**Formato de la etiqueta del eje.** Se formatea en la web desde la clave ISO del corte. La misma función rotula las cabeceras de columna de `TablaCruzadaTorre`. El Excel no cambia.

| Agrupación | Eje | Tooltip (ya existe) | Si el rango cruza de año |
|---|---|---|---|
| Día | «1 jun» | «lun 1 jun 2026» | el primer corte y cada 1 de enero llevan el año: «1 ene 2027» |
| Semana (lunes) | «1 jun» | «Semana del 1 al 7 jun 2026» | igual que día |
| Mes | «jun 2026» | «junio de 2026» | — |
| Trimestre (si la agrupación existe) | «T3 2026» | «T3 2026 (jul–sep)» | — |
| Año | «2026» | «2026» | — |

**Espaciado.** Medir el ancho real del contenedor con `ResizeObserver` y usarlo como ancho del `viewBox`, para que el texto no se escale.
- **Separación mínima entre etiquetas:** 56 px con «1 jun» y 76 px con «jun 2026», «T3 2026» o «2026».
- **Máximo de etiquetas:** `⌊ancho útil / separación⌋`. Se rotula un corte de cada `paso = ⌈cortes / máximo⌉`, siempre desde el primero. El último solo se rotula si queda a la separación mínima del anterior.
- Todos los cortes conservan su marca (tick de 4 px) y su columna de tooltip: el valor de un corte sin rótulo se ve al pasar el cursor.
- Ejemplo: 1366 (≈1.130 px útiles) y 25 semanas dan un máximo de 20 etiquetas, paso 2 y 13 rótulos. A 375 (≈300 px útiles) entra el scroll de abajo.
- Esto reemplaza la regla de hoy («alternar por debajo de 640 px con más de 8»).

**Scroll horizontal:** aparece cuando `cortes × ancho mínimo por corte` supera el ancho útil.
- **Ancho mínimo por corte:** 20 px en línea y `8 px × series + 8` en barras agrupadas.
- **Ejemplos:** a 1366 la línea hace scroll desde unos 56 cortes; a 375, desde 15.
- **El eje Y queda fijo** a la izquierda: va en un SVG aparte o `sticky`. Solo se desliza el área del trazo.
- **Aviso:** sobre la gráfica, en `small`, el texto «Deslice para ver todos los cortes.», el mismo patrón de la tabla cruzada.
- **Posición inicial:** el scroll arranca en el extremo derecho, en el corte más reciente.

**1366, compañía × semana, 6 meses**
```
┌ Trámites aprobados · Últimos 6 meses · por compañía y semana ────────────────────────────────┐
│ 1 jun – 18 nov 2026 · Todas las compañías                                                    │
│ ┌ Trámites aprobados ┐                                                                       │
│ │ 1.102              │                                                                       │
│ └────────────────────┘                                                                       │
│ 80┤      ╭─╮                     ╭╮                                    ╭─╮                   │
│ 40┤ ╭──╮╭╯ ╰─╮╭──╮  ╭─╮  ╭──╮╭─╮╭╯╰╮  ╭─╮ ╭──╮  ╭─╮ ╭──╮  ╭─╮ ╭──╮ ╭─╮╭╯ ╰╮                  │
│  0┼─┴──┴┴───┴┴──┴──┴─┴──┴──┴┴─┴┴──┴──┴─┴─┴──┴──┴─┴─┴──┴──┴─┴─┴──┴─┴─┴┴───┴── (25 ticks)    │
│   1 jun  15 jun  29 jun  13 jul  27 jul  10 ago  24 ago  7 sep  21 sep  5 oct … 16 nov       │
│   ● Demo A  ■ Demo B  ▲ Demo D  ◆ Demo C  ● Demo E  ■ Los demás                              │
│ [tabla cruzada como hoy, cabeceras «1 jun», «8 jun»…]                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**375, mismo caso**
```
│ Deslice para ver todos los cortes.│
│ 80┤│…──╮  ╭─╮ ╭──╮ ╭─╮╭╯ ╰╮   →  │  ← eje Y fijo; el trazo se desliza (600 px)
│  0┼│…┴─┴──┴─┴─┴──┴─┴─┴┴───┴──    │     y arranca en el extremo derecho
│   │ 5 oct  19 oct  2 nov  16 nov  │
```

## 5. Controles de vista (V, solo el Explorador)

**Dónde van:** en la primera fila **dentro** de la tarjeta de resultado, bajo el título y el subtítulo y sobre la cifra.
- Actúan sobre la presentación, no sobre la pregunta. Por eso no van en «¿Qué quiere saber?».
- Orden de la página: barra → constructor → resultado (fila de vista + cifra + desglose).
- **Solo se pintan los controles que aplican.** Si no aplica ninguno, la fila no existe.

**Cuándo aplica cada control:**
- **«Mostrar» (Top):** con una agrupación principal **de dimensión**, sola o en cruce. `FlitSelect` con «5 grupos», «10 grupos», «20 grupos» y «50 grupos». Por defecto, 10 grupos.
  - En el resultado simple, el ranking y la tabla muestran N filas más «Los demás (M)».
  - En el cruce, las filas pasan a ser N más «Los demás (M)», en lugar del tope fijo de 50.
  - No cambian: las columnas (12 más «Los demás»), las 5 series de la gráfica ni los ejes temporales, que nunca se cortan.
- **«Valores» Absoluto / %:** solo en el cruce y solo en conteo y dinero. Un `FiltroSegmentado` con «Absoluto» y «%». Por defecto, Absoluto.
- **«Comparar con el periodo anterior»:** `FlitSwitch`. Por defecto, apagado. No aplica en tres casos:
  - en el cruce;
  - en métricas de foto («Trámites en curso»);
  - con el periodo inválido.
- **Al dejar de aplicar,** Comparar se apaga y % vuelve a Absoluto. No queda un estado oculto. Top conserva su valor.
- **Persistencia:** los tres valores se guardan en `sessionStorage` junto al constructor, nunca en la URL.

**1366, simple con Comparar**
```
┌ Trámites aprobados · Últimos 6 meses · por compañía ───────────────────────────────────────┐
│ 1 jun – 18 nov 2026 · Todas las compañías                                                  │
│ Mostrar [10 grupos ▾]    ( ●━ ) Comparar con el periodo anterior                           │
│ ┌ Trámites aprobados ─────────────┐   Participación                                        │
│ │ 1.102                           │   Compañía Demo A ███████████░░░░░ 36 %   398          │
│ │ ▲ 12,0 % frente a 984           │   Compañía Demo B ██████░░░░░░░░░ 21 %   231           │
│ │ Periodo anterior:               │   …                                                    │
│ │ 11 dic 2025 – 31 may 2026       │   Los demás (4)  ██░░░░░░░░░░░░░░  6 %    71           │
│ └─────────────────────────────────┘                                                        │
│ ┌ COMPAÑÍA ────────┬ TRÁMITES APROBADOS ┬ ANTERIOR ┬ VARIACIÓN ┬ PARTICIPACIÓN ┐           │
│ │ Compañía Demo A  │                398 │      350 │  ▲ 13,7 % │          36 % │           │
│ │ Compañía Demo C  │                130 │        0 │     Nuevo │          12 % │           │
│ │ Compañía Demo F  │                 89 │       95 │   ▼ 6,3 % │           8 % │           │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```
**375:** la fila de vista envuelve: «Mostrar» a todo el ancho y el switch debajo. Las tarjetas del `DataTable` (≤900) suman dos líneas, «Anterior 350» y «Variación ▲ 13,7 %».

**Cruce en % (1366, compañía × mes):** la fila de vista muestra `Mostrar [10 grupos ▾]` y `Valores (Absoluto) (●%)`.
```
│ │ COMPAÑÍA        │  JUN  │  JUL  │ … │  NOV  │ TOTAL │
│ │ Compañía Demo A │ 35,1 %│ 41,4 %│ … │ 38,0 %│ 36,1 %│
│ │ Los demás (2)   │  8,0 %│  6,5 %│ … │  7,0 %│  7,3 %│
│ │ Total           │ 100 % │ 100 % │ … │ 100 % │ 100 % │  ← tfoot
```

**Reglas de la comparación**
- **El periodo anterior** es el inmediatamente anterior y de igual número de días. Por ejemplo, «Este mes» al 18 nov (18 días) se compara con el 14–31 oct. Por eso las fechas del anterior se escriben **siempre** en la cifra: sin ellas el usuario supone que es «1–18 oct».
- **Variación:**
  - conteo, dinero y tiempos (sobre la mediana): «▲ 12,0 %» o «▼ 6,3 %», con un decimal;
  - tasa: en puntos, «▲ 3,2 pp»;
  - sin cambio: «= 0,0 %»;
  - con el anterior en 0 y el actual mayor que 0: «Nuevo»;
  - con los dos en 0: «—».
- **Color:** la variación va en tinta `--flit-text-secondary`, sin verde ni rojo. Subir no es bueno ni malo en todas las medidas (un costo que sube) y el rojo es semáforo en la Torre. La flecha y el signo bastan.
- **En la tabla de una agrupación,** la comparación aplica solo si la agrupación es **de dimensión**. Con una agrupación temporal sola, la comparación va solo en la cifra: la línea ya muestra la evolución.
- **Grupos:** las filas son las del periodo actual. Un grupo que solo existió en el anterior no aparece. «Los demás» compara la suma de sus grupos.
- **Excel:** sigue exportando valores absolutos del periodo actual, sin comparación ni %.

**% en el cruce:** el reparto se hace **dentro de cada corte**. Si un eje es temporal, cada corte de tiempo suma 100 %, esté en filas o en columnas («Intercambiar» no cambia el reparto). Si los dos ejes son categóricos, cada columna suma 100 %. La columna Total da la parte de cada fila en el total general. La gráfica por series pasa a 0–100 %, con «Los demás» incluido para que cada corte sume 100.

## 6. Estados, copy y accesibilidad

**Estados (solo lo tocado; el resto de §5.5 de la spec del Explorador sigue igual):**

| Estado | Qué se ve |
|---|---|
| **Cargando** | El esqueleto de hoy, más una línea corta bajo la cifra y 2 columnas más en la tabla si Comparar está activo. En los tableros, el esqueleto de la gráfica ocupa todo el ancho. Anuncio «Calculando la consulta». |
| **Error** | Sin cambio. `ErrorVista` «No pudimos calcular esta consulta. Revise su conexión e intente de nuevo.» y [Reintentar]. La comparación viaja en la misma petición, así que no tiene un error propio. |
| **Vacío del actual** | Sin cambio: los vacíos con acción del §5.5. La comparación no se pinta. |
| **Anterior sin datos (actual lleno)** | La cifra dice «Sin datos en el periodo anterior (11 dic 2025 – 31 may 2026)». Las columnas muestran «0» y «Nuevo». No lleva aviso aparte. |
| **Lleno** | §4 y §5. |
| **Barra: rango inválido** | Error en línea bajo los campos: «La fecha «Desde» es posterior a «Hasta». Corrija una de las dos.» Sobre la tarjeta de resultado, un aviso en página (`InlineAlert` info): «El resultado corresponde al último periodo válido: {fechas}.» |
| **Barra: fecha incompleta o borrada** | «Escriba la fecha completa en «Desde» y en «Hasta».» Se aplica la misma regla: no se consulta. |

**Notificaciones:** ninguna acción de este delta lleva toast. Los cambios de fecha y de vista se ven en el resultado y su estado persiste, así que van en página. El toast de Excel sigue como hoy.

**Feedback:** los chips de atajo, el switch y los selects llevan el hover y el `flit-focus` del kit. Los date nativos llevan el borde `--flit-border-input` y pasan a `--flit-blue-text` al recibir el foco, como `FlitSelect`. El área desplazable de la gráfica muestra el foco del kit cuando entra el teclado.

**Accesibilidad**
- **Campos de fecha.** Cada uno con su `<label>`: «Desde» y «Hasta». En los dos, `aria-describedby` apunta al texto de ayuda oculto «Formato día/mes/año» y, si existe, al error.
  - Con el rango inválido: `aria-invalid="true"` en los dos campos. El error es un `<p>` con `aria-live="polite"`, no `alert`, para no interrumpir mientras se escribe. Lleva color `--flit-danger-ink` y el ícono ⚠ (no solo color).
- **Atajos.** `FiltroSegmentado` con `ariaLabel="Atajos de periodo"`; el atajo activo lleva `aria-pressed="true"`.
- **Anuncio de las fechas.** Al elegir un atajo o un mes, una región `role="status"` (la del resultado) anuncia «Periodo: 1 de noviembre de 2026 a 18 de noviembre de 2026». Si no, quien usa lector no se entera de que los campos cambiaron.
- **Controles de vista.**
  - El switch, `role="switch"` con la etiqueta «Comparar con el periodo anterior».
  - El select, con el label visible «Mostrar».
  - El segmentado, con `ariaLabel="Valores: absoluto o porcentaje"`.
  - Cambiar un control anuncia el título nuevo del resultado por la región de estado existente.
- **Variación.** La flecha va con `aria-hidden`; el texto accesible es «sube 13,7 %», «baja 6,3 %», «nuevo, sin registros en el periodo anterior».
- **Gráfica.** El `aria-label` del SVG resume **todos** los cortes con su etiqueta completa, no la corta del eje. Con scroll, el contenedor es `role="region"`, `tabindex="0"` y `aria-label="Gráfica {título}, desplazable"`. Contraste: ≥ 3:1 en el trazo y ≥ 4.5:1 en los rótulos, en claro y en oscuro.

## 7. Datos, permiso y QA

**Datos (requerimientos para `architecture-agent` y `backend-agent`):**
1. **Comparar:** un parámetro `comparar: true` en el body de la consulta del Explorador (ruta POST existente, sin PII en la query).
   - La respuesta añade `anterior: { desde, hasta, total }` y, por fila, el valor anterior (la mediana en tiempos).
   - Lo calcula el servidor: igual duración, inmediatamente anterior.
2. **Top en el cruce:** un parámetro `top ∈ {5, 10, 20, 50}` para plegar las filas en «Los demás (N)» del lado del servidor (hoy RN-TOR-C3 fija 50). En el simple, la web corta lo que ya trae `res.filas`, si la API devuelve todos los grupos; si los trunca, también va por `top`. Lo decide architecture.
3. **% en el cruce:** se calcula en el cliente a partir de `celdas` y los cierres. No necesita endpoint.
4. **Fechas de los presets:** para que los campos y la API no difieran, conviene una sola función `resolverPeriodoTorre(preset, hoy)` en `shared-types`, usada por las dos. Hoy `ultimos_6m`, `mes_anterior` y `anio` los resuelve solo la API (D7). La web sigue enviando el preset; el subtítulo sigue mostrando las fechas que devuelve la API.

**Permiso y slug:** sin cambios. Los slugs de la Torre y `torre_explorador` siguen como están, con los mismos roles.

**Notas para QA**
1. **Atajos en las 5 pestañas:** cada atajo llena Desde y Hasta. A las 23:30 de Bogotá, «Hoy» sigue siendo hoy (sin desfase UTC).
2. **Editar Desde a mano** desmarca el atajo y consulta con el rango nuevo. Ningún atajo queda `aria-pressed`.
3. **Desde > Hasta:** sale el error en línea, `aria-invalid` en los dos campos, no se hace ninguna petición y el resultado previo sigue con su aviso.
4. **«Mes» = octubre de 2026** da 01/10/2026 → 31/10/2026. Luego, pulsar «Hoy» devuelve «Mes» a «Elegir un mes».
5. **Compañía × semana en 6 meses** (25 cortes) a 1366: la gráfica va a todo el ancho, sin etiquetas encimadas y con 13 rótulos «1 jun»… A 375: scroll horizontal, eje Y fijo y arranque en «16 nov».
6. **Tooltip:** al pasar el cursor por un corte sin rótulo, se ve su valor y la semana completa.
7. **Top 5 en el simple por compañía:** 5 filas más «Los demás (N)» en el ranking y en la tabla. Con «Agrupar por mes» sola, «Mostrar» no aparece.
8. **Comparar:** en el cruce y con «Trámites en curso», el switch no aparece; si estaba activo, se apaga. La cifra muestra las fechas del anterior y la tasa muestra «pp».
9. **% en el cruce:** cada corte suma 100 % en el tfoot, con «Intercambiar» o sin él. En una medida de tiempo, «Valores» no aparece.
10. **Persistencia y tema:** recargar conserva las fechas y los controles de vista, y ningún valor aparece en la URL. Tema oscuro: los chips, los date nativos y la variación son legibles.

## 8. Maqueta (la construye el hilo: `docs/ux/mockups/torre-vistas-flexibles.html`)

**Construcción:**
- Un solo HTML autocontenido con las clases y tokens del kit (`chip chip--sm`, `card`, `kit-matriz`, `--flit-*`).
- Sin HEX sueltos, sin red y sin JS de negocio. `?vista=` solo cambia qué sección se ve.
- Datos ficticios: Compañía Demo A–F, OT Demo Norte, fechas de 2026. Sin placas ni nombres reales.
- **No mostrar:** el `<select>` «Periodo» viejo, el chip «Rango personalizado», verde o rojo en la variación, ni controles de vista en los tableros.

| `?vista=` | Qué muestra | Ancho |
|---|---|---|
| `barra` | Barra con «Este mes» activo y los campos llenos | 1366 |
| `barra-375` | La misma barra a 375, con los atajos en scroll | 375 |
| `barra-invalido` | Desde > Hasta: error en línea y aviso del último periodo válido | 1366 y 375 |
| `barra-mes` | «Mes» = octubre de 2026, sin atajo activo | 1366 |
| `tablero-eje` | Operativa: línea semanal de 25 cortes a todo el ancho | 1366 |
| `eje-scroll-375` | La misma gráfica a 375 con scroll y eje Y fijo | 375 |
| `explorador-semana` | Compañía × semana, gráfica a todo el ancho y tabla con cabeceras cortas | 1366 |
| `vista-top` | Simple por compañía con «Mostrar 5 grupos» y «Los demás (N)» | 1366 |
| `vista-comparar` | Simple con Comparar (wireframe del §5) | 1366 |
| `vista-comparar-375` | El mismo caso a 375, con las tarjetas del DataTable | 375 |
| `vista-pct` | Cruce compañía × mes en % con el tfoot al 100 % | 1366 |
| `estado-cargando` | Esqueleto con la comparación activa | 1366 |
| `estado-error` | `ErrorVista` con [Reintentar] | 1366 |
| `estado-vacio` | «No hay trámites aprobados este mes.» con [Ver los últimos 6 meses] | 1366 |
| `estado-anterior-vacio` | Actual lleno y anterior sin datos («Nuevo») | 1366 |

**Capturas (Playwright MCP):** cada vista en 1366×768 y 375×812, en el tema claro. Además, `barra`, `vista-comparar` y `vista-pct` en el tema oscuro.

## 9. Decisiones y descartes

- **Date nativos y no `RangoFechas`:** su resumen en un solo disparador esconde las fechas, que es la queja de F1. El nativo trae calendario, teclado y label asociado, y no añade dependencias.
- **«Mes» en un select y no en 12 chips más:** 19 chips envolverían en 3 filas a 1366.
- **Sin verde ni rojo en la variación,** y la variación solo en dimensión: el sentido de bueno o malo depende de la medida, y el rojo es semáforo en la Torre. **Para que el PO lo confirme:** el % solo en conteo y dinero, y la comparación por fila solo en agrupaciones de dimensión. El pedido no lo cerraba; se eligió lo más acotado.
- **Controles de vista en la tarjeta y no en el constructor:** separan «qué pregunto» de «cómo lo veo», y quedan junto a lo que cambian.
- **Sin efectos:** ni animación de la gráfica ni del scroll, ni sombras nuevas.
