# UX — Ayuda FLITO (Feature #11892 · HU #11893)

> **Modo `full`.** Dispara el umbral: **página nueva** (`PageSlug` + ruta + ítem de menú).
> Esta HU publica el **índice por permiso** y la **superficie de ficha**. **No** publica las 18
> fichas de contenido (eso es #11894 / #11895): el índice puede mostrar «Ficha pendiente».
>
> Decisiones de producto **cerradas** (no reabrir): ayuda in-app con Markdown del repo como fuente;
> **un** ítem de menú; **sin** «¿Cómo se usa?» en cada pantalla; **sin** capturas; visibilidad
> derivada de `hasPage` sobre el catálogo (no un permiso que alguien conceda a mano); tono **usted**;
> no copiar LaftManual (PDF). El rol `operaciones` no existe: el operador FLITO es `admin`.

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
| **AC2** | `conductor`, `compliance`, `transito`, `lider_pesv` y `supervisor_flota` **sin** ninguna página del catálogo en sus páginas efectivas: **no** ven el ítem. Si pegan la URL, el mismo patrón que el resto del shell: `NoAccess` («No tienes acceso a …» + **Volver al tablero**). No es el vacío del índice. |
| **AC3** | `proveedor` (gestor SOAT) solo tiene `soat` en el catálogo: el índice lista **SOAT** y no Impuestos, Bolsas ni Siigo. Si el `.md` de SOAT aún no existe, la fila dice **Ficha pendiente** (no es error). |
| **AC4** | Índice y ficha tienen los **4 estados**: carga, error + **Reintentar**, vacío, lleno. Copy abajo. |
| **AC5** | Encabezados reales, nombre accesible en cada control, foco visible, contraste ≥ 4.5:1 (tokens `flit/`). |
| **AC6** | Toda ficha publicada (HUs siguientes) usa la plantilla de secciones. Prohibido capturas, endpoints y tablas dentro de la ficha. Esta HU deja el **renderer** y el estado pendiente listos. |

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
  url -->|Sí| noaccess[NoAccess — mismo patrón del shell]
  url -->|No| fin[Sigue en sus pantallas]
  gate -->|Sí| menu[Ve Ayuda FLITO en General y en ⌘K]
  menu --> idx[/flito/ayuda índice]
  idx --> st{Estado del índice}
  st -->|Carga| skel[PageContentSkeleton]
  st -->|Error| err[Copy de error + Reintentar]
  st -->|Vacío| vac[Sin capítulos para su permiso]
  st -->|Lleno| grupos[Grupos Gestión / Finanzas / Administración]
  grupos --> click[Activa un capítulo]
  click --> det[/flito/ayuda/:slug ficha]
  det --> dst{Estado de la ficha}
  dst -->|Carga| skel2[Skeleton de artículo]
  dst -->|Error al leer .md| err2[Error + Reintentar + Volver al índice]
  dst -->|Sin .md| pend[Ficha pendiente — no es error]
  dst -->|Sin hasPage del slug| noaccess2[NoAccess de esa pantalla]
  dst -->|Slug fuera del catálogo| noficha[Esta ficha no existe + Volver al índice]
  dst -->|Lleno| md[Markdown: plantilla AC6]
  md --> ir[Opcional: Ir a la pantalla]
  pend --> vol[Volver al índice]
  md --> vol
```

No hay rama «ayuda contextual» ni botón «¿Cómo se usa?» en las pantallas del catálogo.

---

## Catálogo de 18 — el índice filtra por `hasPage`

Fuente de verdad de **qué** puede aparecer. El **orden** de cada grupo es el de abajo (el de
`NAV_ITEMS` cuando el ítem existe; si no hay ítem de menú, al final del grupo).

Etiqueta visible = etiqueta de **nav** si el ítem existe; si no, la de `PAGES` (o la indicada).

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
| Rutas | `/flito/ayuda` (índice) y `/flito/ayuda/:slug` (ficha). `:slug` es el **PageSlug** del catálogo (`flito_tramites`, `soat`, …). No es PII. |
| Registro | `App.tsx`: `lazy()` + guarda. **La guarda no es** `hasPage(user, 'flito_ayuda')`. |
| Gate | Helper único, p. ej. `puedeVerAyudaFlito(user)` = existe al menos un slug del catálogo de 18 con `hasPage`. Índice, ficha, ítem de menú y ⌘K usan **el mismo** helper. |
| `ProtectedRoute` | Si el gate falla → `<NoAccess page="flito_ayuda" />` (hace falta el slug en `PAGES` **solo** para el label de NoAccess). |
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
manifiesto estático del catálogo, **no** requiere que el `.md` exista.

Grupos vacíos: **no se renderizan**. `proveedor` ve un solo grupo (Gestión) con una sola fila (SOAT).

### Estados (4) + copy

| Estado | Cuándo | Qué se ve | Copy (usted) | Control |
|---|---|---|---|---|
| **Cargando** | Resolviendo catálogo ∩ `hasPage` y qué `.md` existen | `PageHeaderCard` + `PageContentSkeleton` (`aria-busy`, `aria-label="Cargando página"`) | *(sin párrafo extra; el skeleton habla)* | — |
| **Error** | Falló la carga del manifiesto / del bundle de fichas | `FlitCard` con título de error | **No se pudo cargar el índice de ayuda.** Debajo, el `errorMessage` del cliente (sin PII). | **Reintentar** |
| **Vacío** | Gate pasó en teoría pero la intersección dio 0 capítulos (defensivo; el caso feliz de AC2 es `NoAccess` **antes** de montar la página) | `FlitEmpty` | **No hay capítulos de ayuda para las pantallas que usted puede abrir.** / «Si cree que debería ver una guía, pídale a un administrador que le habilite esa pantalla. La ayuda no se concede aparte.» | **Volver al tablero** (enlace a `/`) |
| **Lleno** | ≥1 capítulo | Lista agrupada | Título de página **Ayuda FLITO**. Subtítulo: **Guías de las pantallas que usted ya puede abrir.** Badge **Ficha pendiente** en filas sin `.md`. | Cada fila navega a `/flito/ayuda/:slug` |

`NoAccess` (AC2, URL directa sin catálogo) **no** es uno de estos cuatro: es el patrón del shell,
antes del índice. Título: **No tienes acceso a Ayuda FLITO**. Cuerpo actual de `NoAccess`. Enlace
**Volver al tablero**.

### Acciones y validaciones

- Clic / Enter en la fila → navega a la ficha. **También** si está pendiente: el detalle explica el
  pendiente; no es un error en el índice.
- No hay búsqueda, filtros ni paginación (máximo 18 filas, casi siempre menos).
- No hay acciones de administración (publicar, editar Markdown) en la UI.

### Permiso y comportamiento por rol

El índice **no** ramifica copy por rol. La única diferencia es **qué filas y qué grupos** salen.
`proveedor` no ve un mensaje «usted es proveedor»; ve SOAT y nada más.

### Datos

Catálogo estático en el cliente (slugs, grupo, etiqueta, ruta de pantalla, archivo `.md` opcional).
**Ningún endpoint nuevo.** Ningún dato de persona en la URL.

---

## Pantalla 2 — Ficha (`/flito/ayuda/:slug`)

Segunda superficie obligatoria: abrir un capítulo desde el índice.

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
│  El capítulo ya figura en el índice; el contenido se publicará  │
│  en una entrega siguiente. No es un error.                      │
│  [ Volver al índice ]                                           │
└─────────────────────────────────────────────────────────────────┘
```

### Estados (4) + copy

| Estado | Cuándo | Copy | Control |
|---|---|---|---|
| **Cargando** | Leyendo / parseando el `.md` | Skeleton de artículo. `aria-label="Cargando ficha"` | — |
| **Error** | El archivo existe pero falló la lectura o el render | **No se pudo cargar esta ficha.** + detalle técnico corto del cliente. | **Reintentar** y **Volver al índice** |
| **Vacío** | Usuario **sí** tiene `hasPage` del slug del catálogo, **no** hay `.md` | **Esta ficha está pendiente.** / «El capítulo ya figura en el índice; el contenido se publicará en una entrega siguiente. No es un error.» | **Volver al índice**. Sin **Reintentar** (reintentar no crea el archivo). **Ir a la pantalla** sí, si hay ruta. |
| **Lleno** | Markdown presente y renderizado | Título = etiqueta del capítulo. Cuerpo = plantilla AC6. | **Volver al índice**. **Ir a la pantalla** si hay ruta conocida. |

Fuera de los 4 (mismas reglas que el resto de FLITO):

- Sin `hasPage` del `:slug` → `NoAccess` de **esa** pantalla (`PAGES[slug]`), no el vacío pendiente.
- `:slug` que no es de los 18 → **Esta ficha no existe.** / «Ese capítulo no forma parte de la ayuda
  FLITO.» + **Volver al índice**. No filtrar aquí un 403 que sugiera que el módulo existe y está
  prohibido; es un capítulo desconocido.

**Ir a la pantalla:** `Link` con el `to` de la tabla del catálogo. Nombre accesible: «Ir a la
pantalla SOAT». Si no hay ruta (`siigo_credenciales` hoy), **no** se pinta el control.

Foco: al montar, el `h1` recibe foco de programa (`titleRef` de `PageHeaderCard`), igual que el
cuadre de conciliación al navegar.

### Acciones y validaciones

- El Markdown **no** se edita en la app.
- El renderer **no** pinta imágenes (`img`, `![...]`) — AC: prohibido capturas.
- No se muestran bloques que parezcan tabla (si el `.md` trae pipe-tables, no renderizarlas; las
  HUs de contenido no las escriben).
- No enlazar a URLs de API ni mostrar paths `/api/...`.
- Enlaces internos permitidos: otras fichas del catálogo **solo si** `hasPage` de ese slug; si no,
  el enlace no se pinta o va al `NoAccess` de esa pantalla (mismo gate). Preferible: no emitir el
  enlace.

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

**Prohibido en el Markdown:** capturas, diagramas como imagen, endpoints, tablas, PII de ejemplo
(cédulas, placas reales, NIT de personas).

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
   catálogo: ítem ausente en nav, drawer y ⌘K. GET `/flito/ayuda` → `NoAccess`, no el vacío del
   índice.
7. Conceder a mano `soat` a un `conductor`: aparece el ítem y el capítulo SOAT (AC1).
8. `admin` ve Compuerta y Tablero FLITO en el índice aunque no estén en el menú; ve Mi ruta aunque
   el nav la reserve a mensajero.
9. `/flito/ayuda/flito_bolsas` como `proveedor` → `NoAccess` de Bolsas, no la ficha pendiente.
10. `/flito/ayuda/privacy` (fuera de los 18) → «Esta ficha no existe», no la guía de Privacidad.
11. Contraste y foco: badge pendiente, **Reintentar**, enlace de fila, **Ir a la pantalla**.
12. No hay «¿Cómo se usa?» en SOAT, Impuestos, Bolsas ni el resto del catálogo.

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

**Fuera de alcance de esta HU:** redactar las 18 fichas; capturas; ayuda de módulos no listados
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
