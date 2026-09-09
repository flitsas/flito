# ADR-0015 — Los roles dejan de ser un tipo de PostgreSQL y pasan a ser filas de una tabla

## Estado

**Propuesto** — HU [#12169](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12169) (Feature [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072)). **Pendiente de aprobación del Líder Técnico**: no lo aprueba ningún agente.

**Diseño detallado**: [`docs/diseno-hu-12169-roles-catalogo-editable.md`](../diseno-hu-12169-roles-catalogo-editable.md) — DDL, trigger, frontera de tipos y lista de archivos.

**Se apoya en** [ADR-0005](./ADR-0005-flito-fk-users-auditoria-on-delete.md) (`ON DELETE` explícito hacia `users`), [ADR-0008](./ADR-0008-flito-soat-canal-cliente.md) §3 (el ámbito de un rol se lee de la BD, no del JWT) y ADR-DB-001 (el runner gestiona la transacción; las migraciones no llevan `BEGIN`/`COMMIT`).

**Se aparta deliberadamente de la migración [`0168`](../../apps/api/src/db/migrations/0168_flito_soat_cliente_check_compania.sql)**: el `CHECK users_cliente_compania_chk` que allí se creó se **elimina** y su garantía pasa a un `CONSTRAINT TRIGGER`. La decisión 3 explica por qué el argumento de la 0168 —«el AC2 es una afirmación sobre la BASE y solo la base la sostiene»— **se conserva entero**, y lo único que cambia es el mecanismo. No es una preferencia de estilo: un `CHECK` no puede consultar otra tabla, y sin consultar `permisos_roles` la garantía no alcanza a ningún rol que el administrador cree.

**Se desvía del texto del AC4** en un punto —el brazo de organismos va `DEFERRABLE INITIALLY DEFERRED` y no `INITIALLY IMMEDIATE`— por una imposibilidad medida, no por criterio. Decisión 3.

**No contradice ningún ADR aceptado.**

---

## Contexto

Los doce roles de FLITO son hoy etiquetas de un tipo enumerado de PostgreSQL, `user_role` (`apps/api/src/db/schema.ts:22`, `users.role` en `:68`). Sobre esa forma de guardarlos, dos criterios funcionales del Feature no son difíciles: **son imposibles**.

- **CF-03 (crear un rol)**: crear un valor de enum es `ALTER TYPE … ADD VALUE`, un cambio de esquema. No es una acción de administrador y no cabe en una petición HTTP.
- **CF-05 (borrar un rol)**: PostgreSQL **no tiene** `ALTER TYPE … DROP VALUE`. Ni en la 16 ni en la 18. Un valor de enum, una vez creado, no se puede quitar aunque no lo use nadie.

Y no es teoría: **hay un rol muerto que no se ha podido retirar**. `user_role` tiene **13** etiquetas vivas en la base; `roleEnum` declara **12**. La número 9 es `operaciones`, deprecada, con **cero usuarios**, y el comentario de `schema.ts:19-21` documenta que se omite del literal de Drizzle precisamente porque de la base no se puede sacar. La deuda lleva ahí desde la migración FLITO y el único remedio disponible fue mentirle al tipo.

### Lo que hay que preservar al cambiarlo

**El ámbito.** Cuatro roles tienen frontera de datos y la guardan en tres sitios: `users.compania_id` (`cliente`), `users.flito_proveedor_soat_id` (`proveedor`), `users.transito_codigo` (`transito`) y la tabla puente `flito_gestor_organismos` (`gestor_impuestos`, desde la HU #12053). Uno de ellos, el del `cliente`, tiene garantía de base desde la 0168 —el `CHECK (role <> 'cliente' OR compania_id IS NOT NULL)`— porque el AC2 de la HU #11913 no decía «la pantalla lo rechaza», decía «no queda un usuario cliente usable». Esa afirmación es sobre la base y sigue siéndolo.

Ese CHECK tiene un techo: **nombra el literal `'cliente'`**. Un rol de compañía que el administrador cree mañana no se llama `cliente`, así que nacería sin ninguna garantía. Y un CHECK **no puede consultar otra tabla**, luego no hay forma de escribirlo mirando el catálogo. RN-A2 lo dice sin rodeos: «la garantía vive en la base de datos y **debe alcanzar también a los roles que el administrador cree**».

**La red de compilación.** Lo que hoy impide que alguien añada un rol y se olvide de darle páginas son tres `Record<UserRole, …>` —`ROLE_LABELS` (`permissions.ts:49`), `ROLE_DEFAULT_PAGES` (`:204`), `ROLES_POR_ACCION` (`siigo-permisos.ts:68`)— y el `z.enum(ALL_ROLES)` de `users.routes.ts:126`/`:167`. **Cuatro sitios, no 330.** Las 276 guardas `requireRole` **no** son red: la firma es `(...roles: string[])` (`auth.ts:181`), sin tipar. Medirlo cambia la conversación: no se está renunciando a una red de trescientos sitios, se está renunciando a una de cuatro, y hay que decidir qué la reemplaza.

### Hechos medidos que condicionan la decisión

Contra `operaciones_db` (PostgreSQL **16.14**) y `grep` sobre `apps/api/src` sin tests, el 2026-09-08:

- `user_role` lo usa **una sola columna** en toda la base. No hay vistas, funciones ni otras tablas colgando de él.
- `users` tiene **10 filas** y **6 roles en uso**. `users.role` **no tiene índice ni DEFAULT**.
- `requireRole(` aparece **276** veces en `apps/api/src/modules`; **205** de ellas en módulos que el Feature excluye (pesv 48, maintenance 33, laft 28, drivers 24, siigo 19, rutas 16, soat 11, vehicles 10, fleet 10, rndc 3, jornadas 3).
- El alta de usuario escribe **primero `users` y después los organismos**, en una transacción (`users.service.ts:160-163`).
- `getEffectivePages` ya tiene un `?? []` que hoy es código muerto (`permissions.ts:285`), y el web ya castea `role: string` para llamarla (`apps/web/src/lib/permissions.ts:29`).
- Precedente de catálogo con PK textual referenciada por FK: `organismos_transito_config.codigo varchar(5)`, `laft_parametros.clave varchar(60)`, `rndc_modos_pago.codigo`, `rndc_empaques.codigo`, `rndc_unidades_medida.codigo`.

---

## Alternativas

### Opción 1 — Tabla `permisos_roles` con `codigo` textual como PK, y `users.role` a `varchar(40)` con FK

`users.role` sigue guardando exactamente las mismas cadenas que guarda hoy (`'admin'`, `'cliente'`, …); lo que cambia es que ahora esas cadenas son la PK de una tabla en vez de etiquetas de un tipo.

**Pros**

- **La conversión no cambia ni un dato.** `ALTER COLUMN role TYPE varchar(40) USING role::text` deja en cada fila el mismo texto que ya tenía. El conteo de usuarios por rol es idéntico antes y después — probado, tres pasadas.
- **Cero cambios en los sitios que comparan.** Los 276 `requireRole('admin')`, los `eq(users.role, 'admin')` de siete consultas y el claim del JWT siguen viendo la misma cadena. Ninguna semántica se mueve.
- **CF-05 y RN-A8 los sostiene la base, no un `if`.** `ON DELETE RESTRICT` da `23503` al intentar borrar un rol con usuarios y deja pasar el borrado de uno sin usuarios. Probado: `admin` (2 usuarios) rechazado, `conductor` (0) borrado.
- **CF-03 funciona el mismo día.** Un rol nuevo es un `INSERT`; asignarlo es un `UPDATE` que la FK acepta. Probado con un rol `consulta_cliente` inventado en la prueba.
- **La FK cierra la puerta que el enum cerraba.** Un `role` inventado da `23503`, igual que antes daba `22P02`. Lo que se pierde en tipo se recupera en referencia.
- **Precedente literal en el repo**: cinco catálogos con PK `varchar` referenciada por FK, empezando por `organismos_transito_config`.
- Reversible mientras no exista un rol fuera de los 12 (ver «Consecuencias»).

**Contras**

- `UserRole` deja de ser la fuente de verdad y hay que escribir la frontera a mano; un literal mal escrito en una comparación deja de dar error de compilación.
- El `codigo` queda de facto inmutable: renombrarlo es tocar 276 literales. Se mitiga declarándolo (`ON UPDATE RESTRICT`) y editando `nombre` en su lugar.
- 40 bytes por fila en `users.role` frente a 4 de un enum. Sobre 10 filas, ruido.

**Esfuerzo**: **M** — una migración, una tabla en `schema.ts`, cuatro archivos de tipos y dos de rutas.

**Riesgos**: la conversión de tipo toma `ACCESS EXCLUSIVE` y reescribe `users` (10 filas, instantáneo). Un valor de `users.role` fuera de los 12 aborta la migración — mitigado con la guarda que lo nombra.

---

### Opción 2 — Tabla `permisos_roles` con `id serial` como PK y `users.role_id integer`

La forma «de libro»: identidad sintética, `codigo` como columna `UNIQUE`.

**Pros**

- Renombrar el código es un `UPDATE` de una columna no referenciada.
- FK de 4 bytes; índices más pequeños.
- Es lo que haría cualquier ORM por defecto.

**Contras**

- **Rompe los 276 sitios que comparan por literal, o los obliga a un join.** `requireRole('admin')` recibe hoy `req.user.role` desde el JWT. Con `role_id`, o el JWT lleva el id —y entonces el literal `'admin'` de las 276 guardas hay que traducirlo en cada petición— o el JWT sigue llevando el código —y entonces el `id` es una **segunda identidad del mismo objeto** que no se usa para nada salvo para la FK—.
- **Las 205 guardas de los módulos que el Feature declara fuera de alcance quedarían atrapadas** en el cambio. El Feature separó esas dos cifras justamente para no tocarlas; esta opción las toca todas.
- La migración deja de ser data-preserving: hay que resolver `role → role_id`, reescribir siete consultas (`eq(users.role, 'admin')`), el claim del JWT, el `userSelect`, la respuesta de `/me` y el front que la lee.
- El `codigo` seguiría siendo lo que el código compara, así que **renombrarlo seguiría siendo igual de peligroso**. La ventaja principal de la opción es ilusoria.
- La reversibilidad se pierde: no hay `USING` que devuelva un `integer` al enum sin una tabla de traducción.

**Esfuerzo**: **L** — y la mayor parte del esfuerzo cae en módulos que el Feature dice explícitamente que no se tocan.

**Riesgos**: alto. Es el cambio que puede dejar sin acceso a un módulo excluido del alcance, donde no hay pruebas del Feature que lo detecten.

---

### Opción 3 — Dejar el enum y añadir una tabla de roles «extra» al lado

`users.role` sigue siendo `user_role` para los 12; los roles del administrador viven en otra tabla y `users` gana una columna `rol_custom` nullable.

**Pros**

- No toca `users.role`: cero riesgo sobre lo existente.
- Migración trivial.

**Contras**

- **Dos fuentes de verdad para la misma pregunta.** Cada lector del rol —276 guardas, el JWT, `getEffectivePages`, el motor de la #12082— tendría que preguntar «¿cuál de las dos?». Es exactamente el estado del que `USER_ROLES` sacó a este repo («antes vivían en 3 sitios con conteos distintos: 8/7/4», `permissions.ts:12-13`).
- **CF-05 sigue sin cumplirse para los doce**: el PO decidió que los roles actuales también se editan y se borran, y en esta opción los doce siguen siendo inmovibles.
- No se puede poner una FK: un usuario tendría dos columnas de rol y ninguna restricción que garantice que exactamente una está puesta (o un `CHECK` que las cruce, y vuelta a empezar).
- El rol muerto `operaciones` sigue vivo para siempre.

**Esfuerzo**: **S** de escribir, **L** de mantener.

**Riesgos**: deuda estructural permanente. Es la opción que parece barata en el sprint y se cobra en cada HU siguiente del Feature.

---

## Decisión

**Opción 1.** `permisos_roles` con `codigo varchar(40)` como PK, y `users.role` convertida a `varchar(40)` con FK `ON UPDATE RESTRICT ON DELETE RESTRICT`.

El argumento decisivo no es la elegancia del modelo, es **dónde cae el trabajo**. La opción 1 concentra el cambio en la base y en cuatro archivos de tipos, y deja intactos los 205 sitios de módulos que el Feature declara fuera de alcance. La opción 2 los arrastra a todos. Cuando un cambio estructural puede hacerse sin mover el significado de una sola comparación existente, esa es la versión que hay que hacer.

### Decisión 1 — PK textual, y `codigo` inmutable

El código del rol **ya es** el identificador que el sistema usa: está en el JWT, en 276 guardas, en siete consultas, en la respuesta de `/me` y en el `localStorage` del navegador. Añadir un `id` numérico no crearía una identidad mejor; crearía una **segunda**, y el sistema seguiría decidiendo por la primera. Un identificador que nadie consulta para decidir nada no es una PK, es una columna.

Lo que la PK textual sí cuesta es que renombrar un código deja de ser barato. Se acepta y se declara: `ON UPDATE RESTRICT` en la FK, para que lo diga la base y no un comentario que alguien borrará. Lo editable de un rol es su `nombre`; el `codigo` se elige una vez.

### Decisión 2 — El tipo `user_role` se declara obsoleto y **no se borra** en esta HU

Con `users.role` convertida, el tipo queda huérfano: ninguna columna lo usa. Borrarlo sería un `DROP TYPE` de una línea.

No se hace, por una razón operativa: **es la única vuelta atrás barata que tiene esta migración**. Mientras todos los valores de `users.role` sean etiquetas del enum, revertir es `ALTER COLUMN role TYPE user_role USING role::user_role`. Sin el tipo, revertir exige recrearlo con sus 13 etiquetas en el orden correcto desde un archivo que ya nadie mirará.

La ventana se cierra sola: el día en que el primer usuario tenga asignado un rol creado por el administrador, ese valor no existe en el enum y la vuelta atrás deja de ser una migración para convertirse en una decisión de negocio. Hasta entonces, el tipo es un seguro que no cuesta nada: no ocupa, no se puede asignar y lleva un `COMMENT` que dice por qué sigue ahí. Se borrará en una migración de una línea cuando el catálogo lleve una release en producción.

Consecuencia deliberada: **`operaciones` sobrevive como etiqueta del tipo obsoleto y NO entra al catálogo** (AC3). Meterlo como fila lo resucitaría como asignable el día que se encienda el panel de la #12084, y el rol se fusionó en `admin` hace tiempo (`permissions.ts:22-24`). Cero usuarios lo tienen, así que la FK no lo necesita. Después de esta HU, el rol muerto queda por fin fuera de todo lo que se puede asignar — que es lo que no se había podido conseguir en año y medio.

### Decisión 3 — Un `CONSTRAINT TRIGGER` sustituye al `CHECK`, y el brazo de organismos va **diferido**

El `CHECK` de la 0168 se elimina porque **no puede hacer lo que RN-A2 exige**: mirar `permisos_roles.tipo_enlace`. Un `CHECK` de PostgreSQL solo ve la fila. Todo lo demás del razonamiento de la 0168 se conserva palabra por palabra —la garantía vive en la base porque un seed, un `psql` de soporte o un PATCH futuro producen el usuario imposible sin que Zod se entere— y es precisamente por eso que la garantía no puede desaparecer, solo cambiar de mecanismo.

Que el trigger es más que el CHECK y no un adorno está **probado**: un rol nuevo `consulta_cliente` con `tipo_enlace='compania'` y un usuario sin compañía se rechaza. El CHECK literal lo habría dejado pasar.

**La desviación del AC4.** El AC pide `DEFERRABLE INITIALLY IMMEDIATE`. Se cumple para `compania` y `proveedor_soat`, cuyo ámbito vive en la misma fila. **No se puede cumplir para `organismos_transito`**, y está medido: `users.service.ts:161-162` inserta el usuario y **después** sus organismos, así que un trigger inmediato se evalúa con la tabla puente todavía vacía y el alta de todo `gestor_impuestos` falla. La contraprueba se ejecutó contra la base real y da `ERROR: El rol gestor_impuestos exige al menos un organismo`. Invertir el orden de escritura no es posible: la PK de la tabla puente es `user_id`, que no existe hasta después del `INSERT`.

Se parte, entonces, en dos triggers sobre la misma tabla: uno inmediato para los ámbitos de la propia fila, uno diferido para el que vive en otra tabla. Lo que se pierde con el diferido es **el momento** del error, no la garantía: ninguna fila incumplidora llega a confirmarse. Y se gana algo que el CHECK no daba: el `DELETE`+`INSERT` de `escribirOrganismos` no ve su propio estado intermedio.

**Hallazgo que obligó a ensanchar el predicado.** El AC3 da el mismo `tipo_enlace='organismos_transito'` a `transito` y a `gestor_impuestos`, pero los dos guardan el organismo en sitios distintos: `users.transito_codigo` el primero, la tabla puente el segundo. Un predicado que mirase solo la tabla puente **rechaza el alta de todo usuario `transito`** — probado. El trigger exige `transito_codigo IS NOT NULL` **o** ≥1 fila puente, mientras las dos formas convivan. Unificarlas es la HU #12088.

Efecto colateral aceptado: el rol `transito` gana una garantía de base que **nunca tuvo** (hoy solo la sostiene el `superRefine` de `users.routes.ts:133-135`). Va en la dirección correcta y no rompe nada: en DEV no hay ningún usuario `transito`, y ninguno de los 10 usuarios actuales violaría el trigger.

### Decisión 4 — La frontera: `UserRole` sigue tipando los doce, y se acepta perder la comprobación del literal

`USER_ROLES`, `UserRole` y los tres `Record<UserRole, …>` **se conservan tal cual**: siguen dando exhaustividad en compilación para los códigos de sistema, que es lo que el AC5 pide. Lo que se ensancha es el tipo del rol **que viaja**: `RoleCode = UserRole | (string & {})`, con el que se tipan `JwtPayload.role` y el parámetro de `getEffectivePages`.

Lo que esto **cuesta**, dicho sin adornos: `req.user.role === 'admn'` deja de ser un error de compilación. Hoy lo es, porque la unión es cerrada. Se acepta porque la alternativa es no tener roles como dato, y porque la protección que se pierde la reemplazan dos cosas más fuertes: la **FK** (un código que no existe no entra en la base, ni por Zod ni por `psql`) y el **motor de la #12082**, que es donde el Feature quiere que acabe esa decisión.

Para `ROLE_DEFAULT_PAGES` la respuesta ya estaba escrita en el repo: `getEffectivePages` tiene un `?? []` (`permissions.ts:285`) que hoy es código muerto porque el `Record` es total. Con roles como dato **empieza a trabajar**, y un rol nuevo obtiene exactamente sus `allowedPages` y nada más. **El fallo por defecto es «no ve nada»** — la misma dirección que el `return null` de `contextoSoat()` (ADR-0008 §3) y que `rolesDe()` en `siigo-permisos.ts:88`. Un rol nace sin pantallas y el administrador le concede; nunca al revés.

Y para `z.enum(ALL_ROLES)`, el precedente también estaba escrito: **la forma en Zod, la existencia en el handler**, exactamente como `companiaExiste()` y `proveedorSoatExiste()`. Zod comprueba que el código tiene forma de código; `rolAsignable()` pregunta al catálogo y responde 400 si no existe o está inactivo. La FK es la tercera capa, por si alguna vez se llega hasta ella.

---

## Consecuencias

**Buenas**

- CF-03 y CF-05 pasan de imposibles a un `INSERT` y un `DELETE`, con la base sosteniendo RN-A8.
- RN-A2 alcanza por fin **a los roles que el administrador cree**, no solo a los doce.
- El rol muerto `operaciones` queda fuera de todo lo asignable, después de sobrevivir a todos los intentos anteriores.
- El rol `transito` gana una garantía de base que no tenía.
- `users.role` gana el índice que su nuevo `ON DELETE RESTRICT` necesita y que el conteo por rol de CF-22 va a agradecer.
- Se borra un cast del web (`permissions.ts:29`) en vez de añadir uno.

**Malas, y asumidas**

- Un literal de rol mal escrito deja de ser error de compilación (decisión 4).
- El `codigo` de un rol es inmutable en la práctica.
- Aparece un mecanismo nuevo en el repo —`CONSTRAINT TRIGGER` con función PL/pgSQL— que Drizzle no declara y que hay que leer en el SQL. Se mitiga nombrándolo en el comentario de `users.role`.
- El brazo diferido reporta su error en el `COMMIT` y no en la sentencia culpable.

**Pendientes que esta decisión NO cierra y que hay que vigilar**

- **`tipo_principal` se persiste aquí y nadie lo lee todavía.** La frontera del canal Cliente sigue disparándose por `ROL_CLIENTE = 'cliente'` (`canal-cliente.ts:54`). Si el panel de creación de roles (#12084) llegara a producción antes de que la #12082/#12083 enganchen la frontera a `tipo_principal`, **un rol externo creado desde el panel nacería con acceso a toda la superficie interna** — el riesgo de seguridad que el propio Feature nombra. Ese orden de merge es una decisión humana y queda escrita aquí para que no se tome por omisión.
- Cambiar el `tipo_enlace` de un rol ya asignado deja incumplidores en reposo: la revalidación es de la #12084.
- Un `DELETE` directo sobre `flito_gestor_organismos` deja a un gestor sin ámbito sin aviso: tercer trigger, propuesto para la #12088.
- Los 205 `requireRole` de módulos excluidos siguen comparando literales de los doce. No se rompen y no se arreglan: siguen negando a cualquier rol nuevo, que es la dirección segura.

**Reversibilidad**

Todo se deshace —tabla, FK, índice, triggers, y el `CHECK` de la 0168 se restituye literal desde el archivo, que sigue en disco— **mientras todos los valores de `users.role` sean etiquetas del enum**. Nada se borra en esta migración: ni columnas, ni filas, ni tipos.

---

## Evidencia

Trece casos ejecutados contra `operaciones_db` (PostgreSQL 16.14) en transacciones cerradas con `ROLLBACK`, con la base verificada intacta después. La tabla completa está en `docs/diseno-hu-12169-roles-catalogo-editable.md` §7. Los cuatro que sostienen este ADR:

| Afirmación de este ADR | Prueba |
|---|---|
| `ON DELETE RESTRICT` sostiene CF-05/RN-A8 | Borrar `admin` (2 usuarios) → `23503`; borrar `conductor` (0 usuarios) → OK |
| El trigger cubre roles que el CHECK no cubría | Rol nuevo `consulta_cliente` con `tipo_enlace='compania'`, usuario sin compañía → rechazado |
| `INITIALLY IMMEDIATE` es imposible para organismos | Alta de `gestor_impuestos` con sus organismos en la línea siguiente → **ERROR** con `IMMEDIATE`, **OK** con `DEFERRED` |
| La migración es idempotente en sentido fuerte | Tres pasadas seguidas: `INSERT 0 0` en la 2.ª y 3.ª, conteo de usuarios por rol idéntico. **Sin la guarda condicional del `ALTER COLUMN`, la 2.ª pasada falla**: `cannot alter type of a column used in a trigger definition` |

---

## Nota sobre una premisa que circula y no es exacta

Se ha dicho que `ALTER TYPE … ADD VALUE` «no va dentro de transacción». Desde PostgreSQL 12 **sí** va; lo que falla es **usar** el valor nuevo en esa misma transacción (`55P04`), que es lo que obligó a partir la 0167 y la 0168 y lo que el propio archivo documenta bien (`0168:14-20`). Para esta HU es indiferente: **la 0178 no añade ningún valor al enum, lo abandona**. Conviene no arrastrar la versión imprecisa a la siguiente migración que toque un tipo enumerado.
