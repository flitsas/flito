# ADR-0022 — `admin` como rol editable con todo marcado y seguro anti-bloqueo por permisos

- **Estado:** Propuesto (lo aprueba el Líder Técnico humano; ningún agente lo marca Aceptado)
- **Fecha:** 2026-10-07
- **HU:** #13424 [BACKEND] · **Feature:** #13414 · **Épica:** #13411
- **Relación:** complementa ADR-0015 (roles como catálogo editable, §Decisión 4 «el acceso total de
  `admin` es configuración, no una rama cableada») y ADR-0014 (registro antes/después de usuarios y
  permisos). **No** lo sustituye: ADR-0015 ya retiró los dos comodines de páginas; este ADR retira los
  restos que siguen tratando a `admin` como especial dentro del motor de permisos y cambia la forma
  del invariante anti-bloqueo de HU #12084. Por eso es ADR nuevo y no adenda: cambia una regla
  (el invariante) y una comprobación de arranque que ADR-0015/HU #12083 dejaron fijadas.
- **Módulos:** legacy `users`, `permisos` (no `flito-*`). No toca módulos FLITO.

## Contexto

Decisiones del PO (cerradas, no se reabren): `admin` es un rol con todos los permisos marcados y
**editable** como cualquier otro; cada permiso nuevo se le marca al sembrarlo; el único límite es el
seguro anti-bloqueo; las excepciones por usuario (conceder/revocar) se mantienen; con el cambio nadie
gana ni pierde acceso (paridad).

Estado medido en `develop` 29d3461e:

- El resolutor (`apps/api/src/shared/permisos-efectivos.ts`, `(R ∪ C) \ V`, caché 60 s) **no** tiene
  rama `admin` (0 coincidencias de `'admin'`). AC1 «≤ 60 s» ya lo da la caché existente.
- `getEffectivePages` (`packages/shared-types/src/permissions.ts:428`) y `ROLE_DEFAULT_PAGES` ya no
  tienen comodín de `admin` (HU #12081). `DEFAULTS_POR_ROL` es `Exclude<UserRole,'admin'>` a propósito.
- El seguro anti-bloqueo existe (`apps/api/src/shared/permisos-anti-bloqueo.ts`) y ya cubre los
  cinco caminos de escritura con lock `FOR UPDATE` población-primero. Pero su invariante es
  «≥ 1 titular **por cada** función» (pueden ser dos usuarios distintos) y los AC3/AC4/AC6 piden
  «≥ 1 usuario activo con **ambos**».
- Quedan cuatro piezas que tratan a `admin` como especial o que impiden editarlo (inventario abajo).

### Inventario exacto de `'admin'` en `apps/api/src` + `packages/shared-types/src` (sin tests ni seed)

**Clase A — motor de permisos: rompen AC1/AC2 y se cambian en esta HU**

| file:line | Qué hace | Por qué choca |
|---|---|---|
| `apps/api/src/modules/permisos/permisos.service.ts:46-57` | `FUNCIONES_SIN_ADMIN` (4 códigos que `admin` no tiene: `soat.solicitud.crear`, `soat.runt.preconsultar`, `soat.factura.leer`, `impuestos.recibos.reemplazar`) | AC2: todo el catálogo marcado en `admin` |
| `apps/api/src/modules/permisos/permisos.service.ts:117-127` | `verificarCatalogoAlArrancar` lanza `ArranquePermisosError` si `admin` no tiene en la **base viva** alguna función fuera de esa lista | **Contradice AC1**: desmarcar P a `admin` desde el panel deja la API **sin arrancar** en el siguiente reinicio |
| `apps/api/src/modules/permisos/permisos.service.ts:130-138` | `funcionesSinAdmin()` (lee la base filtrando `rol === 'admin'`) | Solo existe para el check anterior |
| `apps/api/src/modules/users/users.routes.ts:607-615` | Guarda «último admin activo» al cambiar rol: cuenta `users.role = 'admin'` | Concede inmunidad **por nombre**; bloquea casos legítimos (AC6: otro rol con ambos) y no protege si el último administrador real es de otro rol |
| `apps/api/src/modules/users/users.routes.ts:773-781` | Ídem al desactivar | Ídem |
| `apps/api/src/shared/permisos-anti-bloqueo.ts:80,85-88,145-153` | Invariante por función separada | AC3/AC4/AC6 piden conjunción en el mismo usuario |
| `apps/api/src/shared/permisos-anti-bloqueo.ts:60-63` | Recuperación manual por `psql` hardcodea `'admin'` | Solo comentario; se generaliza |

**Clase B — siembra (se conserva: es el mecanismo de AC2, no un bypass de acceso)**

| file:line | Qué hace |
|---|---|
| `apps/api/src/modules/permisos/catalogo.ts:99-102` | `rolesQueConcedenLaPagina`: al **generar la siembra** de `pagina.*`, `admin` las recibe todas. Es tiempo de siembra, no de petición; no concede nada en runtime. Se mantiene y se reescribe su comentario. |

**Clase C — legacy por nombre de rol fuera del catálogo de permisos (NO se tocan en esta HU — ver Pendiente humano)**

- `requireRole(...)` en **75 archivos / 203 llamadas**, **136** con `requireRole('admin')` a secas
  (drive, drivers, clients, jornadas, pesv, SOAT legacy, RNDC, vehicles, Siigo…). La propia cabecera
  de `apps/api/src/shared/middleware/auth.ts:218-224` las declara listas blancas legacy fuera del
  alcance de #12083. No tienen función en el catálogo: el panel no puede marcarlas ni desmarcarlas.
- Ramas de autorización por literal: `apps/api/src/modules/jornadas/jornadas.routes.ts:53,131,209,243,270,298`;
  `apps/api/src/modules/tramites/transito-scope.ts:25` (ámbito de organismo);
  `apps/api/src/modules/vehicles/vehicles.routes.ts:169` (enmascarado PII salvo `admin`);
  `apps/api/src/modules/pesv/{huerfanos:25,normativa:16,retencion:16,raci:16}.routes.ts` (`ADMIN_OR_LIDER`),
  `apps/api/src/modules/pesv/diagnostico.routes.ts:65`; `apps/api/src/shared/soportes/soportes-consulta.ts:182`;
  `packages/shared-types/src/permissions.ts:380,382` (`PESV_ADMIN_ROLES`, `FLEET_OPS_ROLES`),
  `packages/shared-types/src/siigo-permisos.ts:41,60`, `packages/shared-types/src/traspaso-permisos.ts:25-56`.

**Clase D — no conceden acceso (sin cambio)**

Destinatarios de notificaciones por rol (`laft/cash/aros.cron.ts:46,54`, `jornadas/notify.ts:29`,
`rndc/envio.service.ts:378`, `drivers/alcohol.routes.ts:138`); `actorRole` por defecto en eventos
(`tramites/lote.ts:246,324,499`, `tramites/tramites.service.ts:360`,
`flito-derechos/flito-derechos-drive.cron.ts:35`); texto de firmante (`pesv/policy.routes.ts:157`,
`pesv/export.routes.ts:151`, `laft/manual/manual.routes.ts:220`); `roleEnum` (`db/schema.ts:27`),
`USER_ROLES` (`shared-types/permissions.ts:34`), `ROLES_VALIDOS` de RACI; foto histórica
`modules/permisos/inventario.generado.ts` (270 líneas, no decide).

**Web** (`apps/web/src`, grep obligatorio de la regla 7): `getEffectivePages`, `ROLE_DEFAULT_PAGES`,
`PESV_ADMIN_ROLES`, `FLEET_OPS_ROLES`, `traspasoCapaPrincipal`: **0 usos**. Único literal:
`apps/web/src/components/flit/FlitSidebar.tsx:47,55` (`user?.role === 'admin'` → secciones del menú
expandidas / comportamiento de UI). No concede acceso (las páginas vienen resueltas por `/me`); es
Nota de frontend, fuera de esta HU BACKEND.

## Alternativas

La decisión con tradeoff real es **cómo se garantiza AC2 sin impedir AC1** (hoy el arranque lo
garantiza mirando la base viva, y eso es justo lo que vuelve a `admin` no editable). El resto
(quitar las guardas por nombre, conjunción del invariante) no tiene alternativa razonable.

### Opción 1 — Migración base + test estático sobre las migraciones (recomendada)

- 0226 marca a `admin` todo lo que hoy le falta (`INSERT … SELECT 'admin', codigo FROM permisos_funciones ON CONFLICT DO NOTHING`).
- Se retira la comprobación de `admin` del arranque (el resto de `verificarCatalogoAlArrancar`
  —catálogo código ↔ base, módulo de agrupación— se queda igual).
- Test Vitest **puro** (sin BD) que lee `apps/api/src/db/migrations/*.sql` con número ≥ 0226, extrae
  los códigos insertados en `permisos_funciones` y exige que el **mismo archivo** los marque a `admin`
  en `permisos_rol_funcion` (fila literal o `SELECT 'admin', codigo FROM permisos_funciones`).
- **Pros:** corre en CI (el CI no levanta Postgres — los tests de base se saltan en verde); falla en el
  PR que introduce la siembra, no en producción; no hay lógica escondida en la BD; `admin` queda
  libremente editable después de sembrar.
- **Contras:** depende de parsear SQL a mano (regex sobre `INSERT INTO permisos_funciones`); una
  siembra escrita con otra forma (`COPY`, DO-block) escaparía.
- **Esfuerzo:** S. **Riesgos:** falso negativo por forma de SQL → mitigado con un segundo aserto:
  todo código de `catalogoCompleto()` que no aparezca en ninguna migración ≤ 0225 debe aparecer en una
  ≥ 0226 (si no, el parser se perdió una siembra y el test se pone rojo).

### Opción 2 — Trigger en BD: `AFTER INSERT ON permisos_funciones` marca a `admin`

- **Pros:** estructural; imposible olvidarlo desde una migración.
- **Contras:** lógica oculta en la BD que ningún lector del repo ve; el literal `'admin'` vive en un
  trigger; no se puede probar en CI (sin Postgres); complica `permisos:seed --reagrupar` y cualquier
  reinsert; si un día el PO quiere sembrar una función **sin** `admin` (como hizo la 0220) hay que
  desactivar el trigger.
- **Esfuerzo:** S. **Riesgos:** deriva silenciosa entre ambientes si el trigger falta en uno.

### Opción 3 — Mantener el check de arranque, pero contra un «registro de ofrecimiento»

- Tabla/columna `ofrecida_a_admin_en` por función; el arranque exige que toda función haya sido
  ofrecida una vez, aunque luego se desmarque.
- **Pros:** detecta en runtime y sigue permitiendo editar.
- **Contras:** columna nueva solo para un chequeo; tumba el arranque de producción por un descuido de
  desarrollo (falla tarde, lejos del PR); sobre-diseño frente a la Opción 1.
- **Esfuerzo:** M. **Riesgos:** API caída en un deploy por una migración incompleta.

## Decisión y justificación

**Opción 1.** Falla en el PR (CI), no en un reinicio de producción; no añade tablas ni triggers; deja
`admin` editable sin excepciones. Además:

### D1 — Quitar todo trato especial a `admin` en el motor (AC1)

1. Borrar `FUNCIONES_SIN_ADMIN`, el bloque `sinAdmin/inesperadas` de `verificarCatalogoAlArrancar` y
   `funcionesSinAdmin()` (`permisos.service.ts:46-57,117-138`). Si algún test o script lo importa,
   se elimina con él (grep del backend-agent).
2. Borrar las guardas por nombre `users.routes.ts:607-615` y `:773-781`. Ya son redundantes: el
   servicio (`users.service.ts:445` cambio de rol/excepciones, `:539` desactivar) corre bajo
   `conSeguroAntiBloqueo` y la ruta ya traduce `BloqueoAdministracionError` a 409
   (`users.routes.ts:719,790`). Con ellas puestas, AC6 falla (409 aunque otro rol tenga ambos).
3. `catalogo.ts:99-102` se queda (siembra), con el comentario actualizado: «`admin` recibe en la
   siembra todo lo que exista; después es un rol editable más».
4. Criterio verificable de AC1: `grep -nE "'admin'" apps/api/src/shared/permisos-*.ts
   apps/api/src/modules/permisos/*.service.ts apps/api/src/modules/users/*.ts` devuelve **solo**
   comentarios. (Clase C/D fuera, ver Pendiente.)
5. `guardarCuadro` sobre `admin`: el candado `esSistema` hoy protege `codigo` y el borrado, no las
   funciones. El backend-agent lo confirma con un test: PUT del cuadro de `admin` quitando una función
   no crítica → 200, y en ≤ 60 s el usuario `admin` recibe 403 en esa función (invalidando caché como
   ya hace el guardado).

### D2 — Siembra (AC2)

- **Migración `0226_permisos_admin_todo_marcado.sql`** (la 0224 y la 0225 son de la Épica 13201:
  `0224_flito_soat_incompletas_archivos_purgados_en.sql`, HU #13409, y
  `0225_flito_storage_borrados_pendientes.sql`, HU #13410; ninguna siembra permisos). Contenido
  (forma base; ver la excepción del PO justo abajo):

  ```sql
  INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
  SELECT 'admin', f.codigo FROM permisos_funciones f
  ON CONFLICT DO NOTHING;
  ```
  **Decisión del PO del 2026-10-07 (opción (a), tras el bloqueante del backend-agent):** la 0226 lleva
  `WHERE f.codigo NOT IN ('soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear')`. Sus
  rutas (`flito-soat-cliente.routes.ts`) **no** tienen `requireRole('cliente')` ni otra guarda que la
  función, así que marcarlas daría a `admin` acceso real; se le marcarán cuando la HU #12874 permita
  radicar escogiendo la compañía. El test de AC2 fija esa lista (`EXCLUIDAS_DE_ADMIN`).
  Idempotente (PK `(rol_codigo, funcion_codigo)`; la tabla solo tiene esas dos columnas,
  `apps/api/src/db/schema/permisos.ts:68-76`); no toca `permisos_usuario_funcion`.
- **Paridad de las 4 funciones de `FUNCIONES_SIN_ADMIN`:**
  - `soat.solicitud.crear`, `soat.runt.preconsultar`, `soat.factura.leer`: sus rutas siguen con
    `requireRole('cliente')` + `guardiaCanalCliente`, así que marcarlas a `admin` **no le da acceso**
    (paridad intacta). El backend-agent verifica con `grep "exigirFuncion('soat.solicitud.crear'"` (y
    las otras dos) que **ninguna otra** ruta las use sin la guarda de cliente; si alguna lo hace, es
    BLOQUEANTE y se vuelve al humano.
  - `impuestos.recibos.reemplazar` (HU #13269, 0220 la sembró sin reparto **a propósito**): marcarla
    a `admin` **sí le da una capacidad nueva** → choca con «nadie gana». Ver Pendiente humano P-1.
    Default propuesto si no hay respuesta: **marcarla** (la decisión «admin = todo marcado» es
    posterior y explícita; `admin` ya podía concedérsela a sí mismo desde el panel).
- **Test AC2** (nuevo, puro): descrito en la Opción 1, con los dos asertos. Más un tercer aserto de
  regresión: la 0226 existe y contiene el `INSERT … SELECT 'admin'` (si alguien la «limpia», rojo).

### D3 — Invariante del seguro (AC3–AC7)

**Invariante:** tras cualquier escritura de los cinco caminos existe **al menos un usuario** que sea
activo (`users.active = true`), vivo (`deleted_at IS NULL`), de rol con `tipo_principal = 'interno'`,
y cuyo conjunto efectivo `(R ∪ C) \ V` contenga **a la vez** todas las `FUNCIONES_DE_ADMINISTRACION`.

`FUNCIONES_DE_ADMINISTRACION` pasa de 2 a 4 códigos, los que el panel llama «Usuarios» y «Roles y
permisos» (ver P-2):

```ts
['pagina.users', 'usuarios.usuario.editar', 'pagina.roles_permisos', 'permisos.cuadro.guardar']
```
Sin la `pagina.*`, quien conserva la función de API queda fuera de la SPA: bloqueo práctico cuya única
salida es `curl`/`psql`.

Cambios en `conSeguroAntiBloqueo` (`permisos-anti-bloqueo.ts`):
- **Lock (paso 1) sin cambio de forma:** sigue con `or(tiene(f)…)` — la población bloqueada debe ser un
  **superconjunto** de la contada; bloquear solo a quien tiene las cuatro dejaría sin lock a quien está
  a una escritura de completarlas (concesión concurrente) y no protege nada. Mismo `ORDER BY id`,
  `FOR UPDATE OF users`.
- **Cuenta (paso 3):** un único `count(*) filter (where tiene(f1) and tiene(f2) and …)`; cero → 
  `BloqueoAdministracionError`. Para el mensaje, cuando la cuenta conjunta es cero se calcula en la
  misma consulta qué funciones individuales se quedaron con cero titulares, y `funcion` del 409 es la
  primera de esas (o la primera de la lista si todas tienen titular por separado pero nadie las reúne).
- Contrato 409 **sin cambio de forma**: `{ error: string, funcion: string }`. Mensaje nuevo:
  «No se puede guardar: FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y
  Roles y permisos.»
- Sigue costando exactamente dos `select` (no desordena los mocks posicionales).

**Los cinco caminos** (todos ya envuelven; orden «población primero, objetivo después» sin cambio):

| AC | Camino | Dónde (ya existe) | Resultado |
|---|---|---|---|
| AC3 | Guardar cuadro de un rol | `permisos-roles.service.ts:298` `guardarCuadro` | 409 vía `permisos.routes.ts:90` |
| AC3 | Cambiar `tipoPrincipal` de un rol | `permisos-roles.service.ts:240` `editarRol` | 409 |
| AC5 | Borrar rol | `permisos-roles.service.ts:256` `borrarRol` (además `RolConflictoError` 409 si tiene usuarios, `:281`; `esSistema` no se borra) | 409 |
| AC4 | Cambiar rol / excepciones del usuario | `users.service.ts:445` `actualizarUsuario` | 409 vía `users.routes.ts:719` |
| AC4 | Desactivar | `users.service.ts:539` `cambiarActivo` | 409 vía `users.routes.ts:790` |
| AC4 | Dar de baja | `users.service.ts:573` | 409 vía `users-baja.ts:40` |

AC6 cae solo: con otro usuario activo con las cuatro, la cuenta es ≥ 1. AC7: `poblacionAdministradora()`
ya exige activo + vivo + interno. AC5 en la práctica lo cubre antes `RolConflictoError` (un rol con
usuarios no se borra); el seguro queda como segunda línea.

### D4 — Bitácora del rechazo (AC8)

La transacción que lanza `BloqueoAdministracionError` **revierte**, así que nada escrito dentro
sobrevive. El registro va **después del rollback, fuera de la transacción**, en los tres `catch` que ya
traducen el error (`permisos.routes.ts:90`, `users.routes.ts:719,790`, `users-baja.ts:40`) — mejor
centralizado en un helper del módulo de historial existente (`apps/api/src/shared/historial/permisos-auditoria.ts`,
que ya usan `users` y `permisos` sin dependencia entre hermanos). Campos: `actorUserId` (id opaco),
`objetivo` (`{ tipo: 'rol', codigo }` o `{ tipo: 'usuario', id }`), `operacion` (`guardar_cuadro` |
`editar_rol` | `borrar_rol` | `actualizar_usuario` | `desactivar` | `baja`), `resultado:
'rechazado_anti_bloqueo'`, `funcion`. **Sin PII**: ni username, ni nombre, ni email, ni documento.
Los guardados exitosos ya quedan en el historial antes/después de ADR-0014: sin cambio. Si el registro
del rechazo falla, se loguea (pino, sin PII) y **no** cambia el 409.

## Diagrama de secuencia (Mermaid)

```mermaid
sequenceDiagram
  actor A as Administrador (rol R)
  participant W as RolesPermisos.tsx
  participant RT as permisos.routes / users.routes
  participant S as servicio (roles / users)
  participant G as conSeguroAntiBloqueo
  participant DB as PostgreSQL (tx)
  participant H as permisos-auditoria
  A->>W: desmarca «Roles y permisos» en R
  W->>RT: PUT /api/permisos/roles/R/funciones
  RT->>S: guardarCuadro(R, funciones, actor)
  S->>DB: BEGIN
  S->>G: conSeguroAntiBloqueo(tx, escritura)
  G->>DB: SELECT users … tiene(f1) OR … ORDER BY id FOR UPDATE OF users
  G->>DB: escritura (FOR UPDATE rol R, DELETE/INSERT permisos_rol_funcion)
  G->>DB: SELECT count(*) FILTER (tiene(f1) AND … AND tiene(f4))
  alt cuenta = 0
    G-->>S: throw BloqueoAdministracionError
    S->>DB: ROLLBACK
    RT->>H: registrar rechazo (actor, rol R, resultado) — fuera de la tx
    RT-->>W: 409 { error, funcion }
    W-->>A: COPY_ANTI_BLOQUEO (aviso, nada guardado)
  else cuenta ≥ 1
    S->>DB: historial antes/después (ADR-0014) + COMMIT
    RT-->>W: 200; caché invalidada (≤ 60 s para el resto)
  end
```

## Contrato de endpoints

Sin endpoints nuevos ni cambio de forma. Cambia **cuándo** responden 409 los existentes:

| Endpoint (existente) | 409 nuevo/cambiado |
|---|---|
| `PUT /api/permisos/roles/:codigo/funciones` | cuando nadie activo reuniría las 4 funciones |
| `PATCH /api/permisos/roles/:codigo` (con `tipoPrincipal`) | ídem |
| `DELETE /api/permisos/roles/:codigo` | ídem (además del 409 por usuarios asignados) |
| `PATCH /api/users/:id` (rol / excepciones) | ídem; **desaparece** el 409 «último admin activo» por nombre |
| `PATCH` de activar/desactivar usuario | ídem; **desaparece** «No se puede desactivar al último admin activo» |
| baja de usuario (`users-baja.ts`) | ídem |

Cuerpo 409: `{ "error": "<mensaje>", "funcion": "<codigo>" }` (igual que hoy).

## Modelo de datos (Drizzle)

Sin cambios de esquema. Solo datos: migración `0226` (filas en `permisos_rol_funcion`).

## Archivos a crear/modificar

| Acción | Archivo |
|---|---|
| crear | `apps/api/src/db/migrations/0226_permisos_admin_todo_marcado.sql` |
| modificar | `apps/api/src/shared/permisos-anti-bloqueo.ts` (4 funciones, cuenta conjunta, mensaje, comentario de recuperación `psql` con las 4 filas y «al rol que deba tenerlas») |
| modificar | `apps/api/src/modules/permisos/permisos.service.ts` (quitar `FUNCIONES_SIN_ADMIN`, check de admin en arranque, `funcionesSinAdmin`) |
| modificar | `apps/api/src/modules/users/users.routes.ts` (quitar `:607-615`, `:773-781`; registrar rechazo en `:719`, `:790`) |
| modificar | `apps/api/src/modules/users/users-baja.ts` (registrar rechazo en `:40`) |
| modificar | `apps/api/src/modules/permisos/permisos.routes.ts` (registrar rechazo en `:90`) |
| modificar | `apps/api/src/shared/historial/permisos-auditoria.ts` (helper de evento `rechazado_anti_bloqueo`) |
| modificar | `apps/api/src/modules/permisos/catalogo.ts:99-101` (solo comentario) |
| crear | test AC2 puro (siembra ↔ `admin`) junto a los tests existentes de `permisos-catalogo.test.ts` |
| modificar | tests del seguro anti-bloqueo y de `users.routes` que asertan los mensajes «último admin» (se reescriben a la regla nueva: AC3–AC7) |

Ningún archivo supera 800 líneas por este cambio (todos restan o suman poco); el backend-agent corre
`npx eslint` sobre `users.routes.ts` por el ratchet de `max-lines`.

## Impacto en shared-types

**Ninguno.** `getEffectivePages` y `ROLE_DEFAULT_PAGES` ya no tienen atajo de `admin` (HU #12081) y
la web no los usa (grep: 0 usos en `apps/web/src`). `DEFAULTS_POR_ROL: Exclude<UserRole,'admin'>` se
queda: es el oráculo de siembra, y la ausencia de `admin` es intencional (sus páginas las da la tabla).
Las constantes de Clase C (`PESV_ADMIN_ROLES`, `FLEET_OPS_ROLES`, `siigo-permisos`, `traspaso-permisos`)
no se tocan en esta HU.

## Notas operativas por agente

- **backend-agent:** P1 = test AC2 nuevo + test(s) del seguro + test(s) de `users.routes`/`permisos.routes`
  tocados. Migración: aplicar **solo la 0226** dos veces sobre la BD local (P6), puerto 5434. Antes de
  borrar las guardas por nombre, añadir el test de AC6 (otro rol con las 4 → desactivar al último
  `admin` = 200) y verlo rojo. Comprobar el grep de las 3 funciones de canal Cliente (D2). Si
  `funcionesSinAdmin`/`FUNCIONES_SIN_ADMIN` se importan en scripts o tests, retirarlos con ellos.
- **frontend-agent (no en esta HU):** `COPY_ANTI_BLOQUEO` (`RolesPermisos.tsx:46`) nombra solo «roles y
  permisos»; con el invariante conjunto debería nombrar ambos. `FlitSidebar.tsx:47,55` usa
  `role === 'admin'` para UI del menú. Ambas son Nota para una HU FRONTEND si el PO la quiere.
- **security-agent:** dispara (auth/permisos). Foco: que el lock siga siendo superconjunto, que el
  registro del rechazo no lleve PII, que no quede ninguna rama `'admin'` en el motor.
- **db-review-agent:** dispara (migración). Solo datos, idempotente.
- **Despliegue:** la 0226 debe estar aplicada **antes** de que arranque el código nuevo… y también
  es inocua con el código viejo (añadir filas a `admin` no rompe el check antiguo). Orden seguro:
  migración primero.

## Riesgos abiertos y qué falta decidir

1. **Rollback:** revertir el código restaura el check de arranque de `admin`. Si entre medias alguien
   desmarcó una función a `admin` desde el panel, **la API vieja no arranca**. Procedimiento: antes de
   revertir, re-ejecutar el `INSERT … SELECT 'admin'` de la 0226 (idempotente). La 0226 no se
   revierte (añade permisos a `admin`); si el PO quiere deshacer `impuestos.recibos.reemplazar`, se
   desmarca desde el panel o con migración nueva.
2. **Endurecimiento del invariante:** pasar de «≥ 1 por función» a «≥ 1 con las cuatro» puede hacer que
   operaciones que hoy pasan den 409 en un ambiente donde las capacidades están repartidas entre
   usuarios distintos. Antes del deploy en QA/PDN, comprobar con una consulta de solo lectura que hoy
   existe ≥ 1 usuario activo interno con las cuatro (en DEV, los `admin` las tienen por la 0179/0187).
3. **Recuperación con cero administradores:** el seguro rechaza también la operación que lo arreglaría;
   la vía sigue siendo `psql` (comentario actualizado en el archivo).
4. **AC1 literal vs. Clase C** (P-3 abajo).

### Pendiente humano

- **P-1 (PO):** `impuestos.recibos.reemplazar` se sembró sin `admin` a propósito (HU #13269). Marcarla
  en la 0226 le da a `admin` una capacidad nueva (choca con «paridad»). Default propuesto: marcarla.
- **P-2 (PO):** confirmar que «Usuarios» y «Roles y permisos» del AC son las 4 funciones
  `pagina.users`, `usuarios.usuario.editar`, `pagina.roles_permisos`, `permisos.cuadro.guardar`
  (y no solo las 2 de API, como hoy).
- **P-3 (PO/Líder Técnico):** «ningún código concede acceso por llamarse admin» leído literalmente
  incluye las 136 `requireRole('admin')` y las ramas de Clase C (jornadas, tránsito, vehículos, PESV,
  Siigo, traspaso). Están fuera del catálogo de permisos: el panel no las muestra, así que desmarcar
  P en `admin` no puede afectarlas. Propuesta: AC1 se cumple sobre **todo permiso del catálogo** (lo
  que el panel edita) en esta HU; la reconducción de Clase C a `exigirFuncion` es un Feature aparte
  (del tamaño de #12083), no esta HU.
