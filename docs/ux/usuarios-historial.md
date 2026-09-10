# UX slim — Historial de cambios en el módulo de usuarios (HU #12171, Feature #12072)

> **Qué es este documento.** El delta de UX para la pestaña **Historial** de `Users.tsx` (AC3 de la
> #12171). Modo **slim**: extiende una pantalla existente con el kit que ya hay. La ficha hermana es
> `docs/ux/roles-y-permisos-panel.md` (mismo módulo, mismo público): de ella se calcan tratamiento,
> vocabulario («función», «ámbito», «tipo de acceso») y la regla de «ningún identificador en la URL».
> El contrato de datos es el §7 de `docs/diseno-hu-12171-trazabilidad-usuarios-permisos.md`.
>
> **Público:** operador interno — administrador y auditor. Nunca el canal Cliente.
>
> **Verificado sobre** el worktree `flito-hu12171`, 2026-09-10. Tres hechos condicionan el delta y van
> en §5, porque sin ellos la mitad «auditor» de la HU no se puede cumplir por construcción.

---

## 0. Oficio (respondido antes de dibujar)

| Pregunta | Respuesta |
|---|---|
| **¿Qué vino a hacer quien abre esto?** | Responder **«¿quién le cambió qué a este usuario (o a este rol), y cuándo?»**. Casi siempre con un sujeto en la cabeza: un usuario que de pronto ve de más, o un rol que perdió una función. |
| **¿Qué se ve primero?** | Una fila por cambio, la más reciente arriba, con **cuándo · quién · a quién/qué · antes → después**. Lo que decide «esta fila es la que busco» es la tercera columna (el afectado y el campo). |
| **¿Qué se calla y dónde vive?** | El `loteId` (no se pinta; las filas de un mismo lote van contiguas y ya). El `id` interno del titular y del rol (viajan solo a la API). El JSON crudo del conjunto (se pinta como diff, nunca como dos JSON). IP y user-agent del actor (no vienen en el DTO y no hacen falta aquí). |
| **¿Cuál es la única primaria?** | **Ninguna en la pestaña Historial.** Es una superficie de lectura. «Nuevo usuario» sigue siendo la primaria del módulo, **y vive en la pestaña Usuarios** (§2). |
| **¿El vacío y el error dicen el siguiente paso?** | Sí: dos vacíos distintos (sin registros / sin coincidencias) y un error con **Reintentar** (§4). |
| **¿Hay efectos o un patrón nuevo injustificado?** | No. Pestañas con el patrón ya resuelto en `SiigoParametrizacion.tsx:225-258`; tabla con `FlitTable`; vacío con `FlitEmpty`; paginación con `Paginacion`; chips con `StatusChip`. Cero componentes nuevos en `components/flit/`. |

---

## 1. Superficie tocada

| | |
|---|---|
| Página | `apps/web/src/pages/Users.tsx` — gana una fila de pestañas y ~10 líneas (§9 del diseño) |
| Componente nuevo | `apps/web/src/pages/users/HistorialPermisos.tsx` — **no es kit**: props tipadas, un consumidor |
| Ruta | `/users`, sin cambios. **Ningún id de usuario ni de rol en la URL** (AC3); la pestaña activa y los filtros viven en `useState`, como el filtro por rol de `Users.tsx:34` |
| Slug | `users` (existente). Ver §5-1: hoy solo lo tiene `admin` |
| Datos | `GET /api/users/auditoria` (§7 del diseño) + dos requerimientos, §5 |
| PII | Del titular: **solo `username`** (el DTO no trae ni puede traer nombre, correo ni documento). Del actor: `email`, autorizado por RN-A10. Es **menos** de lo que ya enseña la lista de usuarios de al lado (usuario, nombre y correo) |

---

## 2. Delta de claridad (qué se ve / qué se calla)

**Dónde vive la pestaña.** Una fila de pestañas **entre `PageHeaderCard` y `UsersToolbar`**:
`[ Usuarios ] [ Historial ]`. Solo una de las dos está montada. La lista, su barra y sus modales no
cambian en nada cuando la pestaña activa es «Usuarios».

**La primaria viaja con la lista.** `Nuevo usuario` se pinta en `actions` de la cabecera **solo
cuando la pestaña activa es «Usuarios»**. En «Historial» la cabecera no tiene acción: nadie abre
un historial para crear a alguien, y dejar el gradiente allí sería una primaria sin trabajo detrás
(mismo criterio que `roles-y-permisos-panel.md` §Decisión 4). Para el auditor —que nunca crea— el
botón simplemente no existe.

**Jerarquía dentro de Historial**, de arriba abajo:

1. **Suelo temporal**, una línea de texto secundario: desde cuándo hay historial. Va primero porque
   es lo que hace que un historial corto no se lea como un fallo.
2. **Filtros** en una sola fila: Usuario · Recurso · Desde · Hasta. Sin tarjeta propia: van dentro de
   la misma tarjeta que la tabla, como los pills de la Bitácora.
3. **La tabla**, cuatro columnas: **Cuándo · Quién · Qué · Cambio**. Una fila = un cambio de un campo.
4. **Paginación** con el total: «128 cambios · página 1 de 3».

**Densidad: sin cambio en la lista de usuarios** (no se toca `UsersTable`). El panel nuevo son cuatro
columnas y 50 filas por página; la cuarta columna (el diff) puede ocupar dos o tres líneas en los
cambios de conjunto, y eso es lo que se vino a leer, no ruido.

**Lo que se calla y por qué:**

| Qué | Por qué no está |
|---|---|
| `loteId` | Es trastienda. Las filas de un lote van contiguas (orden `created_at desc, id asc`); no se dibuja agrupación: cada fila completa es lo que hace la tabla navegable (§9) |
| Columna «Acción» aparte | La acción se lee en la celda **Qué** cuando no hay campo (`creado`, `borrado`, `baja`, `reactivación`); una columna más para siete literales sería la saturación del vecino |
| Filtro por rol afectado (`rolCodigo`) | El AC pide usuario, recurso y fechas. El rol afectado **ya se lee** en la celda Qué. Si el PO lo quiere, es un `FlitSelect` más; no se mete de paso |
| IP / user-agent del actor | No vienen en el DTO. Si un incidente lo exige, se consulta en base; la pantalla no es forense |
| Nombre y correo del titular | AC4. El `username` identifica igual de bien en un equipo interno y es lo que la lista de al lado usa como primera columna |

---

## 3. Wireframe — pestaña Historial, estado lleno (administrador)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Gestión de usuarios                                                                        │
│ Equipo y accesos del sistema                                        (sin acción aquí)      │
└────────────────────────────────────────────────────────────────────────────────────────────┘

  ( Usuarios ) (● Historial )                                            ← tablist, pills del kit

┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ El historial comienza el 15 de septiembre de 2026. Los cambios anteriores a esa fecha no    │
│ se registraron con este detalle.                                                           │
│                                                                                            │
│ Usuario [ Todos ▾ ]   Recurso ( Todos )( Usuarios )( Roles )( Cuadro rol × función )        │
│                               ( Funciones por usuario )     Desde [ 2026-09-01 ] Hasta [ 2026-09-10 ] │
│                                                                                            │
│ CUÁNDO             QUIÉN               QUÉ                        CAMBIO                    │
│ ───────────────────────────────────────────────────────────────────────────────────────── │
│ 9 sept 2026, 14:32 admin@flitsas.io    Usuario  jperez            Añadidas (2): Exportar la  │
│                                        Funciones                  cola a Excel · Marcar un   │
│                                                                   impuesto como pagado       │
│                                                                   Quitadas (1): Anular una   │
│                                                                   solicitud de SOAT          │
│                                                                   Quedan 12                  │
│ 9 sept 2026, 14:32 admin@flitsas.io    Usuario  jperez            Gestor de Impuestos →      │
│                                        Rol                        Financiera                 │
│                                                                   Motivo: cambia de área     │
│ 8 sept 2026, 09:10 [Sistema]           Usuario  mruiz             Activo → Inactivo          │
│                                        Estado                                                │
│ 7 sept 2026, 17:45 dchica@flitsas.io   Rol  Gestor de Impuestos   Añadidas (1): Exportar la  │
│                                        Cuadro rol × función       cola a Excel · Quedan 13   │
│ 7 sept 2026, 17:40 dchica@flitsas.io   Rol  Consulta contable     —                          │
│                                        Rol borrado                                           │
│ 6 sept 2026, 11:02 admin@flitsas.io    Usuario  lgomez            Contraseña restablecida    │
│                                        Contraseña                                            │
│ 6 sept 2026, 11:00 admin@flitsas.io    Usuario  lgomez            — → Activo                 │
│                                        Usuario creado · Estado                               │
│                                                                                            │
│ 128 cambios · página 1 de 3                                 [← Anterior]  [Siguiente →]     │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Auditor.** Misma tarjeta, **sin la fila de pestañas** (solo hay un panel: una `tablist` de una
pestaña es un control que no controla nada) y **sin `Nuevo usuario`**. Cabecera: título **«Usuarios»**,
subtítulo **«Historial de cambios en usuarios, roles y permisos»**. No se le montan ni la lista, ni
`UsersToolbar`, ni los catálogos (`useCompanias`, `useProveedoresSoat`, `useOrganismosParametrizados`):
le responderían 403 (§5-1) y un 403 silencioso en un `useEffect` es un error que nadie ve.

**Geometría.** Todo dentro del `max-w-[1600px]` de `Users.tsx`. Por debajo de `md`, los filtros se
apilan en dos filas y la tabla desplaza en horizontal dentro de su `overflow-x-auto`, igual que
`UsersTable`.

---

## 4. Estados (4) + copy exacto

Fuente: `GET /api/users/auditoria?…&limite=50&offset=N`. Cada cambio de filtro vuelve a `offset=0`.

| Estado | Qué se ve | Copy |
|---|---|---|
| **1 · Cargando** | Cabecera de la tabla montada + una fila `colSpan=4`, `role="status"`, como hace `UsersTable.tsx:53`. Los filtros siguen operables | **«Cargando el historial…»** |
| **2 · Error** | Fila `colSpan=4` con título, mensaje del servidor y **botón**. `role="alert"`. La tabla no enseña filas viejas bajo un error (misma regla que `Users.tsx:64-70`) | **«No se pudo cargar el historial.»** + `formatErrors(e)` + botón **«Reintentar»** (secundario, calca el de `UsersTable.tsx:62-69`) |
| **3 · Vacío A — sin filtros y `total = 0`** | `FlitEmpty` en lugar de la tabla | Con `desdeCuando`: **«Todavía no hay cambios registrados desde el {fecha}. Cuando alguien cree o edite un usuario, un rol o sus funciones, aparecerá aquí.»** · Sin `desdeCuando` (tabla vacía): **«Todavía no hay cambios registrados. Aparecerán aquí a partir del primer cambio en un usuario, un rol o sus funciones.»** |
| **3 · Vacío B — con algún filtro y `total = 0`** | `FlitEmpty` + botón secundario | **«Ningún cambio coincide con estos filtros. Amplía el rango de fechas o quita el filtro de usuario o de recurso.»** + botón **«Quitar filtros»** (deja los cuatro en «Todos»/vacío y recarga) |
| **4 · Lleno** | Tabla + `Paginacion` con `sustantivo="cambios"` | «**128** cambios · página 1 de 3» (formato de `Paginacion.tsx:20`) |

**El suelo temporal** se pinta en los estados 3-A, 3-B y 4 (no en error, no en carga):
**«El historial comienza el {desdeCuando, "d 'de' MMMM 'de' yyyy"}. Los cambios anteriores a esa
fecha no se registraron con este detalle.»**

> **Corrección al §9 del diseño.** El diseño proponía «…Lo anterior está en la bitácora de
> auditoría». **No se usa esa frase**: `FlitoBitacora` lee `audit_logs` con la lista blanca
> `RECURSOS_FLITO` (SOAT, impuesto, trámite, revisión) y **los cambios de usuarios no se ven ahí**.
> Mandar al auditor a una pantalla donde no va a encontrar nada es peor que decirle que no hay
> detalle.

**Error de un filtro rechazado por Zod (400)**: se trata como el estado 2 con el `details` del
servidor. No se valida en cliente más que `min`/`max` entre las dos fechas, calcando
`RangoFechaFilter.tsx:55` y `:71`.

---

## 5. Lo que hay que resolver antes de codear (medido, no supuesto)

### 5-1 · El auditor no puede abrir la pestaña — bloquea la mitad «auditor» del AC2/AC3

| Hecho | Dónde |
|---|---|
| `users` no está en `ROLE_DEFAULT_PAGES.auditor` | `packages/shared-types/src/permissions.ts:261-276` |
| `pagina.users` se siembra **solo** a `admin` | `apps/api/src/db/migrations/0179_permisos_modelo.sql:563` |
| El router de usuarios ya es `exigirFuncion('usuarios.*')` por ruta, no `requireRole('admin')` de router | `users.routes.ts:121`, `:320` |
| `usuarios.usuario.listar` y `ver_resumen` están solo en `admin` | `0181_permisos_reconduccion.sql:44-51` |
| No existe ninguna función `usuarios.auditoria.*` en el catálogo | `catalogo-operaciones.ts:311-318`, sin coincidencias para «auditoria» |

El diseño (§7 «Montaje») resolvió el 403 **del endpoint** montándolo aparte; lo que no cubrió es
que **la página** tampoco se le abre al auditor. Requerimiento para `architecture-agent` /
`backend`:

1. Función nueva **`usuarios.auditoria.ver`** («Ver el historial de cambios», «Leer quién cambió
   qué en usuarios, roles y permisos, con el valor anterior y el posterior.»), sembrada en `admin` y
   `auditor`. El endpoint se guarda con ella, como el diseño ya anotaba para no migrar dos veces.
2. **`pagina.users` para `auditor`** (y `users` en `ROLE_DEFAULT_PAGES.auditor` mientras el menú
   se calcule de ahí). Recordatorio: los permisos viajan en el JWT 24 h — un auditor con sesión
   abierta no verá la entrada hasta reiniciar sesión.
3. La página necesita saber si **puede listar** para decidir qué monta (§3, «Auditor»). Hoy el web
   no lee funciones (`Users.tsx:96` sigue con `me?.role === 'admin'`). Mientras no exista
   `tieneFuncion` en `lib/auth`, la condición es `me?.role === 'admin'` **con nombre**
   (`puedeGestionar`), en el mismo sitio y con la misma nota que `puedeExportar`, para que la
   #12170 cambie una línea.

Si el PO decide que el auditor **no** entra por Usuarios sino por una entrada propia de menú, esto
deja de ser slim (slug nuevo → `full`) y hay que volver aquí. La recomendación es la de arriba: la
HU dice «dentro del módulo de usuarios» y una segunda pantalla para leer lo mismo es una pantalla
más que mantener.

### 5-2 · El filtro «Usuario» necesita una fuente que el auditor pueda leer

El parámetro es `titularUserId` (entero). El administrador tiene la lista cargada en `Users.tsx`,
pero el auditor **no puede pedir `GET /users`** (5-1), y darle `usuarios.usuario.listar` solo para
alimentar un `<select>` le entregaría nombre, correo y ámbito de todo el censo — más de lo que AC4
quiere que vea. Requerimiento:

- **`GET /api/users/auditoria/titulares`** → `{ userId: number; username: string }[]`: los usuarios
  que **tienen al menos una fila** en `permisos_auditoria`, ordenados por `username`. Misma guarda
  que el historial. Sin nombre ni correo. Es un `SELECT DISTINCT` con JOIN a `users.username`, que
  es lo que el DTO del historial ya hace por fila.

El `<select>` **Usuario** lo consume para los dos roles: **una** fuente, y la lista de «Todos» solo
contiene a quien tiene historial, que es exactamente lo que se puede filtrar. Si el requerimiento
se rechaza: el administrador alimenta el select con `users` de la página y **el auditor no ve el
filtro Usuario** — y eso se escribe en el PR como AC parcialmente cumplido, no se disimula.

### 5-3 · Los códigos de función llegan como códigos (no bloquea; se declara)

`valorAntes/valorDespues` del `conjunto` son **códigos** (`soat.solicitud.crear`,
`pagina.flito_impuestos`). La pantalla puede etiquetar las **páginas** con `PAGES[slug]` de
`shared-types`; para las **operaciones** no tiene catálogo (el de `GET /api/permisos/cuadro` es de
`admin` y de otra HU). Se pinta **la etiqueta si se conoce y el código en monoespaciada si no**, y se
deja anotado el requerimiento opcional: que la respuesta del historial incluya
`etiquetas: Record<string, string>` con los códigos que aparecen en la página. Sin él, el auditor lee
`soat.solicitud.crear`: cierto, feo, y no falso.

Lo mismo para `compania_id` y `flito_proveedor_soat_id`: se pintan como **«Compañía #15»** y
**«Gestor SOAT {id}»**. No se resuelve el nombre en cliente (el auditor no tiene los catálogos).

---

## 6. Cómo se pinta un cambio — una fila, cuatro celdas

### Cuándo
`new Date(creadoEn).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })` →
«9 sept 2026, 14:32». `medium` y no `short` como la Bitácora: «9/09/26» es ambiguo en una tabla que
se lee para reconstruir un orden. `whitespace-nowrap`, `--flit-text-muted`.

### Quién
- `actor.userId !== null` → `actor.email`, texto normal.
- `actor.userId === null` → `StatusChip tone="draft"` **«Sistema»** (calca `FlitoBitacora.tsx:88`).
- `origen === 'auditoria'` → tras el actor, texto muted **« · reconstruido»** con el mismo `title`
  que `HistorialEstados.tsx:96` **y** el mismo texto en un `sr-only` (el `title` no existe para
  teclado ni táctil; ya lo dijo la ficha de ámbito).

### Qué — dos líneas
Línea 1: `StatusChip tone="neutral"` con la entidad + el identificador:

| `entidad` | Chip | Identificador |
|---|---|---|
| `usuario`, `usuario_funcion` | **Usuario** | `titular.username` en monoespaciada (como la primera columna de `UsersTable`). Si `titular` es `null` (no debería pasar por `ON DELETE RESTRICT`): **«usuario eliminado»** en muted |
| `rol`, `rol_funcion` | **Rol** | `ROLE_LABELS[rolAfectado] ?? rolAfectado` |

Línea 2, en `--flit-text-secondary`: **el campo** con su etiqueta de negocio, o **la acción** cuando
no hay campo:

| Caso | Línea 2 |
|---|---|
| `campo` presente y `accion` es `editar` | etiqueta de `CAMPO_LABELS` (tabla de abajo) |
| `accion = 'crear'` | **«Usuario creado · {campo}»** / **«Rol creado · {campo}»** — el alta escribe una fila por campo inicial y cada una lo dice |
| `accion = 'borrar'` (`campo = null`) | **«Rol borrado»** (y la celda Cambio queda **«—»**) |
| `accion = 'baja'` | **«Baja»** |
| `accion = 'reactivar'` | **«Reactivación»** |
| `accion = 'activar'` / `'desactivar'` | **«Estado»** |

**`CAMPO_LABELS`** (capa de presentación, fuente única en `shared-types` según §8 del diseño; estos son
los literales que se piden):

| `campo` | Etiqueta | Cómo se pinta el valor |
|---|---|---|
| `role` | **Rol** | `ROLE_LABELS[v] ?? v` |
| `active` | **Estado** | `true` → **Activo**, `false` → **Inactivo** |
| `deleted_at` | **Baja** | no se pinta la marca de tiempo: `null → fecha` se lee **«En alta → Dado de baja»**; `fecha → null` **«Dado de baja → En alta»** |
| `password` | **Contraseña** | **sin celda de valores**: la celda Cambio dice **«Contraseña restablecida»**. Que no haya valor es el diseño, no un hueco |
| `funciones` | **Funciones** | diff de conjunto (abajo) |
| `allowed_pages` | **Páginas** | diff de conjunto, etiquetas de `PAGES` |
| `organismos_codigos` | **Organismos** | diff de conjunto, los códigos tal cual (son los que la lista de usuarios ya enseña en Ámbito) |
| `compania_id` | **Compañía** | **«Compañía #{n}»** |
| `flito_proveedor_soat_id` | **Gestor SOAT** | **«Gestor SOAT {id}»** |
| `transito_codigo` | **Organismo de tránsito** | el código |
| `nombre` (rol) | **Nombre** | texto |
| `descripcion` (rol) | **Descripción** | texto; `null` → **«Sin descripción»** |
| `tipo_enlace` (rol) | **Ámbito** | `ninguno` **No se atan a nada** · `compania` **Una compañía** · `proveedor_soat` **Un gestor SOAT** · `organismos_transito` **Organismos de tránsito** (los literales de `roles-y-permisos-panel.md` §8.5) |
| `tipo_principal` (rol) | **Tipo de acceso** | `interno` **Interno** · `externo` **Externo** |
| `activo` (rol) | **Se puede asignar** | `true` → **Sí**, `false` → **No** |
| `conjunto` (`rol_funcion`, `usuario_funcion`) | **Funciones** | diff de conjunto |

### Cambio — por tipo de valor

**Escalar** (`string | number | boolean | null`): **`{antes} → {después}`** en una línea, con el
`→` en muted y los dos valores en `--flit-text-primary`. `valorAntes === null` (alta) → **«— → {después}»**,
calcando el rótulo «Alta» de `HistorialEstados.tsx:89` pero sin la palabra, porque la línea 2 de Qué
ya dice «creado». Nunca `true`/`false`/`null` a pantalla.

**Conjunto** (`{ conjunto, concedidas?, revocadas? }`): **diff legible, nunca dos JSON.** Un `<ul>`
de hasta tres `<li>`:

```
Añadidas (2): Exportar la cola a Excel · Marcar un impuesto como pagado
Quitadas (1): Anular una solicitud de SOAT
Quedan 12
```

- **«Añadidas (n):»** en `--flit-success`, **«Quitadas (n):»** en `--flit-danger-ink` — y **siempre
  con la palabra**: el color no puede ser el único portador (AGENTS.md §12). Nada de «+»/«−» sueltos.
- Los elementos, separados por « · », con la etiqueta si se conoce y el código en monoespaciada si no
  (§5-3). Orden: el del catálogo si hay etiquetas; alfabético de código si no.
- **«Quedan {conjunto.length}»** en muted, siempre. Es la respuesta a la mutación 1 del diseño (§11):
  la pantalla dice **qué quedó**, no solo que hubo cambio. Si el PO quiere ver la lista completa de
  lo que queda, es un acordeón por fila y se pregunta; no se apila.
- Si `concedidas` y `revocadas` vienen vacías o ausentes (alta con `valorAntes = null`): una sola
  línea **«Asignadas (n): …»** con el `conjunto` entero. Con `n > 12` se cortan a 12 y se cierra con
  **«… y {n − 12} más»** — un alta con las 68 funciones de `admin` no puede ocupar media pantalla.
- Cuando **las dos** listas están vacías y sí hay antes (no debería escribirse, pero es honesto
  contemplarlo): **«Sin cambios en el conjunto»** en muted.

**Motivo** (`motivo !== null`): tercera línea de la celda Cambio, en `--flit-text-secondary`:
**«Motivo: {motivo}»**. Es la confirmación que la #12087 AC3 guarda; se lee junto al cambio que
justifica.

---

## 7. Filtros y paginación

| Filtro | Control | Parámetro | Notas |
|---|---|---|---|
| **Usuario** | `FlitSelect`, opción 0 **«Todos»**, resto `username` | `titularUserId` | fuente §5-2. El `<option>` lleva el `username`; el `userId` solo en `value`. Con la fuente vacía, el select se pinta igual con «Todos» y nada más: no se esconde un control porque hoy esté vacío |
| **Recurso** | `FlitPillGroup` + `FlitPillButton` con `pressed`, como `FlitoBitacora.tsx:53-59` | `entidad` | **Todos** · **Usuarios** (`usuario`) · **Roles** (`rol`) · **Cuadro rol × función** (`rol_funcion`) · **Funciones por usuario** (`usuario_funcion`). El vocabulario es el de la ficha de roles (§Decisión 19) |
| **Desde / Hasta** | dos `<input type="date">` con `<label>` visible, calcando los de `RangoFechaFilter.tsx:50-80` (mismas clases, `max`/`min` cruzados) | `desde`, `hasta` | `hasta` se manda **+1 día** porque el rango es medio abierto `[desde, hasta)` (§7 del diseño): quien pone «hasta el 10» espera ver el 10. **No** se reutiliza `RangoFechaFilter` entero: su título «Rango de ingreso» está cableado (`:20`) y aquí sería falso; cambiarlo es tocar kit |

- Cualquier cambio de filtro → `offset = 0` y nueva petición. Los filtros **no van a la URL**.
- **Paginación**: `Paginacion` con `total`, `page = offset / limite + 1`,
  `totalPaginas = max(1, ceil(total / limite))`, `sustantivo="cambios"`. `limite = 50` fijo: **no se
  copia** el `<input type="number">` «Límite» de la Bitácora — un número que hay que teclear para ver
  más es un paginador peor.
- Un lote partido entre dos páginas se ve como dos filas con la misma hora y el mismo actor en
  páginas distintas. Se acepta (§7 del diseño) y no se dibuja nada para taparlo.

**Qué se reutiliza de `FlitoBitacora.tsx` y qué no:**

| Se reutiliza | No se copia |
|---|---|
| Pills de recurso con `FlitPillGroup` | El `<input>` «Límite» (→ `Paginacion`) |
| `FlitTable` / `FlitTh` / `FlitTr` con `label` | La columna «Detalle» en cursiva con texto libre (→ antes/después estructurado) |
| `StatusChip tone="draft"` para «Sistema» | `text-red-600` en el error (→ `--flit-danger-ink`, Bug #11604) |
| `FlitEmpty` para el vacío | La ausencia de estado de carga y de «Reintentar» (la Bitácora deja la tarjeta en blanco mientras `data === null`) |
| El formateo de fecha (subiendo a `dateStyle: 'medium'`) | El copy del vacío («Cuando se sincronice…»): es de otro dominio |

---

## 8. Permiso y comportamiento por rol

| Rol | Ve | No ve |
|---|---|---|
| `admin` | Cabecera con `Nuevo usuario` **solo en la pestaña Usuarios**; las dos pestañas; historial completo | — |
| `auditor` | Cabecera «Usuarios» / «Historial de cambios en usuarios, roles y permisos»; el historial | Pestañas, `Nuevo usuario`, `UsersToolbar`, `UsersTable`, modales, descarga |
| Resto | Nada: no tienen `users` | — |

Guarda del endpoint: `exigirFuncion('usuarios.auditoria.ver')` (§5-1). Un 403 al cargar el historial
se pinta como estado 2 con el mensaje del servidor — no se disimula como vacío.

**Tratamiento.** Se calca `roles-y-permisos-panel.md` §8.6, que es la del módulo: ayudas y
descripciones **impersonales**; imperativos en **tú** («Amplía el rango de fechas», «quita el
filtro»). Nunca «usted»: es una pantalla interna.

---

## 9. Accesibilidad (AGENTS.md regla 12 — bloqueante)

- **Pestañas** (solo admin): el patrón de `SiigoParametrizacion.tsx:225-258` tal cual —
  `FlitPillGroup role="tablist" label="Secciones de usuarios"`, `role="tab"` con `aria-selected`,
  `tabIndex` itinerante, flechas ←/→ e Inicio/Fin, `aria-controls` **solo** en la activa,
  `role="tabpanel"` con `aria-labelledby`, y el `<h2 tabIndex={-1}>` `sr-only focus:not-sr-only` que
  recibe el foco al cambiar («Historial de cambios» / «Lista de usuarios»).
- **Tabla**: `FlitTable label="Historial de cambios en usuarios, roles y permisos"`; `<th scope="col">`
  en las cuatro cabeceras; **ninguna celda vacía** en una fila con datos (por eso no se agrupa por
  lote dejando huecos). La celda Cambio de un `borrar` lleva el guion «—» acompañado de un
  `<span class="sr-only">Sin valor</span>`: texto, no atributo, para que no haya dos literales que
  mantener.
- **El diff** es un `<ul>` con texto completo en cada `<li>`: «Añadidas (2): …». El color es
  refuerzo; el nombre accesible es la frase.
- **Filtros**: cada control con `<label>` visible (`Usuario`, `Desde`, `Hasta`); el grupo de pills
  con `aria-label="Recurso"` y `aria-pressed` en cada pill (prop `pressed` de `FlitPillButton`).
- **Regiones vivas, una sola**: la línea de `Paginacion` («128 cambios · página 1 de 3») envuelta en
  `role="status"` **montado siempre**. Es lo que le dice a quien filtra sin ver que la tabla cambió.
  Ni las filas ni el suelo temporal son vivas.
- `role="status"` en «Cargando el historial…»; `role="alert"` en el error. No se fuerza el foco al
  botón «Reintentar»: el alert ya se anuncia y mover el foco en cada fallo de red es agresivo.
- **Contraste**: cero tokens nuevos. `--flit-danger-ink` para «Quitadas» y para el error (tinta, no
  superficie); `--flit-success` para «Añadidas» — **verificar 4.5:1 sobre `--flit-bg-card` en claro y
  oscuro** antes de cerrar, porque `--flit-success` hoy se usa en chips con fondo y no como tinta
  sobre tarjeta; si no llega, se usa `--flit-text-primary` y la palabra hace el trabajo.
- **axe** con `QA_AXE_CDN=1`. Ningún `aria-label` lleva datos (ni `username` ni correos).

---

## 10. Lo que NO se hace en esta HU

- No se toca `UsersTable`, `UsersToolbar` ni los tres formularios.
- No se agrupa visualmente por `loteId`, ni se pinta el `loteId`.
- No hay filtro por rol afectado (`rolCodigo`), ni por actor, ni buscador de texto.
- No hay exportación del historial a Excel.
- No hay enlace desde la fila al usuario o al rol (sería meter un id en algún sitio y abrir
  modales de edición desde una pantalla de auditoría).
- No se resuelven nombres de compañía ni de gestor SOAT en cliente.
- No se crea `tieneFuncion` en `lib/auth` (es de la #12170); se deja la condición con nombre.
- No se rediseña `RangoFechaFilter` para que acepte título.
- No se mete `pagina.users` a ningún rol que no sea `auditor`.

---

## 11. Notas para QA (≤ 10, cada una con el mutante)

1. **Cuatro estados**: petición pendiente → fila «Cargando el historial…» con `role="status"`; 500 →
   «No se pudo cargar el historial.» + botón que dispara un **segundo** `GET`; `total: 0` sin filtros →
   vacío A con la fecha de `desdeCuando`; `total: 0` con filtro → vacío B con «Quitar filtros» que deja
   los cuatro filtros en blanco. *Mutante:* un solo texto para vacío y error.
2. **Una fila = un cambio**: una respuesta con 3 items del mismo `loteId` pinta **3** `<tr>` y las
   tres tienen las cuatro celdas con contenido. *Mutante:* agrupar por lote dejando celdas vacías.
3. **El diff dice qué se añadió y qué se quitó, con palabra**: `conjunto` con `concedidas: ['a','b']`,
   `revocadas: ['c']`, `conjunto: 12 códigos` → el DOM contiene «Añadidas (2):», «Quitadas (1):» y
   «Quedan 12». *Mutante:* pintar `JSON.stringify(valorDespues)`, o quitar «Quedan».
4. **`password` no enseña valores**: fila con `campo: 'password'` → texto «Contraseña restablecida» y
   **ningún** «→». *Mutante:* pintar `null → null`.
5. **Sin PII del titular**: con un DTO que (por error) traiga `titular.email`, la pantalla **no lo
   pinta**; el DOM del historial no contiene ningún `@` que no sea del actor. *Mutante:* leer
   `titular.email ?? titular.username`.
6. **Nada en la URL**: cambiar de pestaña, filtrar por usuario, paginar → `location.href` sigue siendo
   exactamente `/users`. *Mutante:* `useSearchParams` para el titular.
7. **Una primaria**: pestaña Usuarios → 1 `GradientButton` («Nuevo usuario»); pestaña Historial → **0**;
   como auditor → **0** y ninguna `tablist`. *Mutante:* dejar el botón en `actions` sin condición.
8. **Auditor sin 403 silenciosos**: entrar como `auditor` → **cero** peticiones a `/users`,
   `/users/resumen`, `/companias`, `/flito/proveedores`, `/organismos` y una a `/users/auditoria`.
   *Mutante:* montar `UsersToolbar` y la lista para todos.
9. **`hasta` inclusivo**: filtrar Hasta = `2026-09-10` → la query lleva `hasta=2026-09-11`. Con
   `TZ=UTC` en el test (memoria: en `-05` un rango sobrevive al mutante). *Mutante:* mandar la fecha tal
   cual y perder el último día.
10. **Cambio de filtro vuelve a la página 1**: en página 3, cambiar Recurso → la petición lleva
    `offset=0` y `Paginacion` dice «página 1». *Mutante:* conservar `offset`.

> El CI solo corre un spec E2E (el visor de PDF). Lo que salga de aquí se añade a la lista fija del
> nocturno y se corre a mano antes de cerrar. Fixtures necesarios: un lote de 3 filas, una fila
> `password`, una `borrar` de rol, una con `origen: 'auditoria'`, y un alta de rol con 20+ funciones
> (para el corte «… y n más»).

---

## 12. Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| 1 | Pestaña dentro de `Users.tsx`, estado en `useState` | Ruta `/users/historial`: slug nuevo, menú nuevo, y la HU dice «dentro del módulo» |
| 2 | La primaria `Nuevo usuario` **solo en la pestaña Usuarios** | Dejarla fija en la cabecera: un gradiente sobre un historial de solo lectura es una primaria sin trabajo |
| 3 | El auditor ve el historial **sin pestañas** | Una `tablist` de una pestaña, o enseñarle la pestaña Usuarios con una lista en 403 |
| 4 | **Cuatro columnas**, acción plegada en «Qué» | Columna «Acción» aparte (la Bitácora la tiene): siete literales no justifican una columna en una tabla cuya cuarta celda ya es ancha |
| 5 | Diff de conjunto con **palabra + conteo + «Quedan n»** | Dos JSON (lo prohíbe el encargo); dos listas completas antes/después (68 códigos × 2 por fila); solo «+»/«−» de color |
| 6 | `dateStyle: 'medium'` | `short` de la Bitácora: año de dos dígitos en una tabla de fechas |
| 7 | Fuente del filtro Usuario = endpoint de titulares (§5-2) | Darle `usuarios.usuario.listar` al auditor: expone nombre, correo y ámbito de todo el censo para alimentar un select |
| 8 | Suelo temporal sin mandar a la Bitácora | La frase del diseño: la Bitácora no enseña cambios de usuarios (`RECURSOS_FLITO`) |
| 9 | Códigos de operación en monoespaciada cuando no hay etiqueta | Inventar etiquetas en cliente (deriva con el catálogo) o esconder el código (mentir por omisión) |
| 10 | Sin agrupación visual por lote | Celdas vacías «heredadas» de la fila anterior: rompen la lectura por celda con lector de pantalla |
| 11 | `limite` fijo en 50 con `Paginacion` | El `<input>` «Límite» de la Bitácora |
| 12 | Sin animación, sombra ni ilustración en el vacío | — |

---

## HANDOFF

```
HANDOFF
  Modo: slim
  Resultado: OK (con 2 requerimientos previos, §5-1 y §5-2)
  Entrega: docs/ux/usuarios-historial.md
  Oficio: primaria única (0 en Historial, «Nuevo usuario» solo en Usuarios) | jerarquía dicha (suelo
          temporal → filtros → tabla de 4 columnas → paginación) | vacío con siguiente paso (dos
          vacíos, error con Reintentar) | sin efectos
  Densidad: sin cambio en la lista; panel nuevo de 4 columnas
  Pantallas: 1 (pestaña) | Requerimientos nuevos de datos: 2 obligatorios + 1 opcional
    - usuarios.auditoria.ver + pagina.users para auditor (§5-1)
    - GET /api/users/auditoria/titulares (§5-2)
    - etiquetas de códigos en la respuesta (§5-3, opcional)
  Siguiente: architecture-agent (§5-1, §5-2) → frontend-agent
```
