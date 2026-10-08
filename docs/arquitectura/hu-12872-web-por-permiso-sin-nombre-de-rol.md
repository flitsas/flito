# Diseño slim — HU #12872 · Menú, tablero y pantallas por permiso, sin nombre de rol

> Feature #13414 · Épica #13411 · FRONTEND · Rama `HU/12872-davidchica-menu-pantallas-por-permiso-sin-rol`
> (desde `develop` 8f0d8b85). Marco: ADR-0022 y decisión del PO de la Épica: el acceso lo gobiernan
> solo páginas + funciones configurables; el nombre/código del rol nunca decide en el código.
> Estado: **Propuesto** (diseño, no ADR). Habla con `apps/web` (shell + páginas FLITO y legacy);
> no toca `apps/api` salvo lectura del catálogo. Medido en el worktree `flito-hu12872`, tip `8f0d8b85`.

## Patrón reutilizado

- **Fuente de páginas:** `effectivePages` / `hasPage` de `apps/web/src/lib/permissions.ts` sobre
  `user.allowedPages` de `GET /auth/me` (ya resuelto en servidor).
- **Fuente de funciones:** `AuthProvider` (`apps/web/src/lib/auth.tsx`) carga `GET /permisos/mios`
  y expone `funciones` + `hasFuncion(codigo)` (fail-closed mientras `null`, HU #12170).
  Precedente de uso por función en lugar de rol: `pages/FlitoSoat.tsx:52-74`,
  `pages/TramiteTraspaso.tsx:211`, `pages/TransitoBandeja.tsx:69`, `pages/SiigoOperacion.tsx:206`.
- **Refresco manual existente:** `refrescarFunciones` (lo usa `pages/RolesPermisos.tsx:188`).
- **Gate estático sin dependencias:** `scripts/scan-rules-of-hooks.mjs` (AST con el `typescript`
  ya instalado, script `check:hooks`, paso en el job `build + test` de `ci.yml`). Lista declarada
  + ratchet: patrón del test backend de la HU #13425 (`PENDIENTES_12871`, `toEqual`).
- **E2E:** `apps/web/e2e/helpers/auth.ts` (`loginAs`, `FUNCIONES_POR_ROL`, `sobreDeMe`, `sobreDeMios`).

## 1. Fuente única en el cliente

Decisión: **una sola foto de sesión en `AuthProvider`**, compuesta por las dos respuestas que ya
existen (sin contrato nuevo):

| Dato | Endpoint | Campo en contexto |
|---|---|---|
| Páginas | `/auth/me` → `allowedPages` | `user.allowedPages` → `hasPage` |
| Funciones | `/permisos/mios` → `funciones` | `funciones` → `hasFuncion` |
| Tipo de principal | `/permisos/mios` → `tipoPrincipal` | **nuevo** `tipoPrincipal: 'interno' \| 'externo' \| null` |
| Canal SOAT | `/auth/me` → `puedeSolicitarSoat` | `user.puedeSolicitarSoat` (sin cambio) |

- No se migra `hasFuncion` a `user.funciones` de `/me` (HU #13425) en esta HU: la fuente `/mios`
  ya está probada (fail-closed, e2e con `funciones: null`) y cambiarla rompe specs sin ganancia.
  Ambos salen de `resolverPermisos` (misma caché). Nota para el Feature: unificar en una sola
  petición es deuda menor, no bloqueo.
- `tipoPrincipal` se expone porque `ayudaFlito.ts` necesita «es externo» sin mirar el rol
  (`'cliente'`). Comparar `tipoPrincipal` **no** es comparar nombre de rol: es la frontera
  interno/externo que David mantiene hasta F2.

### NavItem: `roles` → `funcion`

```ts
interface NavItem { page: PageSlug; …; funcion?: string | readonly string[] /* basta una (OR) */ }
navItemPermitido(it, user, allowed, funciones: readonly string[] | null): boolean
  // flito_ayuda → puedeVerAyudaFlito(user, tipoPrincipal); resto:
  // allowed.has(it.page) && (!it.funcion || algunaDe(funciones, it.funcion))
```

- Se **elimina** el campo `roles` del tipo (el compilador marca cualquier resto).
- `useNavSections`, `CommandPalette` (consume `useNavSections`/`navItemPermitido`) y
  `rutaInicio(user, funciones)` pasan `funciones` del contexto. Llamadores de `rutaInicio`:
  `App.tsx` (`InicioGate`) y `components/NoAccess.tsx`.
- Mientras `funciones === null` los ítems con `funcion` no salen (fail-closed). No hay parpadeo:
  `loading` no baja hasta que `/mios` responde (`auth.tsx`, `then(async … await cargarMios())`).

| Ítem | Hoy | Pasa a |
|---|---|---|
| `flito_soat` | `roles: ['proveedor','admin','cliente']` | `funcion: ['soat.cola.ver', 'soat.solicitud.crear']` (AC1: «Ver listado» = `soat.cola.ver`; el Cliente entra por `solicitud.crear`) |
| `flito_impuestos` | `roles: ['gestor_impuestos','admin']` | `funcion: 'impuestos.cola.ver'` |
| `flito_logistica_ruta` | `roles: ['mensajero']` | `funcion: 'logistica.ruta.ver'` (la misma que exige `GET /flito/logistica/mi-ruta`) — AC5 |

Cambio de comportamiento declarado: un rol con la página **y** la función ve el ítem aunque antes
no estuviera en `roles` (p. ej. `auditor` con `soat.cola.ver`). Es exactamente lo que decidió el PO.

## 2. AC7 — refresco sin cerrar sesión

`AuthProvider` gana `refrescarSesion()` (sustituye a `refrescarFunciones`, que queda como alias
para `RolesPermisos.tsx`):

```
refrescarSesion = Promise.all([api.get('/auth/me'), permisosApi.mios()])
  → setUser(me) y setFunciones(mios.funciones) / setTipoPrincipal  — SOLO si cambió algo
    (comparar allowedPages, funciones, puedeSolicitarSoat ordenados) para no re-renderizar el árbol
  → error de red / 5xx: se CONSERVA la foto anterior (no `[]`, no `null`): un fallo transitorio no
    vacía el menú. El 401 sigue su camino de siempre (`SESSION_ENDED_EVENT` en api.ts).
  → una sola petición en vuelo (promesa compartida); llamadas concurrentes la reutilizan.
```

Disparadores (hook `useRefrescoPermisos()` montado **dentro del Router**, en el shell/Layout
autenticado; `AuthProvider` no tiene `useLocation`):

1. `document.visibilitychange` → `visible`: refresca **siempre** (salvo petición en vuelo).
2. Cambio de `location.pathname`: refresca con **throttle de 15 s** (desde el último refresco).
3. Nada de `setInterval`/polling.

Interacción con la caché de 60 s del backend (`PERMISOS_CACHE_TTL_MS`, `apps/api/src/shared/permisos-efectivos.ts:105`):
- Guardar el cuadro del rol llama `invalidarPermisosDeRol` post-commit (`permisos.routes.ts:142,157`);
  en el **mismo proceso** el siguiente `/me`/`/mios` ya trae el cambio.
- La caché es **en memoria por proceso**: con varias instancias PM2, otra instancia puede servir
  la foto vieja hasta **60 s**. Peor caso AC7 = 60 s + el siguiente disparador. Throttle de 15 s
  es suficiente: bajarlo no acelera nada contra una caché de 60 s.
- Al perder la página actual, `ProtectedRoute` (`App.tsx:120`) re-evalúa `hasPage` y muestra
  `NoAccess` sin navegación extra (AC2 en caliente).
- Seguridad: el refresco solo decide qué se **pinta**; el backend sigue negando por `exigirFuncion`.

## 3. AC8 — gate automático «la web no compara nombres de rol»

**Forma:** `scripts/check-roles-web.mjs` (AST con `typescript`, sin dependencia nueva) +
script raíz `"check:roles-web"` + paso en el job `build + test` de `.github/workflows/ci.yml`
junto a `check:hooks`. Su propio test: `scripts/check-roles-web.test.mjs` con `node:test`
(`node --test scripts/check-roles-web.test.mjs`, también en CI) con fixtures positivos y negativos.
No Vitest ni ESLint custom-rule (el lint no tiene plugin propio y añadirlo es más superficie).

**Ámbito:** `apps/web/src/**/*.{ts,tsx}` excluyendo `*.test.ts`. Comentarios ignorados (AST).

**Qué cuenta como «comparar nombre de rol»** (cualquiera → hallazgo `fichero:línea`):

| # | Forma AST | Ejemplos que caen |
|---|---|---|
| R1 | `BinaryExpression` `===`/`!==`/`==`/`!=` donde un lado es `<expr>.role`, `<expr>.rol`, `<expr>.rolCodigo`, `<expr>.rolNombre` o el identificador `role`/`rol`, y el otro es un **literal string** | `user?.role === 'admin'`, `role !== 'cliente'` |
| R2 | Llamada `.includes(X)` / `.has(X)` cuyo argumento es `<expr>.role` (o `rol`/`rolCodigo`/`rolNombre`) | `it.roles.includes(user.role)`, `ROL_PERMITIDO.has(user.role)` |
| R3 | Llamada a función cuyo nombre empieza por `puede`/`es`/`tiene`/`can`/`is`/`has` con un argumento `<expr>.role` | `puedeConciliar(user?.role)`, `puedeMutarTraspaso(user.role, …)`, `puedeEjecutar(user?.role, …)` |
| R4 | Propiedad `roles:` con `ArrayLiteral` de strings dentro de un objeto literal | resto de `navItems` |
| R5 | `Identifier`/`const` cuyo nombre case `/^ROLES?_[A-Z_]+$/` con array/Set de strings (excepto `ROLE_TONE`, `ROLE_LABELS`) | `ROLES_BOLSAS`, `ROLES_CONCILIACION`, `ROL_PERMITIDO` |

**No cuenta (excepciones legítimas, sin lista):** pintar el rol (`{user?.role ?? '—'}` en
`FlitTopbar`, `Perfil.tsx:56`), estilizar (`ROLE_TONE[u.role]`), etiquetar (`etiquetaRol`,
`tipoEnlaceDe`), el formulario de usuarios que compara el rol elegido contra el actual sin literal
(`pages/users/EditUserForm.tsx:96,147`), atributos JSX `role="…"`, y valores de API de roles en
`RolesPermisos`/`users/*` (no comparan contra literal).

**Excepciones declaradas por fichero (con motivo, en el script):**
- `components/fleet/LinksPanel.tsx` — `role === 'principal'` es el **rol del vínculo
  vehículo-persona**, no el rol de usuario. (Alternativa preferible: renombrar la variable a
  `tipoVinculo` y dejar la lista vacía; lo decide el frontend-agent, 1 línea.)

**Lista de pendientes con ratchet:** `PENDIENTES_HUECO: { fichero, veces, motivo }[]` = los HUECO
de §4. Asertos: hallazgos medidos `===` lista (aparece otro → rojo; desaparece uno → rojo hasta
borrarlo de la lista) y `sum(veces) <= TOPE` («solo baja; subirlo exige Líder Técnico»).
Si el humano decide cero pendientes (ver Pendiente humano), la lista nace vacía y esos ficheros
entran en el alcance.

Mutantes nombrados que el test del script debe matar: (M1) quitar R1 → fixture
`user.role === 'x'` no reportado; (M2) quitar la exclusión de comentarios → fixture comentado
reportado; (M3) quitar la excepción de `LinksPanel` → reportado.

## 4. Inventario y sustitución

Medido con grep de `\.role\b|role ===|roles: [|includes(.*role` + helpers por rol. Todas las
funciones citadas **existen** en `apps/api/src/modules/permisos/catalogo-operaciones.ts` (+ `.legado.ts`)
y/o la migración `0227`; donde no existe, **HUECO**.

### Shell / navegación

| Fichero:línea | Hoy | Sustituye |
|---|---|---|
| `components/shell/navItems.ts:52,80,86,87` | `roles` + `it.roles.includes(user.role)` | `funcion` (§1) |
| `components/shell/useNavSections.ts` | pasa `user` | pasa `funciones` |
| `components/shell/CommandPalette.tsx` | vía `navItemPermitido` | idem (sin literales propios) |
| `lib/permissions.ts` `rutaInicio` | `navItemPermitido(it, user as {role…})` | `rutaInicio(user, funciones)`; quitar el cast a `role` |
| `components/flit/FlitSidebar.tsx:47,55` | admin → todas las secciones abiertas | Sin rol: **todas abiertas cuando no hay estado guardado** en `sessionStorage`; si lo hay, el guardado ∪ sección de la ruta. Mismo efecto para admin; no-admin con 1–3 secciones no nota diferencia |
| `App.tsx:158` (`TramiteTraspasoGate`) | `role === 'transito'` → expediente STT | `hasFuncion('transito.tramite.tomar') && !hasFuncion('tramite.tramite.forzar_continuar')` — **misma regla que ya usa `TramiteTraspaso.tsx:212`** (`isTransito`) |
| `lib/ayudaFlito.ts:25` | `role === 'cliente'` → ninguna ficha | `tipoPrincipal === 'externo'` (§1) |
| `lib/ayudaFlito.ts:26` + `content/ayuda/catalogo.ts:86` | `siigo_credenciales` solo `role === 'admin'` | `permiso: 'siigo_credenciales'` en la entrada (el slug **ya existe** en `packages/shared-types/src/permissions.ts:252`; el comentario «no es PageSlug en este worktree» está caducado) |
| `components/flit/FlitTopbar.tsx:156,176` | muestra `user.role` | No es acceso. Nota: pintar `rolNombre ?? role` (opcional, copy) |

### Tablero (AC6)

`pages/Dashboard.tsx:43,110,179,189` — hoy los KPI legacy solo para `admin`.
- Rama FLITO: `hasFuncion('tablero.tablero.ver')` → `<FlitoTablero />` (ya existe, sin cambio).
- Resto: **un bloque por módulo**, cada uno con su propia petición y sus 4 estados:
  SOAT legacy ↔ `hasPage('soat')` (`/soat/stats`), Flota ↔ `hasPage('fleet')`
  (`/fleet/documents/expiring`), RNDC ↔ `hasPage('rndc')` (`/rndc/manifiestos`).
  `Promise.allSettled` por bloque; un **403** de un bloque = ese bloque no se pinta (no es error),
  porque `/soat/stats` aún tiene `requireRole('admin')` en el backend (`soat.routes.ts:509`).
  Error ≠ 403 → bloque con error + reintento. Ningún bloque permitido → estado vacío con la guía ⌘K
  actual (kit FLITO).
- Atajos: «Rendimiento» ↔ `hasFuncion('rum.resumen.ver')`; «Métricas de trámites» ↔
  `hasFuncion('tramite.estadisticas.ver_metricas')`.
- Mismo cambio en las páginas destino: `pages/admin/RumSummary.tsx:87-91` → `rum.resumen.ver`;
  `pages/admin/TramitesMetricas.tsx:87-89` → `tramite.estadisticas.ver_metricas` (frontend-agent:
  confirmar que el endpoint que llama es `GET …/stats/metricas`; si es otro, usar la función de
  esa guarda). Su `<Navigate to="/">` pasa a `<NoAccess />` (AC2/AC9).

### SOAT (AC3, AC4)

- `pages/FlitoSoat.tsx`: ya por función. AC3 se cumple con lo existente
  (`soat.excel.exportar_pago` :272, `soat.comprobante.cargar` :55). Los «modos»
  (`esOperaciones`, `esGestor`, `soloLectura`, `esCliente`) se **conservan** para layout/copy, pero
  **no** deciden acciones del detalle.
- `components/flito/soat/DetalleSoat.tsx` (AC4): sustituir el gating por modo por una prop
  `puede: Record<AccionSoat, boolean>` calculada en `FlitoSoat` con `hasFuncion`, una por botón:

| Acción (línea aprox.) | Hoy | Función |
|---|---|---|
| Cargar factura (`cargaFactura` :70) | `esOperaciones \|\| esGestor` | `soat.factura.leer` |
| Rechazar (:155) | `cargaFactura` | `soat.solicitud.rechazar` |
| Reactivar (:157) | `rechazado && esOperaciones` | `soat.solicitud.reactivar` |
| Reversar (:224) | `esOperaciones` | `soat.solicitud.reversar` |
| Cambiar proveedor (:226) | `esOperaciones` | `soat.proveedor.cambiar` |
| Asumir en Operaciones (:229) | `esOperaciones` | `soat.solicitud.asumir` |
| Devolver al proveedor (:232) | `esOperaciones` | `soat.solicitud.devolver` |

  La condición de **estado** (`enAdquisicion`, `rechazado`, `traspasable`) se mantiene y se combina
  con `&&`. `esCliente` en `DetalleSoat` solo decide copy/datos visibles (no acciones): se queda.
  La sección «Corregir el caso» se pinta si alguna de sus 4 acciones está permitida.
- `pages/FlitoSoatSolicitud.tsx:167`: solo comentario — nada.
- `pages/Soat.tsx:122` (legacy `soat`): `u.role === 'proveedor'` elige **a quién asignar** →
  **HUECO** (backend legacy con `requireRole`; no hay `usuariosConFuncion` expuesto a la web).

### Resto — sustitución con función existente

| Fichero:línea | Hoy | Sustituye |
|---|---|---|
| `pages/FlitoBolsas.tsx:40` + `lib/bolsas.ts:22-25` | `puedeVerBolsas(role)` | Borrar: `ProtectedRoute page="flito_bolsas"` ya decide; dentro, `hasFuncion('bolsas.bolsa.ver')` si hace falta. Borrar `ROLES_BOLSAS` |
| `pages/FlitoConciliacion.tsx:36`, `FlitoConciliacionBoleta.tsx:41` + `lib/conciliacion.ts:33-39` | `puedeConciliar(role)` | Borrar (ruta ya guardada por página); acciones por `conciliacion.boleta.*`. Borrar `ROLES_CONCILIACION` |
| `pages/FlitoRevisiones.tsx:228` | `role === 'auditor'` → solo lectura | `soloLectura = !hasFuncion('revisiones.revision.resolver')` |
| `pages/PesvDiagnosticoAuditoria.tsx:45,94` | `ROL_PERMITIDO` | `hasFuncion('pesv.diagnostico_consulta.administrar')` |
| `pages/PesvDiagnosticoAuditoria.tsx:110,129` | `!== 'compliance'`, admin/lider_pesv | `hasFuncion('pesv.diagnostico.administrar')` |
| `pages/PesvDiagnostico.tsx:187` | `compliance` → redirige a auditoría | `hasFuncion('pesv.diagnostico_consulta.administrar') && !hasFuncion('pesv.diagnostico.administrar')` |
| `pages/Users.tsx:28,29` | admin | `usuarios.usuario.crear` / `usuarios.usuario.exportar` |
| `pages/Drivers.tsx:33`, `pages/DriverDetail.tsx:40` | admin | `drivers.conductores.administrar` |
| `pages/AlcoholTests.tsx:23` | admin | `drivers.alcoholimetria.administrar` |
| `pages/SafetyTrainings.tsx:21` | admin | `drivers.capacitaciones.administrar` |
| `pages/RoadIncidents.tsx:49` | admin | `drivers.incidentes.administrar` |
| `pages/Emergency.tsx:35` | admin | `drivers.emergencias.administrar` (guarda real en `drivers/emergency.routes.ts:44`) |

### HUECO — sin función en el catálogo (el backend sigue con `requireRole`)

Medido: `requireRole(` en `siigo` 19, `fleet` 10, `vehicles` 10, `maintenance` 33, `laft` 28,
`privacy` 3, y legacy `soat`; **0** `exigirFuncion` en esos módulos. Sustituir el literal por
`hasPage` en la web pintaría botones que el servidor rechaza con 403 a quien no sea `admin`.

| Fichero:línea | Módulo backend | Veces (R1–R5) |
|---|---|---|
| `pages/Fleet.tsx:49`, `pages/FleetVehicleDetail.tsx:30` | fleet / vehicles | 2 |
| `pages/Parts.tsx:24`, `Routines.tsx:15`, `Schedule.tsx:27`, `WorkOrders.tsx:50`, `WorkOrderDetail.tsx:36` (+ `LiquidacionPanel` recibe prop) | maintenance | 5 |
| `components/laft/ListsPanel.tsx:92` | laft | 1 |
| `pages/Privacy.tsx:37` | privacy | 1 |
| `components/siigo/PanelTerceros.tsx:51,64`, `pages/SiigoParametrizacion.tsx:71` | siigo | 3 |
| `pages/Soat.tsx:122` | soat legacy (asignables) | 1 |
| `pages/TransitoTraspasoExpediente.tsx:348` | matriz rol×estado en `packages/shared-types/src/traspaso-permisos.ts:45` | 1 |

Total HUECO: **14** ocurrencias en **13** ficheros. No se inventan códigos. Cerrar cualquiera exige
función nueva + migración + cambio de guarda en `apps/api` → trabajo BACKEND fuera de esta HU
FRONTEND (natural del Feature #12871 / F2).

## 5. E2E

- `e2e/helpers/auth.ts`: añadir a `FUNCIONES_POR_ROL` (por el rol que hoy pasa la regla por nombre,
  para que los specs existentes sigan verdes) **cada código nuevo** que la web empiece a consultar:
  `logistica.ruta.ver` (mensajero), `soat.cola.ver`/`soat.solicitud.crear` (proveedor, admin,
  cliente — comprobar que ya estén), `impuestos.cola.ver`, `revisiones.revision.resolver`,
  `pesv.diagnostico.administrar`, `pesv.diagnostico_consulta.administrar`, `rum.resumen.ver`,
  `tramite.estadisticas.ver_metricas`, `usuarios.usuario.crear`/`exportar`, `drivers.*.administrar`
  usados, y las 7 de `DetalleSoat`. Regla: `grep` del helper por cada `hasFuncion('…')` añadido
  en el diff.
- `sobreDeMios` ya devuelve `tipoPrincipal`; nada que añadir para `ayudaFlito`.
- Spec **nuevo** `e2e/tests/permisos-menu-sin-rol.spec.ts`: AC1 (rol con código ≠ `proveedor`
  y `rolNombre: 'Financiera'` + `flito_soat` + `soat.cola.ver` → ítem SOAT), AC2 (sin página → sin
  ítem; `goto('/flito/soat')` → `NoAccess`), AC5 (rol `operador_x` con `logistica.ruta.ver` → «Mi
  ruta»), AC7 (re-mock de `/permisos/mios` sin `soat.excel.exportar_pago`, disparar
  `visibilitychange` vía `page.evaluate` y navegar → botón ausente). Sin roles inventados en la
  matriz: el fixture usa `role` arbitrario a propósito (eso **es** el AC).
- Specs a revisar/ajustar: `shell-navbar.spec.ts`, `dashboard.spec.ts`, `flito-ruta.spec.ts`,
  `flito-soat.spec.ts`, `permisos-botones-funcion.spec.ts`, `pesv-permiso-por-item.spec.ts`,
  `rol-cliente-identidad.spec.ts` (ayuda del Cliente).
- No se añaden al smoke (`test:e2e:smoke` lista fija); local: spec nuevo + los tocados.

## 6. Tamaño y partición

Estimación: producto ~450 líneas (auth/refresh ~70, nav/permissions ~40, Dashboard ~80,
DetalleSoat/FlitoSoat ~50, 15 páginas × ~4, ayuda ~10, script ~150) + tests ~400 (spec nuevo ~200,
test del script ~100, helper/ajustes ~100). Ningún fichero se acerca a 800 (`Dashboard.tsx` y
`DetalleSoat.tsx` < 300). **Recomendación: un solo PR.** Si al implementar el diff de producto
pasa de ~600, partir en dos commits revisables (1: shell+refresh+gate; 2: páginas), mismo PR.
Los HUECO no se parten aquí: son backend.

## Archivos a crear/modificar

Crear:
- `scripts/check-roles-web.mjs`, `scripts/check-roles-web.test.mjs`
- `apps/web/e2e/tests/permisos-menu-sin-rol.spec.ts`
- `apps/web/src/lib/useRefrescoPermisos.ts`

Modificar:
- `package.json` (raíz: script `check:roles-web`), `.github/workflows/ci.yml` (paso en `build + test`)
- `apps/web/src/lib/auth.tsx`, `lib/permissions.ts`, `lib/ayudaFlito.ts`, `lib/bolsas.ts`, `lib/conciliacion.ts`
- `apps/web/src/content/ayuda/catalogo.ts`
- `apps/web/src/components/shell/navItems.ts`, `useNavSections.ts`, `CommandPalette.tsx` (si llama a `rutaInicio`/`navItemPermitido` directo)
- `apps/web/src/components/flit/FlitSidebar.tsx`, `components/NoAccess.tsx`, `App.tsx`, el shell/Layout donde se monta `useRefrescoPermisos`
- `apps/web/src/pages/Dashboard.tsx`, `pages/admin/RumSummary.tsx`, `pages/admin/TramitesMetricas.tsx`
- `apps/web/src/pages/FlitoSoat.tsx`, `components/flito/soat/DetalleSoat.tsx`
- `apps/web/src/pages/{FlitoBolsas,FlitoConciliacion,FlitoConciliacionBoleta,FlitoRevisiones,PesvDiagnostico,PesvDiagnosticoAuditoria,Users,Drivers,DriverDetail,AlcoholTests,SafetyTrainings,RoadIncidents,Emergency}.tsx`
- `apps/web/src/components/fleet/LinksPanel.tsx` (solo si se renombra la variable)
- `apps/web/e2e/helpers/auth.ts` + specs de §5
- Ficha de ayuda: `flit-ayuda-flito` decide delta (menú SOAT/Mi ruta visibles por permiso).

Sin cambios: `apps/api/**`, `packages/shared-types/**` (no se toca `traspaso-permisos.ts`).

## ADR: no aplica

Extensión del patrón ya aceptado por ADR-0022 y la Épica #13411; no hay contrato nuevo de API
(`tipoPrincipal` ya viaja en `/permisos/mios`).

## Notas operativas

- **frontend-agent:** P1 = `npm run typecheck -w apps/web` + `node --test scripts/check-roles-web.test.mjs`
  + `npm run check:roles-web` + spec nuevo y los tocados. `npm run lint` y `npx eslint` de
  `Dashboard.tsx`/`DetalleSoat.tsx` (max-lines). Los 4 estados en cada bloque del tablero y en
  `NoAccess` (kit `components/flit/`). No setear `funciones` a `[]` en un refresco fallido.
- **security-agent:** no aplica por diff (solo UI; el servidor sigue siendo la frontera), salvo que
  el hilo lo considere por «auth». Si se invoca: N/A en ≤2 comprobaciones.
- **qa-agent B:** mutantes sugeridos: quitar `funcion` del ítem `flito_logistica_ruta` (AC5 debe
  caer); refresco que ignora `visibilitychange` (AC7); devolver R1 del script (AC8).

## Riesgos abiertos

- R1: 60 s de foto vieja entre instancias PM2 (AC7 «al volver/navegar» puede no reflejar al
  instante). Aceptable; declarado.
- R2: `auditor` (u otros) con `soat.cola.ver` ganan el ítem SOAT en el menú. Es la decisión del PO;
  avisar en el PR.
- R3: AC8 literal («ningún archivo») no se cumple mientras existan los 14 HUECO.
