# ADR-0016 — La bitácora de intentos denegados es una tabla propia con un contador por (usuario, función, hora), sin PII y con retención de 2 años

## Estado

**Propuesto** — 2026-09-10. Pendiente de aprobación del Líder Técnico (David Chica). HU [#12082](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12082) (Feature [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072)), AC6 y CF-20.

**Diseño detallado**: [`docs/diseno-hu-12082-motor-permisos.md`](../diseno-hu-12082-motor-permisos.md) — el resolutor, `exigirFuncion`, la frontera del canal, la migración 0180 y la lista de archivos. Este ADR decide **solo** dónde y cómo se registra el intento denegado, porque es la única decisión de la HU que sienta precedente y que el AC6 exige cerrar *antes* de elegir dónde se escribe.

**Se apoya en** [ADR-0014](./ADR-0014-registro-antes-despues-usuarios-y-permisos.md) (que ya repartió los tres asuntos de retención y asignó el de esta bitácora a la #12082), [ADR-0005](./ADR-0005-flito-fk-users-auditoria-on-delete.md) (cláusula `ON DELETE` explícita hacia `users`) y ADR-DB-001 (sin `BEGIN`/`COMMIT` en la migración).

**Se aparta deliberadamente** del patrón WORM de `siigo_operaciones` que el propio AC de la HU nombra como modelo («se hereda su forma»): la *forma del middleware* sí se hereda de `siigo.permisos.ts`; el *destino* no, porque una tabla que prohíbe `UPDATE` por disparador no puede tener un contador.

**No contradice ningún ADR aceptado.**

---

## Contexto medido (verificado sobre el worktree `HU/12082-davidchica-motor-permisos` @ `ee4a60c`, 2026-09-10)

| Hecho | Dónde |
|---|---|
| El patrón a heredar registra el intento denegado en `siigo_operaciones` con `operacion='permiso_denegado'`, id numérico y rol, «nunca su correo», y **sin `await`** en el camino de respuesta | `apps/api/src/modules/siigo/siigo.permisos.ts:80-97` y `:119` |
| `siigo_operaciones` prohíbe `UPDATE` y `DELETE` **por disparador** | `db/migrations/0126_siigo_operaciones_worm.sql:47-61` (citado por ADR-0014) |
| Sus columnas `ambiente` y `modo` son `NOT NULL` y específicas de Siigo | `schema.ts:4209-4211` |
| `audit_logs.action` es un **enum de PostgreSQL** (`audit_action`) sin ningún valor de «denegado»; añadirlo sería `ALTER TYPE … ADD VALUE`, que la HU excluye | `schema.ts:113-119`, `:795` |
| `audit_logs` copia `user_email`, no tiene clave única con la que deduplicar, no tiene `REVOKE` y su retención declarada (6 años) no tiene mecanismo (`retencion.cron.ts` es DRY-RUN) | ADR-0014, hallazgos 1 y 2; `schema.ts:791-805` |
| `pii_access_log` ya resuelve «registrar sin PII» con `user_id` + `user_role` | `schema.ts:2226-2239` |
| El registro de políticas de retención existe y su siembra es **condicional a `users.id = 1`** | `0060_pesv_s9_menores.sql:98-110` y `:233-235` |
| `apiLimiter` da **500 peticiones / 15 min por IP** a todo `/api` | `shared/middleware/rateLimiter.ts:84-91`, montado en `app.ts:221` |
| Una sola instancia del API (PM2 `fork`, un servicio en compose) | `ecosystem.config.cjs`, `docker-compose.prod.yml` |
| `schema.ts` está en **3353 sloc** contra el techo congelado de **3400** | `npx eslint apps/api/src/db/schema.ts --rule max-lines` |

### Lo que el AC6 exige, en cuatro frases

1. Registrar método, ruta sin query y recortada, código de función, rol e **id numérico** del usuario. Nada más.
2. Deduplicar por **(usuario, función, ventana)**: 10.000 reintentos no son 10.000 filas.
3. Decidir la **permanencia** antes de elegir el destino.
4. Un fallo al escribir **no** convierte el 403 en 500.

---

## Decisión

**Tabla propia `permisos_intentos_denegados`, una fila por (`user_id`, `funcion_codigo`, `ventana_inicio`) con contador `veces`, escrita con un solo `INSERT … ON CONFLICT DO UPDATE` sin `await` en el camino de respuesta, sin ningún dato personal, y con retención declarada de 2 años con acción `purgar`.**

### 1. La fila es un contador, no un evento

La clave única es `(user_id, funcion_codigo, ventana_inicio)` con `ventana_inicio = date_trunc('hour', now())`. La ventana es **una hora** (constante `VENTANA_DEDUP_MS` en código, declarada en el PR):

- Cota dura: por cada par (usuario, función) hay **como máximo 24 filas al día**, haga lo que haga el usuario. 10.000 reintentos en bucle son **una** fila con `veces = 10000`, o dos si el bucle cruza una hora en punto.
- Resolución suficiente para lo que la bitácora sirve —detectar un rol mal configurado o un usuario sondeando—: «id 7 recibió 340 veces 403 en `soat.solicitud.crear` entre las 10:00 y las 11:00» es una frase que un administrador puede usar; «…el 3 de marzo» ya no.
- Una ventana **diaria** daría 365 filas/año por par; una **horaria**, 8.760. Sobre 10 usuarios y un puñado de funciones negadas por usuario, las dos son ruido. Se elige la horaria por la resolución, no por el tamaño.

`primera_vez` se fija al crear la fila y no se toca; `ultima_vez`, `veces`, `motivo`, `metodo` y `ruta` se actualizan en cada conflicto (**lo último que pasó**, con `primera_vez` conservando cuándo empezó).

### 2. Qué se guarda y qué no

| Columna | Origen | Por qué es admisible |
|---|---|---|
| `user_id integer` | `req.user.sub` (del JWT verificado) | Id interno, la misma forma que `pii_access_log.user_id` y `siigo_operaciones.created_by`; RN-A10 lo permite |
| `rol_codigo varchar(40)` | `req.user.role` (del JWT verificado) | Solo para el texto; **sin FK** a `permisos_roles` por el mismo motivo que ADR-0014 §5: con `RESTRICT` un rol borrado dejaría su historial bloqueando CF-05; con `CASCADE` borrar el rol borraría la señal |
| `funcion_codigo varchar(80)` | el literal que la ruta pasó a `exigirFuncion` | **Sin FK** a `permisos_funciones`: el caso «función no reconocida» guarda a propósito un código que **no está** en el catálogo. Es un literal escrito por un programador en una ruta, nunca un dato del cliente |
| `motivo varchar(16)` | `sin_funcion` · `sin_modulo` · `no_reconocida` · `no_resuelto` | El CHECK lo acota |
| `metodo varchar(10)` | `req.method` | — |
| `ruta varchar(300)` | la **plantilla** de la ruta (`req.baseUrl + req.route.path`, p. ej. `/api/privacy/preview/:docNumber`) cuando la guarda va a nivel de ruta; si va a nivel de router (`router.use`) y `req.route` no existe, `req.originalUrl` **sin query** con cada segmento con pinta de dato sustituido por `*` (≥5 dígitos seguidos, placa, VIN, ≥24 alfanuméricos/hex/base64url, correo con `@`/`%40`). Recortada a 300. **Regla para la #12083: montar `exigirFuncion` a nivel de ruta** (`router.get(path, exigirFuncion(...), h)`), no con `router.use`: el camino de la plantilla no depende de ninguna heurística | **Nunca el dato.** Corrección del security-review de la #12082: hay rutas con cédula (`privacy.routes.ts:454 /preview/:docNumber`), placa (`flito-derechos.routes.ts:162 /candidatos/:placa`), VIN (`vehicles.routes.ts:435-449 /:vin/...`), 22 `/:token` y 6 `/:keyHash` en el PATH. Hoy no pasan por `exigirFuncion`; **es condición de la #12083** que al montar la guarda sobre ellas la bitácora siga sin guardar el dato, y `rutaDe` ya lo garantiza por construcción. Es más estricto que `siigo_operaciones.ruta` (que sí guarda el `originalUrl` sin query), a propósito |
| `ventana_inicio`, `primera_vez`, `ultima_vez`, `veces` | el propio escritor | — |

**No hay** `username`, `email`, `name`, `ip_address`, `user_agent`, `body`, `mensaje` libre ni `detail`. La ausencia de una columna de texto libre es el cierre estructural: no hay dónde meter un correo aunque alguien quiera. El TC AC6 (#12265) lo afirma con datos sintéticos en query, cuerpo y username.

### 3. `ON DELETE RESTRICT` hacia `users` (ADR-0005)

La fila es «el registro de algo hecho *por* una persona»: categoría **auditoría / prueba** → `RESTRICT` explícito. Con `SET NULL` quedaría «alguien intentó 340 veces» sin sujeto (la regla 2 del ADR-0005 lo prohíbe además por la pareja con `ultima_vez`); con `CASCADE`, borrar al usuario borraría la señal que justamente puede explicar por qué se lo borró. RN-A7 dice que el borrado de usuarios es lógico, así que la constraint no estorba a ningún flujo real; si algún día hay supresión física, la salida es la retención del punto 5, no aflojar la cláusula.

### 4. El escritor nunca lanza y nunca se espera

- `registrarIntentoDenegado()` envuelve el UPSERT en `try/catch`, hace `log.warn` con `userId` y el mensaje del error (sin PII) y **resuelve** siempre — la forma de `registrarOperacion` (`siigo.operaciones.repo.ts:77-79`).
- `exigirFuncion` lo invoca como `void registrar(...).catch(() => undefined)` **antes** de `res.status(403)` y sin `await` — la forma de `exigirAccionSiigo` (`siigo.permisos.ts:119-120`). El `.catch` es cinturón sobre tirantes: en Node ≥ 15 una promesa rechazada sin dueño tumba el proceso.
- Es la decisión **contraria** a la de `permisos_auditoria` (ADR-0014 §6, sin `try/catch`) y por un motivo distinto: allí una fila que falta falsea un historial de cambios; aquí una fila que falta es un contador que no subió, y el 403 —que es la decisión de seguridad— ya se dio. **CF-20 pide que el registro no pueda llenar el disco, no que sea evidencia.**

### 5. Retención: **2 años, `purgar`**, declarada en `pesv_retencion_politicas`

Fila `('permisos_intentos_denegados', 2, 'ISO 27001 A.12.4 / Ley 1581 art. 11', 'purgar', …)` sembrada por la 0180, **condicionada** a que exista un `admin` (la columna `created_by` es `NOT NULL` con FK a `users`), y repetida en `COMMENT ON TABLE` para que la política sobreviva a una base donde la siembra condicional no corra (memoria del repo: la 0060 tampoco siembra en una base recién creada).

Por qué **no** los 6 años de `audit_log` y `permisos_auditoria`:

- ADR-0014 alineó `permisos_auditoria` con `audit_log` para que «un auditor que compare las dos bitácoras a través del corte no encuentre una purgada y la otra no». Ese argumento vale entre dos bitácoras **de los mismos actos**. Un contador de 403 por hora no es el registro de un acto de administración; es una señal operativa, y no aparece en ninguna otra tabla con la que se pueda comparar.
- `user_id` es dato personal en sentido amplio (identifica a una persona a través de `users`). Ley 1581 art. 11 pide no conservar más de lo necesario para la finalidad; la finalidad —detectar configuración errónea o sondeo— caduca con dos ciclos anuales de auditoría.
- `purgar` y no `archivar_offline`: un contador agregado no tiene valor probatorio individual que justifique el archivo.

**El mecanismo no se construye aquí**: es la HU [#12215](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12215), como ya fijó ADR-0014. Hasta entonces la tabla crece; la cota del punto 1 dice cuánto como máximo, y es lo que hace tolerable esperar.

### 6. Sin `REVOKE`, a diferencia de `permisos_auditoria`

El escritor necesita `UPDATE` (es un contador) y la retención necesita `DELETE` desde el trabajo que la ejecute. Un `REVOKE UPDATE, DELETE` como el de `laft_audit_log` (`0011:112-115`) haría imposible el diseño. La tabla queda con los privilegios por defecto que reciben las de la 0178 y la 0179, que tampoco declaran `GRANT` alguno.

---

## Alternativas consideradas

### Opción A — Reutilizar `audit_logs`

| | |
|---|---|
| **Pros** | Cero tablas nuevas; ya tiene `user_id`, `resource`, `resource_id`, índice por `created_at` y por `user_id`; los dos lectores de bitácora (`flito-bitacora`, PESV) podrían mostrarlo. |
| **Contras** | **`action` es un enum de PostgreSQL** sin valor para «denegado»: hacerlo bien exige `ALTER TYPE … ADD VALUE`, que la HU excluye; hacerlo mal (`action='view'`) miente. **No hay clave única con la que deduplicar** —la única forma sería un `SELECT` + `UPDATE` no atómico, o una `UNIQUE` parcial nueva sobre una tabla con 312 escritores. **Copia `user_email`** por diseño (`audit.ts:41-42`), exactamente lo que el AC6 prohíbe; habría que pasar por un camino distinto de `audit()` y dejar la columna vacía, es decir, usar la tabla sin usar su escritor. Sin `REVOKE` y con retención sin mecanismo (ADR-0014 hallazgos 1-2), 10.000 reintentos serían 10.000 filas imborrables en la práctica. Y `resource_id varchar(50)` no cabe un `funcion_codigo varchar(80)`. |
| **Esfuerzo** | S en apariencia; M real (el enum). |
| **Riesgo** | Alto: es la tabla con problema de capacidad conocido, y CF-20 trata de capacidad. |

### Opción B — Reutilizar `siigo_operaciones` (el destino del patrón heredado)

| | |
|---|---|
| **Pros** | Es literalmente lo que hace `exigirAccionSiigo`; el escritor (`registrarOperacion`) ya no lanza, ya sanea, ya guarda id + rol y no correo; ya tiene índice por `created_at`. |
| **Contras** | **WORM por disparador**: `UPDATE` está prohibido, luego **no puede haber contador**; cada reintento sería una fila nueva y **no se podrá borrar jamás** — la combinación exacta que el AC6 obliga a decidir *antes* de elegirla. `ambiente` y `modo` son `NOT NULL` y de Siigo: un 403 de `pagina.usuarios` tendría que inventar un ambiente de facturación. Mezcla la bitácora fiscal (HU #11251) con la de permisos de todo el producto, y contamina el tablero de fallos técnicos de Siigo que ya filtra por `resultado`. |
| **Esfuerzo** | S |
| **Riesgo** | Alto e irreversible: cada fila mal puesta es permanente. |

### Opción C — Tabla propia con contador por ventana (**elegida**)

| | |
|---|---|
| **Pros** | Deduplicación **atómica** en una sentencia (`ON CONFLICT DO UPDATE`), sin estado en memoria ni lecturas previas. Cota dura de crecimiento (24 filas/día por par). Columnas exactamente las del AC6 y ninguna más; sin texto libre donde pueda entrar PII. Retención propia, declarable en el registro que ya existe. Radio cero sobre `audit_logs` (312 escritores) y sobre la WORM de Siigo. Mismo prefijo `permisos_` que las cuatro tablas del Feature. |
| **Contras** | Una tabla más en un `schema.ts` a 47 sloc del techo (el modelo cabe en ~18). Otro sitio donde mirar «qué le pasó a un usuario» (ya son `audit_logs`, `permisos_auditoria` cuando exista, y esta); se mitiga con `COMMENT ON TABLE` que diga qué es y qué no es. Cada 403 es una escritura (un `UPDATE` sobre una fila caliente en el caso del bucle) — ver «Opción D» por qué eso se acepta. Sin `REVOKE`: la aplicación puede reescribir el contador; se acepta porque el contador no es evidencia. |
| **Esfuerzo** | M (tabla, modelo Drizzle, escritor, migración, test contra base). |
| **Riesgo** | Bajo. Lo único que hay que vigilar es que nadie añada una columna de texto libre. |

### Opción D — Contador en memoria con volcado periódico (variante de C, descartada)

Acumular en un `Map<(user, funcion), n>` y escribir cada N segundos. Reduce las escrituras del bucle de 10.000 a una por intervalo, pero: pierde el contador si el proceso muere entre volcados, añade un temporizador con ciclo de vida propio en un middleware, y resuelve un problema que **`apiLimiter` ya acota**: 500 peticiones por IP cada 15 minutos (`rateLimiter.ts:85-86`) son 500 `UPDATE` sobre una fila, que PostgreSQL absorbe sin inmutarse. El TC AC6 de deduplicación (#12266) exige que el test unitario de 10.000 vueltas tarde menos de 5 s: con el UPSERT sin `await` lo cumple; con un volcado periódico habría además que probar el temporizador. Se deja escrita por si una medición futura la justifica; hoy no.

---

## Consecuencias

**Positivas**

- CF-20 queda cumplido con una cota que se puede enunciar en una frase y comprobar en una consulta.
- Habeas Data: la tabla no puede contener PII porque no tiene columna donde ponerla. Una supresión bajo Ley 1581 sobre `users` no obliga a tocarla (solo hay un id).
- El destino WORM de Siigo deja de ser el «modelo» implícito para bitácoras de permisos; el patrón que se hereda es el middleware, no la tabla.

**Negativas y a asumir**

- **Un contador se puede reescribir** desde la aplicación (no hay `REVOKE`). Quien quiera evidencia inmutable de un intento tiene que mirar otra cosa; esta tabla no la promete.
- **La retención está declarada y no ejecutada** hasta la #12215. Mientras tanto la cota del punto 1 es la única defensa, y es suficiente.
- **`RESTRICT` hacia `users`** bloqueará el borrado físico de cualquier usuario que haya recibido un 403 alguna vez. Es lo buscado (RN-A7); quien tropiece necesita saber que la salida es purgar por retención, no aflojar la FK.
- **La siembra de la política es condicional** (FK `created_by NOT NULL`): en una base recién creada la fila no existe hasta que exista un `admin`. El `COMMENT ON TABLE` es la copia que no depende de eso; el test de la 0180 comprueba la fila en local.

**Neutras**

- Sin dependencias nuevas. `ON CONFLICT DO UPDATE` ya se usa en el repo; `date_trunc` es SQL estándar.
- No cambia ningún contrato de `packages/shared-types`.

---

## Cómo verificar que quedó como dice este ADR

```sql
-- 1. Un bucle no multiplica filas: tras N intentos del mismo par en la misma hora hay UNA fila.
SELECT user_id, funcion_codigo, ventana_inicio, veces
  FROM permisos_intentos_denegados
 WHERE user_id = <id> AND funcion_codigo = '<codigo>'
 ORDER BY ventana_inicio DESC LIMIT 3;

-- 2. Ninguna columna de texto libre ni de PII.
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'permisos_intentos_denegados';
-- esperado: NO aparecen email, username, name, detail, mensaje, ip_address, user_agent

-- 3. La FK hacia users es RESTRICT ('r').
SELECT conname, confdeltype FROM pg_constraint
 WHERE conrelid = 'permisos_intentos_denegados'::regclass AND contype = 'f';

-- 4. La política quedó declarada (solo si existía un admin al migrar).
SELECT retencion_anios, accion FROM pesv_retencion_politicas
 WHERE tipo_documento = 'permisos_intentos_denegados';
-- esperado: 2 | purgar
```

```bash
# 5. El escritor no se espera en el camino de respuesta y lleva su .catch.
grep -n "registrarIntentoDenegado" apps/api/src/shared/middleware/exigir-funcion.ts
# esperado: 'void registrarIntentoDenegado(...).catch(() => undefined)' ANTES del res.status(403)
```

---

## Notas operativas por agente

- **backend-agent** — El UPSERT es **una** sentencia: `insert(...).values(...).onConflictDoUpdate({ target: [userId, funcionCodigo, ventanaInicio], set: { veces: sql\`${t.veces} + 1\`, ultimaVez: sql\`now()\`, motivo, metodo, ruta } })`. `ventana_inicio` se calcula **en la aplicación** (`Math.floor(Date.now() / VENTANA_DEDUP_MS) * VENTANA_DEDUP_MS`) para que `vi.useFakeTimers` la gobierne en el TC #12266; no uses `date_trunc` en el `VALUES`. No añadas `mensaje`, `detalle` ni ningún `text`.
- **db-review-agent** — Bloqueantes: (a) FK hacia `users` sin cláusula o con `SET NULL`; (b) FK en `rol_codigo` o en `funcion_codigo`; (c) un disparador WORM o un `REVOKE UPDATE` (rompen el contador); (d) una columna de texto libre. Verifica que la `UNIQUE` es exactamente `(user_id, funcion_codigo, ventana_inicio)`.
- **security-agent** — El ataque es contra el escritor, no contra el endpoint: manda PII en query, en cuerpo y en `username` y comprueba que `JSON.stringify(fila)` no la contiene (TC #12265). Comprueba que el escritor **no** recibe `req` entero sino campos ya recortados.
- **qa-agent** — Los TC #12265, #12266 y #12267 son el contrato. En #12266 la constante de ventana se importa del módulo, no se copia; en #12267 el listener de `unhandledRejection` es el aserto que importa.

## Relación con otros ADR

- **ADR-0014** — asignó explícitamente esta decisión a la #12082 (§«Retención», punto 2). Este ADR la toma y elige, a propósito, lo contrario en dos puntos: escritor que se traga errores (§4) y sin `REVOKE` (§6), con el motivo escrito en cada uno. **No lo contradice**: son dos tablas con finalidades distintas.
- **ADR-0005** — aplicado en §3 (`RESTRICT` explícito) y, como en ADR-0014 §5, con un caso documentado donde la FK **no** se pone (`rol_codigo`, `funcion_codigo`).
- **ADR-0015** — compatible: `rol_codigo` se guarda como texto sin FK, así que crear o borrar roles no toca esta tabla.
- Este ADR **no supersede** a ninguno.
