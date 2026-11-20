# UX — Ayuda FLITO (Feature #11892 · HU #11893 · v2: Feature #13691)

> **Modo `full`.** Dispara el umbral: **página nueva** (`PageSlug` + ruta + ítem de menú).
> Esta HU publica el **índice por permiso** y la **superficie de ficha**. **No** publica las 18
> fichas de contenido (eso es #11894 / #11895): el índice puede mostrar «Ficha pendiente».
>
> Decisiones de producto **cerradas** (no reabrir): ayuda in-app con Markdown del repo como fuente;
> **un** ítem de menú; **sin** «¿Cómo se usa?» en cada pantalla; ~~**sin** capturas~~ (revocado por
> Feature #13691 HU-5: capturas y diagramas **solo con datos demo**); visibilidad
> derivada de `hasPage` sobre el catálogo (no un permiso que alguien conceda a mano); tono **usted**;
> no copiar LaftManual (PDF). El rol `operaciones` no existe: el operador FLITO es `admin`.

> **Anexo HU #11901.** Búsqueda de capítulos en el índice:
> [`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md). Revoca **solo** «No hay búsqueda,
> filtros ni paginación». El gate derivado y los 4 estados del índice no cambian; el vacío
> de filtro es **subestado del lleno**.

> **Anexo Feature #13691 «Ayuda FLITO v2» (slim, 2026-10-20).** Delta por HU al final de este
> archivo: [§ Ayuda FLITO v2](#ayuda-flito-v2--feature-13691-slim). La búsqueda por relevancia
> (HU-2) va en [`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md#delta-feature-13691--hu-2).
> Revoca, y lo marca en línea: (1) la prohibición de capturas/diagramas (HU-5); (2) el `NoAccess`
> en la URL directa del **índice** sin fichas visibles (HU-2, P9-3a); (3) el copy «capítulo» → «ficha».
> Lo demás de este documento sigue vigente.

> **Anexo HU #13775.** Grupo Tránsito y ficha «Tablero de control»: [flito-ayuda-transito.md](flito-ayuda-transito.md).

> **Anexo HU #13896 (slim, 2026-10-23).** Árbol lateral de fichas en la vista de ficha:
> [§ HU #13896](#hu-13896--árbol-lateral-de-fichas-slim). Corrige, y lo marca en línea, la
> justificación «la TOC va a la derecha porque el menú del shell ocupa la izquierda»: el menú del
> shell es hoy una barra flotante inferior. La TOC **se queda** a la derecha; la izquierda es del
> árbol. La rejilla de la ficha pasa de 2 a 3 columnas en `≥ lg`.

---

## Contexto y roles

Quien opera FLITO necesita consultar **cómo se usa la pantalla que ya puede abrir**, sin salir a un
PDF ni a un wiki. La ayuda vive **dentro de la app**, en una sola entrada de menú **Ayuda FLITO**.

El índice **no es el catálogo completo del producto**: es la intersección entre las 18 pantallas
documentadas y las que el usuario **ya tiene** en `hasPage` (`getEffectivePages`: defaults del rol ∪
`allowedPages`). Si no puede abrir Impuestos, no ve el capítulo de Impuestos.

### Implicaciones UX de los AC (Gherkin)

| AC | Qué significa en pantalla |
|---|---|
| **AC1** | El ítem **Ayuda FLITO** aparece si el usuario tiene **≥1** slug del catálogo de 18. No hay un permiso `flito_ayuda` que un administrador active a mano para «darle la ayuda». Quien ya entra a SOAT, ve Ayuda. |
| **AC2** | `conductor`, `compliance`, `transito`, `lider_pesv` y `supervisor_flota` **sin** ninguna página del catálogo en sus páginas efectivas: **no** ven el ítem. ~~Si pegan la URL, el mismo patrón que el resto del shell: `NoAccess`.~~ **v2 (P9-3a):** si pegan `/flito/ayuda`, ven el vacío «Su usuario aún no tiene módulos con ayuda» (ver HU-2 al final). El ítem de menú sigue oculto. `/flito/ayuda/:slug` sin `hasPage` del slug sigue siendo `NoAccess` de esa pantalla. |
| **AC3** | `proveedor` (gestor SOAT) solo tiene `soat` en el catálogo: el índice lista **SOAT** y no Impuestos, Bolsas ni Siigo. Si el `.md` de SOAT aún no existe, la fila dice **Ficha pendiente** (no es error). |
| **AC4** | Índice y ficha tienen los **4 estados**: carga, error + **Reintentar**, vacío, lleno. Copy abajo. |
| **AC5** | Encabezados reales, nombre accesible en cada control, foco visible, contraste ≥ 4.5:1 (tokens `flit/`). |
| **AC6** | Toda ficha publicada (HUs siguientes) usa la plantilla de secciones. ~~Prohibido capturas~~ (v2: capturas con datos demo y texto alternativo), endpoints y tablas dentro de la ficha. Esta HU deja el **renderer** y el estado pendiente listos. |

### Matriz de roles × catálogo (quién ve el menú)

Roles de `USER_ROLES` (`packages/shared-types/src/permissions.ts`). Visibilidad del menú = **≥1**
slug de la tabla «Catálogo de 18» en `hasPage`.

| Rol | ¿Ve Ayuda FLITO? (defaults) | Capítulos que lista el índice (defaults) |
|---|---|---|
| `admin` | Sí | Los 18 |
| `proveedor` | Sí | Solo **SOAT** |
| `gestor_impuestos` | Sí | Solo **Impuestos** |
| `mensajero` | Sí | Solo **Mi ruta** |
| `auditor` | Sí | Gestión FLITO de lectura + reporte de costos + Siigo param/operación. **No** Comparendos, Bolsas, Conciliación, Credenciales Siigo, Mi ruta |
| `financiera` | Sí | Clientes y proveedores, Bolsas, Conciliación, Reporte de costos, Siigo param, Siigo operación. **No** trámites/SOAT/impuestos operativos ni Credenciales Siigo |
| `conductor`, `compliance`, `transito`, `lider_pesv`, `supervisor_flota` | **No** (salvo que les concedan a mano un slug del catálogo) | — |

Si un administrador concede `soat` a un `conductor`, ese usuario **pasa a ver** el menú y el capítulo
SOAT. Eso es AC1, no un agujero.

---

## Flujo de usuario (Mermaid)

```mermaid
flowchart TD
  login[Sesión iniciada]
  login --> gate{¿hasPage de ≥1 slug<br/>del catálogo de 18?}
  gate -->|No| oculto[Ítem Ayuda FLITO oculto]
  oculto --> url{¿Pega /flito/ayuda?}
  url -->|Sí| sinmod[v2: vacío «Su usuario aún no tiene módulos con ayuda» + Volver al inicio]
  url -->|No| fin[Sigue en sus pantallas]
  gate -->|Sí| menu[Ve Ayuda FLITO en General y en ⌘K]
  menu --> idx[/flito/ayuda índice]
  idx --> st{Estado del índice}
  st -->|Carga| skel[PageContentSkeleton]
  st -->|Error| err[Copy de error + Reintentar]
  st -->|Lleno sin búsqueda| grupos[Grupos Gestión / Finanzas / Administración]
  st -->|Lleno con búsqueda| lista[v2: lista única por relevancia, grupo como etiqueta]
  grupos --> click[Activa una ficha]
  lista --> click
  click --> det[/flito/ayuda/:slug ficha]
  det --> dst{Estado de la ficha}
  dst -->|Carga| skel2[Skeleton de artículo]
  dst -->|Error al leer .md| err2[Error + Reintentar + Volver al índice]
  dst -->|Sin .md| pend[Ficha pendiente — no es error]
  dst -->|Sin hasPage del slug| noaccess2[NoAccess de esa pantalla]
  dst -->|Slug fuera del catálogo| noficha[Esta ficha no existe + Volver al índice]
  dst -->|Lleno| md[Markdown: plantilla AC6 + v2: versión/fecha, contenido, avisos, imágenes, Aplica para]
  md --> ir[Opcional: Ir a la pantalla]
  md --> sec[v2: salto a sección #ancla / Anterior · Siguiente]
  pend --> vol[Volver al índice]
  md --> vol
```

No hay rama «ayuda contextual» ni botón «¿Cómo se usa?» en las pantallas del catálogo.

---

## Catálogo de 18 — el índice filtra por `hasPage`

Fuente de verdad de **qué** puede aparecer. El **orden** de cada grupo es el de abajo (el de
`NAV_ITEMS` cuando el ítem existe; si no hay ítem de menú, al final del grupo).

Etiqueta visible = etiqueta de **nav** si el ítem existe; si no, la de `PAGES` (o la indicada).

> Nota v2: el catálogo actual tiene 22 entradas y un grupo **General** (HU #13431). Las tablas de
> abajo son la foto de #11893; el orden vigente es el de `catalogo.ts` + `GRUPOS_ORDEN`.

### Gestión

| PageSlug | Ruta de la pantalla | Ítem NAV | Etiqueta en el índice |
|---|---|---|---|
| `flito_tramites` | `/flito/tramites` | Sí · Gestión | Gestión Trámites |
| `soat` | `/flito/soat` | Sí · Gestión (`roles`: proveedor, admin) | SOAT |
| `flito_impuestos` | `/flito/impuestos` | Sí · Gestión (`roles`: gestor_impuestos, admin) | Impuestos |
| `flito_derechos` | `/flito/derechos` | Sí · Gestión | Derechos de tránsito |
| `flito_revisiones` | `/flito/revisiones` | Sí · Gestión | Revisiones OCR |
| `flito_compuerta` | `/flito/compuerta` | **No** | Compuerta de entrega |
| `flito_tablero` | `/flito/tablero` | **No** | Tablero FLITO |
| `flito_bitacora` | `/flito/bitacora` | Sí · Gestión | Bitácora |
| `flito_logistica` | `/flito/logistica` | Sí · Gestión | Logística |
| `flito_logistica_ruta` | `/flito/ruta` | Sí · Gestión (`roles`: mensajero) | Mi ruta |
| `flito_comparendos` | `/flito/comparendos` | Sí · Gestión | Comparendos |
| `clients` | `/clients` | Sí · Gestión | Clientes y proveedores |

`admin` **sí** ve Compuerta, Tablero FLITO y Mi ruta en el índice (`hasPage` de todos los slugs),
aunque Compuerta/Tablero no estén en el menú y Mi ruta esté restringida en nav a `mensajero`. El
índice sigue a `hasPage`, no al filtro `roles` de `NAV_ITEMS`.

### Finanzas

| PageSlug | Ruta de la pantalla | Ítem NAV | Etiqueta en el índice |
|---|---|---|---|
| `flito_bolsas` | `/flito/bolsas` | Sí · Finanzas | Bolsas |
| `flito_conciliacion` | `/flito/conciliacion` | Sí · Finanzas | Conciliación |
| `finanzas_reporte_costos` | `/finanzas/reporte-costos` | Sí · Finanzas | Reporte de costos |
| `siigo_parametrizacion` | `/siigo/parametrizacion` | Sí · Finanzas | Facturación electrónica · Parametrización |
| `siigo_operacion` | `/siigo/operacion` | Sí · Finanzas | Facturación electrónica · Operación |

### Administración

| PageSlug | Ruta de la pantalla | Ítem NAV | Etiqueta en el índice |
|---|---|---|---|
| `siigo_credenciales` | *no hay ruta de producto hoy* | **No** | Facturación electrónica · Credenciales |

Grupo **solo para quien tenga `hasPage('siigo_credenciales')`**. En defaults eso es **`admin`**.
Un grupo sin filas **no se pinta** (proveedor no ve «Administración» vacío).

**Requerimiento de datos (architecture / `shared-types`):** `siigo_credenciales` **no está** en
`PAGES` hoy. Hay que **añadir el slug** para que el filtro `hasPage` exista. No hace falta pantalla
ni ítem de menú en esta HU: el capítulo sale como **Ficha pendiente**. No inventar URL. El enlace
**Ir a la pantalla** se omite mientras no haya ruta. `ROLE_DEFAULT_PAGES`: solo lo obtiene `admin`
(por tener todo el catálogo); **no** añadirlo a `financiera` ni a `auditor`.

---

## Permiso / slug de la página de ayuda

| Pieza | Decisión |
|---|---|
| Rutas | `/flito/ayuda` (índice) y `/flito/ayuda/:slug` (ficha). `:slug` es el **PageSlug** del catálogo (`flito_tramites`, `soat`, …). No es PII. **v2:** la ficha admite `#<seccion>` (ancla derivada del encabezado). Nunca query. |
| Registro | `App.tsx`: `lazy()` + guarda. **La guarda no es** `hasPage(user, 'flito_ayuda')`. |
| Gate | Helper único, p. ej. `puedeVerAyudaFlito(user)` = existe al menos un slug del catálogo de 18 con `hasPage`. Índice, ficha, ítem de menú y ⌘K usan **el mismo** helper. |
| `ProtectedRoute` | ~~Si el gate falla → `<NoAccess page="flito_ayuda" />`~~. **v2 (P9-3a):** si el gate falla en `/flito/ayuda` → vacío «Su usuario aún no tiene módulos con ayuda». En `/flito/ayuda/:slug` sin `hasPage` del slug → `NoAccess` de esa pantalla (sin cambio). |
| Ficha de un slug sin `hasPage` | `<NoAccess page={slug} />` — el mismo mensaje que si hubiera abierto esa pantalla. |
| `PAGES.flito_ayuda` | `'Ayuda FLITO'`. **No** entra en `PAGE_GROUPS` del editor de usuarios: no es un permiso concedible. |
| `NAV_ITEMS` | Un ítem: `to: '/flito/ayuda'`, `label: 'Ayuda FLITO'`, `section: 'general'` (junto a Tablero), `keywords: 'ayuda manual guia ficha como se usa flito'`. **No** filtrar este ítem con `allowed.has('flito_ayuda')`: `useNavSections` y `CommandPalette` deben usar el helper derivado. Si se deja el filtro actual, `proveedor` nunca vería el ítem. |
| Command Palette | El mismo ítem, visible con el mismo helper. |

Patrones a reutilizar: `PageHeaderCard`, `PageContentSkeleton`, `FlitCard`, `FlitEmpty`,
`flitBtnSecondary` (**Reintentar**), `NoAccess`, tokens de `components/flit/`. No hay patrón visual
nuevo. **No** copiar `LaftManual` (lista de versiones PDF + SHA).

Fuente del contenido: **Markdown en el repo, empaquetado en el cliente**. Esta HU no pide un
endpoint de fichas. Si el `.md` no está, es **Ficha pendiente**, no 404 de API.

---

## Pantalla 1 — Índice (`/flito/ayuda`)

### Wireframe

```
┌─────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]                                                │
│  Ayuda FLITO                                                    │
│  Guías de las pantallas que usted ya puede abrir.               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ GESTIÓN                                                    h2   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Gestión Trámites                              Ficha pendiente│ │
│ │ Cómo despachar SOAT, impuestos y entregas.            →     │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ SOAT                                                  Abrir →│ │
│ │ Cola de pólizas del proveedor.                              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ FINANZAS                                                   h2   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Bolsas                                        Ficha pendiente│ │
│ │ Saldos, recargas y cierres.                           →     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ADMINISTRACIÓN                                             h2   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Facturación electrónica · Credenciales      Ficha pendiente│ │
│ │ (solo si hasPage siigo_credenciales)                  →     │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Cada fila es un **enlace** (`<a>` / `Link`) con nombre accesible: «Abrir ficha de SOAT» o, si está
pendiente, «Ficha pendiente de SOAT». Toda la fila es el hit target. No hay botón extra «¿Cómo se
usa?» ni miniaturas.

Una línea de apoyo (una frase, sin endpoints) bajo el título ayuda a escanear; puede vivir en un
manifiesto estático del catálogo, **no** requiere que el `.md` exista. **v2 (HU-1):** esa línea es
el `resumen` del encabezado de la ficha; el del catálogo queda de respaldo para fichas pendientes.

Grupos vacíos: **no se renderizan**. `proveedor` ve un solo grupo (Gestión) con una sola fila (SOAT).

**HU #11901:** en estado **Lleno**, campo de búsqueda bajo el header. Wireframe del control
y copy: [`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md). **v2 (HU-2):** con búsqueda
escrita, la lista deja de agruparse (ver delta en ese archivo).

**HU #13896:** el índice **no** lleva árbol lateral: ya es la lista de fichas.

### Estados (4) + copy

| Estado | Cuándo | Qué se ve | Copy (usted) | Control |
|---|---|---|---|---|
| **Cargando** | Resolviendo catálogo ∩ `hasPage` y qué `.md` existen | `PageHeaderCard` + `PageContentSkeleton` (`aria-busy`, `aria-label="Cargando página"`) | *(sin párrafo extra; el skeleton habla)* | — |
| **Error** | Falló la carga del manifiesto / del bundle de fichas | `FlitCard` con título de error | **No se pudo cargar el índice de ayuda.** ~~Debajo, el `errorMessage` del cliente~~ **v2:** «Revise su conexión y vuelva a intentarlo.» (sin el error crudo) | **Reintentar** |
| **Vacío** | ~~Defensivo~~ **v2 (P9-3a):** el usuario no tiene **ninguna** ficha visible (URL directa; el menú no lo lleva aquí) | `PageHeaderCard` (solo título) + `FlitEmpty` | **Su usuario aún no tiene módulos con ayuda.** / «La Ayuda FLITO muestra guías solo de las pantallas que usted puede abrir. Si necesita una, pídale a un administrador que le habilite esa pantalla.» | **Volver al inicio** (enlace a `/`) |
| **Lleno** | ≥1 ficha | Lista agrupada (sin búsqueda) o lista por relevancia (con búsqueda) | Título de página **Ayuda FLITO**. Subtítulo: **Guías de las pantallas que usted ya puede abrir.** Badge **Ficha pendiente** en filas sin `.md`. | Cada fila navega a `/flito/ayuda/:slug` |

~~`NoAccess` (AC2, URL directa sin catálogo) **no** es uno de estos cuatro: es el patrón del shell,
antes del índice.~~ **v2:** ya no aplica en el índice; ver fila Vacío.

**Subestado del lleno (HU #11901):** ≥1 ficha visible y la búsqueda no pega → **no** es este Vacío
ni el Error. Copy y control en [`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md).

### Acciones y validaciones

- Clic / Enter en la fila → navega a la ficha. **También** si está pendiente: el detalle explica el
  pendiente; no es un error en el índice.
- ~~No hay búsqueda, filtros ni paginación (máximo 18 filas, casi siempre menos).~~
  **Revocado por HU #11901** — hay búsqueda en el índice
  ([`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md)). Sigue **sin** filtros de grupo,
  **sin** paginación y **sin** búsqueda en la ficha.
- No hay acciones de administración (publicar, editar Markdown) en la UI.

### Permiso y comportamiento por rol

El índice **no** ramifica copy por rol. La única diferencia es **qué filas y qué grupos** salen.
`proveedor` no ve un mensaje «usted es proveedor»; ve SOAT y nada más.

### Datos

Catálogo estático en el cliente (slugs, grupo, etiqueta, ruta de pantalla, archivo `.md` opcional).
**Ningún endpoint nuevo.** Ningún dato de persona en la URL.

---

## Pantalla 2 — Ficha (`/flito/ayuda/:slug`)

Segunda superficie obligatoria: abrir un capítulo desde el índice. **v2:** el wireframe vigente
del lleno es el de [HU-3 + HU-1/4/5](#hu-3--tabla-de-contenido-enlace-a-sección-anteriorsiguiente);
este queda como base. **HU #13896:** la disposición vigente en `≥ lg` (3 columnas con el árbol de
fichas a la izquierda) es la de [§ HU #13896](#hu-13896--árbol-lateral-de-fichas-slim).

### Wireframe (lleno)

```
┌─────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]                                                │
│  ← Volver al índice          (enlace, no icono mudo)            │
│  SOAT                                                           │
│  Cola de adquisición de pólizas.                                │
│                                      [ Ir a la pantalla ]       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ artículo (prose, tokens flit)                                   │
│  Qué es                                                    h2   │
│  …                                                              │
│  Para quién                                                h2   │
│  …                                                              │
│  Cómo se entra                                             h2   │
│  …                                                              │
│  Pasos                                                     h2   │
│  … (nombres reales de botones, entre comillas o en negrita)     │
│  Estados                                                   h2   │
│  …                                                              │
│  Qué no hace                                               h2   │
│  …                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Wireframe (ficha pendiente)

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Volver al índice                                             │
│  Impuestos                                                      │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ [FlitEmpty]                                                     │
│  Esta ficha está pendiente.                                     │
│  La ficha ya figura en el índice; el contenido se publicará     │
│  en una entrega siguiente. No es un error.                      │
│  [ Volver al índice ]                                           │
└─────────────────────────────────────────────────────────────────┘
  v2: debajo, Anterior / Siguiente (HU-3)
```

### Estados (4) + copy

| Estado | Cuándo | Copy | Control |
|---|---|---|---|
| **Cargando** | Leyendo / parseando el `.md` | Skeleton de artículo. `aria-label="Cargando ficha"` | — |
| **Error** | El archivo existe pero falló la lectura o el render | **No se pudo cargar esta ficha.** ~~+ detalle técnico corto del cliente~~ **v2:** «Revise su conexión y vuelva a intentarlo.» | **Reintentar** y **Volver al índice** |
| **Vacío** | Usuario **sí** tiene `hasPage` del slug del catálogo, **no** hay `.md` | **Esta ficha está pendiente.** / «La ficha ya figura en el índice; el contenido se publicará en una entrega siguiente. No es un error.» | **Volver al índice**. Sin **Reintentar** (reintentar no crea el archivo). **Ir a la pantalla** sí, si hay ruta. |
| **Lleno** | Markdown presente y renderizado | Título = etiqueta de la ficha. Cuerpo = plantilla AC6. | **Volver al índice**. **Ir a la pantalla** si hay ruta conocida. |

Fuera de los 4 (mismas reglas que el resto de FLITO):

- Sin `hasPage` del `:slug` → `NoAccess` de **esa** pantalla (`PAGES[slug]`), no el vacío pendiente.
- `:slug` que no es del catálogo → **Esta ficha no existe.** / «Esa ficha no forma parte de la
  Ayuda FLITO.» + **Volver al índice**. No filtrar aquí un 403 que sugiera que el módulo existe y está
  prohibido; es una ficha desconocida.

**Ir a la pantalla:** `Link` con el `to` de la tabla del catálogo. Nombre accesible: «Ir a la
pantalla SOAT». Si no hay ruta (`siigo_credenciales` hoy), **no** se pinta el control.

Foco: al montar, el `h1` recibe foco de programa (`titleRef` de `PageHeaderCard`), igual que el
cuadre de conciliación al navegar. **v2 (HU-3):** si la URL trae un `#ancla` existente, el foco va
a ese encabezado en lugar del `h1`.

### Acciones y validaciones

- El Markdown **no** se edita en la app.
- ~~El renderer **no** pinta imágenes (`img`, `![...]`) — AC: prohibido capturas.~~ **Revocado por
  Feature #13691 HU-5:** el renderer pinta imágenes locales con texto alternativo (ver HU-5).
- No se muestran bloques que parezcan tabla (si el `.md` trae pipe-tables, no renderizarlas; las
  HUs de contenido no las escriben).
- No enlazar a URLs de API ni mostrar paths `/api/...`.
- Enlaces internos permitidos: otras fichas del catálogo **solo si** `hasPage` de ese slug; si no,
  el enlace no se pinta o va al `NoAccess` de esa pantalla (mismo gate). Preferible: no emitir el
  enlace. **v2 (HU-3):** la regla vale también con `#ancla` o `?…` en el enlace.

### Permiso y comportamiento por rol

Igual que el índice: no hay modo «ficha de administrador». El contenido del `.md` se escribe en
usted y habla de la pantalla, no del rol. «Para quién» es una sección de la ficha, no un `if (role)`.

### Datos

Archivo estático por slug, p. ej. convención `soat.md` ↔ `soat`. Contrato exacto de paths: lo decide
architecture; UX exige **un archivo por PageSlug** y ausencia = pendiente, no error.

---

## Plantilla de ficha (AC6) — contrato para #11894 / #11895

El renderer de esta HU espera **estos `h2`**, en este orden, en español de producto. Copy de
ejemplo (no es contenido publicado de las 18):

```markdown
## Qué es
Una o dos frases: para qué existe la pantalla.

## Para quién
Quién la usa en operación (nombres de rol de producto: Administrador, Proveedor, Gestor de
Impuestos, Mensajero, Auditor, Financiera). Sin el identificador técnico `proveedor` como título.

## Cómo se entra
Cómo se llega con el menú o, si no hay ítem NAV (Compuerta, Tablero FLITO), desde qué pantalla se
abre. Sin URLs de API.

## Pasos
Lista numerada. Cada paso cita el **copy real del botón o enlace** de la UI («Cargar boleta»,
«Reintentar», «Conciliar»). Prohibido inventar un botón que la pantalla no tiene.

## Estados
Qué ve la persona en cargando, error, vacío y lleno de ESA pantalla (no de Ayuda).

## Qué no hace
Límites honestos. Una viñeta por cosa que la gente espera y la pantalla no cubre.
```

**Prohibido en el Markdown:** ~~capturas, diagramas como imagen,~~ endpoints, tablas, PII de ejemplo
(cédulas, placas reales, NIT de personas). **v2 (HU-5):** capturas y diagramas permitidos **solo con
datos demo** y con texto alternativo obligatorio. **v2 (HU-1/HU-4):** encabezado obligatorio y
avisos `> [!NOTA]` / `> [!IMPORTANTE]` / `> [!PRECAUCION]` (los fija la plantilla `_plantilla.md`).

---

## Accesibilidad (AC5)

- **Headings:** índice `h1` Ayuda FLITO → `h2` por grupo → cada fila no inventa un `h2` duplicado
  (el nombre va en el enlace). Ficha: `h1` del capítulo → `h2` de la plantilla.
- **Nombre en controles:** **Reintentar**, **Volver al índice**, **Volver al tablero**, **Ir a la
  pantalla {etiqueta}**. Nada de iconos solos. El chevron de fila es decorativo (`aria-hidden`).
- **Foco visible:** `focus-visible:ring` de los botones `flit*` / enlaces del shell. No quitar
  `outline` del `h1` enfocado por programa.
- **Contraste ≥ 4.5:1:** texto sobre `PageHeaderCard` / `FlitCard` con tokens (`--flit-blue-text`,
  `--flit-text-secondary`, `--flit-danger-ink`). Badge **Ficha pendiente**: no usar gris sobre gris;
  `StatusChip` o equivalente ya usado en FLITO si cumple contraste.
- **Teclado:** filas como enlaces nativos (tab + Enter). No `div onClick`.
- **Lector:** `aria-live="assertive"` ya lo trae `NoAccess`. El error del índice anuncia el título
  de error (región o foco al mensaje). Pendiente **no** usa `assertive` de error.
- **Movimiento:** skeleton con `motion-reduce:animate-none` (ya en `PageContentSkeleton`).

---

## Notas para QA

1. `proveedor` default: menú **Ayuda FLITO** visible; índice = una fila **SOAT**; no hay grupos
   Finanzas ni Administración.
2. `proveedor` + SOAT sin `.md`: badge **Ficha pendiente**; al abrir, copy de pendiente, **no**
   «No se pudo cargar».
3. `gestor_impuestos`: solo Impuestos. `mensajero`: solo Mi ruta.
4. `financiera`: ve Clientes y proveedores + bloque Finanzas; no ve SOAT ni Credenciales Siigo.
5. `auditor`: ve Gestión FLITO de su `hasPage` y Siigo param/operación; no Bolsas ni Conciliación
   ni Comparendos.
6. `conductor` / `compliance` / `transito` / `lider_pesv` / `supervisor_flota` sin slugs del
   catálogo: ítem ausente en nav, drawer y ⌘K. ~~GET `/flito/ayuda` → `NoAccess`~~ **v2:** GET
   `/flito/ayuda` → «Su usuario aún no tiene módulos con ayuda.» + **Volver al inicio**.
7. Conceder a mano `soat` a un `conductor`: aparece el ítem y el capítulo SOAT (AC1).
8. `admin` ve Compuerta y Tablero FLITO en el índice aunque no estén en el menú; ve Mi ruta aunque
   el nav la reserve a mensajero.
9. `/flito/ayuda/flito_bolsas` como `proveedor` → `NoAccess` de Bolsas, no la ficha pendiente.
10. `/flito/ayuda/privacy` (fuera del catálogo) → «Esta ficha no existe», no la guía de Privacidad.
11. Contraste y foco: badge pendiente, **Reintentar**, enlace de fila, **Ir a la pantalla**.
12. No hay «¿Cómo se usa?» en SOAT, Impuestos, Bolsas ni el resto del catálogo.

Búsqueda (HU #11901 y v2 HU-2): notas en [`docs/ux/flito-ayuda-buscar.md`](flito-ayuda-buscar.md).

---

## Decisiones y descartes

| Decisión | Por qué | Descartado |
|---|---|---|
| Un ítem en **General**, no un grupo «Ayuda» | Un solo destino; no competir con Gestión/Finanzas | Ítem repetido en cada módulo; «¿Cómo se usa?» por pantalla |
| Gate **derivado** de `hasPage` del catálogo | AC1: no hay permiso extra concedible | `hasPage('flito_ayuda')` como filtro de `NAV_ITEMS` (rompería a proveedor) |
| Índice agrupado Gestión / Finanzas / Administración | 18 filas planas no se escanean; Administración solo aparece para admin | Tres páginas de ayuda; copiar `PAGE_GROUPS` del editor de usuarios |
| Pendiente ≠ error | Esta HU no publica las 18 fichas | 404 / toast rojo cuando falta el `.md` |
| Markdown embebido, no PDF | Producto cerrado; no LaftManual | Visor PDF, Drive, Markdown remoto |
| Ficha en ruta propia | Enlazable, foco en `h1`, historial Atrás | Modal / panel que tapa el índice |
| **Ir a la pantalla** en la ficha, no en cada fila del índice | El índice es para elegir capítulo; la ficha ya confirmó intención | Dos CTAs por fila (ruido en pendiente) |
| `siigo_credenciales` en Administración | Es admin-only y no vive en el menú Finanzas | Meterlo bajo Siigo operación (mezclaría audiencia) |

**Fuera de alcance de esta HU:** redactar las 18 fichas; ~~capturas~~ (v2 HU-5); ayuda de módulos no listados
(PESV, LAFT, RNDC, Tránsito); editar Markdown desde la UI; nuevo endpoint.

---

## Requerimientos de datos (para architecture / frontend)

1. **Slug `flito_ayuda`** en `PAGES` (label + `NoAccess`). **No** en `PAGE_GROUPS` del editor.
2. **Slug `siigo_credenciales`** en `PAGES` (hoy no existe) para el 18.º capítulo. Sin ruta ni nav
   en esta HU. Solo `admin` por defaults.
3. **Helper `puedeVerAyudaFlito`** (nombre a criterio de impl) compartido por nav, ⌘K y rutas.
   Catálogo de 18 en un solo módulo, no copiado en tres archivos.
4. **Manifiesto estático** slug → grupo + etiqueta + `to` de pantalla + presencia de `.md`. Sin API.
5. **Ningún PII** en path/query. El único param es el PageSlug.

Si architecture prefiere no crear `flito_ayuda` en `PAGES`, el `NoAccess` necesita igual un label
fijo «Ayuda FLITO»; no reutilizar el de otra pantalla.

---
---

## Ayuda FLITO v2 — Feature #13691 (slim)

> **Modo slim** (extensión de pantalla existente; sin ruta ni `PageSlug` nuevos). HUs en borrador
> `docs/ado-drafts/epic-12756-12757/HUS-F1-13691.md`; IDs de ADO aún no creados → se citan HU-1…HU-5.
> Decisiones P9 cerradas por el humano (2026-10-20): **P9-1a**, **P9-2c**, **P9-3a**, **P9-4a**.
> Público: operador interno (no Cliente; D2: `cliente` no ve la Ayuda). Tono: **usted**.
> **HU-2** (búsqueda) vive en [`flito-ayuda-buscar.md`](flito-ayuda-buscar.md#delta-feature-13691--hu-2).

### Qué vino a hacer quien abre la ficha

**Leer cómo se usa una pantalla y volver a trabajar.** Lo primero que se ve es el título y el
cuerpo de la ficha. Todo lo nuevo de v2 es **orientación**, no contenido: va en la periferia
(una línea arriba, una columna lateral, un pie) y nunca encima del primer párrafo.

| Pieza nueva | Dónde vive | Peso |
|---|---|---|
| Versión y fecha (HU-1) | Primera línea **dentro** del artículo, bajo el título | `text-xs`, `--flit-text-secondary`; una línea |
| Tabla de contenido (HU-3) | Columna derecha pegajosa en `lg+`; acordeón plegado arriba en `<lg` | Enlaces `text-sm`, sin caja de color |
| Enlace a sección (HU-3) | Botón-icono al final de cada `h2` | Discreto, siempre visible (no solo al hover: en táctil no hay hover) |
| Avisos (HU-4) | En el flujo del cuerpo, donde el autor los escribe | Borde izquierdo + rótulo en texto; fondo neutro |
| Imágenes (HU-5) | En el flujo del cuerpo | Ancho máximo del texto, marco `--flit-border-soft` |
| «Aplica para» (HU-4) | Pie del artículo, tras una línea divisoria | `text-sm`, `--flit-text-secondary` |
| Anterior / Siguiente (HU-3) | Debajo de la tarjeta del artículo | Dos enlaces-tarjeta, sin peso de botón |
| Árbol de fichas (HU #13896) | Columna izquierda pegajosa en `lg+`; acordeón «Fichas de ayuda» cerrado arriba en `<lg` | Grupos plegados salvo el de la ficha abierta; enlaces `text-sm` |

**Qué se calla:** la versión y la fecha **no** van en el índice ni en los resultados de búsqueda
(el índice es para elegir ficha, no para auditar su vigencia). «Aplica para» no va arriba: quien
abre la ficha ya tiene permiso a la pantalla; saber qué otros roles la usan es consulta, no la tarea.
Sin resaltado de sección activa por scroll (scrollspy): solo se marca la sección del `#ancla` actual.

**Una primaria por vista:** en la ficha, la única acción con forma de botón sigue siendo **Ir a la
pantalla** (en el header; mantiene el estilo `flitBtnSecondary` de #11893, para no competir con la
lectura). TOC, copiar enlace y Anterior/Siguiente son navegación, no CTA. En el índice no hay botón
primario: el control dominante es el buscador. Ningún `flitBtnPrimary`/`GradientButton` en la Ayuda.

### Wireframe — ficha llena v2 (escritorio, ≥ `lg`)

> **HU #13896:** este wireframe de 2 columnas queda como foto de v2. El vigente en `≥ lg` es el de
> 3 columnas de [§ HU #13896](#hu-13896--árbol-lateral-de-fichas-slim).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]   ← Volver al índice                                          │
│  Reporte de costos                                         [ Ir a la pantalla ] │
│  Costo por trámite y por cliente en el periodo.            (resumen del encab.) │
└────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────┐  ┌─────────────────────┐
│ Versión 1.0 · 20/10/2026                  (xs, sec.) │  │ Contenido de la     │ ← aside sticky
│                                                      │  │ ficha               │   (nav aria-label)
│ Qué es                                         [🔗]  │  │ Qué es              │
│ …                                                    │  │ Para quién          │
│ Pasos                                          [🔗]  │  │ Cómo se entra       │
│ 1. …                                                 │  │ Pasos         ◀ act.│
│ ┃ Importante                                         │  │   Paso avanzado     │
│ ┃ El cierre del periodo no se puede deshacer.        │  │ Estados             │
│ ┌──────────────────────────────────────┐             │  │ Qué no hace         │
│ │  (imagen; placeholder del mismo alto)│             │  └─────────────────────┘
│ └──────────────────────────────────────┘             │
│ Bandeja con el filtro Pendientes.   Ver en tamaño completo
│ Paso avanzado                         (h3)           │
│ …                                                    │
│ ──────────────────────────────────────────────────── │
│ Aplica para: Por defecto Administrador, Financiera y │
│ Auditor. También quien tenga permiso a la pantalla   │
│ Reporte de costos.                                   │
└──────────────────────────────────────────────────────┘
┌ ← Anterior ─────────────────┐   ┌─────────────────────── Siguiente → ┐
│ Finanzas · Conciliación     │   │ Finanzas · Facturación electrónica │
└─────────────────────────────┘   └────────────────────────────────────┘
```

Rejilla: ~~`lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-6`~~ **HU #13896:**
`lg:grid-cols-[15rem_minmax(0,1fr)_15rem]` (con TOC) o `lg:grid-cols-[15rem_minmax(0,1fr)]` (sin
TOC); el artículo `min-w-0`. Anterior / Siguiente ocupan solo la columna del artículo.

### Wireframe — ficha llena v2 (móvil, < `lg`)

> **HU #13896:** encima de «Contenido de la ficha» va el acordeón «Fichas de ayuda» (ver su
> wireframe `< lg`).

```
┌──────────────────────────────┐
│ ← Volver al índice           │
│ Reporte de costos            │
│ Costo por trámite y …        │
│ [ Ir a la pantalla ]         │  (acciones apiladas bajo el título: PageHeaderCard)
└──────────────────────────────┘
┌──────────────────────────────┐
│ ▸ Contenido de la ficha  (7) │  FlitAcordeon, cerrado por defecto
└──────────────────────────────┘
┌──────────────────────────────┐
│ Versión 1.0 · 20/10/2026     │
│ Qué es                  [🔗] │
│ …  (avisos e imágenes a      │
│     ancho completo)          │
│ ──────────────────────────── │
│ Aplica para: …               │
└──────────────────────────────┘
┌ ← Anterior ──────────────────┐
│ Finanzas · Conciliación      │
└──────────────────────────────┘
┌──────────────── Siguiente → ┐
│ Finanzas · Facturación …     │
└──────────────────────────────┘
```

---

### HU-1 · Versión y fecha de la ficha

**Superficie tocada:** ficha (lleno) y fila del índice (solo el origen del resumen).

**Delta de claridad**
- Lleno: primera línea del artículo, **antes** del primer `h2`: `Versión 1.0 · 20/10/2026` (copy
  exacto del AC1; fecha `dd/mm/aaaa` desde la ISO del encabezado). `<p>` con `text-xs`,
  `--flit-text-secondary`. Sin chip, sin icono, sin «Actualizada hace…». No es un encabezado.
- Va dentro del artículo y no en `PageHeaderCard` porque el kit no tiene ranura de metadatos y
  añadirla para una línea sería tocar un componente compartido por todo FLITO. Visualmente queda
  bajo el título, como pide el AC.
- El encabezado (`---…---`) **nunca** se pinta como texto.
- Subtítulo del header y de la fila del índice = `resumen` del encabezado. Fila del índice sin
  cambios visuales.

**Estados**
| Estado | Versión/fecha |
|---|---|
| Cargando | No se pinta. El skeleton no la simula. |
| Error | No se pinta. |
| Vacío (pendiente) | No se pinta (AC3). Subtítulo = resumen del catálogo. |
| Lleno | Se pinta. Si el encabezado trajera una fecha no válida, la prueba de artefactos ya falla (AC4): la UI no inventa fallback; no se pinta la línea. |

**Responsive:** la línea envuelve normalmente; sin cambios <`lg`.
**Feedback:** no es interactiva. **Notificación:** ninguna.
**A11y:** texto plano; contraste de `--flit-text-secondary` sobre `--flit-bg-card` ≥ 4.5:1 en los dos
temas (verificar con `check:contraste`). No usar `--flit-text-muted` aquí.

**QA**
1. Ficha con `version: 1.0` y `fecha: 2026-10-20` → «Versión 1.0 · 20/10/2026» bajo el título, antes de «Qué es».
2. Ningún resto del encabezado (`---`, `palabras_clave:`) en el cuerpo.
3. Ficha pendiente: sin línea de versión; subtítulo = resumen del catálogo.
4. Índice y resultados de búsqueda **sin** versión ni fecha.
5. Tema oscuro: la línea se lee (contraste ≥ 4.5:1).

---

### HU-3 · Tabla de contenido, enlace a sección, Anterior/Siguiente

**Superficie tocada:** ficha (lleno y pendiente).

**Tabla de contenido (TOC)**
- `<nav aria-label="Contenido de la ficha">` con una lista: un enlace por `h2`, los `h3` anidados
  (sangría `pl-3`). Rótulo visible «Contenido de la ficha» como `<p>` `text-xs` (no como `h2`: no
  ensucia el esquema de encabezados ni la propia TOC).
- Solo se pinta si la ficha tiene **≥ 2** `h2`. Con menos, la columna no existe y el artículo ocupa
  el ancho.
- `≥ lg`: columna derecha, `position: sticky` con `top` = alto de la topbar + `1rem`, y
  `max-h-[calc(100vh-…)] overflow-y-auto` propia si la lista es larga. Derecha y no izquierda:
  ~~el menú del shell ya ocupa la izquierda y~~ la TOC es secundaria a la lectura y se lee después
  del artículo (de lo general a lo particular: qué ficha → qué dice → a qué sección salto).
  **HU #13896 (2026-10-23):** la justificación tachada ya no es cierta — el menú del shell es una
  barra flotante inferior (verificado en DEV). La izquierda la ocupa ahora el árbol de fichas; la
  TOC se queda a la derecha, sin cambios de comportamiento.
- `< lg`: `FlitAcordeon` (kit) con `titulo="Contenido de la ficha"` y `cantidad` = número de
  secciones, **cerrado** por defecto, arriba del artículo. Al elegir una sección se cierra.
  **HU #13896:** queda **debajo** del acordeón «Fichas de ayuda».
- Enlaces: `text-sm`, `--flit-text-secondary`; hover velo `--flit-bg-hover` + `transition-colors`;
  `flit-focus`. El enlace de la sección del `#ancla` actual lleva `aria-current="location"` y tinta
  `--flit-blue-text` + `font-semibold` (sin barra de color nueva).
- Clic → `href="#pasos"` real (la URL termina en `#pasos`), salto **instantáneo** (sin scroll suave:
  sin efectos, y respeta `prefers-reduced-motion` por construcción), foco al encabezado
  (`tabIndex={-1}`). Encabezados con `scroll-margin-top` igual al offset de la topbar para que no
  queden tapados.

**Enlace copiable a sección**
- Al final de cada `h2` (no de los `h3`: su enlace ya está en la TOC), botón-icono `Link` de
  `lucide-react`, `--flit-text-secondary`, hover `--flit-bg-hover`, `flit-focus`, área táctil
  ≥ 32 px. `aria-label="Copiar enlace a la sección «Pasos»"`. Siempre visible (en táctil no hay hover
  que lo revele).
- Acción: escribe en la barra la URL con el ancla (`history.replaceState`, sin recargar) **y**
  copia la URL absoluta al portapapeles.
- **Notificación — toast** (`ToastFlito`, cerrable): éxito «Enlace a «Pasos» copiado.» (~4 s).
  Fallo del portapapeles: «No se pudo copiar el enlace. Cópielo desde la barra de direcciones.»
  (≥ 6 s o hasta cerrarlo). Es cierto porque la barra ya tiene el ancla. Nunca el error del navegador.

**Enlace directo con ancla**
- `/flito/ayuda/<ficha>#como-se-entra` → la ficha carga, salta a la sección y el foco va a ese
  encabezado (no al `h1`). Si la TOC está en acordeón (<`lg`), no se abre.
- Ancla inexistente → ficha al inicio, foco al `h1`, **sin** mensaje (AC3).
- Enlace interno con `#…` o `?…` a una ficha sin permiso → texto plano, no enlace (AC4).

**Anterior / Siguiente**
- `<nav aria-label="Navegación entre fichas">` debajo de la tarjeta del artículo. Dos enlaces con
  forma de tarjeta (`--flit-border-soft`, radio del kit, fondo `--flit-bg-card`, **sin** sombra
  extra); hover `--flit-bg-hover`; `flit-focus`.
- Contenido: rótulo «← Anterior» / «Siguiente →» (`text-xs`, `--flit-text-secondary`) y debajo
  `Grupo · Etiqueta` (`text-sm font-semibold`, `--flit-blue-text`). El grupo siempre se ve: así
  cruzar de Gestión a Finanzas no sorprende.
- Nombre accesible: «Ficha anterior: Conciliación» / «Ficha siguiente: Facturación electrónica ·
  Parametrización». Flechas `aria-hidden`.
- Orden: el del índice sin búsqueda, solo fichas visibles, **incluidas las pendientes** (están en
  el índice). En la primera no hay «Anterior»; en la última no hay «Siguiente»; el que queda conserva
  su lado (Siguiente solo, alineado a la derecha).
- Se pinta en **Lleno** y **Vacío (pendiente)**. No en Cargando ni Error.

**Estados de la ficha con HU-3**
| Estado | TOC | Anterior/Siguiente |
|---|---|---|
| Cargando | En `lg+` el skeleton reserva la columna derecha (bloque gris estático del skeleton) para que el artículo no salte al cargar. En `<lg`, sin hueco. | No |
| Error | No (copy de error sin cambio salvo el detalle: «Revise su conexión y vuelva a intentarlo.») + **Reintentar** / **Volver al índice** | No |
| Vacío (pendiente) | No (no hay secciones) | **Sí** |
| Lleno | Sí si ≥ 2 `h2` | Sí |

**Responsive (<`lg`):** TOC pasa a acordeón plegado arriba del cuerpo, sin columnas fijas;
Anterior y Siguiente se apilan a ancho completo (Anterior primero); el botón de copiar enlace queda
pegado al encabezado y envuelve con él si el título es largo.

**QA**
1. Ficha con `## Qué es`, `## Pasos`, `### Paso avanzado` → TOC con 3 enlaces, el `h3` anidado; clic en «Pasos» → URL `#pasos`, foco en el `h2`.
2. URL directa `#como-se-entra` → sección visible bajo la topbar (no tapada) y con foco.
3. `#no-existe` → inicio de la ficha, foco en el `h1`, sin error.
4. Financiera: enlace a `/flito/ayuda/siigo_credenciales#paso-1` dentro de una ficha → texto, no enlace.
5. Anterior/Siguiente salta fichas no visibles y cruza de grupo; sin «Anterior» en la primera ni «Siguiente» en la última.
6. Copiar enlace: toast «Enlace a «Pasos» copiado.», cerrable; la barra de direcciones muestra `#pasos`. Con el portapapeles denegado: toast de fallo, sin texto técnico.
7. 390 px: TOC en acordeón cerrado con contador; Anterior/Siguiente apilados; nada desborda.
8. Teclado: Tab recorre TOC, botones de copiar y Anterior/Siguiente con foco visible; `nav` con sus `aria-label`.
9. Ficha con un solo `h2`: sin TOC ni columna vacía.

---

### HU-4 · Avisos destacados y «Aplica para»

**Superficie tocada:** cuerpo y pie del artículo (lleno).

**Avisos `> [!NOTA]` · `> [!IMPORTANTE]` · `> [!PRECAUCION]`**

```
┃ (i) Nota                          ← rótulo en texto, font-semibold, tinta del tipo
┃ El filtro se conserva al volver.  ← cuerpo en --flit-text-primary
```

| Tipo | Rótulo visible | Icono (`lucide`, `aria-hidden`) | Tinta del rótulo y del borde izquierdo (3 px) |
|---|---|---|---|
| NOTA | **Nota** | `Info` | `--flit-blue-text` |
| IMPORTANTE | **Importante** | `AlertCircle` | `--flit-warning-text` |
| PRECAUCION | **Precaución** | `AlertTriangle` | `--flit-danger-text` |

- Fondo **neutro y común** a los tres: `--flit-bg-table-header` (tiene par oscuro). Se descartan
  `--flit-chip-*-bg`: en el tema oscuro conservan el valor claro y el bloque quedaría fosforescente.
  Se descartan `--flit-*-ink`: no tienen par oscuro.
- El tipo se distingue por **texto** (rótulo) + icono + tinta; el color nunca es el único canal.
- Contraste de rótulo en claro (aprox., sobre `#F4F6FA`): blue-text ≈ 4,8:1, warning-text ≈ 5,0:1,
  danger-text ≈ 5,4:1; en oscuro las tintas `*-text` son claras sobre fondo oscuro. Bloqueante:
  `check:contraste` en los dos temas.
- Marcado: `<div role="note">` con el rótulo como `<p><strong>`, **no** como encabezado (no entra
  en la TOC ni en el esquema). No `role="alert"`: es contenido estático, no un evento.
- Radio del kit para inputs/tarjetas pequeñas, `px-4 py-3`, margen vertical como un párrafo. Sin
  sombra, sin degradado, sin animación.
- `> texto` normal o `> [!OTRO] …` → cita simple: borde izquierdo `--flit-border-soft`, sin fondo,
  texto tal cual (incluido el `[!OTRO]` literal), sin HTML crudo.

**«Aplica para» (P9-2c, calculado)**
- Pie del artículo, tras un divisor `--flit-border-soft`, en `text-sm` `--flit-text-secondary`, con
  «Aplica para:» en `font-semibold` `--flit-text-primary`.
- Copy: «Aplica para: Por defecto Administrador, Financiera y Auditor. También quien tenga permiso
  a la pantalla Reporte de costos.» Roles con `ROLE_LABELS`, en el orden de `USER_ROLES`, unidos con
  comas e «y» antes del último. Nombre de la pantalla = etiqueta de `PAGES[permiso]`. Nunca
  `operaciones`. Si solo un rol la tiene por defecto: «Por defecto Administrador.».
- Solo en **Lleno**. No en pendiente, cargando ni error (se calla: no responde a esas visitas).
- Va al pie y no arriba porque quien lee ya tiene permiso: es consulta, no la tarea.

**Responsive (<`lg`):** avisos a ancho completo del artículo; el rótulo y el texto envuelven; el
pie «Aplica para» envuelve como párrafo. **Feedback:** nada interactivo nuevo (un enlace dentro de un
aviso usa el estilo de enlace del cuerpo, con hover y foco). **Notificación:** ninguna.

**QA**
1. Los tres avisos muestran «Nota», «Importante», «Precaución» en texto; con escala de grises siguen distinguiéndose.
2. Contraste ≥ 4.5:1 del rótulo y del cuerpo en claro **y** oscuro.
3. `> texto` y `> [!OTRO] x` → cita normal, sin romper la ficha ni mostrar HTML.
4. Lector de pantalla: el aviso se anuncia como nota, no como alerta; no aparece en la TOC.
5. «Reporte de costos» → «Aplica para: Por defecto … También quien tenga permiso a la pantalla Reporte de costos.» con los roles de la matriz por defecto.
6. Ningún «Operaciones» en «Aplica para».
7. Ficha pendiente: sin «Aplica para».

---

### HU-5 · Imágenes y diagramas

**Superficie tocada:** cuerpo del artículo (lleno).

```
┌──────────────────────────────────────────┐   ← <figure>, marco 1 px --flit-border-soft,
│                                          │     radio del kit, fondo --flit-bg-table-header
│   imagen (max-w-full, h-auto)            │     mientras carga (mismo alto reservado)
│                                          │
└──────────────────────────────────────────┘
Bandeja con el filtro Pendientes.          Ver en tamaño completo
└ figcaption (pie opcional), text-sm sec. ┘  └ enlace, abre otra pestaña ┘
```

- `<figure>` + `<img alt="…" loading="lazy" decoding="async" width height>`; ancho máximo = el del
  texto del artículo; nunca desborda en <`lg`.
- **Pie** opcional: el título del Markdown (`![alt](src "Pie")`) → `<figcaption>` `text-sm`
  `--flit-text-secondary`. El pie no repite el alt: el alt describe la imagen, el pie la comenta.
- **Placeholder sin salto de layout:** el espacio se reserva **antes** de cargar con `width`/`height`
  reales (o `aspect-ratio`). Fondo `--flit-bg-table-header` estático, **sin** shimmer ni pulso.
  → **Requerimiento a architecture slim:** decidir cómo conoce el render ancho×alto de cada imagen
  (manifiesto generado en build, sintaxis en el Markdown u otra). Sin ese dato no se cumple «sin
  salto». Respaldo si una imagen no lo trae: caja `aspect-ratio: 16/10` con `object-contain`.
- **Imagen que no carga / origen externo o `data:`:** en lugar de la caja, una línea de texto
  `text-sm` `--flit-text-secondary`: «Imagen no disponible: <alt>». Sin icono roto, sin toast, sin
  «Ver en tamaño completo». El resto de la ficha se lee normal.
- **Ampliación — sí, sin modal:** enlace **Ver en tamaño completo** en la fila del pie, alineado a
  la derecha (abajo del pie en <`sm`), que abre el mismo archivo local en otra pestaña
  (`target="_blank" rel="noopener"`). Nombre accesible: «Ver en tamaño completo: <alt> (se abre en
  otra pestaña)». Hover/foco de enlace del kit. Se pinta siempre que la imagen cargó (no
  condicionado al tamaño: aparecer tarde movería la fila). La imagen en sí **no** es clicable.
  Justificación: en móvil una captura de escritorio a 360 px no se lee y la pestaña nueva da zoom
  nativo; un lightbox exigiría trampa de foco, `Esc`, scroll-lock y un patrón nuevo en el kit.
- Diagramas: SVG/PNG como `<img>`, mismo tratamiento. Sin Mermaid ni SVG en línea.
- Tema oscuro: las capturas son claras; el marco `--flit-border-soft` las separa del fondo. Sin
  filtros ni inversión de color.
- Contenido: solo datos demo (sin cédulas, placas, nombres ni teléfonos reales) — regla de la
  plantilla y de la skill, no de la UI.

**Estados (de la imagen, dentro del Lleno de la ficha)**
| Estado | Qué se ve |
|---|---|
| Cargando | Caja reservada con fondo neutro, mismo alto final |
| Error | «Imagen no disponible: <alt>» (sin reintento: es un archivo estático; recargar la ficha ya reintenta) |
| Vacío | No aplica (no hay imagen sin `src`; `alt` vacío lo frena la prueba de artefactos) |
| Lleno | Imagen + pie opcional + «Ver en tamaño completo» |

**Responsive (<`lg`):** la imagen escala al ancho del artículo con `h-auto`; el enlace de ampliación
baja bajo el pie en <`sm`. **Feedback:** el enlace de ampliación tiene hover y foco; la imagen no es
interactiva. **Notificación:** ninguna.

**QA**
1. `![Bandeja de facturas con el filtro Pendientes](./siigo_operacion/bandeja.png)` → imagen con ese `alt`, sin desborde a 390 px.
2. Throttling lento: la caja reserva el alto; el texto bajo la imagen no salta al cargar (CLS ≈ 0).
3. La imagen no se pide hasta abrir su ficha; `loading="lazy"`; `check:bundle` verde.
4. Archivo inexistente → «Imagen no disponible: <alt>», resto de la ficha normal.
5. `http…` o `data:` → no hay petición de red; solo el texto alternativo.
6. «Ver en tamaño completo» abre el archivo local en otra pestaña; su nombre accesible incluye el alt y «se abre en otra pestaña».
7. Pie: solo si el Markdown trae título; sin pie no hay `figcaption` vacío.
8. Tema oscuro: marco visible, sin fondo blanco suelto alrededor.

---

### Accesibilidad v2 (resumen)

- Esquema: `h1` ficha → `h2`/`h3` del cuerpo (con `id` estable). Rótulos de TOC, avisos y «Aplica
  para» **no** son encabezados.
- ~~Dos `nav` con nombre propio: «Contenido de la ficha» y «Navegación entre fichas».~~
  **HU #13896:** tres `nav` con nombre propio: «Fichas de ayuda», «Contenido de la ficha» y
  «Navegación entre fichas».
- Foco: `h1` al montar; encabezado de la sección si hay `#ancla` válido; encabezado al usar la TOC.
- Todo control con nombre accesible, hover sutil (`--flit-bg-hover`, `transition-colors` corta) y
  `flit-focus`. Ningún icono solo sin `aria-label`.
- Contraste ≥ 4.5:1 en texto, ≥ 3:1 en bordes/iconos significativos, **en los dos temas**.
- Sin animaciones nuevas; salto a sección instantáneo.

### Decisiones y descartes v2

| Decisión | Por qué | Descartado |
|---|---|---|
| Versión/fecha dentro del artículo | No tocar `PageHeaderCard` (compartido) por una línea | Ranura `meta` nueva en el kit; chip de versión |
| TOC a la derecha, pegajosa; acordeón cerrado en móvil | Lectura primero; ~~el shell ya usa la izquierda~~ **HU #13896:** la TOC es lo último que se consulta (después del artículo) y la izquierda es del árbol de fichas; el shell ya no ocupa la izquierda (barra flotante inferior) | TOC arriba también en escritorio (empuja el contenido); scrollspy (efecto + complejidad); **HU #13896:** TOC a la izquierda y árbol a la derecha (invierte el orden general → particular) |
| Copiar enlace solo en `h2`, siempre visible | Menos ruido; en táctil no hay hover | Icono que aparece al hover; en cada `h3` |
| Toast al copiar | Resultado de acción puntual (principios) | Cambiar el icono a ✓ (efecto, invisible al lector) |
| Avisos con fondo neutro + rótulo y tinta | Par oscuro garantizado; no depende del color | `--flit-chip-*-bg` (sin par oscuro); `StatusChip` como rótulo (es para estados, no para avisos) |
| «Aplica para» al pie, calculado | P9-2c; consulta, no tarea | Lista escrita a mano; bloque arriba |
| Ampliación por pestaña nueva | Accesible sin trampa de foco; zoom nativo en móvil | Lightbox/modal; clic en la imagen |
| Ninguna primaria nueva | La Ayuda es lectura; «Ir a la pantalla» es la única acción | Botón «Siguiente ficha» con peso primario |

**Nota para PO / F2 (no bloquea):** la sección escrita «## Para quién» y el bloque calculado
«Aplica para» pueden contradecirse. Recomendación para F2: que «Para quién» hable de la tarea
(«quien concilia el periodo»), no de la lista de roles.

---
---

## HU #13896 · Árbol lateral de fichas (slim)

> **Modo slim** (Feature #13691). Extiende la vista de ficha `/flito/ayuda/:slug`; sin ruta ni
> `PageSlug` nuevos, sin endpoint. Decisiones cerradas con el humano el 2026-10-23 (no reabrir):
> árbol grupo → fichas a la izquierda, solo el grupo actual desplegado, memoria en la SPA, TOC y
> Anterior/Siguiente se quedan, acordeón en `< lg`, sin árbol en el índice. Referencia visual del
> humano: manual de FLIT Trámites (grupos plegables con artículos a la izquierda, «En este
> artículo» a la derecha) — se toma la **disposición**, no la estética ni los componentes.
> Público: operador interno. Tono: **usted** (aunque el árbol no lleva frases: solo rótulos).

### Superficie tocada

Vista de ficha (`components/ayuda/AyudaFicha.tsx`) en los estados **Cargando**, **Error**,
**Vacío (pendiente)** y **Lleno**. Componente nuevo del dominio Ayuda (no del kit): el árbol, en
dos presentaciones — columna lateral `≥ lg` y acordeón `< lg` (reusa `FlitAcordeon`).

**No se toca:** el índice `/flito/ayuda` (sin árbol: ya es la lista de fichas), «Esta ficha no
existe» y `NoAccess` (sin árbol: no hay ficha visible que ubicar), la TOC (comportamiento igual),
Anterior/Siguiente, `PageHeaderCard`, el kit.

### Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer quien abre la ficha** no cambia: leer cómo se usa una pantalla. El árbol
responde a la pregunta que la ficha sola no contesta: **«¿qué más hay cerca y cómo salto ahí sin
volver al índice?»**. Es orientación, no contenido: va en la periferia izquierda y nunca encima
del primer párrafo.

- **Siempre visible (≥ lg):** el rótulo «Fichas de ayuda», los nombres de **todos** los grupos con
  fichas visibles, y **solo** las fichas del grupo de la ficha abierta, con la actual resaltada.
  Así el árbol arranca corto (5 grupos como máximo + las fichas de un grupo).
- **A un clic:** las fichas de los otros grupos (botón del grupo).
- **No está:** contadores por grupo, badge «Ficha pendiente», iconos de carpeta/documento,
  buscador, versión al pie, secciones de la ficha (eso es la TOC). Ver descartes.
- **Densidad:** la ficha pasa de 2 a 3 columnas en `≥ lg`. Se contiene porque (a) los grupos
  ajenos arrancan plegados, (b) el árbol no tiene caja de color ni tarjeta — mismo peso visual que
  la TOC — y (c) en `< lg` es una sola fila plegada. El artículo sigue siendo la columna dominante
  (`minmax(0,1fr)`); ver Nota de ancho en QA.
- **Una primaria:** sin cambio. La única acción con forma de botón sigue siendo **Ir a la pantalla**
  (`flitBtnSecondary`) en el header. El árbol es navegación: botones de grupo y enlaces, sin peso
  de CTA.

### Wireframe — ficha llena con TOC (≥ `lg`, 3 columnas)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]   ← Volver al índice                                                    │
│  Reporte de costos                                                   [ Ir a la pantalla ] │
│  Costo por trámite y por cliente en el periodo.                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────┐ ┌──────────────────────────────────────────────┐ ┌─────────────────┐
│ FICHAS DE AYUDA │ │ Versión 1.0 · 20/10/2026                     │ │ CONTENIDO DE LA │
│                 │ │                                              │ │ FICHA           │
│ › General       │ │ Qué es                                 [🔗]  │ │ Qué es          │
│ › Gestión       │ │ …                                            │ │ Para quién      │
│ › Tránsito      │ │ Pasos                                  [🔗]  │ │ Cómo se entra   │
│ ⌄ Finanzas      │ │ 1. …                                         │ │ Pasos           │
│    Bolsas       │ │ ┃ Importante                                 │ │   Paso avanzado │
│    Conciliación │ │ ┃ El cierre del periodo no se puede deshacer.│ │ Estados         │
│  ▌ Reporte de   │ │ …                                            │ │ Qué no hace     │
│  ▌ costos   ◀ ① │ │ ──────────────────────────────────────────── │ └─────────────────┘
│    Facturación  │ │ Aplica para: Por defecto Administrador, …    │    ↑ sticky, scroll
│    electrónica ·│ └──────────────────────────────────────────────┘      propio (sin cambio)
│    Parametriz.  │ ┌ ← Anterior ───────────┐ ┌──────── Siguiente → ┐
│ › Administración│ │ Finanzas · Conciliac. │ │ Finanzas · Factura… │
└─────────────────┘ └───────────────────────┘ └─────────────────────┘
  ↑ sticky (top = topbar + 1rem), scroll propio
① ficha actual: aria-current="page", velo --flit-bg-hover + tinta --flit-blue-text + semibold
  (el «▌» del dibujo marca el velo, no es una barra de color)
› / ⌄ chevron decorativo (aria-hidden); el estado lo dice aria-expanded
```

Rejilla: `lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_15rem] lg:items-start lg:gap-6`. La columna
central contiene **el artículo y debajo Anterior/Siguiente** (para que el árbol y la TOC sigan
pegajosos a su lado mientras se lee hasta el final). Header a ancho completo, encima de la rejilla.

### Wireframe — ficha sin TOC (≥ `lg`, 2 columnas)

Aplica a: ficha llena con < 2 `h2`, **pendiente** y **error**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]   ← Volver al índice                                        │
│  Impuestos                                               [ Ir a la pantalla ] │
└──────────────────────────────────────────────────────────────────────────────┘
┌─────────────────┐ ┌──────────────────────────────────────────────────────────┐
│ FICHAS DE AYUDA │ │ [FlitEmpty]  Esta ficha está pendiente.                  │
│                 │ │  La ficha ya figura en el índice; el contenido se        │
│ › General       │ │  publicará en una entrega siguiente. No es un error.     │
│ ⌄ Gestión       │ │  [ Volver al índice ]                                    │
│    Gestión      │ └──────────────────────────────────────────────────────────┘
│    Trámites     │ ┌ ← Anterior ──────────┐            ┌────────── Siguiente → ┐
│    SOAT         │ │ Gestión · SOAT       │            │ Gestión · Derechos …  │
│  ▌ Impuestos ◀  │ └──────────────────────┘            └───────────────────────┘
│    …            │
│ › Finanzas      │   (en Error: tarjeta de error con Reintentar / Volver al índice,
└─────────────────┘    sin Anterior/Siguiente — sin cambio)
```

Rejilla: `lg:grid-cols-[15rem_minmax(0,1fr)]`. **No** se reserva una columna derecha vacía: el
artículo toma ese ancho (regla de HU-3: «sin TOC ni columna vacía»).

**Cargando (≥ lg):** 3 columnas — el árbol **real** a la izquierda (sus datos son locales y
síncronos: catálogo + permisos, no dependen del `.md`), el skeleton del artículo en el centro y la
reserva estática de la TOC a la derecha (sin cambio de HU-3). Así nada salta al cargar.

### Wireframe — `< lg`

```
┌──────────────────────────────┐
│ ← Volver al índice           │
│ Reporte de costos            │
│ Costo por trámite y …        │
│ [ Ir a la pantalla ]         │
└──────────────────────────────┘
┌──────────────────────────────┐ ┐
│ › Fichas de ayuda       (14) │ │ un solo bloque de navegación:
└──────────────────────────────┘ │ gap 0.5rem entre los dos acordeones
┌──────────────────────────────┐ │ (1rem con el resto de la página)
│ › Contenido de la ficha  (7) │ │
└──────────────────────────────┘ ┘
┌──────────────────────────────┐
│ Versión 1.0 · 20/10/2026     │
│ Qué es                  [🔗] │
│ …                            │
└──────────────────────────────┘
  Anterior / Siguiente apilados (sin cambio)

Abierto «Fichas de ayuda»:
┌──────────────────────────────┐
│ ⌄ Fichas de ayuda       (14) │
├──────────────────────────────┤
│ › General                    │
│ › Gestión                    │
│ ⌄ Finanzas                   │
│    Bolsas                    │
│  ▌ Reporte de costos     ◀   │
│    …                         │
│ › Administración             │
└──────────────────────────────┘
```

- **Orden:** «Fichas de ayuda» **encima** de «Contenido de la ficha» — mismo orden que en escritorio
  de izquierda a derecha (qué ficha → qué sección). Ambos **cerrados** por defecto: el bloque ocupa
  dos filas y el artículo empieza en el primer pliegue.
- **Para que no saturen:** los dos acordeones van juntos en un contenedor `lg:hidden` con
  `space-y-2`, con la misma envoltura visual que ya usa `TablaContenidoPlegable` (borde
  `--flit-border-soft`, radio del kit, fondo `--flit-bg-card`) — gemelos, no dos estilos.
  Sin TOC (pendiente, error, < 2 `h2`) queda solo «Fichas de ayuda».
- `FlitAcordeon` con `titulo="Fichas de ayuda"`, `cantidad` = número de fichas visibles del usuario
  (`capitulosEnOrdenDeIndice(user).length`). Dentro, **el mismo árbol** (grupos plegables con la
  misma memoria que en escritorio).
- El acordeón exterior arranca **cerrado en cada carga de ficha**; al elegir una ficha se navega y la
  ficha nueva lo pinta cerrado. Su apertura **no** se recuerda (sí la de los grupos internos).
- Se pinta en los cuatro estados de la ficha (una fila; en Cargando ya tiene sus datos).

### Spec del árbol

**Datos (sin endpoint, sin requerimiento nuevo)**
- Fichas = `capitulosEnOrdenDeIndice(user)` (`lib/ayudaFlito.ts`): ya filtradas por permiso y en el
  orden del índice. Agrupadas por `entrada.grupo` en el orden de `GRUPOS_ORDEN`
  (`general, gestion, transito, finanzas, administracion`); rótulo del grupo =
  `GRUPO_AYUDA_LABEL[grupo]`; etiqueta de la ficha = `entrada.etiqueta` (igual que el índice).
- Grupo sin fichas visibles → **no aparece**. Fichas pendientes **sí** aparecen (están en el índice y
  en Anterior/Siguiente), sin marca.
- Destino de cada enlace: `/flito/ayuda/<clave>` (sin `#ancla`). Solo PageSlug en la URL; sin PII.

**Marcado**
```
<nav aria-label="Fichas de ayuda">
  <p>Fichas de ayuda</p>                       ← rótulo visible, NO encabezado
  <ul>
    <li>
      <button type="button" aria-expanded="true" aria-controls="<id-único>">
        <ChevronRight aria-hidden="true" /> Finanzas
      </button>
      <ul id="<id-único>">                     ← plegado: atributo `hidden`
        <li><Link to="/flito/ayuda/flito_bolsas">Bolsas</Link></li>
        <li><Link … aria-current="page">Reporte de costos</Link></li>
```
- `aria-label="Fichas de ayuda"` — distinto de «Contenido de la ficha» y de «Navegación entre
  fichas». Rótulo visible como `<p>` (mismo estilo que el rótulo de la TOC: `text-xs font-semibold
  uppercase tracking-[0.18em]`, `--flit-text-secondary`); los grupos **no** son encabezados (no
  ensucian el esquema `h1 → h2` de la ficha).
- Un `<button>` por grupo, con el **texto** del grupo como nombre accesible, `aria-expanded` y
  `aria-controls` apuntando a su lista. IDs con `useId` (conviven la instancia lateral y la del
  acordeón). Lista plegada con `hidden` (fuera del orden de tabulación; `aria-controls` sigue
  apuntando a un nodo que existe).
- Chevron `ChevronRight` de `lucide-react`, `aria-hidden`, `--flit-text-muted`, rota 90° abierto —
  el mismo gesto de `FlitAcordeon` (`transition-transform motion-reduce:transition-none`); nada más
  se anima.
- Sin `role="tree"` ni flechas de teclado: es una navegación con botones de despliegue (patrón
  *disclosure*). Tab recorre botones de grupo y enlaces visibles; Enter/Espacio pliega/despliega.

**Estilo (tokens del kit; nada nuevo)**
| Pieza | Reposo | Hover (sutil) | Foco | Actual |
|---|---|---|---|---|
| Botón de grupo | `text-sm font-semibold`, `--flit-text-primary`, `rounded-md px-2 py-1.5`, ancho completo, alineado a la izquierda | velo `--flit-bg-hover` + `transition-colors` | `flit-focus` | — |
| Enlace de ficha | `text-sm`, `--flit-text-secondary`, `rounded-md px-2 py-1.5`, sangría para alinear con el texto del grupo (pasado el chevron), `break-words` (etiquetas largas envuelven, **no** se truncan) | velo `--flit-bg-hover` + `transition-colors` | `flit-focus` | `aria-current="page"` + velo `--flit-bg-hover` fijo + tinta `--flit-blue-text` + `font-semibold` |

- El resaltado de la ficha actual **no** usa barra de color nueva ni fondo de acento: velo + tinta +
  peso (tres canales, ninguno solo el color). Se distingue del `aria-current="location"` de la TOC
  (que no lleva velo).
- Contraste ≥ 4.5:1 de `--flit-text-primary`, `--flit-text-secondary` y `--flit-blue-text` sobre el
  fondo de página **y** sobre `--flit-bg-hover`, en claro y oscuro (`check:contraste`). Foco ≥ 3:1.
- Sin tarjeta, sin sombra, sin borde de caja en `≥ lg`: el árbol pesa lo mismo que la TOC.

**Posición (≥ lg)** — mismo patrón que `TablaContenidoLateral`: `hidden lg:block lg:sticky lg:top-24
lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto` (top = topbar + 1rem; scroll propio si la lista es
larga, p. ej. `admin` con Gestión desplegado). Si la ficha actual queda fuera de la zona visible del
árbol al cargar, se lleva a la vista **dentro del árbol** (`scrollTop` del contenedor) **sin mover
la página** ni robar el foco del `h1`.

**Plegado y memoria**
1. Primera ficha abierta en la sesión: solo su grupo desplegado.
2. El conjunto de grupos desplegados vive **en memoria de la SPA** (estado de módulo o contexto que
   sobreviva al cambio de `:slug` y a ir al índice y volver). Se pierde al recargar. **No**
   `localStorage` ni `sessionStorage`.
3. Al abrir una ficha, su grupo **se fuerza desplegado** (se añade al conjunto), aunque el usuario lo
   hubiera plegado antes. Los demás conservan lo que el usuario dejó.
4. El usuario **puede** plegar el grupo de la ficha actual (la ficha queda oculta en el árbol; el
   resaltado vuelve al desplegar). No se lo impedimos.
5. La misma memoria sirve a la columna `≥ lg` y al árbol dentro del acordeón `< lg`.

**Navegación:** clic en una ficha → ruta nueva; foco al `h1` de la ficha nueva (regla vigente, sin
cambio). El árbol no se re-pliega.

### Estados (4) + copy

**Del árbol en sí:** sus datos son locales y síncronos (catálogo + permisos del usuario).
| Estado | Árbol |
|---|---|
| Cargando | No aplica como estado propio: se pinta completo de inmediato (no hay skeleton del árbol). |
| Error | No aplica: no hay lectura que pueda fallar. |
| Vacío | No alcanzable: si se pinta, el usuario ve al menos la ficha abierta. Defensivo: lista vacía → no se pinta la columna (la rejilla cae a la variante sin árbol). Sin copy. |
| Lleno | Grupos con fichas visibles; grupo actual desplegado; ficha actual resaltada. |

**De la ficha, con el árbol:**
| Estado de la ficha | Árbol ≥ lg | Acordeón «Fichas de ayuda» < lg | Copy |
|---|---|---|---|
| Cargando | Sí (real; reserva la columna) | Sí, cerrado | Sin cambio |
| Error | Sí | Sí, cerrado | Sin cambio: «No se pudo cargar esta ficha.» / «Revise su conexión y vuelva a intentarlo.» + **Reintentar** / **Volver al índice**. El árbol es una salida más: otra ficha sí puede cargar. |
| Vacío (pendiente) | Sí | Sí, cerrado | Sin cambio |
| Lleno | Sí | Sí, cerrado | Sin cambio |
| «Esta ficha no existe» / `NoAccess` | **No** | **No** | Sin cambio |

### Responsive + feedback + notificación

- **< lg:** el árbol pasa al acordeón «Fichas de ayuda» cerrado, encima de «Contenido de la ficha»,
  ambos en un bloque con `space-y-2`; ninguna columna fija; etiquetas largas envuelven; nada
  desborda a 360–390 px.
- **Entre `lg` y `xl`** la rejilla de 3 columnas estrecha el artículo (ver Nota en QA). No se cambia
  el breakpoint sin preguntar al PO.
- **Feedback:** botones de grupo y enlaces con hover `--flit-bg-hover` + `transition-colors` corta y
  `flit-focus`; el disparador del acordeón ya lo trae `FlitAcordeon`. Ningún control plano.
- **Notificación:** ninguna. Plegar/desplegar y navegar no producen toast ni aviso.

### Permiso/slug

Sin cambio: misma guarda de la ficha (`puedeVerAyudaFlito` + `hasPage` del slug). El árbol solo
lista lo que `capitulosEnOrdenDeIndice(user)` ya devuelve; no añade gate ni `PageSlug`.

### Notas para QA (≤ 10)

1. `admin` en «Reporte de costos» (`≥ lg`): 3 columnas; árbol con General, Gestión, Tránsito,
   Finanzas, Administración en ese orden; solo Finanzas desplegado; «Reporte de costos» con
   `aria-current="page"` y resaltado visible.
2. `proveedor`: árbol con un solo grupo (Gestión) y una ficha (SOAT); sin grupos vacíos.
3. Desplegar Gestión, ir a SOAT por el árbol, volver a Finanzas por el árbol: Gestión y Finanzas
   siguen desplegados; plegar Gestión y abrir una ficha de Gestión lo despliega de nuevo. Recargar
   (F5): solo el grupo de la ficha actual queda desplegado. Nada en `localStorage`/`sessionStorage`.
4. Ficha con un solo `h2`, ficha pendiente y error: 2 columnas (árbol + artículo), sin columna
   derecha vacía. Cargando: 3 columnas, sin salto al terminar.
5. «Esta ficha no existe» (`/flito/ayuda/privacy`), `NoAccess` (`proveedor` en `flito_bolsas`) e
   índice `/flito/ayuda`: **sin** árbol.
6. 390 px: «Fichas de ayuda (n)» cerrado encima de «Contenido de la ficha (n)», juntos; abrir el
   primero muestra el árbol con el grupo actual desplegado; elegir otra ficha la abre con el
   acordeón cerrado. Nada desborda.
7. Teclado y lector: tres `nav` con nombres distintos; cada grupo es un botón con su nombre y
   `aria-expanded` correcto; Tab no entra en grupos plegados; foco visible en todo.
8. Árbol largo (`admin`, Gestión desplegado) en ventana baja: el árbol hace scroll propio y la
   ficha actual queda visible dentro de él al cargar, sin mover la página.
9. Claro y oscuro: contraste ≥ 4.5:1 de grupo, ficha y ficha actual (también sobre el velo de hover).
10. **Nota de ancho (no bloquea):** a 1024 px medir el ancho útil del artículo. Si baja de ~28rem y
    la lectura se resiente, se reporta al PO (opción a evaluar: 3 columnas solo desde `xl`). No lo
    decide el implementador.

### Decisiones y descartes HU #13896

| Decisión | Por qué | Descartado |
|---|---|---|
| Árbol a la izquierda, TOC se queda a la derecha | Lectura de lo general a lo particular (qué ficha → qué dice → qué sección); la izquierda quedó libre (menú del shell = barra flotante inferior); misma disposición que el manual de FLIT Trámites que dio el humano | Invertir (TOC izquierda, árbol derecha); fusionar árbol y TOC en una sola columna |
| Dos niveles: grupo → fichas | Responde a «qué más hay»; las secciones ya están en la TOC | Árbol de 3 niveles con las secciones de cada ficha (duplica la TOC y triplica la altura) |
| Solo el grupo actual desplegado al empezar | Árbol corto al primer vistazo; ubica sin saturar | Todo desplegado (22+ enlaces de `admin` compitiendo con la lectura); todo plegado (obliga a buscar la ficha actual) |
| Memoria en la SPA, grupo actual forzado | Quien explora no pierde lo que abrió al saltar de ficha; la ficha abierta siempre se ubica | `sessionStorage`/`localStorage` (persistencia que nadie pidió y estado que sobrevive a otro usuario en el mismo equipo); sin memoria (se re-pliega en cada salto) |
| Sin árbol en el índice | El índice **es** la lista de fichas; duplicarla es ruido | Árbol también en `/flito/ayuda` |
| `< lg`: acordeón del kit cerrado, encima de la TOC plegable | Una fila; patrón ya presente en la misma pantalla; no tapa el contenido | Panel deslizable/drawer en móvil (patrón nuevo, trampa de foco, overlay); árbol desplegado arriba (empuja la ficha fuera del primer pliegue) |
| `nav` + botones *disclosure*, no `role="tree"` | Correcto y simple; el patrón ARIA *tree* exige gestión de flechas y foco itinerante sin beneficio aquí | `role="tree"`/`treeitem`; grupos como `h2`/`h3` (ensuciaría el esquema de la ficha) |
| Resaltado = velo + tinta + semibold | Tokens con par oscuro; tres canales; distinto del actual de la TOC | Barra de color lateral nueva; fondo de acento sin par oscuro |
| Sin contador por grupo, sin badge pendiente, sin iconos | Menos ruido en 15rem; la ficha pendiente se explica al abrirla | Contadores «Gestión (12)»; badge «Ficha pendiente» en el árbol; iconos carpeta/documento (fuera de alcance) |
| Etiquetas largas envuelven | No esconder el nombre | Truncar con «…» + tooltip (patrón nuevo, ilegible en táctil) |
| Sin buscador ni versión en el árbol | Fuera de alcance; el buscador vive en el índice | Buscador en el árbol; versión al pie del árbol |
| Sin efectos | Principios: claridad sin adorno | Animar altura al desplegar, transición de página, sombra en la columna |
