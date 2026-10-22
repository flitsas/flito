# Diseño slim — HU #13425 · Reglas internas de FLITO y la sesión sin nombre de rol

> Feature #13414 · Épica #13411 · BACKEND · Rama `HU/13425-davidchica-reglas-flito-sesion-sin-nombre-de-rol`
> (apilada sobre HU/13424, PR #480). Marco: ADR-0022 (admin editable, acceso por permisos).
> Estado: **Propuesto** (diseño, no ADR). Habla con módulos **FLITO** (`flito-*`) y con los
> legacy `users`, `auth`, `jornadas`, `pesv`, `drivers` — no se unifica nada.

## Patrón reutilizado

- **Regla de acceso dentro de un handler:** `tieneFuncion(req, '<código>')` como ya hace
  `apps/api/src/modules/users/users.routes.ts:62` (`usuarios.contrasena.cambiar_ajena`). En
  servicios que reciben `ctx` (logística), el `ctx` lleva un booleano calculado en la ruta con
  `tieneFuncion` — el servicio no consulta permisos.
- **Indicador derivado desde la foto de permisos:** `resolverPermisos(sub)` (usado en
  `users.routes.ts:57`) — misma foto cacheada 60 s que decide en el servidor.
- **Catálogo de funciones nuevas:** `apps/api/src/modules/permisos/catalogo-operaciones.ts` +
  migración SQL de siembra (patrón `0179_permisos_modelo.sql` / `0226_permisos_admin_todo_marcado.sql`).
- **Guarda estática de nombres de rol:** patrón del test de la HU #13421
  `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` (regex `COMPARACION_DE_ROL`,
  medición por fichero, `toEqual` contra una lista declarada).

## 1. Inventario (medido en el worktree `flito-hu13424`, tip `c5f99772`)

### Fase A — exclusivos de F1b (se hacen primero, sin esperar a #13421)

| # | file:line | Comparación | Clase | Destino |
|---|---|---|---|---|
| A1 | `modules/auth/auth.routes.ts:153` | `user.role !== 'cliente'` en `puedeSolicitarSoat` | **REGLA DE ACCESO** (indicador) | `p.ok && p.funciones.has('soat.solicitud.crear') && companiaId != null && clients.soatSinTramite` — función **existente** (`0179`). Ver riesgo R1 |
| A2 | `modules/flito-logistica/flito-logistica.service.ts:498` | `ctx.role === 'mensajero'` → «solo tus propias actas» (entregar) | **REGLA DE ACCESO** (propiedad) | Función **nueva** `logistica.actas.operar_ajenas`: sin ella, solo actas propias. `ctx.operaAjenas` calculado en la ruta |
| A3 | `flito-logistica.service.ts:527` | idem (devoluciones) | **REGLA DE ACCESO** | Igual que A2 |
| A4 | `flito-logistica.service.ts:627` | `soloMias = ctx.role === 'mensajero'` | **REGLA DE ACCESO** (misma regla de propiedad aplicada al listado) | `soloMias = !ctx.operaAjenas`. No es filtro #12871: AC5 nombra solo gestor_impuestos/transito/admin |
| A5 | `flito-logistica.service.ts:573` | `eq(users.role, 'mensajero')` — candidatos a mensajero | **REGLA DE ACCESO** (quién es asignable) | Usuarios activos cuyo conjunto efectivo tiene `logistica.actas.entregar` **y no** `logistica.actas.operar_ajenas`. Helper nuevo `usuariosConFuncion` (ver §Archivos). Riesgo R3 |
| A6 | `modules/flito-impuestos/flito-impuestos.service.ts:59` | `esGestor = ctx.role === 'gestor_impuestos'` | **FILTRO DE DATOS** (ámbito por organismos del gestor) | Lista `PENDIENTES_12871` |
| A7 | `modules/flito-impuestos/flito-recibos.service.ts:324` | `esGestor = ctx.role === 'gestor_impuestos'` | **FILTRO DE DATOS** | `PENDIENTES_12871` |
| A8 | `modules/flito-impuestos/flito-impuestos.routes.ts:121` | `user.role === 'gestor_impuestos'` | **FILTRO DE DATOS** | `PENDIENTES_12871` |
| — | `modules/flito-liquidacion/**` | 0 comparaciones (la línea 22 de `.routes.ts` es comentario) | — | AC3 queda cubierto por la guarda de AC6 (cero medido) |
| — | `modules/users/**` | 0 comparaciones de **nombre** de rol. Crear = `exigirFuncion('usuarios.usuario.crear')` (:471), asignar rol = `exigirFuncion('usuarios.usuario.editar')` (:565), contraseña ajena = `tieneFuncion('usuarios.contrasena.cambiar_ajena')` (:62). `users.service.ts:445/504` comparan valor viejo vs nuevo, no un literal | — | AC2 se cierra **con tests** (rol llamado `admin` sin la función → 403), sin cambio de prod |

**Condición para A6–A8 (backend-agent, antes de listarlos):** leer las 3 líneas y confirmar que
solo acotan filas (WHERE por organismos/asignación). Si alguna devuelve 403 o habilita una
acción, es REGLA DE ACCESO y se reconduce (no se mete en la lista). Si se confirma, la lista
nace con **3** entradas.

### Fase B — ficheros de F1a (solo tras rebasar sobre `develop` con #13421 mergeada)

Las `requireRole(...)` de declaración de ruta en `pesv/`, `drivers/`, `jornadas/` las retira
#13421 (su test lo exige). Quedan las de `PENDIENTES_13425` dentro de handlers; números de línea a
re-medir tras el rebase (los de abajo son del tip actual):

| # | Fichero (líneas hoy) | Comparación | Clase | Destino |
|---|---|---|---|---|
| B1 | `jornadas/jornadas.routes.ts` :53 :131 :209 :243 :270 :298 (6) | `role !== 'admin'` «otro conductor salvo admin» | **REGLA DE ACCESO** | `tieneFuncion(req, '<jornadas *.administrar de #13421>')` — función **existente tras #13421** (la que guarda `GET /` de jornadas). Si #13421 no dejó una aplicable: nueva `jornadas.jornada.operar_ajena` |
| B2 | `pesv/diagnostico.routes.ts` :62 (+1 tras rebase; 2 medidas) | `role === 'compliance'` → vista de auditoría | **REGLA DE ACCESO** (qué vista ve) | Nueva `pesv.diagnostico.ver_completo` (sembrada a `admin`, `lider_pesv`); sin ella → vista de auditoría. Semántica positiva: la ausencia restringe |
| B3 | `pesv/export-diagnostico.routes.ts` :146 :244 | `role === 'compliance'` → PII enmascarada | **REGLA DE ACCESO** (PII) | Nueva `pesv.export.diagnostico_pii` (sembrada a `admin`, `lider_pesv`); **sin ella se enmascara** (deny-by-default para PII, Ley 1581) |
| B4 | `drivers/alcohol.routes.ts` (1) | `eq(users.role,'admin')` destinatarios del aviso | **REGLA DE ACCESO** (quién recibe) | Nueva `drivers.alcohol.recibir_aviso` + `usuariosConFuncion` |
| B5 | `jornadas/notify.ts` (1) | `eq(users.role,'admin')` destinatarios | **REGLA DE ACCESO** | Nueva `jornadas.alarmas.recibir_aviso` + `usuariosConFuncion` |

### Migración (una sola)

`apps/api/src/db/migrations/NNNN_funciones_reglas_internas_13425.sql` — **NNNN = siguiente libre
en el momento del rebase de la Fase B** (hoy la última es `0226`; #13421 puede ocupar más). No se
numera antes del rebase; si la Fase A necesita commitearla, se renombra al rebasar (no se ha
aplicado en ningún ambiente → seguro).
Contenido, idempotente (`ON CONFLICT DO NOTHING`):
- Alta en el catálogo de: `logistica.actas.operar_ajenas`, `pesv.diagnostico.ver_completo`,
  `pesv.export.diagnostico_pii`, `drivers.alcohol.recibir_aviso`, `jornadas.alarmas.recibir_aviso`
  (y `jornadas.jornada.operar_ajena` solo si B1 lo requiere).
- Siembra **de equivalencia** (AC7: mismo comportamiento que hoy): cada función a los roles que
  hoy pasan la regla por nombre — `operar_ajenas` a todo rol que hoy tiene
  `logistica.actas.entregar` **excepto** el código `mensajero`; `ver_completo`/`diagnostico_pii` a
  los roles con acceso al diagnóstico excepto `compliance`; `recibir_aviso` a `admin`.
- `admin` recibe todas (ADR-0022: admin = todo marcado). Comprobar si `0226` lo hace por
  trigger/regla general; si no, `INSERT` explícito.
- Siembra por código de rol en SQL es **dato**, no regla: no viola AC6 (el test mira `src/modules`).

## 2. Contrato de `/auth/me` (y sobre de `POST /login`)

No existe tipo de `/me` en `packages/shared-types` (grep: 0 usos de `puedeSolicitarSoat`/`rolNombre`
allí). El tipo vive en `apps/web/src/lib/auth.tsx` (`AuthUser`). Decisión: **no** se crea tipo en
shared-types en esta HU (sería un contrato nuevo sin consumidor); el delta va a `AuthUser`.

```
GET /api/auth/me  (y user en POST /api/auth/login)
  id, username, name, email, role, rolNombre, transitoCodigo   — sin cambio
  allowedPages: string[]          — sin cambio (ya efectivas, del resolutor)
  + funciones: string[]           — NUEVO: códigos efectivos de resolverPermisos(sub), ordenados
  puedeSolicitarSoat: boolean     — mismo nombre; ahora = soat.solicitud.crear ∧ compañía ∧ soatSinTramite
  role                            — se mantiene (JWT y respuesta), pero ninguna regla del servidor
                                    lo lee para decidir dentro del alcance de AC6
```

- AC1 verificable: test que renombra `permisos_roles.nombre` (y/o usa un rol de código distinto
  con las mismas funciones) y compara `/me` campo a campo salvo `rolNombre`/`role`.
- `funciones` es lista de códigos, sin PII. `companiaId` sigue sin salir.
- **Grep obligatorio en `apps/web` (regla 7):** `puedeSolicitarSoat` → `lib/auth.tsx:34,38`
  (tipo opcional; sin cambio de forma). `funciones?: string[]` se añade **opcional** a `AuthUser`
  (solo tipo; la web no lo consume en esta HU — su `hasFuncion` ya tiene fuente propia).
  Comparaciones de rol en la web (`App.tsx:158`, `FlitSidebar.tsx:47,55`, `Dashboard.tsx`,
  `Fleet.tsx`, `Emergency.tsx`, `DriverDetail.tsx`, `ListsPanel.tsx`, `PanelTerceros.tsx`,
  `FlitoRevisiones.tsx:228`) **fuera de alcance** (HU BACKEND): Nota para el Feature, no se
  tocan aquí.

## 3. Test de nombres de rol (AC6) y su relación con `PENDIENTES_13425`

- **Dónde:** nuevo `apps/api/__tests__/services/permisos.nombres-de-rol.test.ts`.
- **Ámbito:** `src/modules/{auth,users,jornadas,flito-logistica,flito-impuestos,flito-liquidacion,pesv,drivers}`
  (todos los `*.ts`, sin comentarios). Regex = `COMPARACION_DE_ROL` de #13421 **ampliada** con
  `requireRole(` y `.includes(<algo>.role)` genérico (no solo `req.user`), para cubrir `ctx.role`
  y `user.role`.
- **Lista:** `PENDIENTES_12871: { fichero, veces, que }[]` — solo filtros de DATOS (A6–A8 si se
  confirman). Asertos: (a) `medidas` `toEqual` la lista (aparecer otra → rojo; quitar una → rojo
  hasta borrarla de la lista); (b) **ratchet**: `sum(veces) <= TOPE_13425 = 3` con comentario
  «solo puede bajar; subirlo exige decisión del Líder Técnico».
- **Combinación con #13421:** en la Fase B, `PENDIENTES_13425` del test de #13421 pasa a `[]`
  (su aserto queda como «cero en pesv/drivers/jornadas/rum», útil y barato). No se importa una
  lista desde la otra: cada test mide su ámbito; el nuevo cubre además pesv/drivers/jornadas,
  así que la duplicación es intencional y no contradictoria.
- **Fase A sin #13421:** el test nuevo se escribe en la Fase A con ámbito solo F1b
  (`auth, users, flito-*`); en la Fase B se añaden `jornadas, pesv, drivers` al array de
  directorios. Así la Fase A queda verde sin tocar ficheros de F1a.

## 4. AC4 contra el flujo actual

Medido: **no existe flujo de «cambio de contraseña obligatorio»** en el código (0 coincidencias
de `mustChange`/`debeCambiar`/`obligatori*` sobre contraseña en api, web y shared-types). El único
punto es `PATCH /api/users/:id/password` (`users.routes.ts:46`):
- interno → la propia siempre; no exige `pagina.perfil` → AC4 ya se cumple para internos.
- externo → la propia **exige `pagina.perfil`** (`:58`, HU #13255) → hoy un externo sin Perfil
  **no** puede cambiar su contraseña.

Recomendación con lo que existe hoy: quitar `pagina.perfil` de la condición del externo **solo
para la propia** (`req.user.sub === id`); la ajena sigue vedada al externo. El resto de Perfil
(`GET` de datos/página) sigue con su guarda → 403. Tests: externo sin Perfil cambia la suya (200),
externo sin Perfil cambia ajena (403), interno sin Perfil cambia la suya (200).
Esto cambia una decisión de #13255 → ver «Pendiente humano» P1.

## Archivos a crear/modificar

Fase A (F1b, ya):
- `apps/api/src/modules/auth/auth.routes.ts` — `puedeSolicitarSoat` por función; `funciones` en `/me` y `/login`
- `apps/api/src/modules/flito-logistica/flito-logistica.routes.ts` — `ctx.operaAjenas` vía `tieneFuncion`
- `apps/api/src/modules/flito-logistica/flito-logistica.service.ts` — :498 :527 :573 :627
- `apps/api/src/modules/users/users.routes.ts` — AC4 (condición del externo en `/:id/password`)
- `apps/api/src/modules/permisos/catalogo-operaciones.ts` — alta de los códigos nuevos
- `apps/api/src/shared/permisos-efectivos.ts` — `usuariosConFuncion(codigo)` (rol ∪ custom, misma semántica que el resolutor; una consulta, no N resoluciones)
- `apps/web/src/lib/auth.tsx` — `funciones?: string[]` en `AuthUser` (solo tipo)
- Tests: `__tests__/services/permisos.nombres-de-rol.test.ts` (nuevo); tests de `/me` (AC1/AC7), de users (AC2/AC4) y de logística (A2–A5) junto a los existentes de cada módulo

Fase B (tras rebase con #13421):
- `apps/api/src/modules/jornadas/jornadas.routes.ts`, `jornadas/notify.ts`
- `apps/api/src/modules/pesv/diagnostico.routes.ts`, `pesv/export-diagnostico.routes.ts`
- `apps/api/src/modules/drivers/alcohol.routes.ts`
- `apps/api/src/db/migrations/NNNN_funciones_reglas_internas_13425.sql` (numerada aquí)
- `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` — `PENDIENTES_13425 = []`
- `permisos.nombres-de-rol.test.ts` — ampliar directorios

## ADR: no aplica

Extiende ADR-0022 (acceso por permisos) sin contradecirlo; no hay tabla ni contrato nuevo en
shared-types. Los códigos nuevos son altas de catálogo con el patrón vigente.

## Notas operativas

**backend-agent**
- Orden: Fase A → commit → esperar merge de #13421 → rebase sobre `develop` → Fase B → numerar migración → P1.
- `pesv.export.diagnostico_pii`: el enmascarado es el **default**; la función lo levanta. Mantener `logPiiAccess` donde ya esté.
- Migración: P6 (ese SQL dos veces sobre la BD local ya migrada). Dispara `db-review-agent`; `security-agent` aplica (auth, PII de export).
- Cada código nuevo con `tieneFuncion` debe quedar visible para `inventario-guardas.ts` (operación montada) — seguir lo que hizo #13421.
- P1: tests de este WI únicamente; nada de glob de módulo.

**frontend-agent:** no aplica (solo el tipo opcional en `auth.tsx`, que hace backend-agent por ser contrato).

## Riesgos

- **R1 — `soat.solicitud.crear` puede tenerla un rol interno** (cola SOAT). Con la regla por
  función, un interno con `companiaId` y compañía `soatSinTramite` vería «puede solicitar». Hoy
  `companiaId` solo lo llevan usuarios enlazados a compañía (canal Cliente), así que la
  equivalencia se mantiene; si no, añadir `p.tipoPrincipal === 'externo'` (tipo, no nombre).
  Confirmar con un test con interno + `companiaId`.
- **R2 — Siembra de equivalencia incompleta:** si un rol creado desde el panel hoy pasa por nombre
  (no puede: los nombres son fijos) — riesgo bajo; pero un rol personalizado con
  `logistica.actas.entregar` **ganará** `operar_ajenas` por la siembra «todos menos mensajero».
  Es el comportamiento actual (hoy solo `mensajero` se restringe), así que AC7 se cumple.
- **R3 — `usuariosConFuncion` diverge del resolutor** (custom por usuario, roles externos,
  usuarios dados de baja). Mitigación: test que compara su salida contra `resolverPermisos` sobre
  el mismo fixture.
- **R4 — Ventana entre fases:** si #13421 tarda, la HU queda a medias en su rama (Fase A sin PR).
  Alternativa: PR solo de Fase A no es posible sin partir la HU — decisión humana si se alarga.
- **R5 — AC4 relaja una regla de #13255** para externos (ver P1).
- **R6 — Caché de permisos 60 s:** retirar una función nueva tarda hasta 60 s en surtir efecto;
  igual que el resto del modelo, no es regresión.

## Pendiente humano

- **P1 (bloquea AC4 para externos):** no hay flujo de «cambio obligatorio». ¿«Siempre permitido
  aunque no tenga Perfil» significa que **todo** usuario (incluido externo) cambia **su propia**
  contraseña sin `pagina.perfil` (relaja #13255), o que solo aplica cuando exista el flag de
  cambio obligatorio que vendría con #13428? Recomendación: la primera.
- **P2:** confirmar que A6–A8 son filtros de datos (lectura del backend-agent; si alguno es
  regla de acceso, sale de la lista y el tope baja).
