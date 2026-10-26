# UX slim — Clientes: columna Estado y filtro Activos / Inactivos (HU #13948)

Feature #13939 · Pantalla `apps/web/src/pages/Clients.tsx`, pestaña **Clientes** (`TabClientes`) ·
Solo frontend: el listado `GET /clients` ya trae `active: boolean` y ya no trae eliminados. Filtrar
es **en cliente** sobre la lista cargada; no hay endpoint nuevo ni parámetro de query.
Las piezas se diseñan para que la pestaña **Proveedores** (#13961) las use tal cual.

## Superficie tocada

| Superficie | Cambio |
|---|---|
| Tarjeta de la tabla Clientes (`FlitCard` de `TabClientes`) | Barra de filtro arriba de la tabla; columna «Estado»; pie de conteo; vacío del filtro |
| Componentes nuevos | `apps/web/src/components/clientes/EstadoRegistro.tsx` (ver «Componentes reutilizables») |

Público: operador interno (admin, financiera, auditor). **Qué vino a hacer:** encontrar una
compañía y saber si está activa; con el filtro, ver de una vez cuáles están inactivas.

## Delta de claridad (qué se ve / qué se calla)

```
 [ Clientes ][ Proveedores ]                 ← pestañas de página (sin cambio)
 [ Nuevo cliente ]                           ← única primaria (sin cambio)
┌─────────────────────────────────────────────────────────────────────────┐
│ Estado                                                                  │
│ ( Todos )( Activos )( Inactivos )                                       │
│                                                                         │
│ Empresa        Estado        Documento   Ciudad  …  SOAT sin trámite  … │
│ Acme S.A.S.    [Activo]      NIT 900…    Cali    …  Sin proveedor     … │
│ Beta Ltda.     [Inactivo]    NIT 800…    Bogotá  …  Proveedor X       … │
│                                                                         │
│ Mostrando 5 de 5                                                        │
│ Marca «SOAT», «Impuestos»…  (notas al pie existentes, sin cambio)       │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Filtro: segmentado, no select.** Tres opciones fijas y cortas: las pills (`FlitPillGroup` +
  `FlitPillButton` con `pressed`) las dejan todas a la vista y se cambian con un clic. Es el mismo
  patrón de filtro rotulado de `BarraFiltrosBandeja` (`Grupo`: `role="group"` +
  `aria-labelledby` al rótulo visible «Estado»). Un `FlitSelect` escondería dos de tres opciones
  detrás de un clic más para nada.
- **Dónde:** **dentro** de la `FlitCard` de la tabla, primera fila, alineado a la izquierda. No
  junto a las pestañas «Clientes / Proveedores» de la página: dos grupos de pills seguidos se leerían
  como una sola navegación. Dentro de la tarjeta se lee como lo que es: filtro de esta tabla.
- Opciones, en este orden: **Todos** (por defecto) · **Activos** · **Inactivos**.
- **Columna «Estado»:** segunda columna, justo después de «Empresa» (identificador + estado
  siempre visibles, `_principios-flito.md` §Jerarquía). `StatusChip` con texto: `tone="success"`
  «Activo» / `tone="neutral"` «Inactivo» — el mismo chip que ya usa la pestaña Proveedores. El
  texto es el dato; el color solo acompaña (AC6).
- **Pie:** «Mostrando X de Y», debajo de la tabla y **antes** de las notas al pie existentes,
  `text-xs` en `--flit-text-muted`, `role="status"` (lo anuncia el lector al cambiar el filtro).
  X = filas visibles tras el filtro; Y = total cargado (no cambia con el filtro).
- **Búsqueda:** la pestaña Clientes **no tiene** búsqueda hoy y esta HU no la añade. Por eso X
  depende solo del filtro. Si una HU futura suma búsqueda, la regla queda escrita para no
  rediseñar: X = filas que cumplen filtro **y** búsqueda; Y = total cargado.
- **Menú ⋮:** no existe y no se añade (llega en #13949). Nada que ocultar aquí; la columna de
  acciones sigue como está.
- Se calla: fecha de inactivación, quién inactivó, motivo. No son de esta visita (y el API no los
  trae).
- El filtro vive en estado del componente, **no** en la URL; al cambiar de pestaña y volver,
  vuelve a «Todos».

**Densidad:** +1 columna corta (un chip) y una fila de filtro. Aceptable: el estado es dato de
primera fila y la tabla ya tiene scroll horizontal del kit. No se quita ni mueve otra columna.

**Primaria:** sin cambio — «Nuevo cliente» (`GradientButton`) sigue siendo la única. Las pills no
son primarias.

## Estados (4) + copy

Tratamiento **usted** (el de la pantalla: «Inténtelo de nuevo»).

| Estado | Qué se ve | Filtro y pie |
|---|---|---|
| Cargando | «Cargando compañías…» (sin cambio) | Ocultos |
| Error (AC5) | `role="alert"`: **«No pudimos cargar los clientes.»** + botón **Reintentar** (`flitBtnSecondary`, llama `load`). Reemplaza el `errorMessage(err)` crudo que hoy se pinta | Ocultos |
| Vacío sin clientes (Y = 0) | `FlitEmpty`: «No hay clientes. Cree el primero con «Nuevo cliente».» (sin la segunda frase si no tiene `editaAutogestion`) | Ocultos: filtrar una lista vacía no ayuda |
| Vacío del filtro (Y > 0, X = 0, AC3) | `FlitEmpty`: **«No hay registros con este filtro.»** y debajo botón `flitBtnSecondarySm` **«Ver todos»** que pone el filtro en «Todos» | Visibles; pie «Mostrando 0 de Y» |
| Lleno | Tabla filtrada | Visibles |

Los dos vacíos son distintos a propósito: uno dice «no existe ninguno» (siguiente paso: crear), el
otro «existen, pero no con este filtro» (siguiente paso: «Ver todos»).

Cambiar el filtro **no** vuelve a pedir datos ni pasa por «Cargando»: filtra lo cargado.

## Responsive + feedback del delta

- **<lg:** el grupo «Estado» envuelve (el `FlitPillGroup` ya es `flex-wrap`, sin `min-w`); rótulo
  encima de las pills. La columna Estado vive en el scroll horizontal de `FlitTable`; el chip no
  envuelve (`whitespace-nowrap`). El pie es una línea de texto que envuelve si hace falta.
- **Feedback:** las pills son del kit (`flitPillBtnClase`: hover sutil + `flit-focus`), con
  `aria-pressed` en la seleccionada; «Ver todos» y «Reintentar» son botones del kit con hover y
  foco. El chip y el pie no son interactivos (sin hover, sin cursor de mano).
- **Notificación:** ninguna. Filtrar no es una acción con resultado: el estado persistente lo dicen
  la pill marcada y el pie (`role="status"`). Sin toast. El error de carga es aviso en página
  (`role="alert"`), no toast.

## Componentes reutilizables (para #13961)

Archivo: `apps/web/src/components/clientes/EstadoRegistro.tsx`. Sin dependencias de `Client`:
genéricos sobre un booleano.

```ts
export type FiltroEstado = 'todos' | 'activos' | 'inactivos';

/** Grupo rotulado de pills. role="group" + aria-labelledby al rótulo visible. */
export function FiltroEstadoPills(props: {
  valor: FiltroEstado;
  onCambio: (v: FiltroEstado) => void;
  etiqueta?: string;            // default «Estado»
}): JSX.Element;

/** StatusChip success «Activo» / neutral «Inactivo». */
export function ChipEstado(props: { activo: boolean }): JSX.Element;

/** «Mostrando X de Y», text-xs muted, role="status". */
export function PieConteo(props: { visibles: number; total: number }): JSX.Element;

/** FlitEmpty «No hay registros con este filtro.» + botón «Ver todos». */
export function VacioFiltro(props: { onVerTodos: () => void }): JSX.Element;

/** Filtro puro: Clientes pasa (c) => c.active; Proveedores, (p) => p.activo. */
export function filtrarPorEstado<T>(items: T[], filtro: FiltroEstado, esActivo: (t: T) => boolean): T[];
```

Lo que **no** es reutilizable y queda en cada pestaña: el copy del vacío sin registros y del error
de carga (dicen «clientes» / «proveedores»).

Nota para #13961 (no se toca aquí): la pestaña Proveedores pinta hoy su `StatusChip` en línea
(cambiarlo por `ChipEstado`) y su vacío tutea («Crea el primero»), mientras Clientes trata de usted.

## Permiso/slug

- Página y `PageSlug` de Clientes sin cambio. Sin acción nueva.
- Estado, filtro y pie los ve **todo** el que ve la pestaña, incluido quien solo tiene «Ver
  clientes y proveedores» (AC4). No dependen de `editaAutogestion` ni de `editaSinTramite`.
- Sin PII nueva: ni en URL ni en el pie (solo cuentas).

## Notas para QA (≤10)

1. AC1: 3 activos + 2 inactivos, «Todos» marcado al entrar, 5 filas, columna Estado tras Empresa, pie «Mostrando 5 de 5».
2. AC2: «Inactivos» → solo las 2, pie «Mostrando 2 de 5», sin recarga de red ni «Cargando».
3. AC3: sin inactivos, «Inactivos» → «No hay registros con este filtro.» + «Ver todos» (vuelve a «Todos»); pie «Mostrando 0 de N».
4. Lista vacía total → «No hay clientes…», sin filtro ni pie (distinto del vacío del filtro).
5. AC4: usuario solo con «Ver clientes y proveedores» ve Estado, filtro y pie; no hay menú ⋮.
6. AC5: forzar fallo de `GET /clients` → «No pudimos cargar los clientes.» + «Reintentar» recarga; nunca el mensaje crudo del API; sin filtro ni pie.
7. AC6: el grupo se anuncia como «Estado»; Tab llega a las pills, Enter/Espacio cambian; la seleccionada anuncia «presionado»; el chip dice «Activo»/«Inactivo» en texto.
8. El pie se anuncia al cambiar el filtro (`role="status"`).
9. Claro y oscuro: chip y pie con contraste ≥ 4.5:1; móvil 360 px: pills envuelven, la tabla hace scroll sin desbordar la página.
10. Cambiar a Proveedores y volver deja el filtro en «Todos».
