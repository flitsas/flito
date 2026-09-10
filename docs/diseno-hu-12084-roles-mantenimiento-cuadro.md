# Diseño slim — HU #12084: mantenimiento de roles y guardado del cuadro rol × función

**Feature** [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072) · **HU** [#12084](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12084) «[BACKEND] – Roles – Mantenimiento de roles y guardado del cuadro rol × función»
**Modo:** slim. Extiende `apps/api/src/modules/permisos/permisos.routes.ts` y consume el escritor de la #12171. Lo único nuevo de fondo es el **invariante anti-bloqueo con bloqueo de filas** (§4); todo lo demás es patrón vecino.
**ADR:** no aplica. Se apoya en ADR-0015 (catálogo, PK textual inmutable, `es_sistema` candado), ADR-0014 (escritor por campo, sin PII del titular) y ADR-0016 §2 (`exigirFuncion` a nivel de ruta, nunca de router). No contradice ninguno.
**Verificado sobre** `HU/12084-davidchica-roles-mantenimiento-cuadro` @ `b7db248` (= #12171 completa), 2026-09-10. `origin/develop` @ `f7e3c54` tiene la **0184** como última; la rama trae la 0185 de la #12171.
**Migración:** `0186_permisos_roles_mantenimiento.sql` — **número a confirmar antes de crear el archivo** (§6, riesgo §8.4).
**Decisiones del 10/09 que mandan sobre el texto de los AC:** guardar el cuadro no cierra sesiones (solo `invalidarPermisosDeRol`); dos candados de borrado con motivo (`es_sistema` → «rol del sistema»; N usuarios → «N usuarios lo tienen asignado; reasígnalos primero»); solo `admin` es de sistema.

---

## 0. Contexto medido (lo que condiciona el diseño)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| `permisos.routes.ts` tiene **48 líneas**, dos rutas: `GET /funciones` con `requireRole('admin')` cableado (`:17,:20`) y `GET /mios` sin guarda de función (`:38`) | `modules/permisos/permisos.routes.ts` | Cabe todo (techo `max-lines` 800). `GET /funciones` **tiene que** pasar a `exigirFuncion` (abajo) |
| `permisos/` **no** está en los 19 `DIRECTORIOS_RECONDUCIDOS` ni `permisos.routes.ts` en los 22 `FICHEROS_EN_ALCANCE` | `inventario-guardas.ts:70-93`; `permisos.reconduccion-cierre.test.ts:32-37,:90-92` | Una ruta con `exigirFuncion` fuera del inventario rompe «231 montajes = foto» (`:153-156`). El fichero **entra al inventario** (22→23, 19→20) y con él: cero `requireRole(` en el directorio, `/mios` a la `LISTA_BLANCA` (4→5) |
| `CAMPOS_AUDITABLES.rol = ['nombre','descripcion','tipo_enlace','tipo_principal','activo']`, `rol_funcion = ['conjunto']`; el CHECK `permisos_auditoria_campo_lista_chk` de la 0185 lleva los mismos 16 literales | `packages/shared-types/src/permisos-auditoria.ts:24-29`; `0185:96-103` | **No hay que ampliar** ni la lista ni el CHECK. Ojo: el campo del cuadro es **`conjunto`**, no `funciones` (`funciones` pertenece a `entidad='usuario'`) |
| `ValorAuditable` no admite objetos libres: solo escalares y `{ conjunto, concedidas?, revocadas? }` | `permisos-auditoria.ts:39-41` | El «antes» de un rol borrado **no cabe como documento**: va como un par por campo (§5) |
| `registrarCambiosPermisos(tx, actor, cambios[])` escribe N filas con un `lote_id`; `diffConjunto(antes, despues)`; `actorDeRequest(req)` | `shared/historial/permisos-auditoria.ts:85-137` | Se consume tal cual. Nada nuevo en el escritor |
| Seguro «último admin» actual: **dos copias fuera de transacción**, ambas `count(*) WHERE role='admin' AND active AND id<>:id` | `users.routes.ts:476-481` (PATCH `/:id`, solo si `role` baja de `admin`) y `:638-643` (toggle, solo si `before.role==='admin'`) | Hoy protege **una sola cosa**: que no se desactive/degrade al último usuario con el literal `admin`. **No** protege de: vaciar el cuadro de `admin` (PUT), borrar el rol, mover la administración a otro rol, ni de dos administradores simultáneos (TOCTOU: cuenta con `db` antes de la tx). Se conserva como pre-check con mensaje claro; la verdad pasa al invariante de §4 |
| `actualizarUsuario` abre tx y bloquea al titular con `FOR UPDATE` (`:255`); `cambiarActivo` hace `UPDATE … RETURNING` atómico sin lock previo (`:352-372`); `crearUsuario` solo añade | `users.service.ts` | Los tres puntos de enganche existen. `crearUsuario` **no** invoca el invariante (añadir capacidad nunca lo rompe) |
| `rolAsignable(codigo)` devuelve `{ tipoEnlace }` si existe y `activo=true`; el alta deriva el ámbito de **literales** (`role === 'cliente'` en `:335,:418,:446`, etc.), no de `tipoEnlace` | `users.service.ts:102-108`; `users.routes.ts:327-350,:418-448` | Un rol nuevo con `tipo_enlace='ninguno'` entra en el alta y en la FK. Uno con `'compania'` **no**: la ruta escribe `companiaId: null` y el trigger `users_ambito_trg` (0178) lo rechaza con `23514` → hoy un **500**. Ver §8.1 |
| Resolutor: efectivo = `(R ∪ C) \ V`; para `operacion.*`, C = `permisos_usuario_funcion` `conceder` y V = `revocar`; `tipo_principal` sale del rol y `guardiaCanalCliente` cierra todo lo que no esté en `RUTAS_PERMITIDAS_CLIENTE` | `shared/permisos-efectivos.ts:11-24,:150-167`; `canal-cliente.ts:114-180,:255` | El invariante replica **esa** regla en SQL (§4.2) y exige además rol `interno`: un `admin` pasado a `externo` no puede llegar a `/api/permisos/roles` |
| `RUTAS_PERMITIDAS_CLIENTE` = 11 entradas; 8 corresponden a funciones (`soat.cola.ver`, `soat.cola.filtrar`, `soat.solicitud.ver`, `.ver_historial`, `.ver_soportes`, `soat.runt.preconsultar`, `soat.solicitud.crear`, `soat.factura.leer`); 3 no (`/auth/me`, `/permisos/mios`, `/auth/logout`) | `canal-cliente.ts:114-180` | «Fuera de su canal» es medible con una lista de 8 códigos (§3.3) |
| Los triggers de ámbito se disparan por `INSERT OR UPDATE OF role, compania_id, …` **sobre `users`**, no sobre `permisos_roles` | `0178:234-241` | Cambiar `tipo_enlace` de un rol con usuarios deja incumplidores en reposo (pendiente de ADR-0015). Se cierra en §2.3 |
| `invalidarPermisosDeRol(codigo)` recorre la caché y borra a todo usuario cuyo `rol` cacheado sea ese código | `permisos-efectivos.ts:223-227` | Se llama **después del commit**, como `invalidarPermisosDe` en `users.routes.ts` |
| No hay ningún test de concurrencia real en el repo: `flito-bolsas-transito-carrera.test.ts:15-22` lo dice con esas palabras («no hay concurrencia real… solo la probaría un Postgres de verdad con dos sesiones») | `__tests__/services/` | El test de AC4 es el **primero**. Patrón de conexión: `postgres` (postgres.js, no `pg`) + `skipIf(!TEST_DATABASE_URL)` como `migracion-0185.test.ts:173-190` y `helpers/base-en-tx.ts` |
| Precedente de error de dominio → 409 en la ruta | `flito-tarifas.service.ts:39-41` (`TarifaConflictoError`), `flito-parametrizacion.routes.ts:551` | `BloqueoAdministracionError` y `RolConflictoError` siguen esa forma |
| Los tokens de prueba reciben las operaciones que la foto concede a su rol (`operacionesDePartida`) | `__tests__/helpers/auth.ts:36-45` | Sembrar `roles: ["admin"]` en la foto es lo que hace que el `admin` de los specs pase las guardas nuevas |

---

## 1. Rutas y códigos de función

Todas en `permisos.routes.ts`, montado en `/api/permisos` (`app.ts:241`), cada una con `exigirFuncion('<literal>')` a nivel de ruta. Los literales van entre comillas simples: `leerMontajes` lanza ante variables o templates.

| Ruta | Código | Sembrado a |
|---|---|---|
| `GET /funciones` (existente) | `permisos.catalogo.ver` | admin |
| `GET /roles` | `permisos.rol.listar` | admin |
| `POST /roles` | `permisos.rol.crear` | admin |
| `PATCH /roles/:codigo` | `permisos.rol.editar` | admin |
| `DELETE /roles/:codigo` | `permisos.rol.borrar` | admin |
| `GET /roles/:codigo/funciones` | `permisos.cuadro.ver` | admin |
| `PUT /roles/:codigo/funciones` | `permisos.cuadro.guardar` | admin |
| `GET /mios` (existente) | **sin guarda** — entra a `LISTA_BLANCA` | — |

**`GET /funciones` pasa a `exigirFuncion('permisos.catalogo.ver')` — no es opcional.** Al entrar el fichero al inventario, `permisos.reconduccion-cierre.test.ts:77-86` exige cero `requireRole(` en el directorio (incluso en comentarios) y `:118-132` exige guarda en cada `router.<método>(` que no esté en la lista blanca. La alternativa —meter `/funciones` en la lista blanca con `requireRole`— dejaría un `requireRole(` vivo y el test en rojo. `admin` la recibe por la foto; `FUNCIONES_SIN_ADMIN` (`permisos.service.ts:48-52`) no cambia. Ninguno de los siete códigos va al `auditor`: el cuadro de roles es administración, no observación (`permisos.auditor-observa.test.ts` sigue en 42).

**Siete códigos y no cuatro** porque el catálogo es «una función por ruta» y los códigos son únicos (`catalogo.ts:150-152`; `permisos-catalogo.test.ts:137-143`). El precedente es `usuarios.auditoria.ver` / `.filtrar` de la #12171.

**Las nueve piezas por código** (§7 del diseño de la #12171, con los contadores de HOY):

| Pieza | Qué cambia | Contador hoy → después |
|---|---|---|
| `permisos.routes.ts` | la ruta con `exigirFuncion('…')` | — |
| `modules/permisos/catalogo-operaciones.ts` | `const PER = 'permisos/permisos.routes.ts'` y siete `op(\`${PER} <MÉTODO> <ruta>\`, 'permisos.…', nombre, descripcion)` en un bloque «Permisos» al final. `descripcion` no vacía. Textos = los de la 0186 (`migracion-0179.test.ts:105-119` compara literal) | — |
| `modules/permisos/inventario.generado.ts` | siete filas `{ modulo: "permisos", fichero: "permisos/permisos.routes.ts", metodo, ruta, roles: ["admin"], heredada: false }` | 231 → **238** |
| `modules/permisos/inventario-guardas.ts:70-93` | `{ modulo: 'permisos', fichero: 'permisos/permisos.routes.ts' }` | 22 → **23** ficheros |
| `db/migrations/0186_…sql` | siete funciones + siete pares `('admin', …)` | — |
| `__tests__/helpers/permisos-seed-sql.ts:23-29` | `MIGRACIONES_CON_REPARTO += '0186_…'` | 5 → 6 archivos |
| `__tests__/fixtures/permisos-rutas-reconducidas.ts` | siete filas en una oleada nueva («6 — permisos, HU #12084») | — |
| `__tests__/services/permisos.reconduccion-cierre.test.ts` | `DIRECTORIOS_RECONDUCIDOS += 'permisos'` (`:32-37`); «19» → **20** y «22» → **23** (`:90-92`); `LISTA_BLANCA += 'permisos/permisos.routes.ts GET /mios'` y «4» → **5** (`:40-45,:134-135`); `231` → **238** (`:153-156`) y el comentario `:11` | ver celdas |
| `__tests__/services/permisos.auditor-observa.test.ts` | **nada** (42 se mantiene; ninguna función nueva es del auditor) | 42 → 42 |
| `__tests__/db/migracion-0179.test.ts:105` | título y comentario suman «la 0186» | — |

`catalogoDeOperaciones` exige `decl.codigo.startsWith('permisos.')` para `modulo: 'permisos'` (`catalogo.ts:118-121`): por eso el prefijo de los siete es `permisos.` y el fichero se declara con ese módulo.

---

## 2. Contrato HTTP

Errores de forma con Zod → 400 `{ error: 'Datos inválidos', details }` (patrón `users.routes.ts:394-396`). Errores de dominio → clases en `permisos-roles.service.ts`, mapeadas en la ruta (patrón `flito-parametrizacion.routes.ts:551`).

### 2.1 `GET /roles` → 200

```json
{ "roles": [ { "codigo": "admin", "nombre": "Administrador", "descripcion": null,
               "tipoEnlace": "ninguno", "tipoPrincipal": "interno", "esSistema": true, "activo": true,
               "usuarios": 2, "borrable": false, "motivoNoBorrable": "rol del sistema",
               "createdAt": "…", "updatedAt": "…" } ] }
```

`usuarios` = `count(*)` de `users` con `role = codigo` (**todos**, activos o no: la FK `ON DELETE RESTRICT` cuenta todos). `borrable = !esSistema && usuarios === 0`. `motivoNoBorrable`: `'rol del sistema'` si `esSistema`; si no y `usuarios > 0`, `'${N} usuarios lo tienen asignado; reasígnalos primero'`; si borrable, `null`. Es **el mismo texto** que devuelve el 409 de DELETE: una sola función `motivoNoBorrable(rol, n)` lo produce para los dos. Sin PII: ni un nombre de usuario viaja aquí. Orden: `es_sistema DESC, codigo ASC`.

### 2.2 `POST /roles` → 201 `{ rol }` (misma forma que un ítem de 2.1)

```ts
z.object({
  codigo: z.string().regex(/^[a-z0-9_]+$/).max(40),
  nombre: z.string().trim().min(1).max(80),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  tipoEnlace: z.enum(['ninguno','compania','proveedor_soat','organismos_transito']),
  tipoPrincipal: z.enum(['interno','externo']),          // sin default, a propósito (AC1)
  funciones: z.array(z.string().max(80)).default([]),
})
```

- 409 `{ error: 'Ya existe un rol con el código «x»' }` — por `23505` de la PK, capturado en el servicio (no por «consultar y luego insertar»: dos POST simultáneos pasarían los dos la consulta).
- 400 `{ error: 'Funciones inexistentes', funciones: ['x','y'] }` — la lista de inválidos (§3.1). Transaccional: ni el rol ni parte del cuadro quedan escritos.
- 400 `{ error: 'El código «operaciones» está reservado' }` — **una** excepción medida: `operaciones` sigue siendo etiqueta del tipo obsoleto `user_role` y ADR-0015 §Decisión 2 lo deja **fuera de todo lo asignable** a propósito. Sin esta guarda el panel lo resucitaría. `RESERVADOS = ['operaciones']` en el servicio.
- `es_sistema` no se acepta en el cuerpo: nace `false`. `activo` nace `true` (asignable de inmediato: `rolAsignable` lo exige).
- Post-commit: nada que invalidar (no hay usuarios). Auditoría §5.

### 2.3 `PATCH /roles/:codigo` → 200 `{ rol }`

```ts
z.object({
  nombre: z.string().trim().min(1).max(80).optional(),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  tipoEnlace: z.enum([...]).optional(),
  tipoPrincipal: z.enum(['interno','externo']).optional(),
  activo: z.boolean().optional(),
}).strict()   // `codigo`, `esSistema` y `funciones` → 400 por `.strict()`
```

Qué es editable y qué no, con su motivo:

| Campo | Editable | Regla |
|---|---|---|
| `codigo` | **nunca** | ADR-0015 §Decisión 1; la FK lleva `ON UPDATE RESTRICT`. No aparece en el esquema |
| `esSistema` | **nunca** por API | es el candado de borrado; quitarlo a `admin` sería el primer paso de un bloqueo. Solo por migración |
| `nombre`, `descripcion` | sí | sin condición |
| `activo` | sí, incluso en `admin` | gobierna la asignación, no la autenticación (`rolAsignable`). No toca el invariante |
| `tipoEnlace` | **solo con 0 usuarios** | con N>0 → 409 `'${N} usuarios lo tienen asignado; el tipo de enlace se cambia sin usuarios'`. Motivo: los triggers de la 0178 solo revalidan al escribir `users`; cambiar el enlace de un rol con usuarios deja filas incumplidoras que ningún mecanismo detecta (pendiente literal de ADR-0015). Alternativa descartada: permitirlo y revalidar a los N usuarios dentro de la tx (M, y no hay forma de «arreglar» al que no cumple sin decidir por él). Recomendación: **409 con 0 usuarios**; pendiente humano §8.2 |
| `tipoPrincipal` | sí, con dos condiciones | (a) el invariante de §4 **incluye `tipo_principal='interno'`** en el predicado, así que `admin → externo` con dos admins responde 409 «dejaría cero usuarios activos capaces de administrar permisos»; (b) `invalidarPermisosDeRol` post-commit **obligatorio** (la frontera del canal se lee del resolutor cacheado). El riesgo medido de `externo → interno` es real —abre la superficie interna a sus usuarios— y se mitiga con la fila de auditoría (`campo='tipo_principal'`, antes/después) y con que solo `permisos.rol.editar` lo puede hacer. Alternativa descartada: inmutable tras crear. Obligaría a borrar y recrear, que con N>0 está vedado: un error al crear quedaría sin remedio. Pendiente humano §8.2 |

- 404 si el código no existe. 400 `'Sin cambios'` si ningún campo difiere (patrón `actualizarUsuario`).
- Post-commit: `invalidarPermisosDeRol(codigo)` **siempre que cambie `tipoPrincipal`**; con `nombre`/`descripcion`/`activo`/`tipoEnlace` no hace falta (el resolutor no los lee), pero llamarlo igual cuesta O(caché) y evita un `if` que alguien olvide: **se llama siempre que hubo cambios**.

### 2.4 `DELETE /roles/:codigo` → 204

Dentro de una tx: `SELECT … FROM permisos_roles WHERE codigo=$1 FOR UPDATE` (404 si no existe) → si `es_sistema` → 409 `{ error: 'rol del sistema' }` → `count(*)` de `users` con ese rol → si N>0 → 409 `{ error: '${N} usuarios lo tienen asignado; reasígnalos primero', usuarios: N }` → leer el cuadro (para el «antes») → invariante §4 → `DELETE`; la FK `ON DELETE CASCADE` de `permisos_rol_funcion` borra el cuadro. Un `23503` que llegara a pesar del conteo (un alta concurrente que tomó `KEY SHARE` sobre la fila) se captura y responde el mismo 409 con N releído. `admin` nunca llega al invariante: cae antes por `es_sistema`. Post-commit: `invalidarPermisosDeRol(codigo)` (no hay usuarios, pero la caché puede tener entradas de pruebas o de un usuario reasignado hace <60 s).

### 2.5 `GET /roles/:codigo/funciones` → 200

```json
{ "codigo": "auditor", "tipoPrincipal": "interno", "funciones": ["bitacora.bitacora.ver", "pagina.flito_soat", "…"] }
```

Ordenado por código. 404 si el rol no existe.

### 2.6 `PUT /roles/:codigo/funciones` → 200

Cuerpo `{ funciones: string[] }` (`z.array(z.string().max(80)).max(1000)`; duplicados se pliegan). Respuesta:

```json
{ "codigo": "cliente", "funciones": ["…"], "concedidas": ["…"], "revocadas": ["…"],
  "aviso": { "tipo": "fuera_del_canal",
             "mensaje": "El rol es externo: la guarda de canal sigue mandando y estas funciones no tendrán efecto por HTTP",
             "funciones": ["soat.solicitud.enviar"] } }
```

`aviso` solo aparece si el rol es `externo` **y** hay ≥1 función de operación fuera de la lista de §3.3; `null` en el resto. 400 `{ error: 'Funciones inexistentes', funciones: [...] }` con la lista. 404 si el rol no existe. 409 del invariante §4. Post-commit: `invalidarPermisosDeRol(codigo)`.

---

## 3. `PUT /roles/:codigo/funciones` — cómo se escribe

### 3.1 Validación de códigos

Una consulta: `SELECT codigo FROM permisos_funciones WHERE codigo = ANY($1)`. Los que faltan en la respuesta son los inválidos → `FuncionesInexistentesError(lista)` → 400 con la lista. Se hace **antes** de abrir la tx (es lectura) y la FK `permisos_rol_funcion_funcion_codigo_fkey` queda como tercera capa. No se distingue `activo=false` en `permisos_funciones`: hoy todas están activas y el AC no lo pide.

### 3.2 Reescritura completa, transaccional

`db.transaction`: bloquear administración (§4.3, paso 1) → `SELECT … FROM permisos_roles WHERE codigo FOR UPDATE` (404 si no existe; serializa dos PUT sobre el mismo rol) → leer el cuadro actual → si `mismoConjunto(antes, despues)` → devolver sin escribir ni auditar (patrón `sin_cambios`) → `DELETE FROM permisos_rol_funcion WHERE rol_codigo=$1` + `INSERT … VALUES (…)` (o nada si el conjunto llega vacío) → auditoría (§5) → invariante (§4.3, paso 3) → commit.

**Delete + insert y no diff**, por dos motivos medidos: el diff ya lo calcula `diffConjunto` para la auditoría y no se necesita dos veces; y con un cuadro de ≈ 275 filas por rol como máximo (231 operaciones + páginas), dos sentencias son más baratas de leer que N. Alternativa descartada: `INSERT … ON CONFLICT DO NOTHING` + `DELETE … WHERE NOT IN` — mismo resultado, más SQL.

### 3.3 «Fuera de su canal» (RN-A1): criterio medible

La frontera del canal externo es `RUTAS_PERMITIDAS_CLIENTE` (`canal-cliente.ts:114`) y es código. Para decir «esta función no tendrá efecto» hay que saber qué funciones guardan esas rutas. Dos formas:

| Opción | Cómo | Esfuerzo | Contra |
|---|---|---|---|
| A — aviso genérico | si `tipoPrincipal==='externo'` y hay ≥1 función `operacion.*`, `aviso` sin lista | S | no dice cuáles; la pantalla no puede marcar casillas |
| **B — lista declarada** (recomendada) | `RutaCliente` gana `funcion?: string`; las 8 rutas con guarda lo declaran (`'soat.cola.ver'`, …). `FUNCIONES_DEL_CANAL_EXTERNO = new Set(RUTAS_PERMITIDAS_CLIENTE.flatMap(r => r.funcion ? [r.funcion] : []))`. Fuera del canal = `funciones.filter(f => !f.startsWith('pagina.') && !FUNCIONES_DEL_CANAL_EXTERNO.has(f))` | S (8 literales + 1 test) | la lista se mantiene a mano; lo ata un test: cada `funcion` declarada existe en `catalogoCompleto()` y su ruta de la foto lleva ese código |

**B.** Las `pagina.*` no cuentan: la guarda de canal limita la API, no el menú, y la SPA de un externo pinta lo que `/mios` le dé. Va en `canal-cliente.ts` (una constante derivada; ningún cambio de comportamiento del guarda) y el servicio la importa. Mutación: quitar `'soat.cola.ver'` de la lista → el test de «cada función del canal está en la lista» en rojo.

---

## 4. El invariante anti-bloqueo (AC4)

### 4.1 Dónde vive y por qué ahí

`apps/api/src/shared/permisos-anti-bloqueo.ts` — **no** en `modules/permisos/`. Lo invocan `users.service.ts` (tres operaciones) y `permisos-roles.service.ts` (dos); colgarlo de un módulo crearía la dependencia entre hermanos que `shared/historial/permisos-auditoria.ts:3-6` evitó con el mismo argumento. Vecino de `permisos-efectivos.ts`, que es la regla que replica.

### 4.2 Qué afirma, en SQL

«Tras esta escritura sigue habiendo, **para cada una** de `FUNCIONES_DE_ADMINISTRACION = ['permisos.cuadro.guardar', 'usuarios.usuario.editar']`, ≥1 usuario **activo**, **vivo** (enganche para `deleted_at`, §4.5), de un rol **interno**, cuyo conjunto efectivo la contiene.» Conjunto efectivo = la regla del resolutor para `operacion.*` (`permisos-efectivos.ts:152-165`), en SQL:

```sql
SELECT count(*) FILTER (WHERE tiene($F1)) AS f1, count(*) FILTER (WHERE tiene($F2)) AS f2
FROM users u JOIN permisos_roles r ON r.codigo = u.role
WHERE u.active AND r.tipo_principal = 'interno' /* AND u.deleted_at IS NULL — #12089 */
-- tiene(F) ≡ ( EXISTS (rol_funcion rf WHERE rf.rol_codigo=u.role AND rf.funcion_codigo=F)
--            OR EXISTS (usuario_funcion uf WHERE uf.user_id=u.id AND uf.funcion_codigo=F AND uf.efecto='conceder') )
--          AND NOT EXISTS (usuario_funcion uf WHERE uf.user_id=u.id AND uf.funcion_codigo=F AND uf.efecto='revocar')
```

La pregunta del encargo —«¿basta con contar usuarios activos de roles cuya matriz contenga esas funciones, sin pasar por el resolutor?»— tiene respuesta medida: **casi**. Sin la rama de `permisos_usuario_funcion` el invariante ignoraría a un usuario con la función concedida a título personal (vacío hoy, escritura de la #12087) y, peor, contaría a uno que la tiene **revocada**. Dos `EXISTS` más y el predicado es el del resolutor; no pasar por `resolverPermisos()` es correcto porque ese lee de la caché y de `db`, no de `tx`. Se construye con el query builder (`exists`, `and`, `not`) para que el espía de pruebas lea las condiciones (`espia-drizzle`), no con `sql.raw`.

### 4.3 Forma: envoltorio, no simulación

```ts
export class BloqueoAdministracionError extends Error { constructor(public readonly funcion: string) { … } }
export const FUNCIONES_DE_ADMINISTRACION = ['permisos.cuadro.guardar', 'usuarios.usuario.editar'] as const;

/** 1) bloquea la población administradora, 2) ejecuta la escritura, 3) comprueba; si falla, lanza y la tx revierte. */
export async function conSeguroAntiBloqueo<T>(
  tx: Tx, escritura: () => Promise<T>, funciones: readonly string[] = FUNCIONES_DE_ADMINISTRACION,
): Promise<T>;
```

| Alternativa | Contra |
|---|---|
| `asegurarQueQuedaAdmin(tx, cambioPropuesto)` — simular el cambio antes de escribir | cinco formas de `cambioPropuesto` (rol nuevo del usuario, `active=false`, `deleted_at`, cuadro nuevo, rol borrado) = cinco ramas del predicado, cada una una copia de la regla. Es lo que el AC prohíbe («no se copia la comprobación en cinco rutas») trasladado a un `switch` |
| **envoltorio: escribir y comprobar el estado resultante en la misma tx** (recomendada) | ninguna rama: el `SELECT` ve la escritura propia sin confirmar. Lo que cuesta es el `ROLLBACK` de una escritura ya hecha, que en Postgres es gratis |

**El orden importa y es lo que resuelve la concurrencia:**

1. **Bloquear primero**: `SELECT u.id FROM users u JOIN permisos_roles r … WHERE u.active AND r.tipo_principal='interno' AND (tiene(F1) OR tiene(F2)) ORDER BY u.id FOR UPDATE`. Bloquea **solo las filas de `users` que hoy sostienen la administración** (2 en DEV), no toda `users` ni `permisos_roles`. `FOR UPDATE` admite `ORDER BY` y `EXISTS`; solo bloquea la tabla principal.
2. Ejecutar `escritura()`.
3. Contar (§4.2). Si algún contador es 0 → `throw new BloqueoAdministracionError(F)`. La ruta lo mapea a 409 `{ error: 'Dejaría cero usuarios activos capaces de administrar permisos' | '… administrar usuarios' }`.

**Por qué el lock va antes de la escritura y en orden fijo.** Si cada operación bloqueara primero su propio objetivo (`actualizarUsuario` lo hace en `:255`) y después la población, dos administradores que se degradan mutuamente se bloquean en cruz: A tiene X y espera Y; B tiene Y y espera X → `40P01` (deadlock) y un 500. Con la población bloqueada **primero** y por `id`, B espera en la primera fila que A tiene, A termina, y B continúa viendo el estado confirmado de A (READ COMMITTED: cada sentencia toma foto nueva; `FOR UPDATE` reevalúa el `WHERE` sobre la versión nueva de la fila). Por eso `conSeguroAntiBloqueo` es lo **primero** que corre dentro de cada tx, y el `for('update')` del titular de `actualizarUsuario` queda después (re-bloquear una fila propia es un no-op).

**Alternativa considerada y descartada:** `pg_advisory_xact_lock(<constante>)` al abrir cada tx. Sirve igual y es más simple, pero el AC nombra `SELECT … FOR UPDATE` sobre «las filas afectadas» y la mutación «quitarle el FOR UPDATE» tiene que ser observable. También descartado: `SERIALIZABLE` (obligaría a reintentos `40001` en cinco rutas).

### 4.4 La carrera, paso a paso (la que el test reproduce)

Estado: X e Y son los dos únicos admins activos. A = «cambiar el rol de X a `auditor`»; B = «cambiar el rol de Y a `auditor`».

| t | A | B |
|---|---|---|
| 1 | `BEGIN`; lock población → {X, Y} | |
| 2 | `UPDATE users SET role='auditor' WHERE id=X` | `BEGIN`; lock población → **espera** en X |
| 3 | contar: X ya no cuenta (cambio propio), Y sí → f1=f2=1 → OK | |
| 4 | `COMMIT` | despierta; `FOR UPDATE` reevalúa X con `role='auditor'` → X sale del conjunto; bloquea {Y} |
| 5 | | `UPDATE … WHERE id=Y`; contar → 0 → **lanza** → `ROLLBACK` → **409** |

Sin `FOR UPDATE` (mutación): en t2 B no espera; en t3 B cuenta y ve a X todavía admin (A no confirmó) → OK; A ve a Y → OK; los dos confirman; **cero admins**. Con el invariante fuera de la tx (mutación): la cuenta con `db` no ve la escritura propia → mismo desenlace.

### 4.5 Las cinco operaciones y el enganche de la #12089

| Operación | Dónde se invoca | Qué envuelve |
|---|---|---|
| editar el cuadro | `permisos-roles.service.ts` `guardarCuadro` | delete + insert de `permisos_rol_funcion` |
| borrar rol | `permisos-roles.service.ts` `borrarRol` | el `DELETE` (tras los dos candados) |
| cambiar el rol de un usuario | `users.service.ts` `actualizarUsuario` — **solo si `updates.role !== undefined`**; editar el nombre no paga el lock | el `UPDATE users` |
| desactivar | `users.service.ts` `cambiarActivo` | el `UPDATE … SET active = NOT active`. Se envuelve siempre: reactivar nunca falla el conteo y la comprobación cuesta una consulta |
| dar de baja (#12089) | `users.service.ts` (función que la #12089 cree) | **esta HU no lo implementa**. Deja: (a) el comentario `/* #12089: envolver con conSeguroAntiBloqueo */` en el sitio, (b) en `permisos-anti-bloqueo.ts` la constante `CONDICION_USUARIO_VIVO = sql\`true\`` con el comentario «#12089: `deleted_at IS NULL`», usada en el lock y en la cuenta |

Los pre-checks de `users.routes.ts:476-481` y `:638-643` **se conservan** (AC4 lo dice): responden 409 con «último admin» antes de abrir la tx en el caso común, y el invariante es el que decide de verdad. `crearUsuario` no envuelve nada.

### 4.6 El test de concurrencia — `__tests__/db/permisos-anti-bloqueo.concurrencia.test.ts`

`describe.skipIf(!TEST_DATABASE_URL)`. Conexión con `postgres` (postgres.js) `{ max: 3 }` y `drizzle(sql)` propio del test (el `db` de `client.ts` lee `env`); las funciones bajo prueba reciben `tx` y no saben de dónde viene.

- **Aislamiento del censo real:** el invariante se llama con `funciones = ['zz.prueba12084.administrar']`, una función **temporal** insertada por el test, para que los admins reales de la base no sostengan la cuenta. Por eso el parámetro `funciones` existe en la firma (y por nada más: producción no lo pasa).
- **Datos:** `beforeAll` **confirma** (no puede ser una tx con rollback: dos sesiones tienen que verse) un rol `zz_prueba12084` (`interno`), la función temporal, el par en `permisos_rol_funcion`, y dos usuarios `zz_prueba12084_x` / `_y` activos con ese rol. `afterAll` los borra en orden inverso, y `beforeAll` **empieza** borrando restos de una corrida anterior. Prefijo `zz_prueba12084` en todo lo que toca, para que un residuo sea reconocible.
- **Determinismo:** A entra, hace lock+UPDATE, avisa (`Promise` resuelta) y espera 300 ms antes de contar y confirmar; B arranca tras el aviso y se queda esperando en el lock. `Promise.all([A, B])`; aserto: **exactamente uno** rechaza con `BloqueoAdministracionError` y en la base queda exactamente un usuario de prueba con el rol. Sin `FOR UPDATE`, B no espera, los dos confirman y el aserto «uno de dos» falla. Un caso más: los dos en paralelo **sin** barrera, repetido 5 veces, siempre «uno de dos» (protege contra un orden fijo que el test anterior no ve).
- **No** limpia `permisos_auditoria`: el test invoca el invariante y `tx.update` directos, no los servicios, así que no escribe historial.

Riesgo asumido: si la corrida muere entre `beforeAll` y `afterAll`, quedan cinco filas con prefijo `zz_prueba12084` y `verificarCatalogoAlArrancar` **tumba el API local** al arrancar («La base declara y el código no usa: zz.prueba12084.administrar»). Es ruidoso a propósito y la siguiente corrida lo limpia; se documenta en la cabecera del test con la sentencia de limpieza manual.

---

## 5. Auditoría (AC6) — qué entra por operación

Todo con `registrarCambiosPermisos(tx, actorDeRequest(req), cambios)` dentro de la tx del cambio; un lote por acto; `rolAfectadoCodigo = codigo` y **nunca** `usuarioAfectado` (el CHECK `sujeto_chk` exige uno u otro). Del actor, su correo (RN-A10 lo autoriza); del rol no hay PII.

| Operación | Filas (`entidad` · `accion` · `campo` · antes → después) |
|---|---|
| `POST /roles` | `rol·crear·nombre` null→v; `rol·crear·descripcion` null→v (si no es null); `rol·crear·tipo_enlace` null→v; `rol·crear·tipo_principal` null→v; `rol·crear·activo` null→true; y si `funciones` no está vacío, `rol_funcion·crear·conjunto` null→`{conjunto:[…]}` |
| `PATCH /roles/:codigo` | una fila `rol·editar·<campo>` por campo que **cambió de valor** (`nombre`, `descripcion`, `tipo_enlace`, `tipo_principal`, `activo`), antes→después escalares. Sin cambio real, sin fila (y la ruta responde 400 «Sin cambios») |
| `PUT …/funciones` | `rol_funcion·editar·conjunto` con `diffConjunto(antes, despues)`: `{conjunto}` → `{conjunto, concedidas, revocadas}`. Sin cambio de conjunto, sin fila |
| `DELETE /roles/:codigo` | **un par por campo, todos `accion='borrar'`, `valorDespues=null`**: `rol·borrar·nombre`, `·descripcion`, `·tipo_enlace`, `·tipo_principal`, `·activo` con su valor anterior, y `rol_funcion·borrar·conjunto` `{conjunto:[…]}`→null. El CHECK `campo_chk` admite `campo` con `borrar`. Se aparta de la tabla de §5 del diseño de la #12171 («una fila, `campo=null`») por una razón de tipo: `ValorAuditable` no admite la fila del rol como documento, y una fila sin campo ni valor **no responde «qué se borró»**, que es lo que AC6 exige. Con el lote entero, la pantalla de la #12171 muestra el acto como uno solo |

**`CAMPOS_AUDITABLES` y el CHECK no cambian** (§0). El generador de tests de paridad de la 0185 (`migracion-0185.test.ts:122-140`) sigue verde porque la 0186 no toca esa lista. `es_sistema` no se audita porque no se edita.

---

## 6. Migración `0186_permisos_roles_mantenimiento.sql` (número a confirmar)

Solo siembra; **sin DDL**. Modelo: el bloque de funciones + reparto de la 0185. Cabecera con `-- 0186_…`, `-- Autor:`, `Feature #12072`, `HU #12084`; sin `BEGIN/COMMIT`; `ON CONFLICT DO NOTHING` en los dos `INSERT` (nunca `DO UPDATE`: `migracion-0179.test.ts:100-103`).

```sql
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('permisos.catalogo.ver', 'permisos', 'Ver el catálogo de funciones', '…', 'operacion'),
  ('permisos.rol.listar',   'permisos', 'Ver los roles', '…', 'operacion'),
  ('permisos.rol.crear',    'permisos', 'Crear un rol', '…', 'operacion'),
  ('permisos.rol.editar',   'permisos', 'Editar un rol', '…', 'operacion'),
  ('permisos.rol.borrar',   'permisos', 'Borrar un rol', '…', 'operacion'),
  ('permisos.cuadro.ver',   'permisos', 'Ver el cuadro de funciones de un rol', '…', 'operacion'),
  ('permisos.cuadro.guardar','permisos','Guardar el cuadro de funciones de un rol', '…', 'operacion')
ON CONFLICT (codigo) DO NOTHING;
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES ('admin','permisos.catalogo.ver'), … ×7
ON CONFLICT DO NOTHING;
```

Los textos salen de `catalogo-operaciones.ts` **por el generador** (`npm run permisos:seed -w apps/api`), no a mano: `migracion-0179.test.ts:105-119` compara literal el seed generado con la suma de `MIGRACIONES_CON_REPARTO`. Idempotencia fuerte: segunda pasada `INSERT 0 0`. Sin `REVOKE`, sin retención: no crea tabla. **Antes de crear el archivo:** `git fetch && git ls-tree --name-only origin/develop apps/api/src/db/migrations/ | tail -3` — hoy devuelve 0184; la 0185 es la de #12171 (sin mergear) y la otra sesión (Feature #12365) puede tomar números (§8.4).

---

## 7. Archivos, tests y mutaciones

### 7.1 Backend — crear

| Archivo | Qué |
|---|---|
| `apps/api/src/shared/permisos-anti-bloqueo.ts` | §4: `conSeguroAntiBloqueo`, `BloqueoAdministracionError`, `FUNCIONES_DE_ADMINISTRACION`, `CONDICION_USUARIO_VIVO`. ~90 líneas |
| `apps/api/src/modules/permisos/permisos-roles.service.ts` | `listarRoles`, `crearRol`, `editarRol`, `borrarRol`, `cuadroDe`, `guardarCuadro`, `funcionesInexistentes`, `motivoNoBorrable`, `RESERVADOS`; errores `RolConflictoError(mensaje, usuarios?)`, `FuncionesInexistentesError(lista)`, `RolNoEncontradoError`. Cabecera con RN-A1, RN-A8, RN-A10. No es fichero de rutas: no entra en ningún inventario. ~260 líneas |
| `apps/api/src/db/migrations/0186_permisos_roles_mantenimiento.sql` | §6 |

### 7.2 Backend — modificar

| Archivo | Qué |
|---|---|
| `modules/permisos/permisos.routes.ts` | quitar `requireRole` y `ADMINISTRACION`; importar `exigirFuncion`; `GET /funciones` → `exigirFuncion('permisos.catalogo.ver')`; seis rutas nuevas (Zod en el fichero, lógica en el servicio); mapeo de errores → 400/404/409; `invalidarPermisosDeRol` post-commit en PATCH/DELETE/PUT; cabecera: ya no es «solo lectura». Estimado 48 → ~230 líneas (techo 800) |
| `modules/permisos/catalogo-operaciones.ts` | `const PER` + bloque «Permisos» con siete `op(...)` |
| `modules/permisos/inventario.generado.ts` | siete filas `modulo: "permisos"` (cabecera: «+7 por la HU #12084») |
| `modules/permisos/inventario-guardas.ts:70-93` | `{ modulo: 'permisos', fichero: 'permisos/permisos.routes.ts' }` |
| `modules/users/users.service.ts` | `actualizarUsuario`: `conSeguroAntiBloqueo` como **primera** sentencia de la tx cuando `updates.role !== undefined`, envolviendo el `UPDATE` (el `for('update')` del titular queda dentro, después del lock de población); `cambiarActivo`: envolver el `UPDATE`; comentario de enganche para #12089 |
| `modules/users/users.routes.ts` | `catch` de `BloqueoAdministracionError` → 409 en `PATCH /:id` y `PATCH /:id/toggle` (los pre-checks `:476-481` y `:638-643` se quedan) |
| `shared/middleware/canal-cliente.ts` | `RutaCliente.funcion?: string`; 8 entradas la declaran; `FUNCIONES_DEL_CANAL_EXTERNO` exportada (§3.3) |
| `db/migrations/README.md` | fila de la 0186 si el README lista migraciones |

### 7.3 shared-types — modificar

`packages/shared-types/src/permisos-roles.ts` (nuevo, ~40 líneas) con `RolCatalogo`, `CrearRolInput`, `EditarRolInput`, `CuadroRol`, `RespuestaGuardarCuadro`, `TIPOS_ENLACE`, `TIPOS_PRINCIPALES`; export en `index.ts`. Los `z.enum` de la ruta se construyen desde esas constantes (patrón `USER_ROLES`). La pantalla (#12085) los consume.

### 7.4 Tests

| Archivo | Tipo | Qué fija |
|---|---|---|
| `__tests__/services/permisos.roles.routes.test.ts` (nuevo; modelo `permisos.routes.test.ts` + `users.routes.test.ts`) | mocks | AC1: 201 y forma; 409 por `23505`; `operaciones` → 400; 400 con lista de inválidos y **`insertMock` no llamado para el rol**; `tipoPrincipal` ausente → 400. AC2: PATCH cambia `nombre`; `codigo` en el cuerpo → 400; `tipoEnlace` con N>0 → 409; `tipoPrincipal` → `invalidarPermisosDeRol` llamado **después** del commit (orden en `eventos`, patrón `users.routes.test.ts:161-165`). AC3: 409 «rol del sistema» sin `deleteMock`; 409 con «3 usuarios» (el N del mock aparece en el texto); 204 y `deleteMock` con `where` sobre `codigo`; `borrable`/`motivoNoBorrable` en el listado con el **mismo texto** que el 409. AC5: PUT reescribe (`deleteMock` + `insertMock` con las filas); igual conjunto → sin escrituras ni auditoría; `aviso` solo con rol externo y función fuera de la lista. AC6: cada operación produce el lote de §5 (leer `insertMock` de `permisos_auditoria`: entidad, accion, campo, antes/después; `rolAfectadoCodigo`; ningún `usuarioAfectado`). `permisos.catalogo.ver` protege `GET /funciones` (rol sin la función → 403) |
| `__tests__/services/permisos-anti-bloqueo.test.ts` (nuevo; `createKeyedDb` + `espia-drizzle`) | mocks | orden lock → escritura → cuenta (con `eventos`); `for('update')` **presente** en el lock y `orderBy id` (leer el SQL renderizado: el mock ignora `orderBy`, memoria del repo); cuenta 0 en cualquiera de las dos → lanza con la función que faltó; cuenta ≥1 en ambas → devuelve lo que `escritura()` devolvió; el predicado lleva `tipo_principal='interno'`, `active`, y las tres ramas de `permisos_usuario_funcion` (asertar sobre las condiciones leídas, no sobre la función exportada) |
| `__tests__/db/permisos-anti-bloqueo.concurrencia.test.ts` (nuevo) | base real, `skipIf` | §4.6 |
| `__tests__/db/migracion-0186.test.ts` (nuevo; modelo `migracion-0185.test.ts`) | estático + base | cabecera, sin DDL, `ON CONFLICT DO NOTHING` ×2 y sin `DO UPDATE`; siete funciones y siete pares `admin`; contra base: existen, idempotencia `INSERT 0 0` |
| `__tests__/services/users.routes.test.ts` | modificar | `vi.mock('../../src/shared/permisos-anti-bloqueo.js')` con `conSeguroAntiBloqueo` passthrough por defecto (si no, los `selectMock` encolados de los ~25 tests de PATCH se desordenan); un caso por ruta donde lanza → 409 |
| `__tests__/services/permisos.routes.test.ts` | modificar | el token `admin` sigue en 200 (recibe `permisos.catalogo.ver` por la foto); un rol sin la función → 403 |
| `__tests__/services/canal-cliente*.test.ts` (el que exista) | modificar | cada `funcion` declarada existe en el catálogo y su ruta de la foto lleva ese código; son 8 |
| `permisos.reconduccion-cierre.test.ts`, `permisos-seed-sql.ts`, `permisos-rutas-reconducidas.ts`, `migracion-0179.test.ts` | modificar | contadores de §1 |

### 7.5 Mutaciones nombradas (AC7 + añadidas)

| # | Mutación | Test que se pone en rojo |
|---|---|---|
| M1 (AC7) | invertir la condición del invariante (`=== 0` → `> 0`, o quitar el `throw`) | `permisos-anti-bloqueo.test.ts` «cuenta 0 → lanza»; y en `permisos.roles.routes.test.ts` el PUT que vacía el cuadro de `admin` con un solo admin ya no da 409 |
| M2 (AC7) | sacar el invariante fuera de la tx (contar con `db` tras el commit) | concurrencia §4.6: los dos confirman |
| M3 (AC7) | quitar `.for('update')` del lock | `permisos-anti-bloqueo.test.ts` (SQL renderizado sin `for update`) **y** concurrencia §4.6 |
| M4 | quitar `orderBy(users.id)` del lock | `permisos-anti-bloqueo.test.ts` (SQL renderizado). La concurrencia con dos filas no lo ve siempre: por eso el aserto sobre el SQL |
| M5 | quitar `invalidarPermisosDeRol` del PUT | `permisos.roles.routes.test.ts`: `invalidarPermisosDeRolMock` no llamado tras el commit |
| M6 | invalidar **antes** del commit | orden en `eventos`: `commit` debe preceder a `invalidar-rol` |
| M7 | quitar `r.tipo_principal='interno'` del predicado | `permisos-anti-bloqueo.test.ts`: condiciones leídas |
| M8 | quitar la rama `revocar` del predicado | ídem; y un caso con un usuario `revocar` que ya no cuenta |
| M9 | quitar `es_sistema` del candado de DELETE | 409 «rol del sistema» → 204 |
| M10 | `motivoNoBorrable` distinto entre listado y 409 | el test que compara los dos textos |
| M11 | quitar `'operaciones'` de `RESERVADOS` | POST `operaciones` → 201 |
| M12 | quitar `'soat.cola.ver'` de la lista del canal | el test de paridad canal ↔ catálogo; y el PUT de un rol externo con `soat.cola.ver` empieza a avisar |

---

## 8. Riesgos abiertos y pendientes humanos

1. **AC1 «el INSERT en `users` con ese rol funciona» solo es cierto con `tipo_enlace='ninguno'`** (§0). Con `compania`/`proveedor_soat`/`organismos_transito`, `users.routes.ts` deriva el ámbito de literales de los doce roles y el trigger de la 0178 responde `23514` → 500. Arreglarlo es cambiar cuatro literales por `tipoEnlace` de `rolAsignable()` en `users.routes.ts:327-350,:418-448` — pequeño, pero es la HU #12088 (unificación de ámbitos) o un AC nuevo aquí. **Decisión humana:** (a) esta HU prueba el alta con `ninguno` y deja escrito que los enlazados esperan a la #12088; (b) se absorbe aquí. Recomendación: **(a)**, y como mínimo mapear `23514` a 400 en el alta para que no sea un 500 (una línea en `users.routes.ts`, opcional).
2. **`tipoEnlace` solo con 0 usuarios** y **`tipoPrincipal` editable con invariante + invalidación** (§2.3): dos decisiones de producto tomadas aquí por criterio de riesgo. Confirmar.
3. **`permisos.routes.ts` crece de 48 a ~230 líneas** (techo `max-lines` 800: holgado). Si el backend prefiere partir, el segundo fichero de rutas también entra a `FICHEROS_EN_ALCANCE` (23→24) y a los contadores; no se recomienda.
4. **Numeración**: la 0185 de la #12171 no está en `develop`; la otra sesión (Feature #12365) mergea en paralelo. Comprobar `git ls-tree origin/develop` **el mismo turno** en que se cree el archivo (memoria: «una premisa de estado caduca»). Si la #12171 aterriza como 0186, esta pasa a 0187 y hay que renombrar archivo, cabecera, test y `MIGRACIONES_CON_REPARTO`.
5. **`catalogo.ts:150-152`** (códigos únicos): siete códigos nuevos, ninguno repetido con las 231 operaciones ni con las `pagina.*` del catálogo (comprobado: el prefijo `permisos.` no existía).
6. **La foto congelada** (`inventario.generado.ts`): se edita a mano, como su cabecera permite, «junto con su migración». Las siete filas llevan `heredada: false`.
7. **Recuperación si ya hay cero administradores**: el invariante rechazará **toda** operación de las cinco, incluida la que intente arreglarlo. No es un caso de esta HU (no hay ruta que lo cause), pero conviene dejar escrito en la cabecera de `permisos-anti-bloqueo.ts` que la vía es `psql` (`INSERT INTO permisos_rol_funcion …`).
8. **Residuo del test de concurrencia** (§4.6): tumba el API local al arrancar si la corrida muere a medias. Ruidoso a propósito; la limpieza está en la cabecera del test.
9. **Un tercer administrador creado en paralelo no cuenta** (no toma el lock): el invariante puede dar un 409 conservador en una ventana de milisegundos. Aceptado: negar por defecto.

---

## 9. Notas operativas

- **backend-agent** — Orden: (1) shared-types; (2) `permisos-anti-bloqueo.ts` + su test con espía; (3) `permisos-roles.service.ts` + rutas + las nueve piezas de §1 **a la vez** (el catálogo no compila a medias: `verificarCatalogoAlArrancar` tumba el API si base y código difieren); (4) generar el seed con `npm run permisos:seed -w apps/api` y recortar de la salida las siete funciones + siete pares para la 0186; (5) enganches en `users.service.ts` y el mock en `users.routes.test.ts`; (6) el test de concurrencia contra `TEST_DATABASE_URL` (5434, no 5433). Gate: `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`; `npx eslint apps/api/src/modules/permisos/permisos.routes.ts` para leer `max-lines`; `TZ=UTC` en los tests. El escritor de auditoría se llama **sin** `try/catch`.
- **qa-agent** — Los tres tests de AC7 están en §7.5 M1-M3; el de concurrencia se salta sin `TEST_DATABASE_URL`: correrlo con la variable puesta y **leer** que no dice `skipped`. Verificar la mutación M3 con `git diff` antes de leer el test (memoria: «mutante: comprobar dónde cayó»). Comprobar que `GET /roles` no expone ningún nombre de usuario.
- **security-agent** — Atacar: `PATCH /roles/admin` con `{ esSistema: false }` y `{ codigo: 'x' }` (400 por `.strict()`); `POST /roles` con `codigo: 'operaciones'` (400); `PUT /roles/admin/funciones` con `[]` (409 del invariante); un rol `externo` con `usuarios.usuario.editar` en su cuadro no debe contar como administrador (predicado `interno`).
- **frontend-agent** — no interviene: [BACKEND]. La pantalla es la #12085 y consume `permisos-roles.ts` de shared-types.
