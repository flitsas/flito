# Diseño slim — HU #12087 · Usuarios: añadir y QUITAR permisos a un usuario concreto

Feature #12072. Rama `HU/12087-davidchica-permisos-por-usuario` (HEAD 065266e). Modo **slim**: extiende
`users` y `permisos-efectivos` con el patrón que ya fijaron `guardarCuadro` (#12084) y las ataduras de
ámbito (#12053). Sin ADR nuevo. **Una migración sí hace falta** (§5), contra lo previsto en el prompt.

Decisiones del 10/09 que este diseño da por fijas: AC3 (premarcar para conservar solo las excepciones
que siguen teniendo sentido con el rol nuevo); AC7 sobre `permisos_auditoria` (ADR-0014); escritura en
`permisos_usuario_funcion` con `conceder`/`revocar`; §11-1 de la ficha del panel (opción A).

---

## 1. Patrón reutilizado

| Pieza | Vecino que se copia | Qué se toma |
|---|---|---|
| Reemplazo completo del conjunto + validación de códigos ANTES de la tx + auditoría con `diffConjunto` | `apps/api/src/modules/permisos/permisos-roles.service.ts` `guardarCuadro` (:293-319), `funcionesInexistentes` (:113), `conjunto` (:122) | `DELETE` + `INSERT`, `mismoConjunto` → «sin escrituras ni auditoría», `FuncionesInexistentesError` → 400 con la lista |
| Conjunto por usuario en la misma tx que el alta/edición, compuesto en cada respuesta, lectura por lote para el listado | `apps/api/src/modules/users/users.service.ts` `escribirOrganismos` (:159), `organismosDe` (:128), `organismosDeVarios` (:138), `cambiosDelAlta` (:211), `cambiosDeLaEdicion` (:324) | La forma de `UsuarioConAmbito` («siempre array»), el `invalidada` que mantiene el `UPDATE` no vacío (:273-276), el `estadoAuditable` cerrado |
| Invariante anti-bloqueo envolviendo el cuerpo entero, población PRIMERO | `users.service.ts:258-297`, `shared/permisos-anti-bloqueo.ts` `tiene()` (:110-115, ya cuenta `conceder`/`revocar`) | La condición de envoltura crece (§4-6) |
| Fila de auditoría `entidad='usuario_funcion'`, `campo='conjunto'`, conjunto completo + delta | `diseno-hu-12171 §5` (tabla «Qué escribe cada historia», fila #12087), `permisos-roles.service.ts:311-314` | Mismo escritor, misma forma; la excepción lleva su efecto codificado (§4-5) |
| Rejilla por módulo con acordeones, etiquetas de módulo, catálogo y cuadro del rol | `apps/web/src/pages/roles-permisos/modulos.ts` (`etiquetaModulo`, `modulosVisibles`), `components/flit/FlitAcordeon`, `lib/api.ts` `permisosApi.funciones` / `cuadroDelRol` | Se **reutilizan** helpers y cliente; **no** se reutiliza `CuadroRol.tsx` (§4-7) |
| Catálogo cargado una vez en `UsersGestion` y pasado a los dos formularios | `pages/users/UsersGestion.tsx:43-45` (`useCompanias`, `useProveedoresSoat`, `useOrganismosParametrizados`) + `useCatalogo<T>` de `AtaduraFields.tsx` | Un `useCatalogoFunciones()` más, mismo hook genérico |
| Aviso «debe volver a iniciar sesión» al retirar acceso | `EditUserForm.tsx:98-105` (`COMPANIA_RELOGIN`, `PROVEEDOR_RELOGIN`, `ORGANISMOS_RELOGIN`) | Un literal más, calculado en el cliente con la misma regla que el servidor |

---

## 2. Contrato delta

```
POST  /api/users            body + funciones?: { codigo: string; efecto: 'conceder'|'revocar' }[]   (máx 1000)
PATCH /api/users/:id        body + funciones?: idem. Presente = REEMPLAZO COMPLETO del conjunto del usuario
                            ([] = quitar todas las excepciones). Ausente = no tocar.
                            allowedPages: se RETIRA de los dos esquemas Zod → se descarta como cualquier
                            clave desconocida (los esquemas no son .strict()) + log.warn si venía en el body.
400  funciones: código inexistente → { error: 'Funciones inexistentes', funciones: [...] } sin escribir nada
400  funciones: mismo código con dos efectos → { error: 'Datos inválidos', details… } (Zod superRefine)
409  BloqueoAdministracionError (un revocar/retiro que deja 0 administradores) — como hoy en PATCH
GET  /api/users             cada fila + funciones: { codigo, efecto }[]   (siempre array; una consulta por página)
POST/PATCH/toggle response  UsuarioConAmbito + funciones (compuesto, como organismosCodigos)
GET  /api/auth/me, /login   sin cambio de forma: allowedPages = paginasEfectivasDeUsuario (ya resuelto)
```

`shared-types` (`packages/shared-types/src/permisos-roles.ts`, sin fichero nuevo):

```ts
export const EFECTOS_PERMISO_USUARIO = ['conceder', 'revocar'] as const;
export type EfectoPermisoUsuario = (typeof EFECTOS_PERMISO_USUARIO)[number];
/** Una excepción por usuario sobre lo que da su rol. PK real: (user_id, funcion_codigo). */
export interface FuncionDeUsuario { codigo: string; efecto: EfectoPermisoUsuario }
```

`packages/shared-types/src/permisos-auditoria.ts` (la forma del conjunto auditado, §4-5):

```ts
/** `conceder:soat.cola.exportar` / `revocar:pagina.users` — cómo viaja una excepción dentro de `conjunto`. */
export function codificarExcepcion(f: FuncionDeUsuario): string
export function decodificarExcepcion(s: string): FuncionDeUsuario | null
```

---

## 3. Modelo de datos

- `permisos_usuario_funcion` (0179): sin cambio. PK `(user_id, funcion_codigo)` + CHECK de `efecto` son la
  tercera capa; la primera es Zod, la segunda `funcionesInexistentes`.
- `users.allowed_pages`: **no se borra, no se escribe más, no se lee para decidir**. En `schema.ts:85` el
  comentario JSDoc pasa a decir «OBSOLETA desde la HU #12087: congelada en la foto de la 0188; la fuente
  de las páginas por usuario es `permisos_usuario_funcion`». (Comentario ⇒ no cuenta para el techo 3400.)
- `permisos_auditoria`: sin cambio. `entidad='usuario_funcion'` y `campo='conjunto'` ya están en la lista
  blanca y en los CHECK de la 0185; `sujetoChk` se cumple con `usuarioAfectado` y sin `rolAfectadoCodigo`.

---

## 4. Decisiones (una por pregunta del encargo)

### 4-1 · Contrato y DTO

- `funciones` en `POST` y `PATCH` como está en §2. Reemplazo completo, ausencia = no tocar: es exactamente
  la semántica de `organismosCodigos` (`users.routes.ts:562-616`) y de `PUT …/roles/:codigo/funciones`.
- `allowedPages` **sale de los esquemas Zod** (`allowedPagesSchema` :241 se borra). No se responde 400 (AC6:
  obsoleto, no roto) ni se «traduce» a `conceder pagina.*` (en un PATCH la traducción pisaría las
  excepciones `operacion.*` del usuario, que el cliente viejo no conoce). Con los dos en el body gana
  `funciones` y `allowedPages` se descarta; `log.warn('allowedPages obsoleto en el body')` para verlo.
  El único cliente es la SPA y deja de mandarlo en esta misma HU.
- El listado `GET /api/users` devuelve `funciones` por fila (`funcionesDeVarios(ids)` con `inArray`, una
  consulta por página, espejo de `organismosDeVarios`). No se crea `GET /api/users/:id`: no existe hoy y
  el formulario de edición ya se abre desde la fila cargada. `allowedPages` sigue saliendo en la fila
  (columna congelada) y la SPA deja de leerlo; `types.ts` lo marca `/** @deprecated */`.
- `CrearUsuarioInput.allowedPages` → `funciones: FuncionDeUsuario[]`; `ActualizarUsuarioInput` gana
  `funcionesDestino: FuncionDeUsuario[] | null`.

### 4-2 · «Lo que trae el rol» y los tres estados

Fuentes: catálogo `GET /api/permisos/funciones` (una vez, en `UsersGestion`) y cuadro
`GET /api/permisos/roles/:codigo/funciones` **por rol elegido** (caché por código en el picker, como
`RolesPermisos.tsx:58`). `ROLE_DEFAULT_PAGES` deja de usarse en el picker (AC5): lo que trae el rol es lo
que el administrador marcó en el panel, no una tabla compilada.

Estado por casilla, con `enRol = cuadro.has(codigo)` y `exc = excepciones.get(codigo)`:

| Estado | Condición | Casilla | Etiqueta de texto |
|---|---|---|---|
| `rol` | `enRol && !exc` | marcada | «Lo trae el rol» |
| `quitado` | `enRol && exc === 'revocar'` | desmarcada | «Quitado» |
| `anadido` | `!enRol && exc === 'conceder'` | marcada | «Añadido» |
| `no` | `!enRol && !exc` | desmarcada | — |
| `sin_efecto` | `enRol && exc === 'conceder'` · `!enRol && exc === 'revocar'` | marcada · desmarcada | «Sin efecto» |

`sin_efecto` existe porque el cuadro del rol se edita aparte (#12085) y una excepción puede quedar
redundante sin que nadie cambie de rol; no se limpia en silencio (AC3), se muestra.

Transición al clic — **una sola regla** que cubre los cinco estados:
`deseado = !marcada; excepción = (deseado === enRol) ? ninguna : (deseado ? 'conceder' : 'revocar')`.
Es decir: `rol → quitado`, `quitado → rol`, `no → anadido`, `anadido → no`, `sin_efecto` → el estado
coherente con el clic. Ninguna casilla es `disabled` (AC4). «Quitar adicionales» se conserva con su
semántica literal: borra las excepciones `conceder`; las `revocar` se reponen casilla a casilla.

### 4-3 · AC3, cambio de rol con excepciones

Paso de confirmación **en Guardar, no al cambiar el `<select>`** (cambiar dos veces el rol para mirar no
debe abrir dos modales). En `EditUserForm.submit`, si `f.role !== user.role` **y** el conjunto de
excepciones en edición no está vacío, se abre `CambioRolExcepciones` (modal `FlitModal`) con una fila por
excepción, cada una con una casilla «Conservar» premarcada según la regla del 10/09 contra el cuadro del
rol NUEVO (ya cargado por el picker):

- `revocar X` y el rol nuevo SÍ da X → conservar (premarcada)
- `conceder X` y el rol nuevo NO da X → conservar (premarcada)
- el resto («deja de tener sentido») → retirar (desmarcada), con la etiqueta «Sin efecto con el rol nuevo»

El administrador cambia lo que quiera; «Confirmar» fija `body.funciones` = las conservadas y lanza el
PATCH. **Con `body.role` presente, `funciones` viaja siempre** (aunque no cambie): «lo que guarda es lo
que queda» tiene que ser explícito en la petición. En el alta no hay modal: cambiar el rol antes de
guardar vacía las excepciones (no hay nada guardado que arrastrar).

Cómo queda **registrada** la decisión, con lo mínimo que la hace consultable (ADR-0014):

1. La fila `usuario`/`role` del lote (ya existe) lleva `motivo = 'excepciones revisadas: N conservadas,
   M retiradas'`, calculado en `cambiosDeLaEdicion` cuando `updates.role` y `funcionesDestino` vienen
   juntos. Así «conservar todo» también deja rastro (sin ese `motivo` sería un silencio indistinguible).
2. Si el conjunto cambió, la fila `usuario_funcion`/`conjunto` del mismo lote lleva `motivo =
   'cambio_de_rol'` (constante, filtrable). Es lo que diseno-hu-12171 §5 dejó previsto para esta HU.

No hay campo nuevo en el body ni en la tabla: el `motivo` ya existe (`permisos_auditoria.motivo`).

### 4-4 · AC5 y el menú del SPA

Medido contra `packages/shared-types/src/permissions.ts`:

- Los **dos atajos de `admin` ya no existen**: `DEFAULTS_POR_ROL` es `Record<Exclude<UserRole,'admin'>,…>`
  (:262) y `getEffectivePages` es solo `paginasPorDefecto(role) ∪ allowedPages` (:397-401); los retiró la
  #12081. Lo que queda de AC5 es el cartel «Acceso total» de `PermissionsPicker.tsx:16-23` y el uso de
  `ROLE_DEFAULT_PAGES` en `:13`, que se van con la reescritura del picker.
- Lo que SÍ está roto y esta HU corrige: la SPA vuelve a **unir** los defaults compilados con lo que el
  servidor ya resolvió (`apps/web/src/lib/permissions.ts:26-30` → `getEffectivePages`, y
  `lib/ayudaFlito.ts:30`). Desde la #12085 un admin puede desmarcar `pagina.users` del cuadro de `auditor`
  y el auditor sigue viendo «Usuarios» en el menú porque `DEFAULTS_POR_ROL.auditor` la trae; con esta HU,
  `revocar pagina.X` (AC2) tendría el mismo agujero. Es la «segunda definición de quién puede» que la
  #12082 eliminó del servidor y sobrevivió en el navegador.
- **Decisión:** `effectivePages(user)` devuelve **exactamente** `user.allowedPages` (filtrado por
  `isValidPage`), sin unión; `ayudaFlito.ts` igual (`allowedPages.includes`, sin import de
  `getEffectivePages`, con lo que el ciclo que su comentario evita sigue evitado). **`getEffectivePages`
  en shared-types no cambia**: es el oráculo de catálogo en tiempo de compilación que usan
  `catalogo.ts:92` (seed) y ~30 tests; su JSDoc gana una línea: «la SPA ya no la llama».
- Riesgo medido: nulo para tokens vivos. `/me` (`auth.routes.ts:161`) y el sobre de `/login` (:105) traen
  la lista resuelta por `paginasEfectivasDeUsuario` desde la #12082, y `/me` se llama al cargar; R ya
  contiene los defaults sembrados por la 0179. Para todo usuario de hoy el conjunto es idéntico; solo
  desaparece del menú lo que el administrador quitó, que es lo que se pide.
- Coste real: **20 fixtures e2e** en 10 ficheros llevan `allowedPages: []` «porque sus páginas salen de
  los defaults del rol» (`e2e/helpers/auth.ts:61,81,92,102`, `laft-fixtures`, `privacy-fixtures`,
  `ayuda-fixtures`, y 6 specs). Se arregla en **un sitio**: `loginAs` (`e2e/helpers/auth.ts`) sirve
  `/api/auth/me` con `allowedPages = ∪(paginasPorDefecto(user.role), user.allowedPages)`, que es lo que el
  servidor responde de verdad (R sembrada ∪ C). Se exporta `sobreDeMe(user)` para los 3 specs que mockean
  `/me` a mano (`auth.spec.ts:28,64`, `flito-conciliacion.spec.ts:973`). Es lo contrario del `['*']` de
  la memoria: el fixture reproduce la regla del servidor con el mismo catálogo que siembra R.

### 4-5 · AC7, forma exacta de las filas

Una fila por acto, `entidad='usuario_funcion'`, `campo='conjunto'`, `usuarioAfectado={id, rol}`, escrita
con el `diffConjunto` existente sobre las excepciones **codificadas** `<efecto>:<codigo>`:

```json
valor_antes:   { "conjunto": ["conceder:pagina.rndc", "conceder:soat.cola.exportar"] }
valor_despues: { "conjunto": ["conceder:pagina.rndc", "revocar:pagina.users"],
                 "concedidas": ["revocar:pagina.users"],
                 "revocadas":  ["conceder:soat.cola.exportar"] }
```

Por qué así y no otra forma: `ValorAuditable` no se abre (ADR-0014 §2), `diffConjunto` y el escritor no
cambian, y un cambio de efecto sobre el mismo código sale como un retiro + un alta, que es lo que ocurrió.
`concedidas`/`revocadas` significan aquí «excepciones que entraron / salieron»; la pantalla lo dice con
palabras (§6 frontend: «Excepciones nuevas (n)» / «Excepciones retiradas (n)») y decodifica cada elemento
a «Añadido · Nombre» / «Quitado · Nombre» con `decodificarExcepcion`. En SQL sigue siendo consultable:
`valor_despues->'concedidas' ? 'revocar:pagina.users'`.

Alta: `accion='crear'`, `valorAntes=null`, `valorDespues=diffConjunto([], codificadas).despues`, solo si
hay excepciones (espejo de `crearRol:177-179`). La fila `allowed_pages` de `cambiosDelAlta:217` se retira.

Invalidaciones: `invalidarPermisosDe(id)` ya se llama tras el commit en POST/PATCH/toggle; no cambia.
`sessionInvalidatedAt` **solo si se retira acceso**: `retiraAcceso(diff) = diff.revocadas ∋ 'conceder:*'
|| diff.concedidas ∋ 'revocar:*'`. Conceder o levantar un `revocar` no tira la sesión (los permisos se
resuelven por petición; el JWT no los lleva). Se suma a `invalidada` en `actualizarUsuario`, como
`organismosCambiaron` (:273). La SPA calcula el mismo predicado sobre lo que mandó y muestra
`FUNCIONES_RELOGIN` (mismo patrón que `COMPANIA_RELOGIN`).

### 4-6 · Anti-bloqueo

**Sí**: `actualizarUsuario` envuelve con `conSeguroAntiBloqueo` cuando `updates.role !== undefined ||
funcionesDestino !== null` (hoy :297 solo mira el rol). `tiene()` ya cuenta `revocar` y `conceder`, así
que un `revocar permisos.cuadro.guardar` sobre el último administrador, o retirar el `conceder
usuarios.usuario.editar` al único titular de un rol no-admin, dejan la cuenta en cero → 409 con el mensaje
de siempre. Afinar a «solo si hay un revocar de las dos funciones de administración» ahorra dos `select`
y pierde el segundo caso; no compensa. El alta (`crearUsuario`) no se envuelve: nunca reduce la población.
El pre-check de «último admin» de la ruta (:499-503) queda como está.

### 4-7 · Alcance FRONTEND

`PermissionsPicker.tsx` se **reescribe por su cuenta** (es lo que la #12175 dejó preparado: «la superficie
que la #12087 reescribe entera»). No se extrae `Casilla` de `CuadroRol.tsx`: aquella es binaria y va
atada a la cabecera, la barra sticky y los avisos de canal del panel; ésta tiene cinco estados y etiqueta
de texto. Lo que se comparte de verdad ya es compartible: `FlitAcordeon`, `etiquetaModulo`,
`modulosVisibles`, `permisosApi`. Presupuesto (sloc, techo 800): `PermissionsPicker` ≈ 230,
`CambioRolExcepciones.tsx` (nuevo) ≈ 110, `EditUserForm` 138 → ≈ 185, `CreateUserForm` +10,
`UsersGestion` 215 → ≈ 225, `HistorialPermisos` 342 → ≈ 360. `Users.tsx` no se toca.

Estados del picker: `cargando` (catálogo o cuadro), `error` con «Reintentar» (un 403 en
`permisos.catalogo.ver`/`permisos.cuadro.ver` —hoy solo `admin` las tiene, 0186— no rompe el formulario:
se guarda sin tocar `funciones`), `listo`. Para `admin` el cuadro trae las 68 → todo «Lo trae el rol»,
sin cartel (CF-13). Copy de la ayuda al pie: «Las funciones marcadas como "Lo trae el rol" vienen con el
rol. Desmárcalas para quitárselas solo a este usuario, o marca otras para añadírselas».

### 4-8 · Tests P1 y los dos mutantes del AC8

API (vitest, mocks):
- `users.routes.test.ts`: (a) `POST` con `funciones` → `insert(permisosUsuarioFuncion)` dentro de la tx y
  fila `usuario_funcion/conjunto/crear`; (b) código inexistente → 400 con la lista y **cero** `insert`;
  (c) **mutante AC1**: `[{x,conceder},{x,revocar}]` → 400 — quitar el `superRefine` deja pasar el body y el
  `insert` mockeado no lanza ⇒ 201 ⇒ rojo; (d) `PATCH` con `funciones` = delete + insert, sin `funciones`
  = ni un `delete`; (e) `revocar` nuevo → `sessionInvalidatedAt` en el `set`; solo `conceder` nuevo → no;
  (f) `PATCH` solo con `funciones` pasa por el lock `for('update', {of: users})` (leer el SQL renderizado:
  el mock ignora `orderBy`); (g) `role` + `funciones` → `motivo` en las dos filas; (h) `allowedPages` en
  el body → ni `update.set.allowedPages` ni `insert`, y `log.warn`.
- `permisos-resolutor.test.ts` + `permisos-efectivos.test.ts`: reescribir (c) :148, :118, :163, :200 —
  `conceder pagina.*` de la tabla **cuenta**, `users` se lee sin `allowed_pages`; **mutante AC2**: quitar
  el bucle de `revocar` de `conjuntoEfectivo` → :82/:187 y el nuevo caso «`revocar pagina.fleet` contra
  `pagina.fleet` del rol → no está en `paginasEfectivasDeUsuario`» en rojo. Comprobar con `git diff` dónde
  cayó el mutante antes de leer el test (memoria).
- `permisos-anti-bloqueo.test.ts`: un caso más — usuario con `revocar permisos.cuadro.guardar` no cuenta.
- `__tests__/db/migracion-0188.test.ts` (estático, como la 0187): sin control de tx, `DELETE` acotado a
  `efecto = 'conceder' AND funcion_codigo LIKE 'pagina.%'`, `INSERT … ON CONFLICT DO NOTHING`, `COMMENT ON
  COLUMN users.allowed_pages`, bloque `DO $resumen0188$`. **No** asertar «es la última».
- `packages/shared-types/__tests__/permisos-usuario.test.ts`: `codificarExcepcion`/`decodificarExcepcion`
  ida y vuelta y `null` ante un prefijo desconocido.

Web (Playwright, mocks):
- `e2e/tests/users-permisos.spec.ts` (**nuevo, entra en `test:e2e:smoke`**): tres etiquetas visibles por
  texto; desmarcar «Lo trae el rol» manda `funciones: [{codigo, efecto:'revocar'}]`; marcar una no del rol
  manda `conceder`; `admin` sin «Acceso total» y con casillas marcadas; cambio de rol con excepciones abre
  el modal con el premarcado de la regla y el PATCH lleva las conservadas; toast de re-login al quitar.
- `users.spec.ts:60-90` («conserva/añade allowedPages») se reescribe a `funciones`.
- `users-ambito.spec.ts` (está en el smoke): añadir los mocks de `/api/permisos/funciones` y
  `/api/permisos/roles/*/funciones` a su `beforeEach`; sin ellos el picker queda en `error` y el aserto
  de `:607` sigue verde pero el formulario cambia de forma.
- `users-historial.spec.ts`: una fila `usuario_funcion` se lee como «Excepciones nuevas (1): Quitado ·
  Usuarios».

Gates AC8: `npm run test -w apps/api`, `-w apps/web`, `typecheck`, `build` (NODE_OPTIONS heap 8 GB,
memoria) y `npx eslint` sobre cada archivo tocado de `pages/users/` leyendo el número.

---

## 5. Migración — sí hace falta: `0188_permisos_usuario_paginas_resync.sql`

La 0179 (paso 5, :911-936) copió `allowed_pages` a la tabla **una vez** y dejó escrito que «el alta y la
edición siguen escribiendo `users.allowed_pages`» hasta esta HU. Desde su despliegue, todo usuario creado
o editado tiene la columna distinta de la tabla. Si el resolutor pasa a leer la tabla (AC6) sin
re-sincronizarla, esos usuarios pierden o ganan páginas el día del deploy — justo lo que AC6 prohíbe.

Contenido, idempotente y solo datos (sin `CREATE`/`ALTER`):
1. `DELETE FROM permisos_usuario_funcion uf WHERE uf.efecto = 'conceder' AND uf.funcion_codigo LIKE
   'pagina.%' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uf.user_id AND
   substr(uf.funcion_codigo, 8) = ANY (u.allowed_pages))` — las páginas que el admin quitó después de la
   0179. Las filas `revocar` y las `operacion.*` no se tocan.
2. El mismo `INSERT … SELECT DISTINCT … ON CONFLICT DO NOTHING` de la 0179 paso 5 (las páginas añadidas
   después).
3. `COMMENT ON COLUMN users.allowed_pages IS 'OBSOLETA (HU #12087): congelada; la fuente es
   permisos_usuario_funcion'` — el AC pide el aviso en `schema.ts` (se pone); el `COMMENT` es una línea
   y es lo que ve quien abre `psql`, como hizo la 0179 con la tabla.
4. `DO $resumen0188$` con los conteos (borradas, insertadas, total `conceder pagina.*`) → NOTICE en el CD.

Ventana: el CD aplica la migración y luego despliega el API (memoria); entre ambos el API viejo aún
escribe la columna durante segundos. Aceptado: un PATCH en esa ventana se vería en el historial y se
corrige editando al usuario. `db:apply` local exige superusuario y el rol `operaciones_app` (memoria);
no usa `unaccent`. Sin índice nuevo: la PK sirve las dos consultas por `user_id`.

---

## 6. Archivos a crear/modificar

**Backend (backend-agent)**
- `apps/api/src/db/migrations/0188_permisos_usuario_paginas_resync.sql` — nuevo (§5).
- `apps/api/__tests__/db/migracion-0188.test.ts` — nuevo, estático.
- `apps/api/src/db/schema.ts:85` — JSDoc de obsolescencia en `allowedPages` (solo comentario).
- `apps/api/src/shared/permisos-efectivos.ts` — `FilasPermisos` pierde `allowedPages`;
  `leerFilasDePermisos` deja de pedir la columna (:100-108); `conjuntoEfectivo` (:159-176): C = todas las
  filas `conceder` de la tabla (páginas pasan por `esPaginaViva`), sin bucle de `allowedPages`; cabecera
  :14-19 reescrita.
- `apps/api/__tests__/helpers/auth.ts:120` — `opts.allowedPages` se convierte en
  `excepciones: [{codigo:'pagina.'+slug, efecto:'conceder'}]`; la firma de `testToken` no cambia (los ~16
  ficheros que la usan no se tocan).
- `apps/api/src/modules/users/users.service.ts` — `funcionesDe`, `funcionesDeVarios`,
  `escribirFunciones` (delete + insert), `conjuntoDeFunciones` (pliega duplicados, orden estable),
  `retiraAcceso`; `CrearUsuarioInput.funciones`; `ActualizarUsuarioInput.funcionesDestino`; envoltura
  anti-bloqueo (:297) por rol **o** funciones; `cambiosDelAlta`/`cambiosDeLaEdicion` con la fila
  `usuario_funcion` y los dos `motivo` de §4-3; `UsuarioConAmbito.funciones`; `cambiarActivo` compone
  `funciones` como `organismosCodigos` (:381). Importa `funcionesInexistentes` y
  `FuncionesInexistentesError` de `../permisos/permisos-roles.service.js` (dependencia en un solo sentido;
  93 imports entre módulos hermanos en `src/modules` lo preceden).
- `apps/api/src/modules/users/users.routes.ts` — `funcionesSchema` (array ≤1000, `superRefine` sin
  código repetido, pliega duplicados con el mismo efecto); `createSchema`/`updateSchema` cambian
  `allowedPages` por `funciones`; `allowedPagesSchema` (:241) se borra; `log.warn` si el body traía
  `allowedPages`; `funcionesInexistentes` antes de escribir en POST y PATCH → 400 con la lista;
  `invalidarPorCampos` (:625) deja de mirar `allowedPages` (lo decide el servicio con `retiraAcceso`);
  el listado compone `funciones` (:385-390); `FuncionesInexistentesError` → 400 en el `catch` de ambos.
- `apps/api/src/modules/auth/auth.routes.ts:141` — `/me` deja de seleccionar `allowedPages` (se pisaba en
  :161; limpieza de una línea, opcional).
- `apps/api/__tests__/services/users.routes.test.ts`, `permisos-resolutor.test.ts`,
  `permisos-efectivos.test.ts`, `permisos-anti-bloqueo.test.ts` — §4-8.

**shared-types (backend-agent, primero: lo consumen los dos lados)**
- `packages/shared-types/src/permisos-roles.ts` — `EFECTOS_PERMISO_USUARIO`, `FuncionDeUsuario`.
- `packages/shared-types/src/permisos-auditoria.ts` — `codificarExcepcion`, `decodificarExcepcion`.
- `packages/shared-types/src/permissions.ts:380-396` — solo JSDoc: «la SPA ya no une; `effectivePages`
  del web devuelve lo que trae `/me`».
- `packages/shared-types/__tests__/permisos-usuario.test.ts` — nuevo.

**Frontend (frontend-agent)**
- `apps/web/src/pages/users/PermissionsPicker.tsx` — reescritura: props `{ role, cuadros, catalogo,
  excepciones: Map<string, EfectoPermisoUsuario>, onChange }`; acordeones por módulo; cinco estados de
  §4-2; sin cartel; sin `ROLE_DEFAULT_PAGES`; «Quitar adicionales»; estados cargando/error/listo.
- `apps/web/src/pages/users/CambioRolExcepciones.tsx` — nuevo: el modal de §4-3.
- `apps/web/src/pages/users/EditUserForm.tsx` — `extraPages` → `excepciones` (init de `user.funciones`);
  `body.funciones` cuando el conjunto cambia o cuando `body.role` va; modal antes del PATCH;
  `FUNCIONES_RELOGIN` con `retiraAcceso` (mismo predicado que el servidor, sobre lo que manda).
- `apps/web/src/pages/users/CreateUserForm.tsx` — ídem sin modal; cambiar el rol vacía excepciones;
  `body.funciones` solo si no está vacío.
- `apps/web/src/pages/users/UsersGestion.tsx` — `useCatalogoFunciones()` (sobre `useCatalogo` de
  `AtaduraFields.tsx` o `permisosApi.funciones`) y prop a los dos formularios.
- `apps/web/src/pages/users/types.ts` — `User.funciones: FuncionDeUsuario[]` (siempre array, invariante
  como `organismosCodigos`); `allowedPages` marcado `@deprecated`.
- `apps/web/src/pages/users/HistorialPermisos.tsx:342-438` — `Conjunto`/`Codigo` reciben `entidad`; para
  `usuario_funcion` decodifican y rotulan «Excepciones nuevas / retiradas».
- `apps/web/src/lib/permissions.ts:26-30` — `effectivePages` = `allowedPages` filtrado por `isValidPage`,
  sin `getEffectivePages`; `ROLE_DEFAULT_PAGES` deja de re-exportarse si nadie más lo importa.
- `apps/web/src/lib/ayudaFlito.ts:30` — `allowedPages.includes(entrada.permiso)`.
- `apps/web/src/lib/api.ts` — `permisosApi` sin cambios; el comentario de `:511` («los tipos de
  `/funciones` no los exporta shared-types») sigue siendo cierto.
- `apps/web/e2e/helpers/auth.ts` — `loginAs` sirve `/me` con la unión de §4-4; `sobreDeMe` exportado.
- `apps/web/e2e/tests/auth.spec.ts:28,64`, `flito-conciliacion.spec.ts:973` — usar `sobreDeMe`.
- `apps/web/e2e/tests/users-permisos.spec.ts` — nuevo; `apps/web/package.json` `test:e2e:smoke` lo lista.
- `apps/web/e2e/tests/users.spec.ts`, `users-ambito.spec.ts`, `users-historial.spec.ts` — §4-8.

**No se toca:** `permisos-roles.service.ts`, `permisos.routes.ts`, `permisos-anti-bloqueo.ts`,
`permisos-auditoria.ts` (escritor), `CuadroRol.tsx`, `RolesPermisos.tsx`, `Users.tsx`,
`getEffectivePages` (cuerpo), `ROLE_DEFAULT_PAGES`, `catalogo.ts`.

---

## 7. ADR: no aplica

Sin tabla, sin contrato de integración externa, sin patrón nuevo: el conjunto por usuario copia el del
rol (#12084) y la auditoría usa la forma que ADR-0014 §3 fijó y que diseno-hu-12171 §5 ya asignó a esta
HU. La codificación `<efecto>:<codigo>` y la retirada de la unión en el navegador quedan documentadas en
este archivo y en las cabeceras de `permisos-efectivos.ts` y `lib/permissions.ts`. ADR-0015 §Decisión 4
ya fue corregida por la #12081; nada aquí la contradice.

---

## 8. Notas operativas

**backend-agent**
- Orden: shared-types → migración + test estático → resolutor + helper de pruebas → servicio → ruta →
  tests. El resolutor cambia de fuente y el helper de `testToken` tiene que cambiar en el mismo commit o
  ~16 ficheros pierden las páginas de sus usuarios de prueba.
- `funcionesInexistentes` va **antes** de `db.transaction` (como `guardarCuadro:295`): un 400 no abre tx.
- El `DELETE` de `escribirFunciones` va con `eq(userId)` y después el `INSERT` completo; no hace falta
  el `notInArray` de `escribirOrganismos` porque aquí el efecto puede cambiar sobre la misma PK.
- Sin `try/catch` alrededor del historial (ADR-0014). El `23505` de la PK no debería llegar (Zod lo
  corta); si llega, es 500 y es un bug de validación, no un 409.
- Rebase antes del PR: `origin/develop` ya tiene el merge de #323 (HU #12085), la rama no está apilada
  de verdad. Y `git diff` antes de leer el test cuando un mutante sobreviva (memoria).

**frontend-agent**
- El picker no decide nada: `hasPage`/`ProtectedRoute` siguen leyendo `/me`; el servidor responde 403 si
  el menú se queda viejo (60 s de caché + `invalidarPermisosDe` tras el commit).
- Etiquetas por **texto** (AC4), no solo color; `sr-only` con el estado en la casilla como hace
  `CuadroRol.Casilla` («· rol {nombre}»); código técnico solo en `data-codigo`.
- `users-ambito.spec.ts` corre en el smoke del CI: añadir sus mocks es parte de la HU, no un extra.
- Tras tocar `loginAs`, correr en local las suites que usan fixtures no-admin (grep `allowedPages: []`
  en `e2e/`): el nocturno es donde se ven y llega tarde.

**Riesgos abiertos**
1. La ventana migración→deploy de §5 (segundos) — aceptado.
2. `permisos.catalogo.ver`/`permisos.cuadro.ver` son solo de `admin` (0186): si un día otro rol recibe
   `usuarios.usuario.editar` sin ellas, verá el picker en `error` y guardará sin tocar permisos. Se
   declara; sembrarlas a quien edite usuarios es otra decisión.
3. Un `sin_efecto` que nadie limpie no daña (el resolutor lo ignora), pero ensucia el historial de quien
   lo mire; el modal de AC3 lo limpia al cambiar de rol y la casilla lo limpia al clic.
