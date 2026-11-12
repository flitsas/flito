# UX slim — Tarifas › modo Proveedores (Épica #13763)

> Modo **slim**: se extiende `Finanzas › Tarifas` (`/flito/tarifas`). Sin Azure DevOps por instrucción del humano.
> Base que no cambia: `docs/ux/flito-configurador-tarifas.md` (modo Clientes).
> Mockup: `docs/ux/mockups/flito-tarifas-proveedores.html` (descartable, no se importa a `apps/web`).
> Módulo de API: **`flito-tarifas`** (prefijo `flito-`, `/api/flito/tarifas`). No toca módulos legacy.

## Superficie tocada

| Archivo | Qué cambia |
|---|---|
| `apps/web/src/pages/FlitoTarifas.tsx` | Selector de modo **Clientes / Proveedores** bajo la cabecera; el subtítulo cambia con el modo. En modo Clientes todo sigue igual. |
| `apps/web/src/pages/tarifas/MatrizTarifas.tsx` | Sin cambios de comportamiento en Clientes. Se puede reutilizar la fila (`FilaTarifa`), el modal de $0 y el de «Dejar de cobrar» con copy de proveedor, o crear `MatrizTarifasProveedor.tsx` que los componga (decide `frontend-agent` según el tope de 800 líneas). **Ojo:** en Proveedores ni el botón «Dejar de cobrar» ni la confirmación del modal llevan rojo (ver «Sin rojo»). |
| `apps/web/src/pages/tarifas/HistorialTarifas.tsx` | Mismo acordeón, con columnas de proveedor (añade **Hasta** y **Cerró**). Si la prop de filtros no encaja, `HistorialTarifasProveedor.tsx` hermano. |
| `apps/web/src/pages/tarifas/PanelLogistica.tsx` | **No se usa** en Proveedores: la logística del proveedor es una sola fila, no un panel por modalidad. |

Rutas: `/flito/tarifas` y `/flito/tarifas/:companiaId` (Clientes, sin cambios) + **nuevas** `/flito/tarifas/proveedores` y `/flito/tarifas/proveedores/:proveedorId`. El id es el `uuid` opaco de `flito_proveedores`; **nada** de nombre, NIT ni cédula en la URL (AGENTS §14). Mismo componente de página, mismo `lazy()` y misma guarda.

## Qué vino a hacer quien abre esto

Fijar o revisar **lo que un proveedor le cobra a FLITO** por cada servicio que presta, para que el costo quede registrado con fecha y responsable. Es la otra cara de lo que hoy hace la pantalla con los clientes, y **no se mezcla** con ella: un modo a la vez.

## Delta de claridad (qué se ve / qué se calla)

**Lo primero que se ve:** el selector de modo (qué lado de la cuenta estoy mirando) y, ya elegido el proveedor, sus conceptos con el valor vigente o «Sin configurar».

| Siempre visible | A un clic | No está |
|---|---|---|
| Selector **Clientes · Proveedores** (`FlitPillGroup`, etiqueta «Ver tarifas de») | Historial (acordeón bajo la matriz, igual que en Clientes) | NIT, contacto, dirección del proveedor (viven en Clientes y proveedores) |
| Subtítulo por modo, una frase | Valor anterior (solo dentro de la edición: «Antes: $…») | Comparación costo vs. lo que se cobra al cliente: no es de esta visita |
| Lista de proveedores activos con buscador | | Modalidades de logística (el proveedor tiene **un** concepto «Logística») |
| Por concepto: nombre, valor vigente o «Sin configurar», desde, quién | | Contadores «Faltan n» en la lista (ver Decisiones: pregunta al PO) |
| Aclaración «Valores en pesos, sin IVA» bajo el nombre | | |

**Cómo se nota que no es lo mismo que Clientes, sin explicación larga:**

1. El selector de modo dice de quién son los valores.
2. El subtítulo cambia:
   - Clientes (sin cambios): «Lo que FLITO le cobra a cada cliente por el trámite digital y la logística, desde ahora.»
   - Proveedores: **«Lo que cada proveedor le cobra a FLITO por su servicio, desde ahora.»**
3. Bajo el nombre del proveedor: «Lo que este proveedor le cobra a FLITO. Valores en pesos, sin IVA.»
4. La lista se titula «Proveedores (n)» y la tabla tiene la columna **Servicio** (en Clientes dice **Trámite**).

**Densidad:** sin cambio en Clientes. Proveedores tiene entre 1 y 3 conceptos, menos que los 4 de Clientes. **Aliviada** respecto al vecino.

**Conceptos por proveedor** (solo los servicios que tiene **hoy**, en este orden y agrupados por servicio con el mismo título de grupo que ya usa la matriz, `h3` en mayúsculas pequeñas):

| Servicios del proveedor | Grupos y conceptos |
|---|---|
| Solo logística | LOGÍSTICA → «Logística» |
| Solo SOAT | SOAT → «SOAT con trámite», «SOAT sin trámite» |
| Los dos | LOGÍSTICA → «Logística» · SOAT → «SOAT con trámite», «SOAT sin trámite» |

### Ciclo de vida (decisiones del humano)

- **Se le quita un servicio al proveedor con valor vigente:** la vigencia **no se cierra**, queda **latente**. Sus conceptos desaparecen de la matriz (solo se pintan los servicios que tiene hoy). Si se le **vuelve a dar** el servicio, los conceptos reaparecen **con su último valor**, con su «Desde» y «Quién» originales. No hay aviso ni modal en esta pantalla: el cambio de servicios ocurre en Clientes y proveedores.
  - **En el historial** (filtro «Todos»), la vigencia latente aparece con **Hasta = «Sin servicio asignado»** (texto en tinta secundaria, sin chip), no con «Vigente». Las pills de filtro siguen siendo solo las de los servicios que tiene hoy.
- **Proveedor inactivo:** no se pueden fijar, cambiar **ni dejar de cobrar** sus valores (confirmado por el humano). Si se llega a él (enlace guardado, o se desactivó con la pantalla abierta), la matriz se ve **en solo lectura** con este aviso neutro en página (`role="status"`), encima de la matriz:
  > **Este proveedor está inactivo.** Sus valores se pueden consultar, pero no fijar ni cambiar. Para hacerlo, actívalo en Clientes y proveedores.

  En la lista de escritorio, si es el elegido, lleva «Inactivo» en texto gris (mismo patrón `NOTA_INACTIVO` de Clientes, HU #13950). Si la escritura llega al servidor igual (carrera), el rechazo se muestra en la tarjeta o la fila: «Este proveedor está inactivo; no se le pueden fijar ni cambiar valores.» y la vista se repide.

### Sin rojo (decisión del humano)

**El rojo no se usa en este sistema.** En el modo Proveedores no hay ningún texto, botón, borde ni fondo rojo (`--flit-danger-ink`, `--flit-danger-text`, `flitBtnDanger`): la gravedad la dice el copy, no el color.

| Elemento | Antes (patrón de Clientes) | En Proveedores |
|---|---|---|
| «Dejar de cobrar» en fila/tarjeta | Secundario con tinta roja | Secundario **neutro**: `flitBtnSecondarySm` en la tabla, `flitBtnSecondary` en la tarjeta |
| Confirmar del modal «Dejar de cobrar» | `flitBtnPrimary` con fondo `--flit-danger-ink` | **`flitBtnPrimary` + `flitBtnPrimaryStyle`** (degradado `--flit-gradient-primary`, texto blanco), igual que «Guardar $0» |
| Error de carga, conflicto 409 | Texto `--flit-danger-ink` | **Aviso tonal** con los pares de `AvisoProcesando` / `StatusChip`, sin spinner: tono `activo` (`--flit-chip-active-bg` + tinta `--flit-blue-ink`) para error y conflicto, tono `neutro` (`--flit-chip-draft-bg` + `--flit-chip-draft-ink`) para inactivo. Icono de texto (`!` / `i`, `aria-hidden`) + frase |
| Error de validación en línea | Texto `--flit-danger-ink` | Icono `⚠` (`aria-hidden`) + texto en `--flit-text-primary` seminegrita |
| Borde del input inválido | — | 2 px en `--flit-text-secondary` + `aria-invalid` |
| Chip «Vigente» | — | `StatusChip` tono `active` |

El modo **Clientes** sigue usando `--flit-danger-ink` en «Dejar de cobrar» y en sus errores: este delta no lo toca. Si el criterio «sin rojo» es de todo el sistema, es otra HU (pregunta al PO).

**Contraste comprobado** (valores de `flit-tokens.css`; los pares tonales de chip y el degradado valen lo mismo en claro y oscuro):

| Par | Claro | Oscuro |
|---|---|---|
| Blanco sobre `--flit-cyan-ink` / `--flit-blue-ink` (primaria) | 5,1:1 / 5,6:1 | igual (mismo token) |
| `--flit-text-primary` sobre `--flit-bg-card` (secundarios, validación) | ≈15:1 | ≈11:1 |
| `--flit-blue-ink` sobre `--flit-chip-active-bg` (aviso activo, chip Vigente) | 4,7:1 | igual |
| `--flit-chip-draft-ink` sobre `--flit-chip-draft-bg` (aviso neutro) | 4,7:1 | igual |
| `--flit-text-secondary` sobre `--flit-bg-table-header` (pills) | 5,3:1 | 8,9:1 |
| `--flit-blue-text` sobre `--flit-bg-card` (pill activa) | 5,2:1 | 7,0:1 |
| `--flit-text-muted` sobre `--flit-bg-card` («Sin configurar») | 5,1:1 | 5,9:1 |
| Borde inválido `--flit-text-secondary` sobre tarjeta (no texto, ≥3:1) | 5,3:1 | 7,9:1 |

Dentro de un aviso tonal, el botón («Reintentar», «Recargar») es el secundario normal; en oscuro queda tarjeta oscura con texto claro (≈11:1).

### Wireframe — escritorio (≥ lg): tabla

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ Tarifas                                                    (PageHeaderCard)         │
│ Lo que cada proveedor le cobra a FLITO por su servicio, desde ahora.                │
└────────────────────────────────────────────────────────────────────────────────────┘
 Ver tarifas de:  ( Clientes )  (● Proveedores )                    (FlitPillGroup)

┌──────────────────────────┐  ┌─────────────────────────────────────────────────────────┐
│ Proveedores (4)          │  │ Mensajería Andina Ejemplo S.A.S.   [Historial del proveedor]│
│ [Buscar proveedor…     ] │  │ Lo que este proveedor le cobra a FLITO. Valores en      │
│                          │  │ pesos, sin IVA.                                         │
│ ▌Mensajería Andina Ej.   │  │ ┌─────────────────────────────────────────────────────┐ │
│  Seguros Rápidos Ej.     │  │ │ Servicio        Valor vigente  Desde      Quién      │ │
│  Transportes Norte Ej.   │  │ │ LOGÍSTICA                                            │ │
│  Grúas del Valle Ej.     │  │ │ Logística       $45.000        3 nov 2026 Ana Ejemplo│ │
│                          │  │ │                   [Cambiar] [Historial] [Dejar de c.]│ │
│                          │  │ │ SOAT                                                 │ │
│                          │  │ │ SOAT con trám.  $0             5 nov 2026 Luis Ejem. │ │
│                          │  │ │                   [Cambiar] [Historial] [Dejar de c.]│ │
│                          │  │ │ SOAT sin trám.  Sin configurar —          —          │ │
│                          │  │ │                            [Fijar valor] [Historial] │ │
│                          │  │ └─────────────────────────────────────────────────────┘ │
│                          │  │ Un valor rige desde su fecha. Lo ya registrado no cambia.│
└──────────────────────────┘  └─────────────────────────────────────────────────────────┘
                              ┌─────────────────────────────────────────────────────────┐
                              │ ▸ Historial de Mensajería Andina Ejemplo S.A.S. (acordeón)│
                              └─────────────────────────────────────────────────────────┘
```

Todos los botones de fila son secundarios pequeños neutros; ninguno en rojo.

Fila en edición (una a la vez; los botones de las demás filas se apagan):

```
│ SOAT sin trám.  $ [ 18000      ]                       [Guardar] [Cancelar] │
│                 ⚠ El valor debe ser mayor o igual a cero.  ← solo si es inválido│
```

Historial abierto (≥ lg):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▾ Historial de Mensajería Andina Ejemplo S.A.S.                           │
│ ( Todos ) ( Logística ) ( SOAT con trámite ) ( SOAT sin trámite )         │
│ Servicio          Valor    Desde        Hasta               Fijó   Cerró  │
│ Logística         $45.000  3 nov 2026   [Vigente]           Ana E. —      │
│ Logística         $40.000  1 sep 2026   3 nov 2026          Luis E. Ana E.│
│ SOAT con trámite  $0       5 nov 2026   [Vigente]           Luis E. —     │
│ SOAT sin trámite  $15.000  1 sep 2026   8 nov 2026          Ana E. Luis E.│
└──────────────────────────────────────────────────────────────────────────┘
 Vigencia latente (otro proveedor, al que se le retiró SOAT):
│ SOAT con trámite  $9.000   2 oct 2026   Sin servicio asignado  Ana E. —   │
```

La columna **Servicio** solo aparece con el filtro «Todos»; al filtrar por un concepto se oculta (redundante).

### Wireframe — móvil y tableta (< lg): tarjetas, sin tabla

**Regla: por debajo de `lg` la matriz y el historial NO son tablas, son tarjetas. Cero desplazamiento horizontal de página en 375 px y en 768 px.** No se usa el scroll horizontal de `FlitTable` para esta pantalla en < lg: el humano rechazó tener que deslizar de lado para ver y fijar precios.

- **< md (375 px):** una tarjeta por concepto, una columna.
- **md a lg (768–1023 px):** mismas tarjetas, en rejilla de **2 columnas** dentro de cada grupo (`grid-cols-1 md:grid-cols-2`). La lista de proveedores sigue plegada al `FlitSelect` (cambia a lista lateral solo en `lg`, igual que en Clientes).
- **≥ lg:** la tabla de arriba, sin cambios.

375 px, lleno:

```
┌───────────────────────────────┐
│ Tarifas                       │
│ Lo que cada proveedor le      │
│ cobra a FLITO por su servicio,│
│ desde ahora.                  │
└───────────────────────────────┘
 Ver tarifas de
 ( Clientes ) (● Proveedores )
┌───────────────────────────────┐
│ Proveedores (4)               │
│ [Buscar proveedor…          ] │
│ Proveedor                     │
│ [Mensajería Andina Ejemplo ▾] │  ← FlitSelect, igual que en Clientes
└───────────────────────────────┘
┌───────────────────────────────┐
│ Mensajería Andina Ejemplo     │
│ S.A.S.                        │
│ Lo que este proveedor le      │
│ cobra a FLITO. Valores en     │
│ pesos, sin IVA.               │
│ [  Historial del proveedor  ] │  ← se apila bajo el nombre
│                               │
│ LOGÍSTICA                     │
│ ┌───────────────────────────┐ │
│ │ Logística                 │ │
│ │ $45.000                   │ │  ← valor grande (text-2xl, tabular-nums)
│ │ Desde 3 nov 2026 · Ana Ej.│ │  ← línea secundaria
│ │ [ Cambiar ] [ Historial ] │ │  ← flex-wrap, flex-1: al ancho completo
│ │ [   Dejar de cobrar     ] │ │  ← secundario neutro, sin rojo
│ └───────────────────────────┘ │
│ SOAT                          │
│ ┌───────────────────────────┐ │
│ │ SOAT con trámite          │ │
│ │ $0                        │ │
│ │ Desde 5 nov 2026 · Luis E.│ │
│ │ [ Cambiar ] [ Historial ] │ │
│ │ [   Dejar de cobrar     ] │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ SOAT sin trámite          │ │
│ │ Sin configurar            │ │  ← tinta --flit-text-muted
│ │ Todavía no tiene valor.   │ │
│ │ [Fijar valor] [Historial] │ │
│ └───────────────────────────┘ │
│ Un valor rige desde su fecha. │
│ Lo ya registrado no cambia.   │
└───────────────────────────────┘
```

375 px, tarjeta en edición («Fijar valor» o «Cambiar» abre el campo **dentro de la misma tarjeta**):

```
│ ┌───────────────────────────┐ │
│ │ SOAT sin trámite          │ │
│ │ Valor en pesos, sin IVA   │ │  ← <label> visible
│ │ $ [ -500                ] │ │  ← input al ancho completo, inputMode="numeric"
│ │ ⚠ El valor debe ser mayor │ │  ← error en línea, role="alert", sin rojo
│ │ o igual a cero.           │ │
│ │ (Antes: $15.000)          │ │  ← solo en «Cambiar»
│ │ [ Guardar ] [ Cancelar  ] │ │  ← debajo, flex-1 cada uno
│ └───────────────────────────┘ │
```

Historial < lg (lista de tarjetas, `grid-cols-1 md:grid-cols-2`):

```
│ ( Todos ) ( Logística )       │  ← las pills envuelven
│ ( SOAT con trámite )          │
│ ( SOAT sin trámite )          │
│ ┌───────────────────────────┐ │
│ │ Logística                 │ │  ← solo con filtro «Todos»
│ │ $45.000         [Vigente] │ │
│ │ 3 nov 2026 → Vigente      │ │
│ │ Fijó Ana Ejemplo          │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ Logística                 │ │
│ │ $40.000                   │ │
│ │ 1 sep 2026 → 3 nov 2026   │ │
│ │ Fijó Luis Ej. · Cerró Ana │ │
│ └───────────────────────────┘ │
│ (latente: «2 oct 2026 → Sin servicio asignado»)
```

Reglas < lg que el implementador no adivina:

- En la tarjeta, todos los botones usan la altura de `flitBtnSecondary` / `flitBtnPrimary` (h-10, objetivo táctil), no la `Sm` de la tabla. Una sola altura por barra.
- Acciones: `flex flex-wrap gap-2` con `flex-1` en cada botón; si no caben tres, la tercera baja y ocupa el ancho.
- Textos largos (nombre del proveedor, del concepto) envuelven (`break-words`, `min-w-0`); ningún `min-w` fijo ni `whitespace-nowrap` salvo el chip «Vigente».
- La cabecera del panel, el selector de modo, las pills del historial y los avisos envuelven (`flex-wrap`).
- Una sola tarjeta abierta a la vez; las acciones de escritura de las demás se apagan, igual que en la tabla.

## Componentes del kit a reutilizar

| Pieza | Archivo real | Uso |
|---|---|---|
| `PageHeaderCard` | `apps/web/src/components/flit/PageHeaderCard.tsx` | Título «Tarifas» + subtítulo por modo |
| `FlitPillGroup`, `FlitPillButton` | `apps/web/src/components/flit/flitPageKit.tsx` | Selector de modo y filtros del historial |
| `FlitCard`, `FlitEmpty`, `flitInp` | `flitPageKit.tsx` | Lista, panel, vacíos, buscador e input del valor |
| `FlitTable`, `FlitTh`, `FlitTr` | `flitPageKit.tsx` | Matriz e historial **solo ≥ lg** |
| Tarjeta de concepto (< lg) | composición en la página: `div`/`article` con `rounded-xl border` en `--flit-border-soft` sobre `--flit-bg-card`, padding `p-4` | Concepto e ítem del historial en < lg. No es componente nuevo del kit: es el mismo borde y radio de las tarjetas internas que ya existen |
| `flitBtnPrimary` + `flitBtnPrimaryStyle` | `flitPageKit.tsx` | **Solo** «Guardar» del concepto en edición y la confirmación de **los dos** modales («Guardar $0» y «Dejar de cobrar»). Nunca con fondo rojo |
| `flitBtnSecondarySm` (tabla) · `flitBtnSecondary` (tarjetas) | `flitPageKit.tsx` | Fijar valor, Cambiar, Historial, **Dejar de cobrar (neutro, sin tinta roja)**, Reintentar, Recargar, Cancelar |
| Pares tonales de aviso | `apps/web/src/components/flit/AvisoProcesando.tsx` (tonos `activo` y `neutro`) | Avisos de página (error de carga, conflicto, inactivo). Se copian sus colores y forma (`rounded-2xl border`, borde `color-mix` al 45 %), **sin** el spinner: `AvisoProcesando` es para «procesando», así que se compone un `div` con esos tokens, o se le añade una prop sin spinner (decide `frontend-agent`) |
| `StatusChip` | `apps/web/src/components/flit/StatusChip.tsx` | «Vigente» en el historial, tono `active` |
| `FlitSelect` + `opcionesConEstado` | `apps/web/src/components/flit/FlitSelect.tsx`, `apps/web/src/components/flit/opcionesConEstado` | Lista plegada en < lg |
| `esInactivo`, `NOTA_INACTIVO` | `apps/web/src/components/flit/opcionesConEstado` | «Inactivo» en la lista |
| `FlitModal` | `apps/web/src/components/flit/FlitModal.tsx` | Confirmar $0 y «Dejar de cobrar» |
| `FlitAcordeon` | `apps/web/src/components/flit/FlitAcordeon.tsx` | Historial (igual que en Clientes) |
| Esqueleto `barra()` | `apps/web/src/pages/FlitoTarifas.tsx` | Cargando con la estructura de lista + matriz |
| `toast` (`react-hot-toast`) | ya usado en `MatrizTarifas.tsx` | «Valor guardado» |

Ningún patrón visual nuevo. Sin HEX: tokens `--flit-*` (todos con par oscuro en `flit-tokens.css`). Sin `--flit-danger-*` ni `flitBtnDanger`.

## Estados (4) + copy exacto

Tono: **tú**, calcado de la pantalla de Tarifas actual («Elige un cliente…», «Tienes un valor sin guardar…»).

### Lista de proveedores

| Estado | Qué se ve | Copy |
|---|---|---|
| Cargando | Esqueleto de lista + panel, `role="status" aria-busy`, `aria-label="Cargando proveedores"` | — |
| Error | `FlitCard` con aviso tonal `activo`, `role="alert"` | **«No se pudo cargar la lista de proveedores.»** · «Revisa tu conexión y vuelve a intentarlo.» · botón **Reintentar** |
| Vacío (ningún proveedor activo) | `FlitEmpty` | **«No hay proveedores activos.»** · «Activa un proveedor en Clientes y proveedores; cuando esté activo, aquí se le fijan sus valores.» · enlace-botón **Ir a Clientes y proveedores** (`/clients`) |
| Vacío por búsqueda | `FlitEmpty` dentro de la lista | «Ningún proveedor se llama así.» · «Prueba con otra parte del nombre.» · **Limpiar búsqueda** |
| Lleno sin elegir | Panel derecho | «Elige un proveedor de la lista para ver y fijar sus valores.» |

No se preselecciona el primer proveedor (misma razón que en Clientes: no editar el valor de quien nadie eligió).

### Panel del proveedor (matriz o tarjetas)

| Estado | Qué se ve | Copy |
|---|---|---|
| Cargando | 3 barras dentro del panel, `aria-label="Cargando los valores de {proveedor}"` | — |
| Error | Aviso tonal `activo`, `role="alert"` + **Reintentar** | **«No se pudieron cargar los valores de {proveedor}.»** · «Vuelve a intentarlo en un momento.» |
| Error 404 | Aviso tonal `activo` + enlace | «Ese proveedor ya no existe.» · **Ver la lista** |
| Vacío (proveedor sin servicios) | `FlitEmpty` en el panel | **«{Proveedor} no tiene servicios asignados.»** · «Asígnale logística o SOAT en su ficha de Clientes y proveedores para fijarle valores.» · **Ir a Clientes y proveedores** |
| Lleno | 1–3 conceptos (tabla ≥ lg, tarjetas < lg) | Sin valor: **«Sin configurar»** (tinta `--flit-text-muted`); en la tabla Desde y Quién «—», en la tarjeta «Todavía no tiene valor.» |
| Lleno, proveedor inactivo | Aviso tonal `neutro` de solo lectura + conceptos sin botones de escritura | Ver «Ciclo de vida» |
| Error al recargar (con la matriz ya pintada) | Aviso tonal `activo` encima, `role="alert"` | «No se pudieron recargar los valores de {proveedor}.» · **Reintentar** |

Nunca se pinta `e.message` del API en estos estados.

### Historial (acordeón)

| Estado | Copy |
|---|---|
| Cargando | 3 barras con la forma de la tabla (≥ lg) o de las tarjetas (< lg) |
| Error | Aviso tonal `activo`: «No se pudo cargar el historial.» · **Reintentar** |
| Vacío | «Todavía no hay valores fijados para {proveedor}.» · «Cuando fijes el primero, aquí queda con su fecha y quién lo fijó.» (con filtro de un concepto: «Este servicio todavía no tiene valores fijados.» + **Ver todos**) |
| Lleno | Valor · Desde → Hasta («Vigente» en `StatusChip` si sigue abierta; **«Sin servicio asignado»** si está latente) · Fijó · Cerró («—» o se omite si no se cerró) |

## Acciones, validaciones y modales

**Una primaria:** no hay primaria en reposo (la pantalla consulta). Al abrir la edición de un concepto, **«Guardar»** de ese concepto es la única primaria; en cada modal, su botón de confirmar. El selector de modo y los filtros son pills, no CTA. «Dejar de cobrar» en la fila o tarjeta es secundario neutro, con el mismo peso que «Cambiar».

| Acción | Dónde | Resultado |
|---|---|---|
| **Fijar valor** | Concepto «Sin configurar» (con permiso y proveedor activo) | Abre el campo en sitio (fila o tarjeta), vacío y con foco |
| **Cambiar** | Concepto con valor | Abre el campo con el valor preescrito y seleccionado; debajo «Antes: $45.000» |
| **Guardar** / **Cancelar** | Concepto en edición | Enter guarda (si es válido), Escape cancela; el foco vuelve al botón del concepto |
| **Dejar de cobrar** | Concepto con valor (con permiso y proveedor activo) | Modal de confirmación |
| **Historial** | Cada concepto + «Historial del proveedor» en la cabecera | Abre el acordeón filtrado por ese concepto o en «Todos», y lleva el foco a su título |

**Validación (en línea, junto al campo, `role="alert"`):** vacío, negativo o no numérico → icono `⚠` + **«El valor debe ser mayor o igual a cero.»** en `--flit-text-primary` seminegrita, borde del campo a 2 px en `--flit-text-secondary` y `aria-invalid="true"`. El aviso no depende del color. Pesos colombianos enteros, sin IVA, sin decimales (el campo acepta `45000` y `45.000`). Guardar queda deshabilitado mientras el valor sea inválido.

**Modal — guardar $0** (`FlitModal`):
- Título: **«Cobrar $0 por {servicio}»**
- Cuerpo: «Se cobrará $0: {proveedor} no le cobrará nada a FLITO por «{servicio}» desde ahora.»
- Secundaria: «Cero no es lo mismo que «Sin configurar». Si lo que quieres es quitar el valor, usa «Dejar de cobrar».»
- Botones: **Cancelar** (`flitBtnSecondary`) · **Guardar $0** (`flitBtnPrimary` + `flitBtnPrimaryStyle`)

**Modal — dejar de cobrar** (`FlitModal`). Lo grave lo dice el texto, no el color:
- Título: **«Dejar de cobrar {servicio}»**
- Cuerpo: «{Servicio} de {proveedor} **queda sin valor desde ahora** y la fila vuelve a «Sin configurar».»
- Secundaria: «La vigencia de {valor} queda cerrada en el historial, con tu nombre y la hora. No se puede deshacer: para volver a cobrar, tendrás que fijar un valor nuevo.»
- Botones: **Cancelar** (`flitBtnSecondary`) · **Dejar de cobrar** (`flitBtnPrimary` + `flitBtnPrimaryStyle`, degradado y texto blanco, **sin** fondo rojo)

**Cambio de modo o de proveedor con un concepto en edición:** `confirm` igual al de Clientes: «Tienes un valor sin guardar en {servicio} de {proveedor}. ¿Salir y perderlo?» El proveedor elegido no pasa al modo Clientes ni al revés.

## Responsive + feedback + notificaciones

- **Responsive:** **< md: tarjetas, sin scroll horizontal.** md–lg: tarjetas en 2 columnas, sin scroll horizontal. ≥ lg: tabla. Detalle en «Wireframe — móvil y tableta». Lista → `FlitSelect` por debajo de `lg`; cabecera del panel, selector de modo, pills y avisos envuelven. Criterio de aceptación visual: `document.documentElement.scrollWidth <= window.innerWidth` en 375 y 768 px, en todas las vistas.
- **Feedback:** todos los controles vienen del kit con hover (`HOVER_SECUNDARIO`, velo `--flit-veil-press-hover` en primarios) y `flit-focus`. Ítems de la lista: `hover:bg-[var(--flit-bg-hover)]` + `flit-focus` (ya existe en la lista de Clientes). Pills: `FlitPillButton`. Las tarjetas no son clicables enteras (no llevan hover): lo clicable son sus botones. Nada plano, nada animado aparte de `transition-colors`.
- **Notificaciones:**

| Acción | Patrón | Copy |
|---|---|---|
| Guardar (valor nuevo, cambio o $0) | **Toast** de éxito, cerrable, ~4 s | **«Valor guardado.»** |
| Dejar de cobrar | Toast de éxito, cerrable | «Valor quitado. {Servicio} queda sin configurar.» |
| Guardar sin cambios (mismo valor) | Toast neutro | «Ese ya era el valor vigente. No hay nada que guardar.» |
| Fallo de red/servidor al guardar | **En el concepto**, junto al campo (la edición sigue abierta), mismo estilo que la validación | «No se pudo guardar. El valor que escribiste sigue aquí; vuelve a intentarlo.» |
| Fallo al dejar de cobrar | Toast cerrable, ≥ 6 s, estilo neutro del toast (sin rojo) | «No se pudo dejar de cobrar. Vuelve a intentarlo en un momento.» |
| **Conflicto (409)** | **Aviso tonal `activo` en página** encima de la matriz (`role="alert"`), persiste hasta recargar; la edición se cierra | **«Otro usuario cambió este valor. Recarga para ver el vigente.»** + botón secundario **Recargar** (repide la vista y quita el aviso) |
| Proveedor inactivo | **Aviso tonal `neutro` en página** (`role="status"`), no toast | Ver «Ciclo de vida» |

El conflicto y el proveedor inactivo son avisos y no toasts porque siguen siendo ciertos mientras se mira la página. `toast.error` de `react-hot-toast` pinta un icono rojo por defecto: en este modo el fallo va con `toast(…)` neutro (o con el icono sobrescrito por un token no rojo).

## Permiso y comportamiento por rol

- **Slug:** el existente `flito_tarifas` (`ProtectedRoute page="flito_tarifas"`). Mismos roles que hoy ven Tarifas; no se crea slug nuevo ni se usa el rol `operaciones` (no existe).
- La pantalla decide por **`capacidades`** que devuelve el servidor por proveedor (`editar`, `verHistorial`), igual que en Clientes, nunca por el nombre del rol. Con el proveedor inactivo, el servidor devuelve `editar: false` y la UI añade el aviso.
- Sin `editar`: se ve la matriz o las tarjetas completas (valores, desde, quién) **sin** Fijar valor / Cambiar / Dejar de cobrar. «Historial» solo con `verHistorial`.
- Si el negocio quiere que el modo Proveedores lo vea un subconjunto de roles distinto al de Clientes → pregunta al PO (no se asume).

## Datos — requerimiento para `architecture-agent` / `backend-agent`

**No existe hoy** ningún endpoint de tarifas de proveedor (comprobado: `apps/api/src/modules` no tiene ruta de tarifas por proveedor). Contrato mínimo que la UI necesita, en `flito-tarifas`:

| Uso | Propuesta |
|---|---|
| Lista | `GET /api/flito/tarifas/proveedores` → `[{ id (uuid), nombre }]` solo activos, orden alfabético. Sin NIT ni contacto en el DTO |
| Vista | `GET /api/flito/tarifas/proveedores/:proveedorId` → `{ proveedorId, proveedorNombre, activo, capacidades: { editar, verHistorial }, filas: [{ servicio: 'logistica' \| 'soat_con_tramite' \| 'soat_sin_tramite', vigenciaId, valor \| null, vigenteDesde, fijadoPor }] }` — **solo** los conceptos de los servicios que el proveedor tiene **hoy**; una vigencia abierta de un servicio retirado (latente) no se devuelve hasta que el servicio vuelva; `filas: []` = proveedor sin servicios; `activo: false` ⇒ `editar: false` |
| Fijar | `POST /api/flito/tarifas/proveedores/:proveedorId` `{ servicio, valor, confirmarCero? }` — rechaza con proveedor inactivo o servicio no asignado |
| Cambiar / dejar de cobrar | `PATCH /api/flito/tarifas/proveedores/vigencias/:vigenciaId` `{ valor, confirmarCero? }` · `{ activo: false }`; **409** si la vigencia ya no es la vigente (conflicto); rechazo distinguible si el proveedor está inactivo (también para dejar de cobrar) |
| Historial | `GET /api/flito/tarifas/proveedores/:proveedorId/historial?servicio=` → `[{ servicio, valor, desde, hasta \| null, latente, fijadoPor, cerradoPor \| null }]` — `latente: true` cuando la vigencia sigue abierta pero el servicio ya no está asignado (la UI pinta «Sin servicio asignado») |

Ids opacos (`uuid`) en path; ningún dato personal en query. Si `fijadoPor`/`cerradoPor` son nombres de usuarios internos, mismo tratamiento que ya tiene el historial de clientes.

## Accesibilidad

- Selector de modo: `FlitPillGroup label="Ver tarifas de"`, pills con `aria-pressed`.
- Lista: `<ul aria-label="Proveedores">`, ítem elegido con `aria-current="true"`; buscador con `aria-label="Buscar proveedor"`.
- Tabla (≥ lg): `FlitTable label="Valores de {proveedor}"`; cada fila con `<th scope="row">`; títulos de grupo como `h3` (no `th rowgroup`, misma lección de la matriz de Clientes).
- Tarjetas (< lg): contenedor `role="group" aria-label="Valores de {proveedor}"`; grupo con `h3` (LOGÍSTICA / SOAT); cada tarjeta `article` con `aria-labelledby` a su `h4` (nombre del concepto). Orden de lectura: nombre → valor → desde/quién → acciones.
- Botones con `aria-label` que incluye el sujeto: «Cambiar · SOAT con trámite de {proveedor}».
- Input: en la tabla `<label class="sr-only">Valor de {servicio} de {proveedor}</label>`; en la tarjeta, `<label>` **visible** «Valor en pesos, sin IVA». En ambos, `aria-invalid` y `aria-describedby` al mensaje. El error se distingue por icono + texto + borde más grueso, no por color.
- Avisos: el icono (`!`, `i`, `⚠`) es `aria-hidden`; el texto lleva el mensaje.
- Anuncio `role="status"` al cargar: «Valores de {proveedor}.»
- Modales `FlitModal` con foco atrapado y devuelto al concepto.
- Contraste: ver la tabla de «Sin rojo»; todo texto ≥ 4.5:1 y bordes de estado ≥ 3:1 en claro y oscuro.

## Notas para QA (≤10)

1. El modo Clientes queda idéntico: mismos conceptos, mismo subtítulo, mismas rutas (y su rojo, que este delta no toca).
2. Proveedor solo logística → 1 concepto; solo SOAT → 2; ambos → 3 en dos grupos (LOGÍSTICA primero). Sin servicios → «{Proveedor} no tiene servicios asignados.»
3. Vacío, negativo o texto → «El valor debe ser mayor o igual a cero.» con `⚠` y Guardar deshabilitado; 0 abre «Cobrar $0…» y Cancelar no escribe nada.
4. Dejar de cobrar → el concepto vuelve a «Sin configurar» y el historial muestra la vigencia con Hasta y Cerró.
5. 409 → aviso «Otro usuario cambió este valor. Recarga para ver el vigente.»; Recargar lo quita y muestra el valor nuevo.
6. Sin `capacidades.editar` o con proveedor inactivo: ningún botón de escritura (tampoco «Dejar de cobrar»); con inactivo, además el aviso «Este proveedor está inactivo.»
7. Quitar un servicio con valor vigente → sus conceptos desaparecen y el historial muestra «Sin servicio asignado»; volver a darlo → reaparecen con el mismo valor, Desde y Quién.
8. **Sin rojo** en Proveedores: ni en «Dejar de cobrar» (fila, tarjeta, modal), ni en avisos, ni en validación. Texto de todos los botones ≥ 4.5:1 en claro y oscuro (axe sin hallazgos de contraste).
9. **375 px y 768 px:** sin desplazamiento horizontal de página en ninguna vista (`scrollWidth <= innerWidth`); conceptos e historial en tarjetas; el campo, Guardar y Cancelar dentro de la tarjeta.
10. URL: solo `/flito/tarifas/proveedores/<uuid>`; ≥ 1024 px: tabla como antes.

## Decisiones y descartes

- **Sin rojo** (decisión del humano): «Dejar de cobrar» es secundario neutro y su confirmación es la primaria del kit; avisos con los pares tonales de `AvisoProcesando`/`StatusChip`; validación con icono + texto. El rojo del botón del modal además no dejaba leer su texto. El modo Clientes no se toca en este delta (pregunta al PO si se unifica).
- **< lg tarjetas, no tabla con scroll.** El humano rechazó el scroll lateral para ver y fijar precios. Con 1–3 conceptos la tarjeta no gana densidad y deja el valor (lo que se vino a ver) en grande. La tarjeta se compone con borde y radio que ya usa el kit; no es componente nuevo.
- **md–lg también tarjetas** (2 columnas): a 768 px el panel ocupa todo el ancho y la tabla de 5 columnas con 3 botones por fila volvía a apretar; un cambio en md y otro en lg habría sido un tercer layout que mantener.
- **Historial en acordeón, no en modal.** Clientes ya usa `FlitAcordeon` debajo de la matriz, y dos patrones para lo mismo en una pantalla es drift.
- **Vigencia latente = «Sin servicio asignado» en Hasta** (confirmado por el coordinador): mostrarla como «Vigente» confundiría, porque no se aplica mientras el proveedor no tenga el servicio.
- **Inactivo = solo lectura, también para «Dejar de cobrar»** (confirmado).
- **Modo en el path (`/flito/tarifas/proveedores`), no en query.** Deja el modo en el enlace compartido y no choca con `/flito/tarifas/:companiaId` (que solo acepta dígitos).
- **Sin «Faltan n» en la lista de proveedores.** El pedido solo menciona buscador y proveedores activos; añadirlo exigiría otro endpoint. **Pregunta al PO** si lo quiere como en Clientes.
- **«FLITO» en el subtítulo** (el pedido decía «FLIT»): calca el subtítulo de Clientes y la regla de voz.
- **Qué pasa aguas abajo con «Sin configurar» de un proveedor** (¿bloquea liquidar costos?): no se inventa; **pregunta al PO**.
- **Toast «Valor guardado.» corto**, como pidió el humano.
- No se agregan KPIs, totales, iconos de servicio, sombras ni ilustraciones.

## Brief de mockup

Archivo: `docs/ux/mockups/flito-tarifas-proveedores.html`. Enlaza `flito-tarifas-proveedores.css`, que el hilo compila con el Tailwind 4 del repo (dark por la clase `.dark`); **sin CDN**. Solo clases utilitarias estándar de Tailwind más un `<style>` inline con los tokens `--flit-*` (copia de `flit-tokens.css`, claro y oscuro) y las clases que imitan el kit. Sin HEX en el marcado, sin `--flit-danger-*`. Sin red ni lógica de negocio. La barra de conmutadores de arriba no es producto y **envuelve** (`flex-wrap`): no puede causar scroll horizontal.

- **Parámetros de captura:** `?vista=lleno|edicion|conflicto|sinpermiso|inactivo|sinservicios|cargando|error|vacio` `&historial=1` `&modal=modalCero|modalDejar` `&toast=1` `&tema=oscuro`. `vista=edicion` muestra la fila abierta en ≥ lg y la **tarjeta** con el campo abierto en < lg.
- **Vistas:** Lleno (Logística $45.000 · SOAT con trámite $0 · SOAT sin trámite «Sin configurar»), Edición con error de validación, Conflicto 409, Sin permiso, Proveedor inactivo, Sin servicios, Cargando, Error con Reintentar, Vacío, Historial abierto, modal $0, modal Dejar de cobrar, toast.
- **Capturas:** 1366×768, 768×1024 y 375×812, claro y oscuro: `docs/ux/mockups/flito-tarifas-proveedores-<estado>-<ancho>.png`. En cada una, verificar `scrollWidth <= innerWidth`; en `modal=modalDejar` en los dos temas, comprobar que el texto del botón se lee.
- **No está en la maqueta:** la vigencia latente («Sin servicio asignado»), porque el proveedor de ejemplo tiene los dos servicios; queda descrita en la spec y en el wireframe del historial.
- **Datos ficticios:** «Mensajería Andina Ejemplo S.A.S.», «Seguros Rápidos Ejemplo», «Transportes Norte Ejemplo», «Grúas del Valle Ejemplo»; usuarios «Ana Ejemplo», «Luis Ejemplo». Sin NIT, cédula, teléfono ni placa.
- **Qué NO mostrar:** NIT o contacto del proveedor, comparación con lo que se cobra al cliente, modalidades de logística, «Faltan n».
