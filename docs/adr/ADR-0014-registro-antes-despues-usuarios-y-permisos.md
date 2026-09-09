# ADR-0014 — Registro antes/después de usuarios, roles y permisos: tabla propia, un par por campo, sin PII del titular

## Estado

**Propuesto** — Feature [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072) («Módulo de usuarios: roles configurables, permisos por función y borrado lógico»), HU [#12171](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12171).

Queda en `Propuesto` hasta que lo apruebe el Líder Técnico humano. **Ninguna implementación de las HU #12084, #12087, #12089 y #12171 debe empezar antes de esa aprobación**: las cuatro escriben contra el mecanismo que aquí se decide.

Origen: el AC1 de la #12171 pide explícitamente que la HU documente la decisión entre «(a) añadir `before_state` y `after_state` jsonb a `audit_logs`» y «(b) seguir el patrón que ya existe en `laft_audit_log`». El Feature lo declaró riesgo antes: *«Hay que decidir el mecanismo antes de escribir la historia de auditoría, o CF-19 se cumplirá sobre el papel y no en la práctica»*.

## Contexto medido (verificado sobre `develop` @ `42d889e`, 2026-09-08)

| Hecho | Dónde |
|---|---|
| `audit_logs` tiene `id, user_id, user_email, action, resource, resource_id, detail, ip_address, user_agent, created_at`. **No tiene `before_state` ni `after_state`** | `apps/api/src/db/schema.ts:695-709` |
| Sus únicos índices: `idx_audit_logs_created_at`, `idx_audit_logs_user_id` y uno **parcial** de PESV | `schema.ts:707-708`; `db/migrations/0004_closed_skaar.sql:9-10`; `0068_pesv_diagnostico_niveles.sql:118-120` |
| El índice de PESV es `(resource, resource_id, created_at DESC) WHERE resource IN ('pesv_diag','pesv_diag_item','pesv_evidence')` → **inservible para `resource='user'`** | `0068_pesv_diagnostico_niveles.sql:118-120` |
| `laft_audit_log` **sí** tiene los dos campos, ambos `jsonb` | `schema.ts:885-886` (la HU dice `884-885`: está corrido en uno) |
| El helper `audit()` se llama **312 veces en 80 archivos** (excluidos tests y su propia definición) | `grep -rEo "\baudit\(req\b" apps/api/src` — la HU dice 311/81; la diferencia es de conteo, no cambia el análisis |
| Además hay **13 `insert(auditLogs)` directos** en servicios transaccionales, que por eso no graban `ip_address` ni `user_agent` | `flito-soat.service.ts:1800`, `flito-impuestos.service.ts:541`, `flito-revisiones.service.ts:35`, `flito-derechos.service.ts:648`, `flito-compuerta.service.ts:212/237`, `flito-excepciones.service.ts:63`, `flito-recibos.service.ts:81`, `certificacion.service.ts:251`, `flito-soat-cliente.service.ts:816`, `flito-soat-vigencia.service.ts:374/389`, `flito-sync.service.ts:94` |
| **`audit()` se traga sus errores**: si el INSERT falla, la petición sigue y no queda fila | `shared/middleware/audit.ts:38-54`, en concreto `:52-53` |
| Un cambio de permisos se registra hoy como el texto `Cambios: allowedPages`, sin decir qué páginas | `users.routes.ts:393-396`, construido desde `camposCambiados` en `users.service.ts:214` (la HU dice `:216`) |
| El módulo `users/` tiene **6 puntos de llamada** a `audit()`, no 6 filas: `:52, :184, :240, :393, :431, :451`. Cinco escriben `resource='user'`; el sexto, `resource='user_session'` | `modules/users/users.routes.ts` |
| Solo el rol y el estado activo guardan antes→después, y **metidos dentro de la frase** | `users.routes.ts:395` (`(rol: X→Y)`) y `:433` (`Estado: activo → inactivo`) |
| El repo ya declaró por escrito que ese patrón no sirve | `shared/historial/estado-historial.ts:3-7` |
| Su respuesta fue una tabla propia con `estado_anterior`/`estado_nuevo`/`motivo`/`origen` | `schema.ts:3393-3411`; `db/migrations/0115_flito_trazabilidad.sql:63-87` |
| Y su escritor **no lleva try/catch a propósito**, al contrario que `audit()` | `estado-historial.ts:49-53` |
| **No hay lector de `audit_logs` para `resource='user'`**: los dos GET de bitácora filtran por la lista blanca `RECURSOS_FLITO` | `flito-bitacora.routes.ts:19`, aplicada en `:40` y `:47` |
| El router de `users` es **`admin` puro** desde su línea 61 | `users.routes.ts:61` — `router.use(authMiddleware, requireRole('admin'))` |
| `laft/audit.routes.ts` es `requireRole('admin','compliance')` y **ninguna pantalla lo consume** (`grep "laft/audit"` en `apps/web` solo devuelve `/laft/audit-plan`, que es otra cosa) | `modules/laft/audit.routes.ts:8`; `apps/web/src/pages/LaftAuditPlan.tsx:34` |
| `users` guarda PII del titular: `username`, `name`, `email`, `password_hash` | `schema.ts:64-67` |
| `pii_access_log` ya resuelve «registrar sin PII» guardando `user_id` + `user_role` | `schema.ts:2130-2143` |
| Las tablas del Feature aún **no existen**: no hay `modules/permisos/` ni `permisos_*` en `schema.ts`. Las crea la #12081 | `ls apps/api/src/modules/`; `grep permisos_roles` |
| `Users.tsx` está en **680 sloc** contra el techo 800 de `max-lines` | `npx eslint apps/web/src/pages/Users.tsx --rule max-lines` |
| Última migración: `0177_flito_soat_vigencia_runt.sql` | `apps/api/src/db/migrations/` |

### Tres hechos que la HU y el Feature dan por ciertos y **no lo son**

**1. `audit_logs` NO es append-only por `REVOKE`.** El comentario de `0132_clients_modelo_fiscal.sql:101` afirma que «`audit_logs.detail` … es append-only por REVOKE y … ningún cron purga». La segunda mitad es cierta; la primera es **falsa**. `grep -rn REVOKE apps/api/src/db/migrations/` devuelve 16 líneas y **ninguna nombra `audit_logs`**: las protecciones son de `laft_audit_log` (`0011_laft_module.sql:112-115`), `laft_ros_sla_alarmas` (`0065:63-66`), `laft_lists_sync_jobs` (`0062:61-64`), `laft_cash_txns`, `laft_reportes_uiaf` y `laft_cash_idempotency_keys` (`0064:74-176`). La única tabla con inmutabilidad **por disparador** es `siigo_operaciones` (`0126_siigo_operaciones_worm.sql:47-61`). Sobre `audit_logs`, `operaciones_app` puede hoy hacer `UPDATE` y `DELETE`. Nada los hace —el grep de `delete(auditLogs)` y `DELETE FROM audit_logs` da **cero**—, pero nada los impide. Diseñar la evidencia de CF-19 sobre una tabla que se cree protegida y no lo está es el peor de los dos errores posibles.

**2. Sí existe una política de retención declarada para `audit_logs`.** `0060_pesv_s9_menores.sql:231` siembra en `pesv_retencion_politicas` la fila `('audit_log', 6, 'ISO 27001 A.12.4', 'archivar_offline', …)`. Lo que no existe es su **ejecución**: `pesv/retencion.cron.ts` es DRY-RUN por diseño y escribe `cantidadAfectada: 0` (`:74`), con el comentario `// DRY-RUN: nunca toca datos`. La frase correcta no es «no hay retención», es **«hay política y no hay mecanismo»**. Cambia la decisión: no hay que inventar un plazo, hay que decidir quién ejecuta el que ya está escrito.

**3. La cláusula `ON DELETE` de `audit_logs.user_id` está en deriva.** `schema.ts:697` declara `onDelete: 'set null'`; la migración que creó la constraint escribió `ON DELETE no action` (`0001_worthless_omega_flight.sql:16`) y **ninguna migración posterior la altera** (`grep audit_logs_user_id` sobre `db/migrations/` solo devuelve esa línea y los snapshots `meta/`). No pude contrastarlo contra la base viva —`localhost:5434` rechazó la conexión en este worktree—, así que el hallazgo es sobre el par SQL/`schema.ts`, que ya es suficiente: **la tabla que la opción (A) propone convertir en evidencia legal no sabe qué le pasa a su columna de autor cuando se borra un usuario.**

## Decisión

**Una tabla propia, `permisos_auditoria`, con un par antes/después por campo cambiado, sin PII del titular, escrita dentro de la transacción que hace el cambio, y con `audit_logs` intacto.** Es la opción (B).

Las seis precisiones que siguen son el contenido normativo del ADR.

### 1. Tabla nueva; `audit_logs` no se toca

`permisos_auditoria` (prefijo `permisos_`, el mismo espacio de nombres que la #12081 fija para `permisos_roles`, `permisos_funciones`, `permisos_rol_funcion` y `permisos_usuario_funcion`). Discriminador `entidad` para las cuatro cosas que CF-19 nombra —usuario, rol, cuadro rol × función y permiso concreto de usuario—, exactamente como `flito_estado_historial.concepto` cubre SOAT e impuestos con una sola tabla (`schema.ts:3389-3392`).

Los seis `audit()` del módulo `users/` **se quedan como están**. `audit_logs` sigue siendo la bitácora de cumplimiento transversal; `permisos_auditoria` es el historial consultable. Es la misma convivencia que el repo ya eligió una vez: `flito_estado_historial` no reemplazó a `audit_logs`, se puso al lado.

### 2. Un par por campo, no un documento por cambio

`valor_antes` y `valor_despues` guardan **el valor de un solo campo**, no el estado de la entidad. Un PATCH que cambia rol y compañía escribe **dos filas**, no una con dos documentos.

La forma del valor está acotada por tipo, y ese acotamiento **es** la garantía de PII del punto 4:

```ts
type ValorAuditable =
  | string | number | boolean | null
  | { conjunto: string[]; concedidas?: string[]; revocadas?: string[] };
```

No hay `Record<string, unknown>` ni `object` en la unión, a propósito: `db.select().from(users)` **no compila** como argumento. La forma «documento entero» no se descarta por convención, se descarta porque el tipo no la admite.

### 3. Para los conjuntos: el conjunto completo **y** el delta, en la misma fila

Para `campo = 'funciones'`, `'allowed_pages'` u `'organismos_codigos'`:

```json
valor_antes:   { "conjunto": ["soat.cola.ver", "soat.solicitud.crear", "pagina.usuarios"] }
valor_despues: { "conjunto": ["soat.cola.ver", "pagina.usuarios"],
                 "concedidas": [], "revocadas": ["soat.solicitud.crear"] }
```

La pregunta que hay que poder responder es *«qué permisos tenía Fulano el 3 de marzo y quién se los quitó»*, y son **dos** preguntas con costes distintos:

- **Solo delta** — «qué tenía el 3 de marzo» exige reconstruir por reproducción hacia atrás desde el conjunto de hoy. Eso solo es correcto si **ninguna fila se perdió jamás**, y en este repo eso ya falló: `0115_flito_trazabilidad.sql:150-156` documenta que los envíos en lote auditaban con `ids.join(',')` contra un `varchar(50)`, Postgres rechazaba el INSERT, `audit()` se tragaba el error y **se perdieron todas** — «ocho SOAT están hoy en `solicitado` sin ninguna fila que lo cuente». Una reconstrucción por reproducción sobre un historial con huecos no da un resultado incompleto: da uno **equivocado y con aspecto de correcto**. Descartado.
- **Solo conjunto completo** — «qué tenía el 3 de marzo» es una fila; «quién le quitó `soat.solicitud.crear`» obliga a diferenciar filas consecutivas en el lector, y a repetir esa diferencia en el front, en el export y en cualquier consulta manual.
- **Los dos** — cada pregunta es una fila leída. El coste es duplicación dentro de la misma fila, y está acotado: el catálogo de la #12081 son 50 páginas más las operaciones de los módulos FLITO (18 solo de SOAT), con `codigo varchar(80)`; un conjunto máximo realista queda muy por debajo del umbral de TOAST de 2 KB. Y la tabla la escriben actos de administración, no tráfico.

Se elige **los dos**. `concedidas`/`revocadas` son derivados y se calculan al escribir, nunca al leer: si se calcularan al leer, volveríamos a depender de que no falte ninguna fila.

### 4. Datos personales: el correo del actor sí; del titular, ni uno

La asimetría es deliberada y tiene precedente en las dos direcciones:

- **Del actor se copia el correo**, además del id. Es lo que ya hace `audit()` (`audit.ts:41-42`) y lo que `flito_estado_historial` hace con `usuario_email`, con su motivo escrito en `schema.ts:3403-3404`: *«si el usuario se borra, el historial debe seguir diciendo quién lo hizo»*. RN-A10 lo autoriza explícitamente: es el autor del acto.
- **Del titular no se copia nada.** Ni correo, ni documento, ni teléfono, ni nombre, ni `username`. Se guardan `titular_user_id` (entero interno) y `titular_rol` (varchar), que es literalmente lo que RN-A10 permite y la misma forma que ya usa `pii_access_log` con `user_id` + `user_role` (`schema.ts:2132-2133`).
- **El nombre visible del titular se resuelve por JOIN a `users` en la lectura**, no se persiste. Consecuencias: el registro no envejece con PII dentro; una supresión bajo Ley 1581 sobre `users` desaparece de la pantalla sin tocar el historial; y la pantalla no muestra del titular nada que el módulo de usuarios no muestre ya (AC4), porque muestra exactamente el mismo `username` que lista `users.routes.ts:181`.

Tres cierres, no uno, porque una promesa en un comentario no es un control:

1. **Tipo** (punto 2): no existe firma capaz de recibir la fila entera del titular.
2. **Lista blanca de campos** en `packages/shared-types`, congelada, con un test que asegura su contenido exacto — añadir `'email'` deja el test en rojo.
3. **CHECK en base** sobre `(entidad, campo)`, para que un INSERT crudo tampoco pueda inventarse un campo fuera de la lista.

Y el caso del secreto, aparte: el restablecimiento de contraseña (`users.routes.ts:52`) **es** un acto auditable, así que se registra con `campo = 'password'` y `valor_antes = valor_despues = NULL`. El hecho es la fila; no hay valor. Con un CHECK que lo hace obligatorio, de modo que ni un hash ni un fragmento puedan entrar por ahí.

### 5. `ON DELETE` de las dos FKs hacia `users`: **`RESTRICT` en ambas, por motivos distintos** (ADR-0005)

Las dos caen en la categoría «auditoría / prueba» de ADR-0005, y las dos llevan la cláusula explícita que ese ADR exige. Pero conviene justificarlas por separado, porque lo que rompería cada una es distinto:

- **`actor_user_id` → `RESTRICT`.** Viaja emparejada con `created_at`; la regla 2 de ADR-0005 prohíbe `SET NULL` en ese caso literal. Y hay un motivo propio: si el actor se pudiera anular en silencio, **la forma de borrar el propio rastro sería conseguir que borren tu usuario**. Copiamos también `actor_email`, así que un `SET NULL` no dejaría la fila muda del todo —dejaría un correo suelto sin identidad verificable detrás—, y es precisamente el par id+correo lo que un auditor usa para sostener una imputación. La columna es **nullable** aun así, pero `NULL` significa **«sistema»**, no «se desconoce»: lo fija el `origen` y lo obliga un CHECK, con el mismo criterio que `estado-historial.ts:21-24` y que `flito-sync.service.ts:94`, que ya escribe `userId: null` para el sync.
- **`titular_user_id` → `RESTRICT`.** Con `SET NULL` la fila diría «a alguien le quitaron `soat.solicitud.crear` el 3 de marzo»: un cambio sin sujeto, que además infla el conteo de cambios sin permitir atribuir ninguno. Y hay una segunda razón que no aplica al actor: **todo el diseño de PII del punto 4 se apoya en el JOIN a `users`**; si el enlace se puede anular, la fila deja de ser legible sin haber ganado nada. Además es coherente con RN-A7 y con el AC1 de la #12089: la baja del usuario es lógica y la fila nunca se borra, así que un `DELETE` real sobre `users` es exactamente lo que debe fallar ruidosamente.

- **`titular_rol_codigo`: sin FK, a propósito.** Aquí la aplicación mecánica de ADR-0005 daría el resultado equivocado, y por eso se declara: la FK no es hacia `users`, es hacia `permisos_roles`, y **cualquiera de las dos cláusulas rompe algo**. Con `RESTRICT`, todo rol que haya cambiado alguna vez tendría filas de auditoría y **nunca podría borrarse**, dejando CF-05 y el AC3 de la #12084 en código muerto. Con `CASCADE`, borrar un rol borraría su historia, que es justo lo que un auditor va a buscar. Se copia el código como texto y sin FK, con el mismo razonamiento que `flito_estado_historial` usa para no referenciar `flito_soat`/`flito_impuestos` (`schema.ts:3390-3392`): la integridad la dan el discriminador y el filtro del lector.

### 6. El escritor va **dentro** de la transacción y **no** se traga los errores

`registrarCambioPermisos(ex, cambio)` recibe el ejecutor —conexión o transacción abierta— igual que `registrarCambio` (`estado-historial.ts:53`), porque el AC1 de la #12087 exige que la escritura del conjunto vaya en la misma transacción que el alta o la edición.

Y **sin `try/catch`**, que es la decisión contraria a la de `audit()` y está tomada con el mismo argumento que ya está escrito en `estado-historial.ts:49-52`: *«si el historial no se puede escribir, el cambio de estado tampoco debe confirmarse»*. Para CF-19 esto no es una preferencia: una fila que falta en silencio es el fallo que la `0115` tuvo que ir a limpiar a mano.

## Alternativas consideradas

### Opción A — `before_state`/`after_state` jsonb en `audit_logs` + parámetro opcional en `audit()`

| | |
|---|---|
| **Pros** | Una sola tabla y un solo concepto de auditoría; el `ADD COLUMN … jsonb` nullable y sin `DEFAULT` es instantáneo en PostgreSQL 11+, sin reescritura; el parámetro es opcional, así que las **312** llamadas siguen compilando sin tocarlas (AC1 satisfecho al pie de la letra); cualquier módulo gana el par gratis; alinea `audit_logs` con `laft_audit_log`. |
| **Contras** | **El radio de PII es el contrario del que hace falta.** El campo queda disponible para 312 puntos de llamada en ~50 módulos que manejan conductores, propietarios, VIN y cédulas; nada impide `before: filaEntera`, y con la tabla sin `REVOKE` (hallazgo 1) y sin purga ejecutada (hallazgo 2) esa PII sería **imborrable en la práctica** — que es exactamente el peligro que `0132:101` intentaba conjurar creyendo que la tabla estaba protegida. **No hay columna para el titular**: `resource_id varchar(50)` lo guardaría como texto sin FK, así que ADR-0005 **no se puede aplicar** y el filtro «por usuario afectado» del AC2 sería un `WHERE resource='user' AND resource_id='47'` sobre un varchar. Y `resource_id` tiene un tope de 50 con un historial de rechazos silenciosos (`audit.ts:20-33`). **`audit()` se traga los errores** (`:52-53`), de modo que la evidencia de CF-19 podría no existir sin que nadie se entere. Un índice no parcial para el AC2 lo pagarían las 312 llamadas en cada escritura; uno parcial hereda el patrón de `0068` pero deja el resto de la tabla igual de ilegible. Y el `ON DELETE` de la FK está en deriva (hallazgo 3), así que la evidencia se apoyaría en una constraint que nadie sabe cómo se comporta. |
| **Esfuerzo** | S (la migración). M si se cuenta el gobierno permanente del campo nuevo. |
| **Riesgo** | **Alto y permanente.** El coste no está en la migración, está en que cada HU futura de cualquier módulo pueda meter PII en un vertedero sin retención efectiva ni control de escritura. |

### Opción B — Tabla propia `permisos_auditoria` (**elegida**)

| | |
|---|---|
| **Pros** | Es el patrón que este repo ya eligió dos veces para este mismo problema —`flito_estado_historial` y `laft_audit_log`—, no un invento. Columnas tipadas para el titular y el actor, cada una con su `ON DELETE` explícito según ADR-0005. **Radio cero** sobre las 312 llamadas y los 13 INSERT directos. La lista blanca de campos es enumerable porque el escritor es uno solo y los llamadores son tres, no cincuenta. Presupuesto de índices propio: se pueden poner cuatro sin que lo pague ninguna ruta de tráfico. Retención, `REVOKE` y guardas propios, sin arrastrar los de PESV ni los de LAFT. Escritura transaccional y ruidosa, imposible sobre `audit()`. |
| **Contras** | **Dos sitios donde mirar** un cambio de usuario: `audit_logs` seguirá teniendo sus cinco filas de `resource='user'` y la tabla nueva tendrá el historial. Riesgo real de divergencia y de que alguien pregunte cuál manda. Una tabla más que mantener, con su migración, su `schema.ts` y sus tipos. Y el historial **empieza en cero** (ver más abajo). |
| **Esfuerzo** | M |
| **Riesgo** | Bajo y acotado. La mitigación de la divergencia es la misma que ya funcionó con `flito_estado_historial`: `audit_logs` es la bitácora de cumplimiento y la nueva es el historial consultable; la pantalla del AC3 dice cuál está mirando. |

### Opción C — Reutilizar `laft_audit_log` ampliando su alcance

| | |
|---|---|
| **Pros** | Los campos `before_state`/`after_state` ya existen y ya son `jsonb` (`schema.ts:885-886`); ya hay índices por recurso y por usuario (`:889-891`); ya está protegida con `REVOKE UPDATE, DELETE` (`0011_laft_module.sql:112-115`); cero migraciones de esquema. |
| **Contras** | **El rol no cuadra**: su lector es `requireRole('admin','compliance')` (`laft/audit.routes.ts:8`) y CF-19 exige `auditor`; abrirla a `auditor` le daría acceso a toda la traza SARLAFT, y meter permisos dentro obligaría a que `compliance` viera los cambios de usuarios. Se ensancharían **dos** audiencias para resolver una. **La retención choca de frente**: sobre LAFT rige conservación 10 años + anonimización por Ley 1121/2006 y circular UIAF (`0067_laft_anonimizacion_post_10y.sql:1-13`), que no tiene nada que ver con un cambio de permisos. **El `REVOKE` juega en contra**: `operaciones_app` no puede borrar de ahí, así que cualquier retención futura de lo nuestro sería imposible desde la app. Tampoco tiene columna de titular. Y **no tiene lector en el producto**: `grep "laft/audit"` en `apps/web` no devuelve nada (lo que aparece es `/laft/audit-plan`, otro endpoint), así que la parte de CF-19 que hoy nadie entrega tampoco la resolvería. Por último, mezcla dos marcos legales distintos en una tabla cuyo nombre dice `laft`. |
| **Esfuerzo** | S en código, L en consecuencias. |
| **Riesgo** | Alto: contamina el valor probatorio de SARLAFT con datos de otro dominio y de otro plazo. |

### Opción D — Descartada sin desarrollar: reconstruir por diferencia al leer

Guardar solo el estado actual y calcular el antes/después comparando versiones al consultar. No se desarrolla como alternativa formal porque **CF-19 pide campos consultables**, y una diferencia calculada al vuelo no lo es; además vuelve a depender de que no falte ninguna versión, que es el supuesto que la `0115` ya demostró falso.

## Decisiones derivadas que este ADR también cierra

### Retención

- **De `permisos_auditoria`:** **6 años, `archivar_offline`**, declarada como fila en el registro que ya existe, `pesv_retencion_politicas` (`0060_pesv_s9_menores.sql:98-110`): `tipo_documento = 'permisos_auditoria'`, `base_legal = 'Ley 1581/2012 art. 11 + ISO 27001 A.12.4'`. Seis años y no diez para que no diverja de la fila `('audit_log', 6, …)` que ya está sembrada en `:231`: un auditor que compare las dos bitácoras a través del corte no debe encontrar una purgada y la otra no.
- **El plazo se declara; el mecanismo no se construye en esta HU.** El cron es DRY-RUN global (`pesv/retencion.cron.ts:74`) y convertirlo en purga real afectaría a la vez a `audit_logs`, `pii_access_log`, `alcohol_tests`, `checklists`, `manifiestos`, `road_incidents` y `pesv_comite_actas`. Eso es un proyecto, no un AC de la #12171.
- **La retención de `audit_logs` NO se toca en esta HU.** Su política existe desde la `0060`; lo que falta es quien la ejecute. **Corrección al enunciado del Feature: no es cierto que «no exista política»; lo que no existe es su ejecución.**
- **Dónde se decide cada cosa** — tres asuntos distintos, tres dueños:
  1. Retención de `permisos_auditoria` → **aquí**, en este ADR (fila del registro).
  2. Retención de la bitácora de intentos denegados de CF-20 → **HU [#12082](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12082)**, cuyo AC6 ya la exige: *«la permanencia está decidida antes de elegir dónde se escribe»*.
  3. **Mecanismo** de ejecución de la retención declarada (incluida la de `audit_logs`) → **work item de deuda técnica por crear**, con título propuesto *«Ejecutar la retención declarada: convertir el cron PESV de DRY-RUN a purga real»*. **Su ID se escribe aquí y en el PR cuando se cree**; no se inventa un número en este documento. Crearlo es requisito de cierre del AC5 de la #12171.
- Bono medido, para que nadie confunda esto con un problema de capacidad: `permisos_auditoria` la escriben **actos de administración**, no tráfico. Su retención es una obligación de Habeas Data, no una defensa contra el crecimiento. Lo contrario ocurre con `audit_logs`, que recibe 312 puntos de llamada de tráfico de producto y **sí** tiene un problema de capacidad sin resolver.

### Escritura: `REVOKE`, no disparador WORM

`permisos_auditoria` lleva `REVOKE UPDATE, DELETE … FROM PUBLIC` y `FROM operaciones_app`, copiando `0011_laft_module.sql:112-115`. **No** lleva disparadores WORM al estilo de `siigo_operaciones` (`0126:47-61`): un disparador `BEFORE DELETE` que lanza excepción haría **imposible** ejecutar la retención de 6 años que acabamos de declarar, incluso desde una migración con superusuario. `REVOKE` deja la tabla intocable para la aplicación y purgable por un trabajo privilegiado, que es exactamente el reparto que hace falta.

### Migración de lo ya escrito: **se empieza limpio, sin backfill**

- El texto que hay que backfillear es `Cambios: allowedPages` (`users.routes.ts:395`). Nombra **el campo, no los valores**: el «antes» de los permisos nunca llegó a escribirse. Un backfill produciría filas con `valor_antes = NULL` y `valor_despues = NULL`, es decir, filas que afirman un cambio y no pueden responder la pregunta por la que existe la HU.
- Donde el texto **sí** lleva el par —rol (`(rol: X→Y)`, `:395`) y estado activo (`Estado: activo → inactivo`, `:433`)— el backfill es técnicamente posible, y la `0115` demostró cómo hacerlo bien: extracción por expresión fija, tres cortafuegos y marca `origen='auditoria'` para que nadie confunda lo reconstruido con lo de primera mano (`0115:92-140`). **Aun así se descarta**, y este es el juicio del ADR: reconstruir rol y estado mientras los permisos —que son la razón de ser de CF-19— quedan irrecuperables produciría una pantalla **que parece completa y no lo es**. Eso es literalmente el fracaso que el Feature anticipa: *«CF-19 se cumplirá sobre el papel y no en la práctica»*. Es preferible un historial vacío con su fecha de inicio declarada que uno parcial con aspecto de íntegro.
- **Lo que sí se hace:** la columna `origen` nace con el valor `'auditoria'` admitido y sin usar, para que un futuro backfill —si alguien lo pide con el alcance claro— pueda añadirse sin migración y quedando distinguible. Y la pantalla del AC3 muestra el suelo temporal: «el historial comienza el `<fecha de la migración>`; lo anterior está en la bitácora de auditoría».
- Nota de precisión sobre el enunciado: **no son «6 filas»**, son 6 puntos de llamada en `users.routes.ts` (`:52, :184, :240, :393, :431, :451`). Cuántas filas hay en la base no se pudo medir en este worktree (`localhost:5434` rechazó la conexión) y no cambia la decisión.

### Deuda que este ADR deja anotada y **no** resuelve

1. **`audit_logs` no tiene `REVOKE`** y el comentario de `0132:101` afirma lo contrario. Corregirlo es una migración de una línea, pero fuera del alcance de la #12171: cabe en el mismo work item de retención, o en uno propio. **Que el comentario mienta es lo más peligroso**, porque induce a decisiones —como la opción (A)— tomadas sobre una garantía inexistente.
2. **Deriva del `ON DELETE` de `audit_logs.user_id`** (`set null` en `schema.ts:697` contra `no action` en `0001:16`). ADR-0005 ya decidió no migrar FKs existentes; esto solo se anota para que quien lea `schema.ts` no dé por cierta la cláusula.
3. Ninguna de las dos bloquea esta HU: la opción elegida no se apoya en `audit_logs`.

## Consecuencias

**Positivas**

- Las cuatro HU bloqueadas se desbloquean con **un** artefacto compartido: `shared/historial/permisos-auditoria.ts`. La #12084, la #12087 y la #12089 lo invocan; no negocian formato entre ellas.
- CF-19 queda cumplido en las dos mitades: campos consultables (tabla) y pantalla (AC3), que es la mitad que hoy no entrega nadie.
- RN-A10 pasa de ser una promesa a un control con tres cierres, uno de ellos en el compilador.
- `audit_logs` no cambia: cero riesgo sobre 312 llamadas, 13 INSERT directos, ~50 módulos y los dos lectores existentes (`flito-bitacora`, PESV).
- ADR-0005 gana su segunda aplicación, y con ella el primer caso documentado en que la regla se **no** aplica por buen motivo (`titular_rol_codigo`), que es lo que impide que se vuelva un ritual.

**Negativas y a asumir**

- **El historial empieza en cero.** El primer mes la pantalla estará casi vacía, y alguien pedirá el backfill. La respuesta está escrita arriba y debe llegar a la UX: el suelo temporal es visible.
- **Dos tablas para «lo que le pasó a un usuario».** Convivirán las cinco filas de `resource='user'` de `audit_logs` y el historial nuevo. Quien busque en la base sin leer esto se confundirá. Mitigación: `COMMENT ON TABLE` en las dos direcciones y la nota en la pantalla.
- **Un fallo al escribir el historial tumba el cambio** (punto 6). Es lo buscado, y significa que un administrador puede recibir un 500 al guardar si la tabla nueva falla. Mitigación: es un `INSERT` en una tabla sin disparadores ni FK hacia catálogos volátiles; la superficie de fallo es la de la propia transacción.
- **La lista blanca de campos hay que mantenerla.** Cada campo nuevo de `users` que deba auditarse exige tocar tres sitios (tipo, constante, CHECK). Es fricción deliberada: es lo que impide que el campo 43 entre sin que nadie mire si es PII.
- **`RESTRICT` en las dos FKs** hará fallar cualquier borrado real de un usuario que haya sido actor o titular de un cambio de permisos — es decir, prácticamente cualquiera. Es lo buscado (RN-A7 dice que ese borrado no debe existir), pero quien se lo encuentre necesitará saber que la salida es una migración deliberada de reasignación o anonimización, no aflojar la constraint.

**Neutras**

- Sin dependencias nuevas: Drizzle, Zod y `jsonb` ya están en el repo. `jsonb` ya se usa en `laft_audit_log` (`schema.ts:885-886`) y en `siigo_factura_envios`, que además ya tiene precedente de índice `gin (… jsonb_path_ops)` (`0141_siigo_factura_envios.sql:122`) por si algún día hiciera falta buscar dentro del valor. Hoy **no** hace falta: ninguna consulta del AC2 filtra por el contenido del `jsonb`.
- No cambia ningún contrato existente de `packages/shared-types`; solo añade un archivo.

## Cómo verificar que quedó como dice este ADR

```sql
-- 1. Las dos FKs hacia users son RESTRICT ('r'). Una 'n' es la mutación silenciosa a impedir.
SELECT conname, confdeltype
  FROM pg_constraint
 WHERE conrelid = 'permisos_auditoria'::regclass AND contype = 'f';

-- 2. La app no puede reescribir ni borrar el historial.
SELECT has_table_privilege('operaciones_app', 'permisos_auditoria', 'UPDATE') AS puede_update,
       has_table_privilege('operaciones_app', 'permisos_auditoria', 'DELETE') AS puede_delete;
-- esperado: false, false

-- 3. La contraseña nunca lleva valor.
SELECT count(*) FROM permisos_auditoria
 WHERE campo = 'password' AND (valor_antes IS NOT NULL OR valor_despues IS NOT NULL);
-- esperado: 0  (y el CHECK debería haberlo impedido antes)

-- 4. La política de retención quedó declarada.
SELECT retencion_anios, accion, base_legal
  FROM pesv_retencion_politicas WHERE tipo_documento = 'permisos_auditoria';
-- esperado: 6 | archivar_offline | Ley 1581/2012 art. 11 + ISO 27001 A.12.4
```

Y en el repo:

```bash
# 5. Ningún campo fuera de la lista blanca. Un 'email' o un 'name' aquí es bloqueante.
grep -n "CAMPOS_AUDITABLES" -A 20 packages/shared-types/src/permisos-auditoria.ts

# 6. audit_logs no se tocó.
git diff develop -- apps/api/src/db/schema.ts | grep -c "audit_logs"   # esperado: 0
```

## Notas operativas por agente

- **backend-agent** — El escritor es **uno** (`shared/historial/permisos-auditoria.ts`) y recibe el ejecutor de la transacción. No lo llames desde la ruta después del `commit`: el AC1 de la #12087 exige lo contrario. No le pongas `try/catch`. Y no añadas un parámetro que acepte objetos libres: es lo único que sostiene el punto 4.
- **db-review-agent** — Tres hallazgos bloqueantes en la revisión de la migración: (a) una FK hacia `users` sin cláusula explícita o con `SET NULL`; (b) `titular_rol_codigo` **con** FK (rompe CF-05); (c) un disparador WORM en vez de `REVOKE` (haría imposible la retención declarada).
- **security-agent** — Lo que hay que atacar no es el endpoint, es el escritor: intenta pasarle la fila entera de `users` y comprueba que no compila; intenta un `INSERT` crudo con `campo='email'` y comprueba que el CHECK lo rechaza; comprueba que el DTO de lectura no expone `users.email` del titular. Y toma nota de los dos hallazgos de deuda: `audit_logs` **no** tiene `REVOKE` pese a lo que afirma `0132:101`.
- **qa-agent** — Las tres mutaciones nombradas del AC6 de la #12171 aplican tal cual. Añade una cuarta: cambiar `RESTRICT` por `SET NULL` en `titular_user_id` deja el esquema válido, todos los tests funcionales en verde y el historial ilegible — es el eje que ADR-0005 pide vigilar. Ojo con `TZ=UTC` en cualquier aserto sobre el filtro de rango de fechas.
- **frontend-agent** — La pantalla resuelve el nombre del titular con lo que devuelve el endpoint; **nunca** llames a `/api/users` para «completar» el nombre y no guardes el id del titular en la URL del router (AC3).

## Relación con otros ADR

- **ADR-0005** (`Propuesto`) — este ADR es su **segunda aplicación**: clasifica las dos FKs nuevas como «auditoría / prueba» → `RESTRICT` explícito, y documenta un caso donde la regla **no** aplica porque la FK no apunta a `users` (`titular_rol_codigo`). No lo contradice ni lo modifica.
- **ADR-0015** (`Propuesto`, HU #12169) — apareció en el árbol de trabajo mientras se escribía este ADR. Convierte `users.role` en `varchar(40)` con FK hacia `permisos_roles(codigo)`. **Compatible sin cambios**: este ADR guarda `rol_afectado_codigo varchar(40)` y deliberadamente **sin** FK (§5), así que la conversión de ADR-0015 no lo afecta y este no interfiere con CF-05. Si ADR-0015 cambiara la PK a `serial` (su Opción 2, descartada), habría que revisar §5 de este.
- **ADR-DB-001** — la migración de este ADR **no lleva `BEGIN`/`COMMIT`**: el runner envuelve cada archivo y rechaza con `exit 2` cualquier migración `>= 0071` que traiga control de transacción propio (`apps/api/src/scripts/db-apply.ts:102-127`). Las migraciones `0060` y `0067` que este ADR cita sí lo llevan porque están indultadas por ser `<= 0070`; no son modelo a copiar en ese punto. **Hallazgo colateral:** el propio runner remite a `docs/runbook/adr-db-001-migration-transaction-policy.md` (`db-apply.ts:124`) y **ese archivo no existe** — `docs/runbook/` no existe en el repo. ADR-DB-001 hoy solo vive en el código y en sus tests (`apps/api/__tests__/scripts/db-apply.test.ts`), así que quien tropiece con el `exit 2` no tiene dónde leer la política. No bloquea nada; se anota para quien recoja la deuda de documentación.
- **ADR-0012** (`Propuesto`) — comparte criterio: registrar el acto sin arrastrar el dato personal. Allí fue el HMAC del VIN en `pii_access_log`; aquí es el id + rol del titular con el nombre resuelto por JOIN. Sin dependencia técnica entre ambos.
- Este ADR **no supersede** a ninguno.
