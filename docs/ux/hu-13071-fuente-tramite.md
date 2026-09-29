# UX slim — Gestión Trámites: columna y filtro «Fuente» (HU #13071)

Feature #13058 · Épica #12736 · Apilada sobre la HU #13070 (API: `fuente` por fila y `?fuente=flit|flit2`).
Público: analistas de Operaciones (operador interno). Pantalla: `apps/web/src/pages/FlitoTramites.tsx`
(slug existente de Gestión Trámites; sin página ni permiso nuevo).

## Superficie tocada

1. La barra de filtros de la tarjeta del listado (la fila de `flex flex-wrap` con búsqueda, presets, rangos, autogestión…).
2. El `<thead>` y el `<tbody>` del listado: una columna nueva.
3. El vacío filtrado del listado (`filas.length === 0`).

Fuera de esta HU (decisión del PO): el detalle del trámite y el Excel. No se tocan.

**Qué vino a hacer el analista:** lo mismo que antes: encontrar el trámite que va a gestionar.
La fuente responde a otra pregunta, «¿esto vino de FLIT 2?», y hoy la respuesta es casi siempre «no».
Por eso la columna tiene que estar ahí sin llamar la atención cuando dice lo de siempre, y notarse
cuando dice lo raro.

## Delta de claridad (qué se ve / qué se calla)

### Columna «Fuente»

- **Ubicación exacta:** justo después de la columna **Trámite** y antes de **Creado**. En Operaciones queda así:
  casilla · Trámite · **Fuente** · Creado · Aprobado · Vehículo · …
  Motivo: el origen es un atributo del trámite, no del vehículo ni del comprador, y en esta posición
  cae dentro del primer ancho visible en móvil (casilla ~40 px + Trámite ~120 px + Fuente ~64 px ≈ 225 px < 360 px).
  Así se lee sin desplazarse en horizontal (AC5).
- **Encabezado:** `<FlitTh estrecha>Fuente</FlitTh>`, **sin** `ThFiltroMulti`: el filtro vive en la barra (ver abajo).
  Dos filtros para lo mismo sería ruido.
- **Celda (`CeldaFuenteTramite`):** hay texto siempre, pero no con el mismo peso.
  - `flit` → texto plano `FLIT`, `text-xs`, `--flit-text-muted`. Es el caso normal: se ve, no pesa.
  - `flit2` → `<StatusChip tone="neutral">FLIT 2</StatusChip>`. Es la excepción y es la que el ojo debe encontrar.
    Se usa `neutral`, no `active`, porque `active` ya significa «asignado» en el chip de estado de la columna Trámite.
  - Si el valor no pasa `esFuenteTramite` (no debería pasar, por el CHECK de la base): `—` en muted. Nunca rompe la fila.
  - Etiquetas **solo** de `ETIQUETA_FUENTE_TRAMITE` (`@operaciones/shared-types`), nunca escritas a mano.
  - Celda `px-3 py-2 align-top whitespace-nowrap`, para que «FLIT 2» no se parta en dos líneas.
- La columna **no** lleva acción: no se puede hacer clic y no necesita hover propio (ya lo tiene `FlitTr`).

### Filtro «Fuente» en la barra

- **Ubicación exacta:** inmediatamente **después del grupo de autogestión** y antes del chip de alerta o del «Orden».
  Los dos son filtros rápidos de conjunto y van juntos.
- **Rótulo visible «Fuente»** delante del grupo, con el mismo estilo que el rótulo «Orden»
  (`text-xs font-semibold`, `--flit-text-secondary`). Es obligatorio: sin él quedarían dos grupos seguidos
  que empiezan por «Todas» y no se sabría cuál filtra qué.
- **Opciones:** `Todas` · `FLIT` · `FLIT 2` (`''` | `'flit'` | `'flit2'`). Una sola activa. Por defecto, `Todas`.
- **Altura:** `h-9`, la misma que el resto de la barra (búsqueda, autogestión, Orden). Una sola altura de control por barra.
- **Aspecto de cada botón** (misma geometría que autogestión: `h-9 rounded-lg border px-3 text-xs font-semibold`):
  - En reposo: fondo transparente, borde `--flit-border-input`, tinta `--flit-text-secondary`.
  - **Hover:** `hover:bg-[var(--flit-bg-hover)]` con `hover:transition-colors` (la transición es solo del hover,
    no del cambio de activo; es la lección de la HU #12997).
  - **Activo:** fondo `--flit-bg-app`, borde y tinta `--flit-pill-active-ink`. Los dos tokens tienen par oscuro.
  - **Foco:** `flit-focus`.
  - **No** se copia el activo de autogestión (`background: --flit-blue-text; color: '#fff'`): en tema oscuro
    `--flit-blue-text` es `#9DBCF7`, y el blanco encima da un contraste de ~1,8:1, que no cumple.
- **Recomendado en esta HU:** sacar el grupo a un componente genérico `FiltroSegmentado` y **migrar a él también
  el de autogestión**. Así los dos grupos, que van juntos, se ven iguales, se arregla el contraste del activo en
  oscuro y el hover que hoy le falta a autogestión, y `FlitoTramites.tsx` **pierde** unas 14 líneas, algo que
  su techo congelado agradece. El cambio visible en autogestión: el activo deja de ser azul sólido y pasa a
  tinta azul sobre velo. Si `frontend-agent` no puede migrarlo sin salirse del alcance, debe declararlo como
  Nota. En ningún caso se entrega el filtro nuevo con el activo de `'#fff'`.

### Comportamiento (AC2, AC3)

- Elegir una fuente vuelve a la página 1 (se añade a las dependencias del `setPage(1)`) y pide `?fuente=<valor>`.
  `Todas` no manda el parámetro.
- El conteo «N trámite(s)» y la paginación salen del `total` del API con la fuente aplicada. No hay cálculo en el cliente.
- Se combina con la búsqueda, los presets, las fechas, la autogestión, la alerta y los filtros de columna.
- `hayFiltros` incluye `fuente !== ''`, así que con solo la fuente puesta aparece «Limpiar filtros».
  `limpiarFiltros` (el enlace y el `onQuitar` de los presets) la devuelve a `Todas`.
- Aplicar un preset no toca la fuente, igual que no toca la autogestión.
- La fuente **no** va a la URL del SPA (no es PII, pero el AC no la pide y autogestión tampoco va). Tampoco
  se recuerda entre visitas.

### Componentes nuevos (fuera de `FlitoTramites.tsx`)

| Componente | Dónde | Qué hace |
|---|---|---|
| `FiltroSegmentado` | `apps/web/src/components/flit/FiltroSegmentado.tsx` | Grupo `role="group"` + `aria-label`, botones `aria-pressed`, `h-9`, rótulo visible opcional. Lo usan fuente y (recomendado) autogestión. |
| `CeldaFuenteTramite` | `apps/web/src/components/flito-tramites/FuenteTramite.tsx` | La celda: texto muted para FLIT, chip neutral para FLIT 2, `—` si el valor es desconocido. |
| `VacioFuenteTramite` | mismo archivo | El vacío filtrado cuando hay una fuente elegida (ver Estados). |

Si ya existe una carpeta de componentes propia de Gestión Trámites, `frontend-agent` usa esa y no crea
`flito-tramites/`. La página solo añade el estado `fuenteSel`, el parámetro, una `<FlitTh>`, una `<td>` y el
condicional del vacío.

### Densidad

Empeora un poco, y lo pide el AC: una columna estrecha más (15 en lugar de 14) y un grupo de 3 botones más
en la barra. Se compensa así: la columna casi siempre muestra texto muted (nada compite con el estado ni con la
placa), el filtro va junto a su hermano y no abre una fila nueva en escritorio, y la migración de autogestión
deja la página con menos líneas. No hace falta preguntar al PO: la columna y el filtro son el AC, y el detalle
y el Excel ya los dejó fuera.

## Estados (4) + copy

Tono de la página: **tú** («Sincroniza desde FLIT…»). Se calca.

| Estado | Qué cambia |
|---|---|
| **Cargando** | Nada nuevo. Si el esqueleto dibuja columnas, suma una estrecha después de Trámite. Mientras recarga, el filtro se puede seguir pulsando, igual que autogestión. |
| **Error** | No cambia. Si la carga con `?fuente=` falla, sale el error que ya tiene la página, con su **Reintentar**, y el reintento conserva la fuente elegida. El filtro no crea un error propio. **Nunca** se trata un 0 resultados como error (AC4). |
| **Vacío, sistema sin trámites** | No cambia («No hay trámites. Sincroniza desde FLIT para traer trámites.»). Solo sale sin filtros; con una fuente puesta, `hayFiltros` es verdadero y se ve el vacío filtrado. |
| **Vacío filtrado con fuente elegida** (`VacioFuenteTramite`, dentro del `FlitEmpty` de siempre) | Sin otros filtros ni búsqueda: **«Todavía no hay trámites de FLIT 2. Cuando lleguen, aparecen aquí.»** Con otros filtros o búsqueda: **«Ningún trámite de FLIT 2 coincide con los filtros.»** En los dos casos, un botón `flitBtnSecondarySm` con el texto **«Ver todas las fuentes»**, que pone `Todas`. La etiqueta sale de `ETIQUETA_FUENTE_TRAMITE`, así que para FLIT dice «de FLIT». |
| **Vacío filtrado sin fuente** | No cambia («Ningún trámite coincide con el filtro.»). |
| **Lleno** | La columna Fuente, con FLIT en muted y FLIT 2 en chip. El conteo corresponde a la fuente elegida. |

**Notificación:** ninguna. Filtrar es un estado de la página, no una acción con resultado. No hay toast. El
estado se ve en el botón activo y en el conteo.

## Responsive + feedback del delta

- **<`lg` / móvil (360–390 px):** la barra ya hace `flex-wrap`. El bloque «Fuente + 3 botones» es un solo
  elemento que **no se parte por dentro** (`flex-nowrap`, ~230 px) y cae a su propia línea cuando no cabe.
  Los botones conservan `h-9`, que da un área táctil suficiente, y ninguno lleva `min-w`.
- **Tabla en móvil:** esta página **no tiene vista compacta ni tarjeta móvil**. El listado es `FlitTable` con
  el scroll horizontal del kit, y así se queda. Para AC5 bastan tres cosas: la columna está dentro del primer
  ancho visible sin desplazarse, `whitespace-nowrap` impide que crezca en alto, y el contenedor del kit
  impide que la página se desborde. Si el AC5 esperaba una vista compacta que no existe, eso es otra HU:
  pregunta al PO y no la inventes aquí.
- **Feedback:** los botones del filtro llevan hover `--flit-bg-hover`, foco `flit-focus` y `aria-pressed`.
  «Ver todas las fuentes» usa `flitBtnSecondarySm`, que ya trae hover y foco. La celda no es interactiva.
- **Tema oscuro:** solo se usan tokens con par (`--flit-bg-app`, `--flit-pill-active-ink`, `--flit-text-muted`,
  `--flit-bg-hover`, `StatusChip`). Nada de `#fff`.

## Permiso/slug

Sin cambios: el slug existente de Gestión Trámites. La columna y el filtro los ve quien ya ve el listado. No
hay acción nueva, así que no hace falta una función de permiso nueva.

## Accesibilidad

- El grupo lleva `role="group"` y `aria-label="Filtrar por fuente"`, y cada botón `aria-pressed`. El rótulo
  visible «Fuente» es texto, no un `<label>`, porque no hay un input.
- Contraste: el texto muted y el chip neutral son del kit, que ya pasa en los dos temas. El activo nuevo,
  `--flit-pill-active-ink` sobre `--flit-bg-app`, es el par que ya usan las pills.
- El vacío lleva el botón «Ver todas las fuentes», que se alcanza con el teclado.

## Notas para QA (≤10)

1. AC1: los trámites existentes muestran «FLIT» en muted en la columna que sigue a Trámite. Una fila `flit2`
   (sembrada) muestra el chip «FLIT 2».
2. AC2: con `Todas`, `FLIT` o `FLIT 2`, la petición lleva `?fuente=` (o no lo lleva con `Todas`), y el conteo
   «N trámite(s)» coincide con el `total` del API.
3. AC3: fuente + autogestión + búsqueda + filtro de columna se combinan. «Limpiar filtros» (y quitar un preset)
   vuelve a `Todas`. Con solo la fuente puesta, aparece «Limpiar filtros».
4. AC3: cambiar la fuente estando en la página 3 vuelve a la página 1.
5. AC4: `FLIT 2` con 0 resultados muestra «Todavía no hay trámites de FLIT 2…» y «Ver todas las fuentes», que
   vuelve a `Todas`. No sale el error ni el vacío de «Sincroniza desde FLIT».
6. AC4: con otros filtros puestos, el vacío dice «Ningún trámite de FLIT 2 coincide con los filtros.».
7. AC5 a 360 px: el grupo Fuente cae en bloque a su línea sin partirse, la columna se ve sin scroll horizontal
   y la página no se desborda.
8. Tema oscuro: el botón activo del filtro se lee (sin blanco sobre azul claro). Si se migró autogestión, el
   suyo también.
9. Teclado: Tab llega a los tres botones, el foco se ve y `aria-pressed` cambia.
10. Detalle y Excel no cambian (fuera de alcance).

## Decisiones y descartes

- **Chip solo para FLIT 2, texto muted para FLIT.** Un chip en cada fila, hoy casi todas FLIT, añadiría
  cientos de pastillas iguales sin información. Si solo tuviera texto, un FLIT 2 no se distinguiría de un vistazo.
- **Filtro en la barra, no en el encabezado.** El `ThFiltroMulti` es de selección múltiple y en móvil queda
  detrás del scroll horizontal. El AC pide tres opciones exclusivas y que se use en móvil.
- **Columna aparte, no una línea dentro de Trámite.** Lo pide el AC1 («columna»). Además, la columna se puede
  filtrar y ordenar mentalmente, y la celda Trámite ya lleva id, tipo, estado y «Listo para entregar».
- **Sin vista compacta ni tarjeta móvil nuevas.** La página no las tiene, y crearlas sería un patrón nuevo
  fuera del pedido.
- **Sin adornos:** sin icono de fuente, sin color de marca por sistema, sin animaciones.
