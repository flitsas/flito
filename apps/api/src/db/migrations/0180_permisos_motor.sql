-- 0180_permisos_motor.sql
-- Feature #12072 — Roles y permisos configurables. HU #12082 (eslabon 2 de 1 → 2 → 3): motor unico
--   de decision. La bitacora de intentos denegados (ADR-0016: contador por ventana, sin PII,
--   retencion 2 anios) y la retirada del candado temporal de `cliente` (AC8).
-- Autor: equipo FLITO. Antecedentes: ADR-0016 (la bitacora), ADR-0005 (clausula ON DELETE explicita
--   hacia users), ADR-0015 §Decision 5 (es_sistema es candado de borrado), migracion 0178 (HU #12169,
--   `permisos_roles`) y 0179 (HU #12081, `permisos_funciones`).
--
-- Depende de la 0178 (permisos_roles) y de la 0179 (permisos_funciones). Orden 0178 → 0179 → 0180.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente en sentido FUERTE: la segunda pasada no toca una fila (users, permisos_roles ni
--     pesv_retencion_politicas incluidas). Lo comprueba __tests__/db/migracion-0180.test.ts.
--   - Nada de ALTER TYPE ni de ADD COLUMN sobre columnas existentes.
--   - Dollar-quoting ETIQUETADO en el bloque DO, y la etiqueta no se nombra en ningun comentario.

-- ── Paso 1 — La bitacora de intentos denegados (AC6, CF-20) ─────────────────────────────────────
-- Una fila por (usuario, funcion, hora). `veces` es el contador: 10.000 reintentos en la misma hora
-- son UNA fila. Sin columnas de texto libre: no hay donde escribir un correo aunque alguien quiera.
-- rol_codigo y funcion_codigo van SIN FK a proposito (ADR-0016 §2): un rol borrado no debe quedar
-- retenido por su bitacora, y una funcion «no reconocida» es justamente un codigo que no existe.
CREATE TABLE IF NOT EXISTS permisos_intentos_denegados (
  id              bigserial    PRIMARY KEY,
  user_id         integer      NOT NULL REFERENCES users(id)
                                 ON UPDATE RESTRICT ON DELETE RESTRICT,   -- ADR-0005: auditoria
  rol_codigo      varchar(40)  NOT NULL,
  funcion_codigo  varchar(80)  NOT NULL,
  motivo          varchar(16)  NOT NULL,
  metodo          varchar(10)  NOT NULL,
  ruta            varchar(300) NOT NULL,
  ventana_inicio  timestamptz  NOT NULL,
  primera_vez     timestamptz  NOT NULL DEFAULT now(),
  ultima_vez      timestamptz  NOT NULL DEFAULT now(),
  veces           integer      NOT NULL DEFAULT 1,
  CONSTRAINT permisos_intentos_denegados_motivo_chk
    CHECK (motivo IN ('sin_funcion','sin_modulo','no_reconocida','no_resuelto')),
  CONSTRAINT permisos_intentos_denegados_veces_chk CHECK (veces >= 1),
  CONSTRAINT permisos_intentos_denegados_ventana_uq UNIQUE (user_id, funcion_codigo, ventana_inicio)
);

-- La UNIQUE ya indexa por usuario; este es el otro sentido: «quien esta chocando con esta funcion».
CREATE INDEX IF NOT EXISTS idx_permisos_intentos_funcion
  ON permisos_intentos_denegados (funcion_codigo, ultima_vez DESC);

COMMENT ON TABLE permisos_intentos_denegados IS
  'Intentos denegados por exigirFuncion (HU #12082, ADR-0016). CONTADOR por (usuario, funcion, hora), '
  'no un registro de eventos: no es evidencia inmutable y la aplicacion lo reescribe. Sin datos '
  'personales: user_id numerico y rol; nada mas. Retencion declarada: 2 anios, purgar '
  '(pesv_retencion_politicas.tipo_documento = permisos_intentos_denegados); mecanismo en la HU #12215.';
COMMENT ON COLUMN permisos_intentos_denegados.ruta IS
  'originalUrl SIN query string y recortada a 300, como siigo_operaciones.ruta.';
COMMENT ON COLUMN permisos_intentos_denegados.ventana_inicio IS
  'Inicio de la hora en punto (UTC) a la que pertenece el contador. Lo calcula la aplicacion.';

-- ── Paso 2 — Retirar el candado temporal de `cliente` (AC8, retirada heredada 1) ────────────────
-- La 0178 lo puso en es_sistema=true SOLO porque la frontera del canal se disparaba por su literal.
-- Desde esta HU la frontera lee permisos_roles.tipo_principal, asi que el candado se queda sin motivo.
-- Condicionado para que la segunda pasada no toque la fila.
UPDATE permisos_roles SET es_sistema = false, updated_at = now()
 WHERE codigo = 'cliente' AND es_sistema = true;

COMMENT ON COLUMN permisos_roles.es_sistema IS
  'Candado de BORRADO (ADR-0015 §Decision 5): true ⇒ el rol no se borra. Solo admin. Editar sigue '
  'permitido (CF-04). El candado temporal de cliente se retiro en la 0180 (HU #12082 AC8).';

-- ── Paso 3 — La retencion, declarada donde ya se declaran las demas ─────────────────────────────
-- created_by es NOT NULL con FK a users: la siembra queda condicionada a que exista un admin (igual
-- que la 0060 se condiciona a users.id = 1). En una base recien creada no habra fila hasta que haya
-- admin; por eso la politica va TAMBIEN en el COMMENT ON TABLE del paso 1, que no depende de nadie.
INSERT INTO pesv_retencion_politicas
  (tipo_documento, retencion_anios, base_legal, accion, notas_md, created_by)
SELECT 'permisos_intentos_denegados', 2, 'ISO 27001 A.12.4 / Ley 1581 art. 11',
       'purgar'::pesv_retencion_accion,
       'Contador de 403 por (usuario, funcion, hora). Senal operativa, no evidencia: se purga a los '
       '2 anios (ADR-0016 §5). Mecanismo: HU #12215.',
       (SELECT min(id) FROM users WHERE role = 'admin')
 WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
ON CONFLICT (tipo_documento) DO NOTHING;

-- ── Paso 4 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
DO $resumen0180$
DECLARE n_cliente int; n_politica int;
BEGIN
  SELECT count(*) INTO n_cliente FROM permisos_roles WHERE codigo = 'cliente' AND es_sistema = false;
  SELECT count(*) INTO n_politica FROM pesv_retencion_politicas
   WHERE tipo_documento = 'permisos_intentos_denegados';
  RAISE NOTICE '0180: permisos_intentos_denegados lista; cliente sin candado = %; politica de retencion sembrada = %',
    n_cliente, n_politica;
END $resumen0180$;
