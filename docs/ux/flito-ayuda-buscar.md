# UX slim — Buscar capítulos del índice de Ayuda FLITO (HU #11901)

> **Anexo de `docs/ux/flito-ayuda.md`, no lo sustituye.** Revoca **solo** la línea
> «No hay búsqueda, filtros ni paginación». El gate derivado (`puedeVerAyudaFlito` /
> `puedeVerEntradaAyuda` / `hasPage`), los **4 estados** del índice y la ficha
> (`/flito/ayuda/:slug`) **no cambian**.
>
> Producto **cerrado** (no reabrir): campo solo en el índice; indexa etiqueta + resumen +
> cuerpo Markdown de capítulos **visibles**; coincidencias agrupadas; 0 coincidencias ≠
> FlitEmpty de permiso ≠ error de carga; consulta **no** en URL; no persiste; case/acento
> insensible; sin resaltar en el artículo; sin ⌘K; sin permiso extra; sin «¿Cómo se usa?»
> por pantalla. **Fuera de alcance:** reescribir la ficha `siigo_credenciales` (aunque
> #11890 esté en develop).

---

## Superficie tocada

**Solo** `/flito/ayuda` (índice), en estado **Lleno** (≥1 capítulo visible).

No hay campo en `/flito/ayuda/:slug`. No hay atajo ⌘K nuevo (la paleta sigue yendo al
índice, no filtra capítulos). No hay query `?q=` ni `searchParams`.

El control vive **bajo** el `PageHeaderCard` y **arriba** de los grupos. Patrones:
`FlitField` + `flitInp` + `type="search"`, igual que Bolsas (`BolsaTransitoForm`:
`type="search"` + `aria-label` + `flitInp`). Tono **usted**. Contraste ≥ 4.5:1 (tokens
`flit/`).

### Wireframe (lleno con consulta)

```
┌─────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]                                                │
│  Ayuda FLITO                                                    │
│  Guías de las pantallas que usted ya puede abrir.               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Buscar capítulos                                           label│
│ [  Cargar factura…                              ] [Limpiar…]    │
│  type=search · class flitInp                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ GESTIÓN                                                    h2   │
│ │ SOAT                                                  Abrir →│ │
│ │ Cola de pólizas del proveedor.                              │ │
└─────────────────────────────────────────────────────────────────┘
     (Finanzas / Administración no se pintan si no hay filas)
```

### Qué se indexa (cliente, sin endpoint)

Sobre `capitulosVisibles` (`puedeVerEntradaAyuda` / `hasPage` del catálogo):

| Campo | Cuándo entra |
|---|---|
| `etiqueta` | Siempre (también «Ficha pendiente») |
| `resumen` | Siempre |
| Cuerpo Markdown | Si el `.md` del slug **existe** en el bundle. Se busca el **fuente**, no el HTML renderizado. |

Un capítulo que el usuario **no** puede ver **no** entra al índice de búsqueda: Financiera
que escribe «Credenciales RNDC» no ve Credenciales ni el grupo Administración, aunque ese
texto viva en `siigo_credenciales.md`.

Campo **vacío** (espacios que recortan a `''` cuentan como vacío) = índice completo, mismos
grupos y filas que hoy. Recargar la página o volver desde la ficha **vacía** el campo
(estado de React; no `localStorage`, no URL).

Normalización: minúsculas y **sin acento** (`es`). «Cargar factura», «cargar FACTURA» y
«cargar factura» son la misma consulta. Sin resaltar coincidencias en la fila ni en el
artículo.

---

## Estados (4) + copy

Los cuatro del índice **siguen** los de `docs/ux/flito-ayuda.md`. El campo **no** se pinta
en Cargando, Error ni Vacío de permiso.

| Estado | ¿Campo de búsqueda? | Qué no cambia |
|---|---|---|
| **Cargando** | No | `PageContentSkeleton` |
| **Error** | No | **No se pudo cargar el índice de ayuda.** + **Reintentar** |
| **Vacío** (0 capítulos en la intersección) | No | FlitEmpty: **No hay capítulos de ayuda para las pantallas que usted puede abrir.** + **Volver al tablero** |
| **Lleno** (≥1 capítulo visible) | **Sí** | Lista agrupada Gestión / Finanzas / Administración; grupo sin filas **no se pinta** |

### Subestado del lleno — filtro sin coincidencias

**Cuándo:** hay capítulos visibles **y** el texto no pega con ninguno (etiqueta, resumen ni
cuerpo). **No** es el Vacío de la tabla. **No** es Error.

| Pieza | Copy (exacto) |
|---|---|
| Mensaje | **Ningún capítulo coincide con su búsqueda.** |
| Control | **Limpiar búsqueda** (`flitBtnSecondary`) — también vale vaciar el campo. Al limpiar: índice completo, foco de vuelta al input. |
| Qué no se usa | `FlitEmpty` de permiso, **Volver al tablero**, **Reintentar**, `role="alert"` de error |

El `PageHeaderCard` y el campo **siguen visibles**. `aria-live="polite"` en el mensaje (no
`assertive`). Grupo sin filas no se pinta; si ninguno tiene filas, solo quedan header +
campo + mensaje + limpiar.

### Copy del control (lleno)

| Pieza | Copy |
|---|---|
| `<label>` / `aria-label` | **Buscar capítulos** (`FlitField` visible; no icono mudo) |
| `placeholder` | **Buscar capítulos…** |
| Botón junto al campo (si el valor no es vacío) | **Limpiar búsqueda** |

---

## Permiso/slug

Sin cambio. Sin `flito_ayuda` concedible. Sin slug nuevo. La búsqueda **no** amplía
visibilidad: solo filtra lo que `capitulosVisibles` ya devolvió.

`NoAccess` (URL sin catálogo) sigue **antes** de montar el índice: no hay campo ahí.

Datos: **ningún endpoint nuevo.** Bundle y catálogo ya embebidos. Sin PII en path/query.

---

## Notas para QA (≤10)

1. **AC1.** `proveedor` en `/flito/ayuda`, busca «Cargar factura» → una fila **SOAT** bajo
   **Gestión**. La URL sigue `/flito/ayuda` (sin `?q=` ni hash).
2. **AC2.** `financiera` busca «Credenciales RNDC» → no aparece Credenciales ni el grupo
   **Administración**. Copy **Ningún capítulo coincide con su búsqueda.** + **Limpiar búsqueda**.
3. **AC3.** Tres cosas distintas: (a) filtro 0 coincidencias = copy de esta HU; (b) FlitEmpty
   de permiso = «No hay capítulos de ayuda para las pantallas…»; (c) error = «No se pudo
   cargar el índice de ayuda.» + **Reintentar**. No reutilizar el FlitEmpty en (a).
4. **AC4.** Grupos: con consulta, un grupo sin filas no se pinta. `financiera` busca
   «Asentar corrección» → **Bolsas** bajo **Finanzas**; Gestión y Administración ausentes.
5. **AC5.** El campo **solo** está en el índice. En `/flito/ayuda/soat` no hay input ni
   resaltado del término. Recargar el índice (F5) deja el campo vacío y el catálogo visible
   completo. Vaciar a mano = mismo efecto.
6. **AC6.** Label asociado **Buscar capítulos**; `type="search"`; `flitInp`; foco visible;
   contraste ≥ 4.5:1. Los 4 estados del índice no se rompen: el filtro 0 es subestado del
   lleno (header + campo siguen).
7. Case/acento: «cargar factura» y «CARGAR FACTURA» pegan igual. Campo vacío (o solo
   espacios) = índice completo del rol, sin mensaje de 0 coincidencias.
8. No hay ítem nuevo en ⌘K ni atajo de teclado de esta búsqueda. No hay paginación ni
   filtro por grupo aparte del que ya oculta grupos vacíos.
9. `admin` con «Credenciales RNDC» **sí** puede ver el capítulo Credenciales (es visible
   para él); `financiera` no. Eso es visibilidad, no un fallo del filtro.
10. Fuera de alcance de esta HU: copy de `siigo_credenciales.md`, permiso extra, «¿Cómo se
    usa?» en otras pantallas.

---

## Remisiones a insertar en `docs/ux/flito-ayuda.md`

1. Tras el bloque de contexto del Feature: anexo HU #11901 → este archivo.
2. Acciones del índice: tachar «No hay búsqueda, filtros ni paginación» y remitir aquí.
   Sigue sin filtros de grupo, sin paginación y sin búsqueda en la ficha.
3. Tabla de 4 estados: una nota bajo **Lleno** — el vacío de filtro es **subestado**, no un
   quinto estado ni el Vacío de permiso.

---

## Decisiones (esta HU)

| Decisión | Por qué | Descartado |
|---|---|---|
| Campo solo en el índice | Producto cerrado; la ficha es lectura | Buscar dentro del artículo; ⌘K de capítulos |
| 0 coincidencias = subestado del lleno | Distinguir permiso / error / filtro (AC3) | Reusar `FlitEmpty` de permiso; tratarlo como error |
| Consulta en estado React | No PII en URL; recargar vacía (AC5) | `?q=`, `localStorage` |
| Indexar cuerpo Markdown visible | AC1/AC4 pegan un botón que solo vive en el `.md` | Solo etiqueta; buscar fichas no visibles |
