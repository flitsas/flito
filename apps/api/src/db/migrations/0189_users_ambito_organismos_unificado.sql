-- 0189_users_ambito_organismos_unificado.sql
-- Feature #12072 — HU #12088: el ámbito lo dicta tipo_enlace; organismos solo en puente.
-- Autor: equipo FLITO. Diseño: docs/diseno-hu-12088-ambito-tipo-enlace.md
--
-- Sin BEGIN/COMMIT propios (ADR-DB-001). Idempotente: segunda pasada no cambia filas.
-- Orden: backfill transito → NOTICE huérfanos → NULL columna → REPLACE trigger solo puente
-- → recrear trigger OF role → COMMENT OBSOLETA.

-- == 1. Backfill: usuarios `transito` con código → flito_gestor_organismos =================
-- Espejo del bloque 2 de la 0173 (gestores). El JOIN evita 23503 si el código no está en
-- organismos_transito_config.
INSERT INTO flito_gestor_organismos (user_id, organismo_codigo)
SELECT u.id, u.transito_codigo
  FROM users u
  JOIN organismos_transito_config o ON o.codigo = u.transito_codigo
 WHERE u.role = 'transito'
   AND u.transito_codigo IS NOT NULL
    ON CONFLICT DO NOTHING;

-- == 2. Huérfanos: código fuera del catálogo parametrizado =================================
DO $$
DECLARE huerfanos text;
BEGIN
  SELECT string_agg(u.id || '->' || u.transito_codigo, ', ' ORDER BY u.id) INTO huerfanos
    FROM users u
   WHERE u.role = 'transito' AND u.transito_codigo IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM organismos_transito_config o WHERE o.codigo = u.transito_codigo);
  IF huerfanos IS NOT NULL THEN
    RAISE NOTICE '[0189] Usuarios transito con transito_codigo fuera del catalogo parametrizado (%). Quedan SIN organismos en puente: reasignar en /users.', huerfanos;
  END IF;
END $$;

-- == 3. Columna obsoleta: NULL en rol transito (espejo bloque 4 de 0173) ==================
UPDATE users SET transito_codigo = NULL
 WHERE role = 'transito' AND transito_codigo IS NOT NULL;

-- == 4. Trigger organismos: solo puente (ya no acepta transito_codigo) ====================
-- Predicado unificado: tipo_enlace = organismos_transito exige ≥1 fila en flito_gestor_organismos.
-- Sin brazo NEW.transito_codigo IS NOT NULL (HU #12088).
CREATE OR REPLACE FUNCTION users_ambito_organismos_requerido() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE te text;
BEGIN
  SELECT tipo_enlace INTO te FROM permisos_roles WHERE codigo = NEW.role;
  IF te = 'organismos_transito'
     AND NOT EXISTS (SELECT 1 FROM flito_gestor_organismos g WHERE g.user_id = NEW.id) THEN
    RAISE EXCEPTION 'El rol % exige al menos un organismo y el usuario % no tiene ninguno',
      NEW.role, NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $fn$;

-- == 5. Recrear trigger: ya no OF transito_codigo ==========================================
DROP TRIGGER IF EXISTS users_ambito_organismos_trg ON users;
CREATE CONSTRAINT TRIGGER users_ambito_organismos_trg
  AFTER INSERT OR UPDATE OF role ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_ambito_organismos_requerido();

-- == 6. Comentario de obsolescencia =======================================================
COMMENT ON COLUMN users.transito_codigo IS
  'OBSOLETA desde HU #12088. Fuente unica de organismos_transito = flito_gestor_organismos. '
  'Se conserva NULL tras backfill 0189; no DROP. JWT/bandeja leen el 1.er codigo de la puente.';
