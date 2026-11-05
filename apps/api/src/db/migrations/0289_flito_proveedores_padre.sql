-- 0289_flito_proveedores_padre.sql
-- Autor: David Chica
-- Feature #14323, HU #14328, #14329 y #14330 (ADR-0039 §5.2) — identidad única de proveedor. Solo expansión.
--
-- `flito_proveedores` pasa a ser el padre; las tablas de SOAT y de Logística quedan como sus perfiles, con el
-- mismo UUID. `users.flito_proveedor_id` es la nueva pertenencia del usuario. La imagen anterior sigue
-- funcionando contra este esquema gracias a los triggers de transición, que se retiran en F5. Nada de RENAME,
-- DROP de columna ni NOT NULL sobre tablas existentes. Una vez aplicada en cualquier ambiente, no se edita.
--
-- Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en una transacción, así que una parada no deja
-- nada de este archivo aplicado ni lo registra. Idempotente: se puede aplicar dos veces.

-- ── Paso 0. Paradas (HU #14328) ─────────────────────────────────────────────────────────────────────────
-- Se bloquean las escrituras en los perfiles hasta el final del archivo: una fila creada entre la parada y la
-- copia quedaría sin padre.
LOCK TABLE flito_proveedores_soat, flito_proveedores_logistica IN SHARE ROW EXCLUSIVE MODE;

DO $parada$
DECLARE
  casos text[] := ARRAY[]::text[];
  fila record;
BEGIN
  -- >>> PARADAS (idéntico en 0289 y en manual/flito-proveedores-preflight.sql; el test exige la igualdad)
  -- Nombre: SOAT vigentes y Logística, con la normalización del índice único del padre. `to_jsonb` lee
  -- `deleted_at` de Logística solo si la columna existe: antes de la 0289 no existe y ninguna fila está de baja.
  FOR fila IN
    WITH vigentes AS (
      SELECT 'SOAT'::text AS origen, s.id, s.nombre FROM flito_proveedores_soat s WHERE s.deleted_at IS NULL
      UNION ALL
      SELECT 'Logística', l.id, l.nombre FROM flito_proveedores_logistica l WHERE to_jsonb(l) ->> 'deleted_at' IS NULL
    )
    SELECT string_agg(format('"%s" (%s %s)', v.nombre, v.origen, v.id), ', ' ORDER BY v.origen, v.id) AS detalle
    FROM vigentes v
    GROUP BY lower(btrim(regexp_replace(v.nombre, '\s+', ' ', 'g')))
    HAVING count(DISTINCT v.id) > 1
    ORDER BY 1
  LOOP
    casos := casos || format('NOMBRE REPETIDO: %s. Renombre uno desde la pantalla de proveedores.', fila.detalle);
  END LOOP;

  -- NIT sin dígito de verificación, con la expresión del índice único del padre. Nunca se escribe el valor: el
  -- de una persona natural equivale a su cédula y este texto termina en el log del initContainer.
  FOR fila IN
    SELECT string_agg(format('"%s" (%s)', l.nombre, l.id), ', ' ORDER BY l.id) AS detalle
    FROM flito_proveedores_logistica l
    WHERE to_jsonb(l) ->> 'deleted_at' IS NULL AND NULLIF(btrim(l.nit), '') IS NOT NULL
    GROUP BY split_part(btrim(l.nit), '-', 1)
    HAVING count(DISTINCT l.id) > 1
    ORDER BY 1
  LOOP
    casos := casos || format('NIT REPETIDO: %s. Corrija el NIT desde la pantalla de proveedores; renombrar no basta.', fila.detalle);
  END LOOP;

  -- Identificador en ambas tablas sin registro padre. Con padre es un proveedor legítimo con los dos servicios.
  IF to_regclass('flito_proveedores') IS NULL THEN
    FOR fila IN
      SELECT s.id FROM flito_proveedores_soat s JOIN flito_proveedores_logistica l ON l.id = s.id ORDER BY s.id
    LOOP
      casos := casos || format('IDENTIFICADOR REPETIDO: %s está en SOAT y en Logística sin registro padre. No se unen automáticamente.', fila.id);
    END LOOP;
  ELSE
    FOR fila IN
      SELECT s.id FROM flito_proveedores_soat s JOIN flito_proveedores_logistica l ON l.id = s.id
      WHERE NOT EXISTS (SELECT 1 FROM flito_proveedores p WHERE p.id = s.id) ORDER BY s.id
    LOOP
      casos := casos || format('IDENTIFICADOR REPETIDO: %s está en SOAT y en Logística sin registro padre. No se unen automáticamente.', fila.id);
    END LOOP;
  END IF;
  -- <<< PARADAS

  IF cardinality(casos) > 0 THEN
    RAISE EXCEPTION '%', format(
      E'0289 detenida: %s caso(s) de proveedores por corregir. Ningún proveedor se unió ni se modificó.\n- %s\nEjecute apps/api/src/db/manual/flito-proveedores-preflight.sql, corrija los datos y reintente el despliegue.',
      cardinality(casos), array_to_string(casos, E'\n- '));
  END IF;
END
$parada$;

-- ── Paso 1. Padre y auditoría ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_proveedores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      varchar(150) NOT NULL,
  nit         varchar(20),
  telefono    varchar(30),
  correo      varchar(150),
  direccion   varchar(300),
  ciudad      varchar(100),
  contacto    varchar(150),
  activo      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  deleted_by  integer CONSTRAINT flito_proveedores_deleted_by_users_id_fk REFERENCES users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_proveedores_nombre_vivo
  ON flito_proveedores (lower(btrim(regexp_replace(nombre, '\s+', ' ', 'g')))) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_proveedores_nit_vivo
  ON flito_proveedores (split_part(nit, '-', 1)) WHERE deleted_at IS NULL AND nit IS NOT NULL;

COMMENT ON TABLE flito_proveedores IS
  'Identidad única de proveedor (ADR-0039). Los perfiles de SOAT y Logística comparten su UUID. '
  'El servicio se deduce de los perfiles; no hay catálogo editable.';

CREATE TABLE IF NOT EXISTS flito_proveedores_auditoria (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id   uuid NOT NULL CONSTRAINT flito_proveedores_auditoria_proveedor_id_fk REFERENCES flito_proveedores(id) ON DELETE RESTRICT,
  accion         varchar(20) NOT NULL CONSTRAINT ck_flito_proveedores_auditoria_accion CHECK (accion IN
                   ('crear', 'editar', 'activar', 'desactivar', 'eliminar', 'servicio_agregado', 'servicio_quitado')),
  campo          varchar(30) CONSTRAINT ck_flito_proveedores_auditoria_campo CHECK (campo IN
                   ('nombre', 'nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto', 'activo', 'servicio',
                    'estrategia', 'umbral_ocr', 'sla_horas')),
  valor_antes    text,
  valor_despues  text,
  actor_id       integer CONSTRAINT flito_proveedores_auditoria_actor_id_users_id_fk REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_prov_aud_proveedor ON flito_proveedores_auditoria (proveedor_id, created_at);

-- ── Paso 2. Copia conservando el UUID (R21) ─────────────────────────────────────────────────────────────
-- Una colisión de id entre tablas ya detuvo la migración en el paso 0: el ON CONFLICT solo cubre la reaplicación.
INSERT INTO flito_proveedores (id, nombre, activo, created_at, updated_at, deleted_at, deleted_by)
SELECT s.id, s.nombre, s.activo, s.created_at, s.created_at, s.deleted_at, s.deleted_by
FROM flito_proveedores_soat s
ON CONFLICT (id) DO NOTHING;

INSERT INTO flito_proveedores (id, nombre, nit, contacto, telefono, activo, created_at, updated_at)
SELECT l.id, l.nombre, NULLIF(btrim(l.nit), ''), l.contacto, l.telefono, l.activo, l.created_at, l.created_at
FROM flito_proveedores_logistica l
ON CONFLICT (id) DO NOTHING;

-- ── Paso 3. Perfiles y vista de servicios ───────────────────────────────────────────────────────────────
ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS deleted_by integer;

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_proveedores_logistica_deleted_by_users_id_fk') THEN
    ALTER TABLE flito_proveedores_logistica ADD CONSTRAINT flito_proveedores_logistica_deleted_by_users_id_fk
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_proveedores_soat_id_padre_fk') THEN
    ALTER TABLE flito_proveedores_soat ADD CONSTRAINT flito_proveedores_soat_id_padre_fk
      FOREIGN KEY (id) REFERENCES flito_proveedores(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_proveedores_logistica_id_padre_fk') THEN
    ALTER TABLE flito_proveedores_logistica ADD CONSTRAINT flito_proveedores_logistica_id_padre_fk
      FOREIGN KEY (id) REFERENCES flito_proveedores(id) ON DELETE RESTRICT;
  END IF;
END
$fk$;

-- Los literales coinciden con SERVICIOS_PROVEEDOR de shared-types, la única lista de servicios (el test lo exige).
CREATE OR REPLACE VIEW flito_proveedor_servicios_v AS
  SELECT s.id AS proveedor_id, 'soat'::text AS servicio FROM flito_proveedores_soat s WHERE s.deleted_at IS NULL
  UNION ALL
  SELECT l.id, 'logistica'::text FROM flito_proveedores_logistica l WHERE l.deleted_at IS NULL;

-- ── Paso 4. Triggers de transición: la imagen anterior escribe en los perfiles. Se retiran en F5 ─────────
-- Un choque de unicidad en el padre se relanza sin el DETAIL de Postgres, que traería el NIT al log de la API, y
-- con el nombre de la restricción del perfil, que es el que reconocen las rutas actuales para responder 409 en
-- lugar de 500 (`esDuplicadoNombreProveedorSoat`, `escribir` de Logística).
CREATE OR REPLACE FUNCTION flito_proveedor_restriccion_del_perfil(tabla text, restriccion text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN tabla = 'flito_proveedores_soat' THEN 'uq_flito_proveedores_soat_nombre_vivo'
    WHEN restriccion = 'uq_flito_proveedores_nit_vivo' THEN 'uq_flito_proveedores_logistica_nit'
    ELSE 'flito_proveedores_logistica_nombre_unique'
  END
$fn$;

CREATE OR REPLACE FUNCTION flito_proveedor_perfil_crea_padre() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  perfil jsonb := to_jsonb(NEW);  -- El perfil de SOAT no tiene NIT, contacto ni teléfono: quedan NULL.
  restriccion text;
BEGIN
  INSERT INTO flito_proveedores (id, nombre, nit, contacto, telefono, activo, created_at, updated_at)
  VALUES (NEW.id, NEW.nombre, NULLIF(btrim(perfil ->> 'nit'), ''), perfil ->> 'contacto', perfil ->> 'telefono',
          NEW.activo, NEW.created_at, NEW.created_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS restriccion = CONSTRAINT_NAME;
  RAISE EXCEPTION 'El nombre o el NIT del proveedor % ya pertenecen a otro proveedor vigente', NEW.id
    USING ERRCODE = '23505', CONSTRAINT = flito_proveedor_restriccion_del_perfil(TG_TABLE_NAME, restriccion);
END
$fn$;

-- Profundidad: la escritura original llega con 1. Sube al padre, cuyo trigger baja a los perfiles con 2, y el
-- UPDATE de esos perfiles llega aquí con 3, donde se corta. Un cambio directo en el padre llega aquí con 2.
CREATE OR REPLACE FUNCTION flito_proveedor_perfil_a_padre() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  restriccion text;
BEGIN
  IF pg_trigger_depth() >= 2 THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'flito_proveedores_soat' THEN
    UPDATE flito_proveedores p
       SET nombre = NEW.nombre, activo = NEW.activo, updated_at = now(), version = p.version + 1
     WHERE p.id = NEW.id AND (p.nombre, p.activo) IS DISTINCT FROM (NEW.nombre, NEW.activo);
  ELSE
    UPDATE flito_proveedores p
       SET nombre = NEW.nombre, activo = NEW.activo, nit = NULLIF(btrim(NEW.nit), ''), contacto = NEW.contacto,
           telefono = NEW.telefono, updated_at = now(), version = p.version + 1
     WHERE p.id = NEW.id
       AND (p.nombre, p.activo, p.nit, p.contacto, p.telefono) IS DISTINCT FROM
           (NEW.nombre, NEW.activo, NULLIF(btrim(NEW.nit), ''), NEW.contacto, NEW.telefono);
  END IF;

  -- La imagen anterior elimina un SOAT con baja lógica y eso libera el nombre (0259, RN-PROV-6). Si el padre lo
  -- conservara, volver a crear ese nombre fallaría al revertir la imagen.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE flito_proveedores p
       SET deleted_at = NEW.deleted_at, deleted_by = NEW.deleted_by, updated_at = now(), version = p.version + 1
     WHERE p.id = NEW.id AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM flito_proveedor_servicios_v v WHERE v.proveedor_id = NEW.id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS restriccion = CONSTRAINT_NAME;
  RAISE EXCEPTION 'El nombre o el NIT del proveedor % ya pertenecen a otro proveedor vigente', NEW.id
    USING ERRCODE = '23505', CONSTRAINT = flito_proveedor_restriccion_del_perfil(TG_TABLE_NAME, restriccion);
END
$fn$;

CREATE OR REPLACE FUNCTION flito_proveedor_padre_a_perfil() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE flito_proveedores_soat s
     SET nombre = NEW.nombre, activo = NEW.activo
   WHERE s.id = NEW.id AND (s.nombre, s.activo) IS DISTINCT FROM (NEW.nombre, NEW.activo);
  UPDATE flito_proveedores_logistica l
     SET nombre = NEW.nombre, activo = NEW.activo, nit = NEW.nit, contacto = NEW.contacto, telefono = NEW.telefono
   WHERE l.id = NEW.id
     AND (l.nombre, l.activo, l.nit, l.contacto, l.telefono) IS DISTINCT FROM
         (NEW.nombre, NEW.activo, NEW.nit, NEW.contacto, NEW.telefono);
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION flito_proveedor_perfil_borrado() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE flito_proveedores p
     SET deleted_at = now(), updated_at = now(), version = p.version + 1
   WHERE p.id = OLD.id AND p.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM flito_proveedor_servicios_v v WHERE v.proveedor_id = OLD.id);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS perfil_crea_padre ON flito_proveedores_soat;
CREATE TRIGGER perfil_crea_padre BEFORE INSERT ON flito_proveedores_soat
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_crea_padre();
DROP TRIGGER IF EXISTS perfil_crea_padre ON flito_proveedores_logistica;
CREATE TRIGGER perfil_crea_padre BEFORE INSERT ON flito_proveedores_logistica
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_crea_padre();

DROP TRIGGER IF EXISTS perfil_a_padre ON flito_proveedores_soat;
CREATE TRIGGER perfil_a_padre AFTER UPDATE ON flito_proveedores_soat
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_a_padre();
DROP TRIGGER IF EXISTS perfil_a_padre ON flito_proveedores_logistica;
CREATE TRIGGER perfil_a_padre AFTER UPDATE ON flito_proveedores_logistica
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_a_padre();

DROP TRIGGER IF EXISTS padre_a_perfil ON flito_proveedores;
CREATE TRIGGER padre_a_perfil AFTER UPDATE ON flito_proveedores
  FOR EACH ROW
  WHEN ((OLD.nombre, OLD.activo, OLD.nit, OLD.contacto, OLD.telefono) IS DISTINCT FROM
        (NEW.nombre, NEW.activo, NEW.nit, NEW.contacto, NEW.telefono))
  EXECUTE FUNCTION flito_proveedor_padre_a_perfil();

DROP TRIGGER IF EXISTS perfil_borrado ON flito_proveedores_logistica;
CREATE TRIGGER perfil_borrado AFTER DELETE ON flito_proveedores_logistica
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_borrado();

-- ── Paso 5. Usuarios ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS flito_proveedor_id uuid;

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_flito_proveedor_id_flito_proveedores_id_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_flito_proveedor_id_flito_proveedores_id_fk
      FOREIGN KEY (flito_proveedor_id) REFERENCES flito_proveedores(id) ON DELETE RESTRICT;
  END IF;
END
$fk$;

CREATE INDEX IF NOT EXISTS idx_users_flito_proveedor ON users (flito_proveedor_id);

UPDATE users
   SET flito_proveedor_id = flito_proveedor_soat_id
 WHERE flito_proveedor_soat_id IS NOT NULL AND flito_proveedor_id IS DISTINCT FROM flito_proveedor_soat_id;

-- Sincroniza las dos columnas antes de escribir. Si cambió la nueva, manda ella, y la vieja solo se llena con un
-- perfil de SOAT vigente: revertir la imagen niega el acceso en lugar de dar el de otro proveedor. Si solo cambió
-- la vieja, es la imagen anterior y la nueva toma el mismo resultado, incluido quitarlo.
CREATE OR REPLACE FUNCTION users_proveedor_sincroniza() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  manda_la_nueva boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    manda_la_nueva := NEW.flito_proveedor_id IS NOT NULL;
  ELSE
    manda_la_nueva := NEW.flito_proveedor_id IS DISTINCT FROM OLD.flito_proveedor_id;
    IF NOT manda_la_nueva AND NEW.flito_proveedor_soat_id IS NOT DISTINCT FROM OLD.flito_proveedor_soat_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF manda_la_nueva THEN
    NEW.flito_proveedor_soat_id := (
      SELECT s.id FROM flito_proveedores_soat s WHERE s.id = NEW.flito_proveedor_id AND s.deleted_at IS NULL
    );
  ELSE
    NEW.flito_proveedor_id := NEW.flito_proveedor_soat_id;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS users_proveedor_sync ON users;
CREATE TRIGGER users_proveedor_sync BEFORE INSERT OR UPDATE OF flito_proveedor_id, flito_proveedor_soat_id ON users
  FOR EACH ROW EXECUTE FUNCTION users_proveedor_sincroniza();

-- Reescribe la versión de la 0231: un rol de enlace proveedor exige la columna nueva, que el trigger anterior ya
-- dejó sincronizada. Un usuario de un proveedor solo de Logística es válido y su columna vieja queda vacía.
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
  IF te = 'proveedor' AND NEW.flito_proveedor_id IS NULL THEN
    -- Mismo texto de la 0231: la ruta de usuarios lo muestra tal cual y F1 no cambia nada visible.
    RAISE EXCEPTION 'El rol % exige proveedor SOAT y el usuario % no lo tiene', NEW.role, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora
END $fn$;

DROP TRIGGER IF EXISTS users_ambito_trg ON users;
CREATE CONSTRAINT TRIGGER users_ambito_trg
  AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_soat_id, flito_proveedor_id ON users
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION users_ambito_requerido();

-- ── Paso 6. Comprobación final ──────────────────────────────────────────────────────────────────────────
-- >>> COMPROBACION FINAL
DO $final$
DECLARE
  perfiles_sin_padre bigint;
  usuarios_distintos bigint;
BEGIN
  SELECT count(*) INTO perfiles_sin_padre FROM (
    SELECT s.id FROM flito_proveedores_soat s UNION ALL SELECT l.id FROM flito_proveedores_logistica l
  ) perfil
  WHERE NOT EXISTS (SELECT 1 FROM flito_proveedores p WHERE p.id = perfil.id);

  SELECT count(*) INTO usuarios_distintos FROM users u
  WHERE u.flito_proveedor_soat_id IS NOT NULL AND u.flito_proveedor_id IS DISTINCT FROM u.flito_proveedor_soat_id;

  IF perfiles_sin_padre > 0 OR usuarios_distintos > 0 THEN
    RAISE EXCEPTION '0289 detenida en la comprobación final: % perfil(es) sin registro padre y % usuario(s) con proveedor distinto.',
      perfiles_sin_padre, usuarios_distintos;
  END IF;
END
$final$;
-- <<< COMPROBACION FINAL
