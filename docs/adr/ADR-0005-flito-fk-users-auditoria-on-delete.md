# ADR-0005 — `ON DELETE` de las claves foráneas hacia `users`: autoría, auditoría y pertenencia

## Estado

**Propuesto** — Feature [#11495](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11495) (17b), HU [#11556](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11556).

El Líder Técnico (David) aprobó el **2026-08-18** el diseño de la HU #11556, y con él la cláusula concreta `ON DELETE RESTRICT` de `flito_comparendos_registros.gestion_actualizada_por` (migración `0154`), además de la creación de este ADR. La **regla general** que aquí se propone —las tres categorías y su aplicación a toda FK futura hacia `users`— queda en `Propuesto` hasta que se apruebe como política del repo.

Origen: hallazgo del `db-review-agent` durante la HU [#11555](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11555), al señalar que `flito_comparendos_registros.causal_id` quedó en `NO ACTION` **por omisión y no por decisión escrita**.

## Contexto

`apps/api/src/db/schema.ts` declara **164 columnas** que referencian `users.id`. Su reparto por cláusula `ON DELETE`, contado sobre el esquema tal como está hoy:

| Cláusula | Columnas | Ejemplos |
|---|---|---|
| **Sin cláusula** (`NO ACTION` implícito) | **125** | `flito_comparendos_nits.created_by`, `flito_comparendos_token_simit.updated_by`, `flito_comparendos_sync_runs.iniciado_por` |
| `SET NULL` | 28 | `tramites_digitales.created_by`, `tramite_eventos.actor_user_id`, `laft_alertas.decided_by` |
| `CASCADE` | 6 | `driver_profile.user_id`, `driver_documents.user_id`, `laft_employees_kyc.user_id`, `training_attendees.user_id` |
| `RESTRICT` | 5 | `laft_cash_txns.registrado_por`, `laft_reportes_uiaf.generado_por`, `alcohol_tests.conductor_id`, `checklists.conductor_id`, `siigo_factura_estados_dian.registrado_por` |

El dato relevante no es cuál gana, sino que **la mayoría absoluta —125 de 164, el 76 %— no expresa ninguna decisión**. `NO ACTION` no se eligió: es lo que PostgreSQL pone cuando nadie escribe nada. Y en las tres cláusulas que sí se escribieron se adivina un criterio coherente que nunca se puso por escrito:

- `SET NULL` aparece siempre en columnas de **autoría blanda** —`created_by`, `updated_by`, `uploaded_by`, `actor_user_id`—, donde la fila conserva todo su sentido sin saber quién la creó.
- `RESTRICT` aparece en filas que **son prueba** y pierden su valor probatorio sin la persona: quién registró una operación en efectivo bajo SARLAFT, quién generó un reporte a la UIAF, a qué conductor se le hizo una prueba de alcoholemia o un checklist.
- `CASCADE` aparece en filas que **no existen sin el usuario**: su perfil de conductor, sus documentos, su asistencia a una capacitación, su KYC de empleado. Ahí la fila no habla *de* un acto, es una extensión del propio usuario.

En el módulo `flito-comparendos` las **cinco** FKs hacia `users` existentes (`nits.created_by`, `nits.updated_by`, `token_simit.created_by`, `token_simit.updated_by`, `sync_runs.iniciado_por`) están en el grupo de las 125: sin cláusula, sin decisión.

Un dato que cambia cómo se lee todo lo anterior: **la aplicación no borra usuarios**. No existe un solo `db.delete(users)` ni `DELETE FROM users` en `apps/api/src`; la baja de una persona es `users.active = false`, y la invalidación de sesión es `sessionInvalidatedAt`. Es decir, hoy ninguna de estas 164 cláusulas se ejecuta jamás. Lo que se está decidiendo no es un comportamiento en caliente: es **qué pasará el día que alguien tenga que borrar un usuario de verdad** —una supresión bajo Ley 1581, una depuración de datos de prueba, un empleado que ejerce su derecho— y si ese día el sistema falla ruidosamente, borra en silencio, o reescribe registros de auditoría dejándolos falsos pero con apariencia válida.

La HU #11556 obliga a resolverlo porque introduce la primera FK hacia `users` del módulo que **no es autoría, es auditoría**: `flito_comparendos_registros.gestion_actualizada_por` responde «quién gestionó este comparendo» y viaja emparejada con `gestion_actualizada_en`. Las dos columnas se leen juntas o no se leen.

## Decisión

**Toda FK nueva hacia `users` declara su `ON DELETE` de forma explícita, y lo elige clasificando la columna en una de estas tres categorías.**

| Categoría | Pregunta que la identifica | `ON DELETE` | Por qué |
|---|---|---|---|
| **Autoría blanda** | ¿La fila sigue siendo verdad y útil sin saber quién la tocó? | `SET NULL` | El dato principal es la fila, no la persona. Perder el «quién» degrada la información; no la corrompe. |
| **Auditoría / prueba** | ¿La fila *es* el rastro de un acto, o el registro de algo hecho *a* una persona, y hay que poder sostenerla ante alguien? | `RESTRICT` (explícito) | Sin la persona, la fila no queda incompleta: queda **falsa**. Un borrado debe fallar con un error nombrado, no resolverse solo. |
| **Pertenencia** | ¿La fila es una extensión del usuario, que no tiene existencia propia si él no está? | `CASCADE` | Conservarla produce huérfanos sin significado. |

Reglas de aplicación:

1. **Nunca se omite la cláusula.** `NO ACTION` deja de ser un resultado aceptable: si alguien quiere el comportamiento de `NO ACTION`, escribe `RESTRICT`, que es lo que quería decir. La única diferencia real entre ambos —que `NO ACTION` admite `DEFERRABLE INITIALLY DEFERRED` y `RESTRICT` no— no se ha necesitado en ninguna de las 164 columnas; si algún día hace falta, se declara `NO ACTION DEFERRABLE` **con un comentario que diga por qué**, y eso ya es una decisión escrita.
2. **`SET NULL` está prohibido cuando la columna forma pareja con una marca de tiempo o de estado que sobreviviría al borrado.** Es el caso exacto de `gestion_actualizada_por` / `gestion_actualizada_en`: con `SET NULL`, borrar un usuario deja una fila que afirma «gestionado el 3 de marzo, por nadie» —indistinguible de un error de escritura— y lo hace en silencio, sin que ninguna consulta lo delate.
3. **La categoría se justifica en un comentario**, en `schema.ts` y en el `COMMENT ON COLUMN` de la migración. Una palabra en el DDL no explica por qué; el comentario sí, y es lo que impide que la próxima revisión la «uniforme» con el resto del archivo.
4. **Aplicación inmediata:** `flito_comparendos_registros.gestion_actualizada_por` es **auditoría** → `ON DELETE RESTRICT`, migración `0154_flito_comparendos_auditoria_gestion.sql`.

### Lo que este ADR NO hace

**No migra ninguna FK ya aplicada.** Las 125 columnas sin cláusula, incluida `flito_comparendos_registros.causal_id` —que es el hallazgo que originó todo esto—, se quedan como están. La regla rige **desde la migración `0154` hacia adelante**.

El motivo es coste contra beneficio, y conviene que quede escrito para no reabrirlo cada trimestre:

- Cambiar el `ON DELETE` de una FK existente no es un `ALTER`: es `DROP CONSTRAINT` + `ADD CONSTRAINT`, con `ACCESS EXCLUSIVE` sobre la tabla referenciante durante la validación. Sobre `flito_comparendos_registros` —la tabla que más crece del módulo— es una parada por algo que hoy no se ejecuta nunca.
- El beneficio sería nulo mientras no exista borrado de usuarios. Y el día que exista, esa funcionalidad traerá su propia migración de preparación, que es el momento correcto para repasar las FKs que le afecten.
- `causal_id` además **no es una FK hacia `users`** y no la cubre este ADR: apunta a un catálogo (`flito_comparendos_causales`). Su cláusula correcta se decide el día que exista un endpoint que borre causales, no antes.

Lo que sí cambia desde hoy: el `db-review-agent` tiene un criterio contra el que revisar, y una FK nueva sin cláusula explícita hacia `users` es un hallazgo, no una observación de estilo.

## Alternativas consideradas

### Opción A — Unificar todo en `SET NULL` (la cláusula escrita más frecuente)

| | |
|---|---|
| **Pros** | Una sola regla, sin clasificar nada; ningún borrado de usuario falla jamás; una futura supresión bajo Ley 1581 se resuelve con un `DELETE` y sin migración de preparación; es lo que ya hacen 28 columnas. |
| **Contras** | **Corrompe la auditoría en silencio**: `laft_cash_txns.registrado_por` y `laft_reportes_uiaf.generado_por` son `NOT NULL`, así que ni siquiera admiten `SET NULL` sin cambiar el esquema — la propia base ya está diciendo que la regla única no existe; deja registros que afirman un acto sin actor; contradice el enunciado de la HU #11556 («borrar un usuario no debería borrar ni falsear el rastro»); en las columnas de pertenencia produce huérfanos sin sentido (un `driver_documents` sin dueño). |
| **Esfuerzo** | S |
| **Riesgo** | Alto sobre el valor probatorio de LAFT, PESV y del módulo de comparendos. |

### Opción B — Unificar todo en `RESTRICT`

| | |
|---|---|
| **Pros** | Ningún dato se pierde ni se falsea nunca; una sola regla, fácil de revisar; todo borrado de usuario se convierte en una decisión consciente. |
| **Contras** | Convierte 164 columnas en 164 motivos para que un borrado falle, la mayoría irrelevantes —no se debería bloquear la baja de un usuario porque hace tres años subió un archivo—; la supresión bajo Ley 1581 pasaría de «difícil» a «prácticamente imposible sin un script a medida»; en las columnas de pertenencia es directamente incorrecto: obligaría a borrar a mano el perfil del conductor antes que al conductor. |
| **Esfuerzo** | S |
| **Riesgo** | Medio: fricción operativa alta y una regla que la primera excepción real rompe. |

### Opción C — Dejarlo caso por caso, sin regla (el estado actual)

| | |
|---|---|
| **Pros** | Cero trabajo; cada autor decide con el contexto de su tabla, que es quien mejor lo conoce. |
| **Contras** | **Es lo que produjo el hallazgo**: 125 de 164 columnas sin decisión, y un revisor sin criterio contra el que contrastar; el defecto silencioso (`NO ACTION` por omisión) no coincide con ninguna de las tres intenciones —es `RESTRICT` disfrazado de descuido—; obliga a rediscutir lo mismo en cada HU que añada una FK; hace imposible auditar el esquema, porque «sin cláusula» no distingue «lo pensé y quiero bloquear» de «no lo pensé». |
| **Esfuerzo** | Ninguno |
| **Riesgo** | El que ya se materializó. |

### Opción D — Las tres categorías, aplicadas también retroactivamente a las 125

| | |
|---|---|
| **Pros** | Esquema íntegramente coherente; el criterio queda demostrado, no solo enunciado; elimina de una vez la ambigüedad de «sin cláusula». |
| **Contras** | Una migración enorme con `DROP`/`ADD CONSTRAINT` sobre decenas de tablas, varias de ellas grandes, con `ACCESS EXCLUSIVE` en cada una; el riesgo de la migración es real y el beneficio es cero mientras no exista borrado de usuarios; obligaría a clasificar 125 columnas de módulos cuyo dominio no está fresco para nadie, que es exactamente cómo se cuela una clasificación equivocada; convierte una regla barata en un proyecto. |
| **Esfuerzo** | L |
| **Riesgo** | Alto, y voluntario. |

**Elegida: la regla de tres categorías, hacia adelante** (D sin la parte retroactiva).

## Consecuencias

**Positivas**

- La HU #11556 puede escribir `ON DELETE RESTRICT` en `gestion_actualizada_por` con una justificación citable en el PR, en vez de una preferencia.
- Toda FK futura hacia `users` se decide en un minuto, no en una discusión: se responde a la pregunta de la categoría y sale la cláusula.
- `db-review-agent` gana un criterio objetivo. «FK a `users` sin cláusula explícita» pasa a ser un hallazgo reportable.
- El día que exista supresión de usuarios, el esquema dirá dónde se puede borrar sin pensar (`SET NULL`, `CASCADE`) y dónde hace falta una decisión humana (`RESTRICT`). Hoy eso no se puede saber sin leer 164 líneas y adivinar.

**Negativas y a asumir**

- **Convivencia de dos estados.** Durante mucho tiempo el esquema tendrá FKs clasificadas (nuevas) y FKs sin cláusula (viejas). Quien lea `flito_comparendos_registros` verá `causal_id` sin cláusula y `gestion_actualizada_por` con `RESTRICT`, y podría concluir que hay una inconsistencia. La respuesta es este ADR y el `COMMENT ON COLUMN` de la `0154`.
- **Un borrado de usuario fallará** si tiene comparendos gestionados. Es lo buscado, pero es fricción real, y quien la encuentre por primera vez necesitará saber que la salida es una migración deliberada que reasigne o anonimice antes —no aflojar la constraint—.
- **La categoría se elige a mano**, y una elección equivocada solo se descubre el día del borrado. Mitigación: el comentario obligatorio de la regla 3, que obliga a argumentarla en el momento de escribirla.
- `RESTRICT` **no es diferible**. Si alguna vez hace falta borrar un usuario y repuntar filas en la misma transacción, habrá que recrear la constraint. No se ha necesitado en 164 columnas.

**Neutras**

- Añadir la cláusula no cuesta nada en tiempo de migración cuando la columna es nueva: PostgreSQL sabe que nace toda `NULL` y marca la constraint como validada sin recorrer la tabla. Medido en PostgreSQL 16.14 sobre 500 000 filas: 3,8 ms, `pg_constraint.convalidated = true`.
- No cambia ningún contrato de API, ningún tipo de `packages/shared-types` ni ninguna consulta.

## Cómo verificar que una FK quedó como dice este ADR

```sql
SELECT conname, confdeltype
  FROM pg_constraint
 WHERE conrelid = 'flito_comparendos_registros'::regclass
   AND contype = 'f';
```

`confdeltype`: `a` = NO ACTION, `r` = RESTRICT, `n` = SET NULL, `c` = CASCADE. Para `flito_comparendos_registros_gestion_actualizada_por_fkey` el valor esperado es **`r`**. Una `n` significaría que la cláusula se degradó en revisión, que es la mutación silenciosa que este ADR existe para impedir.

## Notas operativas por agente

- **backend-agent** — Al añadir una FK hacia `users`: clasifica, escribe la cláusula y el comentario. No dejes que `drizzle` la genere por omisión (además, en este repo las migraciones se escriben a mano; ver `AGENTS.md`).
- **db-review-agent** — Una FK nueva hacia `users` sin cláusula explícita es un hallazgo. Una FK de auditoría con `SET NULL` es un hallazgo **bloqueante**: deja el registro falso, no incompleto.
- **security-agent** — La categoría «auditoría» es la que sostiene el art. 17 de la Ley 1581 («quién consultó / quién actuó»). Degradar un `RESTRICT` a `SET NULL` en una columna de esa categoría es una pérdida de trazabilidad, no un ajuste de esquema.
- **qa-agent** — El eje a vigilar en los tests de paridad esquema/migración no es solo que la columna exista, sino que **la cláusula coincida en los dos lados**: cambiar `RESTRICT` por `SET NULL` deja el esquema válido, todos los tests funcionales en verde y la auditoría falseada.

## Relación con otros ADR

- **ADR-0001** (Aceptado) define el módulo y su retención. Este ADR no lo contradice ni lo modifica.
- **ADR-0003** (Aceptado) y **ADR-0004** (Propuesto) tratan de homologación y de export. Sin relación.
- Este ADR **no supersede** a ninguno.
