# UX slim — Buscar fichas del índice de Ayuda FLITO (HU #11901 · v2: Feature #13691 HU-2)

> **Anexo de `docs/ux/flito-ayuda.md`, no lo sustituye.** Revoca **solo** la línea
> «No hay búsqueda, filtros ni paginación». El gate derivado (`puedeVerAyudaFlito` /
> `puedeVerEntradaAyuda` / `hasPage`), los **4 estados** del índice y la ficha
> (`/flito/ayuda/:slug`) **no cambian**.
>
> Producto **cerrado** (no reabrir): campo solo en el índice; indexa etiqueta + resumen +
> cuerpo Markdown de capítulos **visibles**; ~~coincidencias agrupadas~~ (v2 P9-1a: lista única por
> relevancia); 0 coincidencias ≠ vacío de permiso ≠ error de carga; consulta **no** en URL; no persiste; case/acento
> insensible; sin resaltar en el artículo; sin ⌘K; sin permiso extra; sin «¿Cómo se usa?»
> por pantalla. **Fuera de alcance:** reescribir la ficha `siigo_credenciales` (aunque
> #11890 esté en develop).
>
> **v2 (Feature #13691 HU-2):** el delta vigente está en
> [§ Delta Feature #13691 · HU-2](#delta-feature-13691--hu-2). Donde este documento y el delta
> difieran, **manda el delta** (copy «capítulo» → «ficha», lista por relevancia, vacíos).

---

## Superficie tocada

**Solo** `/flito/ayuda` (índice), en estado **Lleno** (≥1 capítulo visible).

No hay campo en `/flito/ayuda/:slug`. No hay atajo ⌘K nuevo (la paleta sigue yendo al
índice, no filtra capítulos). No hay query `?q=` ni `searchParams`.

El control vive **bajo** el `PageHeaderCard` y **arriba** de los grupos. Patrones:
`FlitField` + `flitInp` + `type="search"`, igual que Bolsas (`BolsaTransitoForm`:
`type="search"` + `aria-label` + `flitInp`). Tono **usted**. Contraste ≥ 4.5:1 (tokens
`flit/`).

### Wireframe (lleno con consulta) — versión #11901, sustituida por el delta v2

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
| `palabras_clave`, `consultas` (v2 HU-1) | Si el `.md` existe y trae encabezado |
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

## Estados (4) + copy — versión #11901 (ver delta v2)

Los cuatro del índice **siguen** los de `docs/ux/flito-ayuda.md`. El campo **no** se pinta
en Cargando, Error ni Vacío de permiso.

| Estado | ¿Campo de búsqueda? | Qué no cambia |
|---|---|---|
| **Cargando** | No | `PageContentSkeleton` |
| **Error** | No | **No se pudo cargar el índice de ayuda.** + **Reintentar** |
| **Vacío** (0 fichas visibles) | No | ~~FlitEmpty: No hay capítulos de ayuda…~~ v2: «Su usuario aún no tiene módulos con ayuda.» + **Volver al inicio** |
| **Lleno** (≥1 ficha visible) | **Sí** | Sin búsqueda: lista agrupada General / Gestión / Finanzas / Administración; grupo sin filas **no se pinta**. Con búsqueda: v2, lista única |

### Subestado del lleno — filtro sin coincidencias

**Cuándo:** hay capítulos visibles **y** el texto no pega con ninguno. **No** es el Vacío de la
tabla. **No** es Error.

| Pieza | Copy |
|---|---|
| Mensaje | ~~Ningún capítulo coincide con su búsqueda.~~ v2: **Ninguna ficha coincide con "xyzzy"** |
| Control | **Limpiar búsqueda** (`flitBtnSecondary`) — también vale vaciar el campo. Al limpiar: índice completo, foco de vuelta al input. |
| Qué no se usa | `FlitEmpty` de permiso, **Volver al inicio**, **Reintentar**, `role="alert"` de error |

El `PageHeaderCard` y el campo **siguen visibles**. `aria-live="polite"` en el mensaje (no
`assertive`).

### Copy del control (lleno)

| Pieza | Copy |
|---|---|
| `<label>` / `aria-label` | ~~Buscar capítulos~~ v2: **Buscar fichas** (`FlitField` visible; no icono mudo) |
| `placeholder` | ~~Buscar capítulos…~~ v2: **Buscar fichas…** |
| Botón junto al campo (si el valor no es vacío) | **Limpiar búsqueda** |

---

## Permiso/slug

Sin cambio. Sin `flito_ayuda` concedible. Sin slug nuevo. La búsqueda **no** amplía
visibilidad: solo ordena y filtra lo que `capitulosVisibles` ya devolvió.

~~`NoAccess` (URL sin catálogo) sigue antes de montar el índice.~~ v2 (P9-3a): la URL directa sin
fichas visibles muestra el vacío «Su usuario aún no tiene módulos con ayuda», sin campo de búsqueda.

Datos: **ningún endpoint nuevo.** Bundle y catálogo ya embebidos. Sin PII en path/query.

---

## Notas para QA (HU #11901)

1. **AC1.** `proveedor` en `/flito/ayuda`, busca «Cargar factura» → **SOAT** en resultados. La URL
   sigue `/flito/ayuda` (sin `?q=` ni hash).
2. **AC2.** `financiera` busca «Credenciales RNDC» → no aparece Credenciales.
3. **AC3.** Tres cosas distintas: (a) búsqueda sin coincidencias; (b) vacío sin fichas visibles;
   (c) error + **Reintentar**. No reutilizar el copy de una en otra.
4. **AC5.** El campo **solo** está en el índice. Recargar (F5) deja el campo vacío.
5. **AC6.** Label asociado; `type="search"`; `flitInp`; foco visible; contraste ≥ 4.5:1.
6. Case/acento: «cargar factura» y «CARGAR FACTURA» pegan igual. Solo espacios = índice completo.
7. No hay ítem nuevo en ⌘K ni atajo de teclado de esta búsqueda. Sin paginación.

---

## Decisiones (HU #11901)

| Decisión | Por qué | Descartado |
|---|---|---|
| Campo solo en el índice | Producto cerrado; la ficha es lectura | Buscar dentro del artículo; ⌘K de capítulos |
| 0 coincidencias = subestado del lleno | Distinguir permiso / error / filtro (AC3) | Reusar `FlitEmpty` de permiso; tratarlo como error |
| Consulta en estado React | No PII en URL; recargar vacía (AC5) | `?q=`, `localStorage` |
| Indexar cuerpo Markdown visible | AC1/AC4 pegan un botón que solo vive en el `.md` | Solo etiqueta; buscar fichas no visibles |

---
---

## Delta Feature #13691 · HU-2

> **UX slim** · HU-2 «Ayuda FLITO: búsqueda ordenada por relevancia y vacíos diferenciados»
> (borrador `docs/ado-drafts/epic-12756-12757/HUS-F1-13691.md`). Decisiones P9: **P9-1a** (lista
> única por relevancia, grupo como etiqueta) y **P9-3a** (vacío en URL directa; menú oculto).
> Público: operador interno. Tono: **usted**.

### Superficie tocada

`/flito/ayuda` (índice): estado **Lleno con consulta** (nuevo trazado), subestado sin
coincidencias (copy), **Vacío** (pasa a ser alcanzable por URL directa) y **Error** (copy del
detalle). El índice **sin consulta** no cambia (agrupado, orden del menú — HU #13431).

### Qué vino a hacer y qué se ve primero

Quien escribe en el buscador quiere **la ficha que explica su pantalla, arriba**. Con consulta, lo
primero es la mejor coincidencia; el grupo pasa de encabezado a etiqueta pequeña de la fila. La
relevancia no se muestra (ni puntaje ni «coincidencia en título»): el orden ya la dice.

### Wireframe — lleno con consulta (≥ `lg`)

```
┌─────────────────────────────────────────────────────────────────┐
│ [PageHeaderCard]  Ayuda FLITO                                   │
│  Guías de las pantallas que usted ya puede abrir.               │
└─────────────────────────────────────────────────────────────────┘
 Buscar fichas                                              label
 [ conciliación                                  ] [ Limpiar búsqueda ]
 3 fichas coinciden con "conciliación"          ← role="status", polite, text-sm sec.
┌─────────────────────────────────────────────────────────────────┐ ← <ol aria-label="Resultados de la búsqueda">
│ FINANZAS                                                        │ ← etiqueta de grupo (xs, mayúsc., sec.)
│ Conciliación                                                  → │
│ Cuadre de pagos contra extractos.                               │
├─────────────────────────────────────────────────────────────────┤
│ FINANZAS                                                        │
│ Bolsas                                                        → │
│ Saldos, recargas y cierres.                                     │
├─────────────────────────────────────────────────────────────────┤
│ GESTIÓN                                       Ficha pendiente   │
│ Gestión Trámites                                              → │
│ …                                                               │
└─────────────────────────────────────────────────────────────────┘
```

- **Una sola tarjeta** con lista ordenada (`<ol>`), misma fila que hoy (`FilaCapitulo`: enlace a
  toda la fila, hover `--flit-bg-app`, `flit-focus`) con una línea extra arriba: el grupo en
  `text-xs uppercase tracking` `--flit-text-secondary` (no `--flit-text-muted`: ≥ 4.5:1). Texto,
  no chip: el chip ya lo usa «Ficha pendiente» y dos chips por fila serían ruido.
- Nombre accesible de la fila: «Abrir ficha de Conciliación, Finanzas» (o «Ficha pendiente de …,
  Gestión»).
- Empates de relevancia: orden del índice (determinista; la prueba por ficha depende de ello).
- Al limpiar o vaciar el campo: vuelve el índice **agrupado** de siempre (`<nav aria-label="Fichas
  de ayuda">` con `h2` por grupo).
- La línea de conteo y el mensaje sin coincidencias son **la misma región** `role="status"`
  `aria-live="polite"`: «1 ficha coincide con "x"» / «N fichas coinciden con "x"» / «Ninguna ficha
  coincide con "x"». Se anuncia cuando el usuario deja de escribir (≈300 ms), no por tecla.
- La consulta se muestra como texto (React escapa), con `break-words`; `maxLength={100}` en el campo.

### Estados (4) + copy

| Estado | Qué se ve | Copy (usted) | Control |
|---|---|---|---|
| **Cargando** | `PageHeaderCard` + `PageContentSkeleton`; sin campo | — | — |
| **Error** | `FlitCard` de error; sin campo | **No se pudo cargar el índice de ayuda.** / «Revise su conexión y vuelva a intentarlo.» (ya **no** el `errorMessage` crudo) | **Reintentar** → al éxito, índice lleno (AC8) |
| **Vacío** (P9-3a: 0 fichas visibles; solo por URL directa) | `PageHeaderCard` con el título «Ayuda FLITO» (sin subtítulo) + `FlitEmpty`; sin campo | **Su usuario aún no tiene módulos con ayuda** (título; AC7) / «La Ayuda FLITO muestra guías solo de las pantallas que usted puede abrir. Si necesita una, pídale a un administrador que le habilite esa pantalla.» | **Volver al inicio** (`Link` a `/`, `flitBtnSecondary`) |
| **Lleno** sin consulta | Índice agrupado (sin cambio) | — | Filas |
| **Lleno** con consulta | Lista única por relevancia (wireframe) | Conteo en la región de estado | Filas · **Limpiar búsqueda** |
| Subestado: sin coincidencias | Header + campo + región de estado; **sin** tarjeta de lista | **Ninguna ficha coincide con "xyzzy"** | **Limpiar búsqueda** (el mismo botón junto al campo; no se duplica). Vacía el campo, devuelve el foco al input y restaura el índice agrupado |

Gate (P9-3a): el ítem «Ayuda FLITO» **sigue oculto** en menú, cajón y ⌘K para quien no tiene
fichas visibles; solo cambia lo que ve quien pega `/flito/ayuda`. `/flito/ayuda/:slug` sin `hasPage`
del slug sigue en `NoAccess` de esa pantalla. **F3 (Dr. Flit) no debe usar este vacío como señal
de visibilidad** (su regla es D2).

### Responsive (<`lg`)

La barra (campo + **Limpiar búsqueda**) envuelve con `flex-wrap`: el campo a ancho completo y el
botón debajo; una sola altura de control. Las filas de resultados apilan etiqueta de grupo, nombre y
resumen; el chip «Ficha pendiente» baja bajo el resumen en <`sm` en lugar de apretar el nombre. La
región de conteo envuelve. Nada con `min-w` que desborde 360 px (revisar el `min-w-[240px]` actual:
cabe, pero no subirlo).

### Feedback y notificación

- Filas: hover `--flit-bg-app` + `transition-colors` (ya existe) y `flit-focus`. **Limpiar
  búsqueda**: hover/foco de `flitBtnSecondary`. Campo: foco del kit (`flitInp`).
- **Ningún toast**: buscar no es una acción con resultado; el conteo y el «sin coincidencias» son
  estado de la página → región `role="status"` en página (principios: estado persistente = aviso).

### Permiso/slug

Sin cambio: sin slug nuevo, sin permiso concedible. El ranking corre **después** del filtro de
visibilidad: una ficha sin permiso no se puntúa ni se cuenta (AC5).

### Notas para QA (HU-2, ≤ 10)

1. «conciliación»: la ficha con la palabra en el título sale antes que la que solo la tiene en el cuerpo.
2. «GESTION tramites» → «Gestión Trámites» primera.
3. Con consulta: una sola lista, sin `h2` de grupo, cada fila con su grupo en texto; limpiar → índice agrupado en el orden del menú.
4. Financiera + «credenciales siigo»: «Integración con Siigo» no aparece y no suma al conteo.
5. «xyzzy» → «Ninguna ficha coincide con "xyzzy"» anunciado (polite); **Limpiar búsqueda** vacía el campo y deja el foco en él.
6. Usuario sin fichas por URL directa → «Su usuario aún no tiene módulos con ayuda» + **Volver al inicio**; el ítem sigue ausente de menú, cajón y ⌘K.
7. Error forzado → copy sin texto técnico + **Reintentar**; tras reintento con éxito, índice lleno.
8. Cargando: skeleton, sin campo. Lleno: label «Buscar fichas» asociado, foco visible, contraste ≥ 4.5:1 en los dos temas.
9. 390 px: barra envuelve, nada desborda; chip pendiente bajo el resumen.
10. La URL nunca lleva la consulta (`?q=` ni hash).

### Decisiones y descartes (HU-2)

| Decisión | Por qué | Descartado |
|---|---|---|
| Lista única con grupo como texto (P9-1a) | «Primera al buscar su título» solo tiene sentido en una lista | Grupos ordenados por dentro (P9-1b); chip de grupo (dos chips por fila) |
| Conteo en región de estado | Confirma que la búsqueda respondió, también al lector | Toast; contador dentro del campo |
| Un solo **Limpiar búsqueda** | Ya existe junto al campo; dos botones iguales confunden | Botón repetido en el mensaje sin coincidencias |
| Vacío nuevo en la URL directa (P9-3a) | Explica el porqué y el siguiente paso sin exponer el menú | `NoAccess` genérico (tutea y no explica que la ayuda no se concede aparte) |
| Error sin `errorMessage` crudo | Principios: nunca el error del cliente en pantalla | Mantener el detalle técnico |
