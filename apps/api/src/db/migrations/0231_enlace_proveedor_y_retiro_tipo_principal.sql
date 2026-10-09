-- 0231_enlace_proveedor_y_retiro_tipo_principal.sql
--
-- HU #12875 (Feature #12871, Épica #13411) — Frontera por enlace en lugar del tipo interno/externo.
-- ADR-0024 · diseño docs/arquitectura/hu-12875-frontera-por-enlace.md §7.
-- Autor: equipo FLITO. Antecedente: 0230 (la anterior); 0178 (CHECK y trigger que aquí se reescriben).
--
-- Qué hace:
--   1. Renombra el valor de enlace `proveedor_soat` → `proveedor` en `permisos_roles.tipo_enlace`, con
--      su CHECK nuevo de cuatro valores y una fila de auditoría de sistema por rol renombrado (AC8).
--   2. Reescribe `users_ambito_requerido()` (trigger de la 0178) con el literal de enlace nuevo; el
--      resto del cuerpo es copia literal de la 0178.
--   3. Marca `permisos_roles.tipo_principal` como RETIRADA (expand/contract, AC6): el código ya no la
--      lee ni la escribe. NO se borra aquí: un rollback de imagen con la columna borrada dejaría al
--      resolutor viejo en `ok:false` → 403 para todos. El DROP va en el WI de contracción.
--
-- Sin NINGÚN literal de código de rol (lección de la 0227: un literal de rol rompió el CD de DEV por
-- la FK a `permisos_roles`). Todo se decide por el valor de enlace.
--
-- Idempotente: la segunda pasada no encuentra filas `proveedor_soat` (UPDATE de 0 filas, INSERT de 0
-- filas), el CHECK se reemplaza por el mismo y la función por la misma.

-- ── 1. Enlace `proveedor_soat` → `proveedor` ───────────────────────────────────────────────────
-- El CHECK viejo no admite `proveedor`: se quita ANTES del UPDATE y se repone después.
ALTER TABLE permisos_roles DROP CONSTRAINT IF EXISTS permisos_roles_tipo_enlace_chk;

WITH lote AS (
  SELECT gen_random_uuid() AS id
), ren AS (
  UPDATE permisos_roles
     SET tipo_enlace = 'proveedor', updated_at = now()
   WHERE tipo_enlace = 'proveedor_soat'
  RETURNING codigo
)
INSERT INTO permisos_auditoria
  (lote_id, entidad, accion, campo, valor_antes, valor_despues, rol_afectado_codigo, origen, motivo)
SELECT lote.id, 'rol', 'editar', 'tipo_enlace',
       to_jsonb('proveedor_soat'::text), to_jsonb('proveedor'::text),
       ren.codigo, 'sistema', 'Migración 0231 (HU #12875): el enlace proveedor_soat pasa a llamarse proveedor'
  FROM ren CROSS JOIN lote;

ALTER TABLE permisos_roles ADD CONSTRAINT permisos_roles_tipo_enlace_chk
  CHECK (tipo_enlace IN ('ninguno','compania','proveedor','organismos_transito'));

-- ── 2. Trigger del ámbito del usuario con el valor de enlace nuevo ─────────────────────────────
CREATE OR REPLACE FUNCTION users_ambito_requerido() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE te text;
BEGIN
  SELECT tipo_enlace INTO te FROM permisos_roles WHERE codigo = NEW.role;
  IF te IS NULL THEN
    RAISE EXCEPTION 'El rol % no existe en permisos_roles (usuario %)', NEW.role, NEW.id
      USING ERRCODE = '23503';
  END IF;
  IF te = 'compania' AND NEW.compania_id IS NULL THEN
    RAISE EXCEPTION 'El rol % exige compañía y el usuario % no la tiene', NEW.role, NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF te = 'proveedor' AND NEW.flito_proveedor_soat_id IS NULL THEN
    RAISE EXCEPTION 'El rol % exige proveedor SOAT y el usuario % no lo tiene', NEW.role, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora
END $fn$;

-- ── 3. Comentarios: el enlace es la frontera; el tipo interno/externo, retirado ────────────────
COMMENT ON COLUMN permisos_roles.tipo_enlace IS
  'ninguno | compania | proveedor | organismos_transito. Única frontera desde la HU #12875 '
  '(ADR-0024): ninguno decide el permiso; los demás solo alcanzan los módulos que '
  'FRONTERA_POR_ENLACE (shared-types) les abre más las rutas transversales de sesión.';

COMMENT ON COLUMN permisos_roles.tipo_principal IS
  'RETIRADA (HU #12875): sin lectores ni escritores en el código. Se conserva por expand/contract; '
  'DROP en el WI de contracción, cuando la versión sin lectores esté en PDN.';
