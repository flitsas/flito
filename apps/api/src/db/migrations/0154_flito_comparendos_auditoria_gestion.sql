-- 0154_flito_comparendos_auditoria_gestion.sql
-- Feature #11495 (17b) — Monitoreo de comparendos. HU #11556 (registrar la auditoría de gestión en
-- el esquema y en el timeline).
-- Autor: equipo FLITO. Motivo: la gestión de un comparendo —asignarle una causal, escribirle una
-- observación— la introduce 17b, y hoy la tabla no guarda NI QUIÉN la hizo NI CUÁNDO. `updated_at`
-- no sirve para eso: lo reescribe el sync en cada corrida (RN-04), así que una fila gestionada ayer
-- por una persona es indistinguible de una que el sync tocó hace diez minutos. Esta migración abre
-- la zona de auditoría de la gestión: dos columnas en la fila y un tipo de evento nuevo para el
-- timeline.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente: se puede re-aplicar entera sin efecto adicional.
--
-- Decisiones: docs/adr/ADR-0005-flito-fk-users-auditoria-on-delete.md (por qué RESTRICT y no
-- SET NULL en una FK de auditoría). Pantalla: docs/ux/flito-comparendos-visor.md.
--
-- ============================================================================
-- QUÉ ESCRIBE ESTA MIGRACIÓN Y QUÉ **NO**
-- ============================================================================
--
-- Escribe FORMA y nada más: dos columnas nullable, un valor de enum y los comentarios. **No inserta
-- ni actualiza una sola fila** (AC2), y en particular no crea ningún evento de tipo «gestion» —ni
-- siquiera para las filas que ya tienen causal u observación puestas a mano—: no existe registro de
-- quién las tocó, y fabricarlo sería inventar auditoría, que es peor que no tenerla.
--
-- Hay además una razón técnica por la que ese INSERT no podría estar aquí aunque se quisiera, y es
-- la misma que ordena este archivo — está explicada abajo, en el bloque del enum.
--
-- Tampoco añade el `CHECK` que ata las dos columnas entre sí («o las dos puestas o las dos nulas»).
-- Va con la HU #11557, que es la que introduce el endpoint que las escribe: hoy no hay ni un camino
-- de código que pueda poner una y dejar la otra, así que la restricción no defendería nada y sí
-- obligaría a decidir de antemano cómo se comporta un `UPDATE` que todavía no existe.
--
-- Los `GRANT` de la 0150 son a nivel de TABLA (`GRANT SELECT, INSERT, UPDATE ON
-- flito_comparendos_registros TO operaciones_app`), y en PostgreSQL un privilegio de tabla alcanza a
-- las columnas que se le añadan después. Por eso aquí no hay ningún `GRANT`: si los permisos fueran
-- por columna, faltarían dos.
--
-- ============================================================================
-- POR QUÉ DOS COLUMNAS EN LA FILA **Y ADEMÁS** UN EVENTO EN EL TIMELINE
-- ============================================================================
--
-- Parecen la misma información escrita dos veces y no lo son: es la figura que el módulo ya sostiene
-- entre `estado` / `inactivado_en` y los eventos de inactivación. La FILA lleva el estado ACTUAL
-- —quién fue el último en gestionar y cuándo—, que es lo que el listado y el visor pintan sin tener
-- que abrir el timeline ni resolver un agregado por registro; el TIMELINE lleva la HISTORIA, que es
-- lo que responde «¿cuántas veces se reclasificó esto y quién lo movió?». Ninguna de las dos se
-- deriva de la otra a coste razonable: la fila no puede contar la historia, y sacar el estado actual
-- del timeline sería un `DISTINCT ON` por registro en cada página del listado.
--
-- ============================================================================
-- POR QUÉ `INTEGER` Y NO `UUID`
-- ============================================================================
--
-- Porque `users.id` es `serial`. El resto de llaves de este módulo son `uuid` —lo son las suyas
-- propias, que nacieron con la 0150— pero una clave foránea no elige su tipo: lo hereda de la
-- columna a la que apunta. Mismo criterio, y mismo tipo, que `flito_comparendos_sync_runs
-- .iniciado_por` y que `flito_comparendos_nits.created_by`, que ya apuntan a `users(id)`.
--
-- ============================================================================
-- POR QUÉ `ON DELETE RESTRICT` Y NO `SET NULL`
-- ============================================================================
--
-- Porque esto es AUDITORÍA. `ON DELETE SET NULL` deja filas que afirman «gestionado el 3 de marzo, y
-- por nadie»: la fecha sigue ahí, el autor desaparece, y el registro pasa de decir la verdad a decir
-- una media verdad sin que nadie lo note ni quede rastro de la pérdida. `RESTRICT` convierte eso en
-- un error en el momento del borrado: un usuario que gestionó comparendos no se borra, se desactiva
-- —que es lo que el sistema hace con las personas que dejan la empresa (`users.active`)—.
--
-- Es el mismo criterio con el que el repo ya reparte esta decisión (ADR-0005). De las 164 columnas
-- que referencian `users.id`, 125 (el 76 %) no llevan cláusula —es decir, `NO ACTION`, que casi
-- siempre es ausencia de decisión y no una decisión—, 28 son `SET NULL`, 6 `CASCADE` y solo 5
-- `RESTRICT`. Y esas cinco son exactamente las que son PRUEBA DE UN ACTO: `laft_cash_txns
-- .registrado_por`, `laft_reportes_uiaf.generado_por`, `alcohol_tests.conductor_id`,
-- `checklists.conductor_id` y `siigo_factura_estados_dian.registrado_por`. `gestion_actualizada_por`
-- es de esa familia: dice quién tomó una decisión sobre la deuda de un tercero.
--
-- La diferencia con `flito_comparendos_nits.created_by` (que no lleva cláusula) es deliberada por lo
-- mismo: aquel dice quién dio de alta un parámetro, no quién decidió nada sobre un comparendo.
--
-- Si algún día alguien «arregla» un borrado bloqueado cambiando esta cláusula a `SET NULL`, el
-- esquema seguirá siendo válido y la auditoría quedará falseada sin un solo error: por eso la
-- cláusula está afirmada en un test de paridad
-- (`__tests__/services/flito-comparendos-migracion-0154-paridad.test.ts`) y no solo escrita aquí.
--
-- ============================================================================
-- POR QUÉ **NINGÚN** ÍNDICE NUEVO
-- ============================================================================
--
-- Porque no hay consulta que lo pida. Ni `GET /registros` ni `POST /registros/buscar` filtran ni
-- ordenan hoy por la zona de gestión —sus filtros son municipio, fuente, causal, estado y el número
-- (HU #11555, RN-36), y el orden es siempre el del cursor `(created_at DESC, id DESC)`, RN-32—, y la
-- pantalla del visor tampoco lo pide (docs/ux/flito-comparendos-visor.md deja «ordenar por gestión
-- reciente» explícitamente fuera). Un índice sobre una columna que nadie consulta no acelera nada y
-- se paga en cada escritura.
--
-- Y aquí ese pago no es teórico, porque el proceso que más escribe en esta tabla es el sync. Cada
-- corrida reescribe `ultimo_visto_en` en TODAS las filas que ve, y `ultimo_visto_en` está indexado
-- (`idx_flito_comparendos_ultimo_visto`, de la 0152): un `UPDATE` que toca una columna indexada NO
-- puede ser HOT, así que PostgreSQL escribe una versión nueva de la fila y una entrada nueva en
-- TODOS los índices de la tabla —hoy nueve, contando la llave primaria—, aunque el resto de columnas
-- no haya cambiado. Añadir un índice más aquí sería sumarle una décima escritura a cada fila vista
-- por cada corrida, a cambio de acelerar cero consultas.
--
-- El día que la #11557 traiga una pantalla que ordene por gestión reciente, ese índice se decide con
-- la tabla poblada y un `EXPLAIN` delante, que es mejor momento que este.

-- ── 1. La zona de auditoría de la gestión ──────────────────────────────────
--
-- Las dos NULLABLE y sin `DEFAULT`, y eso es el AC5: las filas que ya existen —todas, hoy— no se
-- reescriben y quedan con las dos en `NULL`, que es la verdad («esta fila no la ha gestionado
-- nadie»). Un `DEFAULT now()` habría datado como gestionado el histórico entero, y un `NOT NULL`
-- habría exigido reescribir la tabla para inventarle un valor a cada fila.

ALTER TABLE flito_comparendos_registros
  ADD COLUMN IF NOT EXISTS gestion_actualizada_en TIMESTAMPTZ;

ALTER TABLE flito_comparendos_registros
  ADD COLUMN IF NOT EXISTS gestion_actualizada_por INTEGER REFERENCES users(id) ON DELETE RESTRICT;

-- ── 2. El tipo de evento nuevo, **al final del bloque DDL** ────────────────
--
-- El orden de este archivo no es estético: es la única forma en que puede correr.
--
-- `ALTER TYPE ... ADD VALUE` sí funciona dentro de la transacción que abre el runner (PostgreSQL lo
-- permite desde la 12), pero el valor añadido NO SE PUEDE USAR hasta que esa transacción hace
-- commit. Verificado contra el PostgreSQL 16.14 de este proyecto: en la misma transacción, tanto un
-- INSERT con el literal nuevo como un índice parcial que lo mencione en su WHERE mueren con
--
--     55P04: unsafe use of new value "..." of enum type flito_comparendos_evento_tipo
--
-- De ahí las dos consecuencias que gobiernan el archivo: (1) el ADD VALUE va DESPUÉS de las columnas
-- y antes solo de los COMMENT, y (2) por debajo de esta línea NADA puede nombrar el literal nuevo
-- salvo los comentarios —ni una fila sembrada, ni un índice parcial, ni un CHECK—. La HU #11557, que
-- es la primera que escribirá eventos de este tipo, lo hará desde el código y contra una transacción
-- distinta, que es donde el valor ya existe sin reparos.
--
-- Va al FINAL del enum y no intercalado: el orden de `pg_enum` es el orden de comparación del tipo,
-- y `ADD VALUE ... BEFORE/AFTER` sobre un tipo ya usado reordena algo que nadie pidió reordenar. Los
-- cuatro valores quedan, en este orden: primera_llegada, inactivacion, reaparicion y el nuevo.
--
-- El nombre es el de la ACCIÓN («se gestionó»), no el del campo que cambió: la HU #11557 escribirá
-- causal y observación en el mismo movimiento, y un evento por columna partiría en dos lo que para
-- quien lee el timeline fue un solo acto.

ALTER TYPE flito_comparendos_evento_tipo ADD VALUE IF NOT EXISTS 'gestion';

-- ── 3. Comentarios ─────────────────────────────────────────────────────────
--
-- Idempotentes por naturaleza: COMMENT ON fija el comentario, no lo acumula.

COMMENT ON COLUMN flito_comparendos_registros.gestion_actualizada_en IS
  'Cuándo se gestionó la fila por última vez (causal u observación). NULL = nadie la ha gestionado. '
  'Distinto de updated_at, que el sync reescribe en cada corrida y por eso no dice nada de quién '
  'gestionó. La escribe el endpoint de la HU #11557; el sync no toca esta zona.';

COMMENT ON COLUMN flito_comparendos_registros.gestion_actualizada_por IS
  'Quién la gestionó por última vez (users.id). ON DELETE RESTRICT a propósito: esto es auditoría, y '
  'un SET NULL dejaría la fila diciendo que se gestionó en una fecha y por nadie. Un usuario que '
  'gestionó comparendos no se borra, se desactiva.';
