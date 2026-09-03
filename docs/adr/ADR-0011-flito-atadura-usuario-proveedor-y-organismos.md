# ADR-0011 — La atadura del gestor de impuestos deja de ser una columna y pasa a ser una tabla

## Estado

**Propuesto** — HU [#12053](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12053) (Feature [#12052](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12052)). **Pendiente de aprobación del Líder Técnico**: no lo aprueba ningún agente.

**Se apoya en** [ADR-0005](./ADR-0005-flito-fk-users-auditoria-on-delete.md) (categorías de `ON DELETE` hacia `users`) y en el patrón de [ADR-0008](./ADR-0008-flito-soat-canal-cliente.md) §3 (el ámbito de un rol se lee de la BD, no del JWT).

**No contradice ningún ADR aceptado.** Se aparta deliberadamente de **un** detalle de la migración `0168` —el `CHECK` que sostiene «un `cliente` siempre tiene compañía»— y la decisión 5 explica por qué el argumento de aquella migración no se transfiere a este caso.

**No toca** el rol `transito`. `users.transito_codigo` sigue siendo suya, con su `CHECK` ausente, su claim en el JWT y sus tres lectores (`transito-scope.ts`, `transito-config.routes.ts`, `tramites.service.ts`). Lo único que cambia para esa columna es que **deja de tener un segundo inquilino**.

## Contexto

FLITO tiene hoy cuatro roles con frontera de datos y tres formas distintas de guardarla:

| Rol | Dónde vive el ámbito | Cardinalidad | Lo escribe la pantalla de usuarios |
|---|---|---|---|
| `transito` | `users.transito_codigo` | 1 | Sí |
| `cliente` | `users.compania_id` | 1 | Sí (Feature #11912) |
| `proveedor` | `users.flito_proveedor_soat_id` | 1 | **No — solo el seed** |
| `gestor_impuestos` | `users.transito_codigo` **prestada** | 1 | **No — solo el seed** |

Los dos últimos son el objeto de esta HU, y cada uno falla de una manera distinta.

**El `proveedor`.** La columna existe desde la migración de arranque de FLITO, con su FK a `flito_proveedores_soat`, y `contextoSoat()` (`flito-soat.service.ts:85`) la lee de la BD en cada petición: **CA-09 ya funciona**. Lo que no existe es la forma de escribirla: `users.routes.ts` no la nombra en `createSchema`, ni en `updateSchema`, ni en `userSelect`. El único escritor del repo es `flito-seed.ts:103-106`. Un `proveedor` creado desde la pantalla nace con `flito_proveedor_soat_id = NULL` y —correctamente, porque el fallo es cerrado— no ve absolutamente nada. El admin no tiene manera de arreglarlo salvo un `psql`.

**El `gestor_impuestos`.** Reutiliza `users.transito_codigo`, y esa reutilización está rota por los dos extremos:

1. **La API la prohíbe.** El `superRefine` de `createSchema` rechaza `transitoCodigo` cuando `role !== 'transito'` con «Solo usuarios tránsito pueden tener organismo asignado», y el `PATCH` repite la guarda. Es decir: **el contrato de la API declara ilegal el estado en el que el seed deja a `gestor.medellin` y `gestor.envigado`**. No es una omisión de la pantalla; es una contradicción entre lo que la base contiene y lo que la API acepta.
2. **La cardinalidad no da.** El AC2 pide *varias* (la HU las llama «secretarías»; en el repo, y en la UI, la fila de `organismos_transito_config` se llama **organismo de tránsito** — ver la nota de vocabulario al final del contexto). Una columna `varchar(5)` guarda una.

Hechos medidos en el worktree `flito-hu12053` antes de decidir (`grep` sobre `apps/api/src`, sin `__tests__`):

- Los lectores de `users.transito_codigo` son **cinco**, y **cuatro de ellos filtran por `role = 'transito'`**: `transito-scope.ts:25` (`if (user.role !== 'transito') return 403`), `transito-config.routes.ts:100/128/224` (mismo gate), `tramites.service.ts:259` (`opts.actorRole === 'transito' && …`) y `transito-config.ts:76/98` (`WHERE … AND role = 'transito'`, el contador de usuarios por organismo). **El quinto es `flito-impuestos`**, el único que la lee para un gestor.
- `auth.routes.ts:88` mete `transitoCodigo` en el JWT **para cualquier rol que la tenga puesta**. Hoy los dos gestores del seed llevan en su token un claim que significa «mi organismo, como usuario `transito`» sobre un usuario que no es `transito`. Nadie lo lee para ellos; el día que alguien añada un check que mire solo el claim, lo leerá.
- **La atadura del gestor no llega a la carga de recibos.** `flito-recibos.service.ts:102` hace `ctx.role === 'gestor_impuestos' ? ctx.transitoCodigo : null`, y `buscarCandidato()` (línea 190) solo acota `organismo_codigo` **si ese valor no es null**. Un `gestor_impuestos` sin `transito_codigo` —el que produce hoy la pantalla de usuarios, porque la API le prohíbe ponérselo— sube un recibo y **cruza contra impuestos de cualquier organismo**, incluidos los asumidos por Operaciones (`gestionOperaciones`, que también se acota dentro de ese mismo `if`). La cola le sale vacía; la conciliación, no. Es un agujero preexistente, no una regresión, y el diseño lo cierra de paso.
- **`umbralPara(null)` es lo que hoy usa Operaciones** aunque el impuesto tenga organismo con `flito_umbral_ocr` propio: el umbral por organismo solo se aplica cuando quien sube es el gestor (`umbralDelGestor`, línea 114). Es una asimetría existente y sin justificación escrita, y con N organismos deja de poder mantenerse tal cual.
- **`gestorRequiereProveedor()` y `gestorRequiereOrganismo()` ya existen** en `packages/shared-types/src/flito-roles.ts:26-32`, exportados desde `index.ts`, y **con cero consumidores en todo el repo**. Se escribieron para esto y nunca se enchufaron.

**Nota de vocabulario.** La HU y su rama dicen «secretarías»; el repo entero dice **organismo de tránsito** —el menú es «Organismos STT», el campo del rol `transito` es «Organismo de tránsito», la columna es `organismo_codigo` y el helper de `shared-types` es `gestorRequiereOrganismo`—. `docs/ux/usuarios-ambito-proveedor-y-gestor-impuestos.md` (decisión 11) fija «organismo» para la UI. **Este ADR usa «organismo» en todo lo que se escribe** (tabla, columna, campo del contrato, copy) y reserva «secretaría» para citar el AC. Un sinónimo nuevo para la misma fila es deuda de lenguaje que dura más que el código.

## Alternativas

### Opción 1 — Tabla de unión `flito_gestor_organismos` (PK compuesta)

Una fila por par `(user_id, organismo_codigo)`. `users.transito_codigo` queda solo para el rol `transito`.

**Pros**

- La FK a `organismos_transito_config(codigo)` la comprueba la base: un código inventado es un `23503` en el `INSERT`, no una fila muerta. `users.transito_codigo` **no tiene FK** —es un `varchar(5)` suelto—, así que hoy nada impide sembrar un gestor con un código que no existe (y el backfill demuestra que hay que contemplarlo).
- La consulta de la cola es la generalización literal de la actual: `eq(organismoCodigo, x)` → `inArray(organismoCodigo, xs)`. No cambia el plan, no cambia la semántica.
- El listado de usuarios se resuelve con **una** consulta más para toda la página, agrupada en memoria: `users` es una tabla de decenas de filas en esta instalación.
- La cardinalidad futura sale gratis: si mañana un `transito` necesita dos organismos, o un `proveedor` dos aseguradoras, el molde ya está escrito.
- Precedente exacto en el repo: `flito_bolsa_transito_cobertura` (`schema.ts:3623`) es una tabla de unión con PK compuesta sobre `organismos_transito_config`.

**Contras**

- Es la primera tabla del repo que se escribe desde `users.routes.ts`, que hoy es un módulo de un solo archivo sin `.service.ts`. Obliga a transaccionar el alta y la edición.
- El `updates` de Drizzle deja de ver el cambio de ámbito, así que la invalidación de sesión del AC4 hay que dispararla a mano (decisión 4).
- No existe `CHECK` capaz de exigir «≥1 organismo»: es una cardinalidad entre tablas, y eso un `CHECK` no lo expresa (decisión 5).

**Esfuerzo**: M · **Riesgos**: el backfill de la 0173 es el único punto donde se pueden perder gestores existentes; se mitiga con `JOIN` + `RAISE NOTICE` (decisión 3).

### Opción 2 — `users.organismos_codigos text[]`

Una columna array en `users`, al lado de `allowed_pages` (que ya es `text[]`).

**Pros**

- Cero tablas nuevas, cero transacciones nuevas: entra en el `updates` de Drizzle como una clave más y **la invalidación de sesión del AC4 sale gratis** con la línea de `debeInvalidar` que ya existe. Es la única ventaja real, y es de verdad.
- `userSelect` la lleva sin componer nada, así que `.returning(userSelect)` sigue devolviendo el usuario completo en `POST` y `PATCH`.
- Precedente en el mismo archivo (`allowedPages`).

**Contras**

- **No hay FK sobre los elementos de un array.** PostgreSQL no la admite. La única defensa contra un código que no existe sería Zod, es decir, exactamente la garantía que `users.transito_codigo` ya tiene hoy y que ya falló: la base quedaría de nuevo aceptando lo que la API rechaza. Y borrar un organismo de `organismos_transito_config` dejaría gestores apuntando a la nada, en silencio.
- El predicado de la cola pasa de `organismo_codigo = $1` a `organismo_codigo = ANY(u.organismos_codigos)` con `users` metida en la consulta de impuestos, o a leer el array antes y `inArray`. Lo segundo es lo mismo que la opción 1 con peor integridad; lo primero mete `users` en el `WHERE` de la cola, que hoy no está.
- `allowed_pages` **no es precedente**: sus elementos no referencian ninguna tabla, son slugs de un catálogo de código (`isValidPage`). Un array es correcto cuando no hay a qué apuntar; aquí hay una tabla con PK.
- La pregunta «qué gestores cubren Medellín» —la que hará Operaciones el día que un gestor se vaya— pasa de un índice a un `unnest`.

**Esfuerzo**: S · **Riesgos**: integridad referencial inexistente; es el riesgo que esta HU viene a cerrar, no a repetir.

### Opción 3 — Seguir en `users.transito_codigo`, con «principal» + tabla de las demás

Mantener la columna como el organismo principal del gestor y poner el resto en una tabla.

**Pros**

- `flito-recibos.service.ts` no se toca: `umbralDelGestor()` y el `organismoCodigo` del recibo siguen leyendo un único código.
- El backfill es trivial: no hay que mover nada.

**Contras**

- **Dos fuentes para un hecho.** La pregunta «¿de qué organismos es este gestor?» se responde uniendo una columna y una tabla, y el primer lector que consulte solo una de las dos estará en lo cierto la mitad de las veces. Es la definición de deriva silenciosa.
- La API tendría que **dejar de rechazar** `transitoCodigo` para `gestor_impuestos`, borrando la guarda que hoy es lo único que impide atar un gestor por error.
- Convierte «cuál es la principal» en una semántica que nadie puede explicar: el umbral de OCR y el organismo del recibo dependerían de qué organismo marcó primero el admin.
- El claim `transitoCodigo` del JWT seguiría viajando en gestores.

**Esfuerzo**: S · **Riesgos**: el peor de los tres. Deja el sistema con la contradicción con la que empezó, ampliada.

## Decisión

**Opción 1.** Con seis decisiones concretas:

### 1. La tabla se llama `flito_gestor_organismos` y su PK es el par

`PRIMARY KEY (user_id, organismo_codigo)`, sin `id` sustituto. La fila **es** el par: un `uuid` propio obligaría a añadir además un índice único sobre el par para impedir duplicados —dos objetos de base de datos para un solo hecho— y nadie referencia estas filas por id. Es el molde de `flito_bolsa_transito_cobertura`, que sí necesita el índice único aparte porque su PK lleva una tercera columna.

Nombre atado al rol (`gestor`) y no genérico (`users_organismos`) a propósito: impide que alguien la reutilice mañana para el rol `transito`, que tiene su columna, su semántica y su combobox, y **no se toca**. Y dice «organismos», no «secretarías», por la nota de vocabulario de arriba.

**`ON DELETE`, clasificado según ADR-0005:**

- `user_id → users.id` **`CASCADE`**: categoría *pertenencia*. La fila no dice nada de un acto; es una extensión del usuario y sin él no significa nada. Mismo cajón que `driver_profile.user_id`.
- `organismo_codigo → organismos_transito_config.codigo` **`RESTRICT`**: borrar un organismo no puede desatar gestores en silencio. `SET NULL` es imposible (es columna de la PK) y `CASCADE` sería justamente el borrado silencioso. Mismo criterio que `users.compania_id` (ADR-0008 §3) y que `flito_bolsa_transito_cobertura.organismo_codigo`.

**Índices**: la PK sirve la única consulta caliente —«los organismos de este usuario», que corre en cada petición del gestor— porque `user_id` es su columna líder. Se añade `idx_flito_gestor_organismos_organismo` sobre `organismo_codigo` **por el `RESTRICT`**, no por un reporte: sin él, cada borrado de una fila de `organismos_transito_config` escanea la tabla entera para comprobar que nadie la referencia. Es el mismo motivo, escrito, por el que existe `idx_users_compania` (`schema.ts:104-106`). No se añade ningún índice más: la tabla tiene el tamaño de «usuarios gestores × sus organismos» y cualquier otro índice sería más grande que la ganancia.

**Sin `created_by`.** Quién ató a quién ya lo registra `audit()` en `users.routes.ts`, con su `resourceId` y su detalle. La fila es un **estado**, no un evento, y se borra y se recrea en cada edición: un `created_by` en ella sería un dato de autoría que caduca al primer cambio de la lista.

### 2. Fuente única: la columna se limpia, no se espeja

Para el rol `gestor_impuestos`, `users.transito_codigo` **deja de usarse y se pone a `NULL`** en la misma migración, después del backfill.

El argumento decisivo no es de gusto: **la API ya declara ilegal ese estado**. El `superRefine` de `createSchema` y las guardas del `PATCH` rechazan `transitoCodigo` en cualquier rol que no sea `transito`. Dejar la columna poblada en los gestores mantendría la base en un estado que su propia API rechaza —el que hoy produce el seed y solo el seed—, y el primer `PATCH` sobre uno de esos usuarios (cambiarle el nombre, por ejemplo) ya arrastra las guardas de `transitoCodigo` con un valor que la pantalla no muestra ni puede cambiar.

Consecuencias comprobadas antes de decidir:

- **Ningún lector se rompe.** Los cuatro lectores no-FLITO filtran por `role = 'transito'`; el contador de `transito-config.ts:76` también. El único que lee la columna para un gestor es `flito-impuestos`, que pasa a leer la tabla.
- **El claim del JWT desaparece para el gestor** (`auth.routes.ts:88` lo mete solo `if (user.transitoCodigo)`), que es la mitad buena del cambio: un token de gestor deja de llevar un ámbito que no le corresponde.
- El seed (`flito-seed.ts:107-109`) deja de escribir `transitoCodigo` en los dos gestores y pasa a insertar sus filas en la tabla nueva.

### 3. La migración 0173 backfillea, avisa y limpia — en ese orden

```
INSERT … SELECT u.id, u.transito_codigo
  FROM users u JOIN organismos_transito_config o ON o.codigo = u.transito_codigo
 WHERE u.role = 'gestor_impuestos' AND u.transito_codigo IS NOT NULL
    ON CONFLICT DO NOTHING;
```

El `JOIN` no es adorno: `users.transito_codigo` **no tiene FK**, así que un gestor en DEV puede llevar un código que no está en `organismos_transito_config`, y un `INSERT` directo abortaría con `23503` **la cadena entera de migraciones** de todos los ambientes. Con el `JOIN`, esos gestores quedan fuera; un bloque `DO $$` los cuenta y emite `RAISE NOTICE` con sus `id` y su código —sin `username`, sin PII— **antes** de limpiar, para que quede en el log del CD (que es donde se leen los `NOTICE` de esta cadena) y un admin pueda reasignarlos desde la pantalla nueva.

Se limpia **también** a los huérfanos. Su código era inutilizable —no existe en el catálogo parametrizado, así que `inArray` nunca lo cruzaría— y conservarlo solo mantendría el estado que la decisión 2 elimina. Quedan sin organismos, y sin organismos **no ven cola**: el fallo es cerrado, que es el punto.

Idempotencia fuerte: en la segunda pasada el `SELECT` del backfill no encuentra nada (la columna ya está a `NULL`), el `NOTICE` cuenta cero y el `UPDATE` toca cero filas.

### 4. La invalidación de sesión (AC4) se dispara con un booleano calculado, no con el `updates`

El `PATCH` compara el conjunto de organismos **anterior** (leído en la misma transacción) con el pedido y calcula `organismosCambiaron`. Ese booleano entra en `debeInvalidar` junto a `role | allowedPages | transitoCodigo | companiaId | flitoProveedorSoatId`, y `updates.sessionInvalidatedAt = new Date()` sigue siendo lo que ejecuta la invalidación.

Detalle que hay que escribir para que nadie lo «simplifique»: la guarda `if (Object.keys(updates).length === 0) → 400 'Sin cambios'` pasa a ser `if (Object.keys(updates).length === 0 && !organismosCambiaron)`. Y cuando lo único que cambia son los organismos, **es la propia `sessionInvalidatedAt` la que mantiene el `UPDATE` no vacío**, así que `db.update(users).set(updates).returning(userSelect)` sigue devolviendo la fila sin ninguna rama especial.

Todo —el `UPDATE` de `users`, el `DELETE` y el `INSERT` de la tabla nueva— va en **una** `db.transaction`. Si no, un fallo entre medias deja al gestor con organismos nuevos y su sesión vieja viva, que es exactamente lo que el AC4 prohíbe. `invalidateSessionCacheFor(id)` se llama **después** del commit, como ya se hace.

La escritura del conjunto es `DELETE … WHERE user_id = $1 AND organismo_codigo <> ALL($2)` seguido de `INSERT … ON CONFLICT DO NOTHING`, y no un `DELETE` total + `INSERT`: preserva el `created_at` de las filas que no cambiaron.

### 5. No hay `CHECK` para «≥1 organismo», y tampoco se añade el de `proveedor`

**Para los organismos es imposible**: la cardinalidad mínima entre dos tablas no cabe en un `CHECK` (haría falta un trigger, y un trigger que decida quién ve qué es la clase de lógica que no debe vivir donde nadie la busca).

**Para `proveedor` sería posible** —`role <> 'proveedor' OR flito_proveedor_soat_id IS NOT NULL`, calcado del `users_cliente_compania_chk` de la 0168— **y aun así no se añade**. La 0168 dejó escrita su propia condición de validez: «Se aplica sobre las filas existentes sin `NOT VALID`: **hoy no hay ningún usuario `cliente`**». Ese argumento no se transfiere: el rol `proveedor` existe desde antes de FLITO y cualquier `proveedor` creado desde la pantalla tiene `flito_proveedor_soat_id = NULL` —la pantalla nunca lo pudo escribir—. Un `CHECK` validado abortaría la migración; uno `NOT VALID` dejaría esas filas **imposibles de tocar**: `PATCH /:id/toggle` (activar/desactivar) reevaluaría el `CHECK` sobre la fila y devolvería un `23514` como 500, dejando a un usuario legítimo sin poder ser desactivado.

A cambio, la 0173 **cuenta y avisa**: un `RAISE NOTICE` con cuántos `proveedor` quedan sin proveedor SOAT, para que Operaciones los vea en el log del CD y los arregle desde la pantalla que esta HU entrega. Y la garantía real sigue siendo la de siempre y la que importa: `contextoSoat()` devuelve `proveedorSoatId = null` y **el gestor no ve nada**. El fallo por defecto es «no ve nada», nunca «lo ve todo» — igual que la tercera capa del AC2 de la 0168.

Consecuencia asumida: las dos ataduras nuevas tienen garantía **de aplicación**, no de base. Se dice aquí para que quede como decisión y no como olvido, y para que el día que las filas huérfanas sean cero alguien pueda añadir el `CHECK` del `proveedor` en una migración posterior.

### 6. El umbral de OCR pasa a ser el del organismo del impuesto — solo cuando quien sube es el gestor

Es el tradeoff que la lista de organismos fuerza, y las tres salidas posibles son:

| Salida | Qué implica | Veredicto |
|---|---|---|
| **Umbral del organismo del impuesto concreto** | Se resuelve **después** de `buscarCandidato()`, por archivo, con un mapa `codigo → umbral` cacheado por lote | **Elegida** |
| Umbral más estricto de sus organismos | Un recibo de Envigado juzgado con el listón de Medellín va a revisión sin que nadie sepa por qué | Descartada |
| Mantener un organismo «principal» | Reintroduce la opción 3 por la puerta de atrás: el umbral dependería de cuál marcó primero el admin | Descartada |

Es viable porque el umbral **no cambia lo que el OCR lee**: `aCampoExtraido()` (`flito-ocr.service.ts:223`) solo lo usa para marcar `confiable: confianza >= umbral`, y `evaluarReciboImpuesto()` compara contra el número, no contra ese flag. Así que la extracción puede correr con el umbral por defecto —solo necesita producir valores y confianzas— y el umbral real aplicarse cuando ya se sabe a qué impuesto cruza. **Sin una segunda llamada al OCR.**

Con un matiz que hay que implementar o el cambio miente: `flito_impuestos.extraccion` se **persiste** con el flag `confiable`, y `FlitoRevisiones.tsx:183` pinta con él el chip «confiable / no confiable». Si el veredicto usa el umbral del organismo y el flag guardado usa el defecto, la pantalla de revisión puede mostrar «confiable» sobre un campo que mandó el recibo a revisión. Por eso la extracción se **re-marca** con el umbral definitivo antes de persistirla: recorrer los campos ya extraídos recalculando un booleano, sin red y sin OCR.

**No aplica a Operaciones (`admin`)**: se implementó la variante conservadora del párrafo siguiente. La propuesta original de este ADR era aplicarlo también a `admin`, con este argumento: hoy `umbralDelGestor()` le devuelve `umbralPara(null)` aunque el impuesto sea de un organismo con `flito_umbral_ocr` propio. El umbral es una propiedad **del organismo que emite el documento** —lo dice el docstring de `umbralPara()`: «sobrescribible por proveedor (SOAT §6) o por organismo (Impuestos §6.2)»—, no de quién sube el archivo. Dejar dos reglas según el rol es una asimetría que hoy nadie sabe explicar y que la HU obliga a tocar de todas formas.

> **Decidido (2026-09-03, hilo de la HU #12053): variante conservadora.** El umbral por organismo se aplica
> solo cuando `esGestor(ctx)`; para `admin` no cambia nada (`umbralPara(null)`, como hoy). Motivo: el Feature
> #12052 declara «rediseñar las colas SOAT/impuestos» fuera de alcance y ningún AC pide tocar el umbral de
> `admin`. Se pierde la regla única; no se pierde nada del AC6. La asimetría queda **documentada y viva**:
> unificarla es un corte propio, no un efecto colateral de esta HU.

### 7. CA-10 con lista: `inArray`, y lista vacía sigue siendo «no ve nada»

`ImpuestoCtx.transitoCodigo: string | null` pasa a `ImpuestoCtx.organismos: string[]`. Se **renombra** a propósito: mantener el nombre con otro tipo dejaría compilando cada `if (ctx.transitoCodigo)` con una semántica nueva. El renombrado obliga al compilador a enseñar los seis lectores.

La semántica de frontera **no cambia**: `if (ctx.organismos.length === 0) return null` sustituye letra por letra al `if (!ctx.transitoCodigo) return null` de `flito-impuestos.service.ts:195`. **Sin frontera no ve nada.** El retorno temprano va antes del `inArray` también por una razón mecánica: `inArray` con un array vacío no produce SQL válido en Drizzle, así que llegar ahí con la lista vacía sería un error de servidor donde hoy hay una cola vacía.

Y se cierra el agujero medido en el contexto: `buscarCandidato()` deja de recibir «un código o null» y pasa a recibir la lista, con la regla explícita **gestor con lista vacía → ningún candidato**, en vez del actual «null → sin acotar».

## Consecuencias

- Los gestores existentes en DEV (`gestor.medellin`, `gestor.envigado`) siguen viendo exactamente su misma cola tras la 0173: el backfill los mueve, no los reinicia.
- Un `gestor_impuestos` que quede con cero organismos —por un huérfano del backfill, o porque un `psql` de soporte le borró las filas— no ve cola, no ve detalle y no concilia recibos. Es el único estado degradado posible y es cerrado.
- `apps/web/src/pages/Users.tsx` está en **551 líneas de código** sobre un techo de 800 (`max-lines`, `skipBlankLines` + `skipComments`). Los dos campos nuevos y sus catálogos no caben con margen: salen a `components/flit/`. Es un número, no una preferencia.
- `packages/shared-types` **no cambia de tipos**: no existe allí ningún tipo `User` (`Users.tsx` lo declara en local). Sí se enchufan por fin `gestorRequiereProveedor()` y `gestorRequiereOrganismo()`, que llevaban desde la migración a FLITO exportadas y con cero consumidores, y se corrigen sus docstrings —hablan de `users.proveedor_soat_id` y `users.organismo_id`, dos columnas que no existen—.
- El rol `transito` queda **más** limpio que antes: su columna deja de tener un segundo inquilino y su claim del JWT deja de aparecer en usuarios que no son suyos.
- No se remodela `flito_impuestos`, no se toca la Feature #11969, y `flito-soat` no se rediseña: CA-09 ya funciona y esta HU solo le da por fin un escritor.
