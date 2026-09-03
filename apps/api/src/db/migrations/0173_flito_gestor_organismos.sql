-- 0173_flito_gestor_organismos.sql
-- Feature #12052 — Atar usuarios Proveedor y Gestor de impuestos al crearlos. HU #12053
-- (la atadura del gestor de impuestos a SUS organismos, que antes era UNO prestado).
-- Autor: equipo FLITO. Diseño: docs/diseno-hu-12053-atadura-proveedor-organismos.md
-- ADR: docs/adr/ADR-0011-flito-atadura-usuario-proveedor-y-organismos.md (Propuesto)
--
-- Sin BEGIN/COMMIT propios (ADR-DB-001: el runner envuelve cada archivo). Idempotente en el sentido
-- fuerte: la segunda pasada no cambia ni una fila. El orden de los cuatro bloques es carga:
-- crear -> backfillear -> avisar -> limpiar.

-- == 1. La tabla ==============================================================
CREATE TABLE IF NOT EXISTS flito_gestor_organismos (
  user_id          integer     NOT NULL REFERENCES users(id)                          ON DELETE CASCADE,
  organismo_codigo varchar(5)  NOT NULL REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_gestor_organismos_pk PRIMARY KEY (user_id, organismo_codigo)
);

CREATE INDEX IF NOT EXISTS idx_flito_gestor_organismos_organismo
  ON flito_gestor_organismos (organismo_codigo);

COMMENT ON TABLE flito_gestor_organismos IS
  'CA-10 (HU #12053): los organismos de transito que ve un usuario rol gestor_impuestos. Sustituye '
  'el prestamo de users.transito_codigo, que es del rol transito y solo guardaba UNO. FUENTE UNICA: '
  'para un gestor esa columna queda NULL desde esta migracion. La PK es el par porque la fila ES el '
  'par y nadie la referencia por id. user_id CASCADE (pertenencia, ADR-0005); organismo_codigo '
  'RESTRICT para que borrar un organismo no desate gestores en silencio. Sin created_by: quien ato '
  'a quien lo registra audit(); esto es un ESTADO y se reescribe en cada edicion.';

-- == 2. Backfill de los gestores existentes ===================================
-- El JOIN NO es adorno: users.transito_codigo no tiene FK, asi que puede llevar un codigo que no
-- esta en organismos_transito_config, y un INSERT directo abortaria con 23503 la cadena entera de
-- migraciones en TODOS los ambientes.
INSERT INTO flito_gestor_organismos (user_id, organismo_codigo)
SELECT u.id, u.transito_codigo
  FROM users u
  JOIN organismos_transito_config o ON o.codigo = u.transito_codigo
 WHERE u.role = 'gestor_impuestos'
   AND u.transito_codigo IS NOT NULL
    ON CONFLICT DO NOTHING;

-- == 3. Lo que el JOIN dejo fuera, y los proveedores sin proveedor =============
-- Se leen en el log del CD, que es donde esta cadena escribe sus NOTICE. Sin username: el id y el
-- codigo bastan para reasignarlos desde /users y no son datos personales.
DO $$
DECLARE huerfanos text; n_prov int;
BEGIN
  SELECT string_agg(u.id || '->' || u.transito_codigo, ', ' ORDER BY u.id) INTO huerfanos
    FROM users u
   WHERE u.role = 'gestor_impuestos' AND u.transito_codigo IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM organismos_transito_config o WHERE o.codigo = u.transito_codigo);
  IF huerfanos IS NOT NULL THEN
    RAISE NOTICE '[0173] Gestores con transito_codigo fuera del catalogo parametrizado (%). Quedan SIN organismos: no veran cola hasta que un admin se los asigne en /users.', huerfanos;
  END IF;

  SELECT count(*) INTO n_prov FROM users
   WHERE role = 'proveedor' AND flito_proveedor_soat_id IS NULL;
  IF n_prov > 0 THEN
    RAISE NOTICE '[0173] % usuario(s) rol proveedor SIN proveedor SOAT. No ven nada (contextoSoat devuelve null). Asignarlo en /users; no hay CHECK que lo impida, ver ADR-0011 decision 5.', n_prov;
  END IF;
END $$;

-- == 4. Limpieza: users.transito_codigo vuelve a ser SOLO del rol transito =====
-- Tambien a los huerfanos: su codigo no cruza con nada (no esta en el catalogo parametrizado) y
-- conservarlo mantendria la base en el estado que el superRefine de users.routes.ts declara ilegal.
UPDATE users SET transito_codigo = NULL
 WHERE role = 'gestor_impuestos' AND transito_codigo IS NOT NULL;

-- == Permisos =================================================================
-- Sin UPDATE: las dos columnas de datos son la PK, asi que una fila se crea o se borra, nunca se
-- edita. Sin GRANT de secuencia: no hay columna serial.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, DELETE ON flito_gestor_organismos TO operaciones_app;
  END IF;
END $$;
