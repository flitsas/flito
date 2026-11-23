-- 0313_flito_proveedores_perfil_espejo.sql
-- Autor: David Chica
-- Feature #14327, HU #14673 (ADR-0039 §5.2, F5 E1) — el código deja de declarar las columnas viejas de los perfiles.
--
-- Drizzle nombra todas las columnas declaradas en `select()`, `insert` y `returning`, así que la imagen que todavía
-- las declara no sobrevive a su DROP (#14355). Esta imagen ya no las escribe: `nombre` y `activo` de los perfiles, y
-- `nit`, `contacto` y `telefono` de Logística, quedan como espejo del padre que llena la BD mientras existan. Así la
-- imagen anterior (#14354), que todavía las lee y las escribe, sigue funcionando sobre este esquema.
--
--   · Crear un perfil: si el padre ya existe, el espejo se copia de él. Si no, se conserva el cuerpo de la 0292: la
--     imagen anterior y los altas que crean el perfil antes que el padre siguen creando el padre aquí.
--   · Reactivar un perfil (`deleted_at` a NULL): el espejo se copia del padre.
--   · Retirar Logística (`deleted_at` a no nulo): se vacían NIT, contacto y teléfono (RN-PSERV-4), como hacía el servicio.
--
-- Son BEFORE: corren antes del chequeo NOT NULL de `nombre`, así que no hace falta `DROP NOT NULL`. `padre_a_perfil`,
-- `perfil_a_padre` y `users_proveedor_sync` no cambian. Todo se retira con las columnas en la #14355.
--
-- Sin BEGIN/COMMIT (ADR-DB-001): lo pone el runner. Idempotente: se puede aplicar dos veces.

-- Con `strategy: Recreate` en PDN la API ya está caída: sin un límite, un lock ajeno la dejaría esperando sin
-- ningún error en el log. Así falla a los 30 s y queda visible en el initContainer.
SET LOCAL lock_timeout = '30s';

-- ── Crear: el espejo sale del padre si ya existe ────────────────────────────────────────────────────────
-- Misma firma y mismo manejo del choque de unicidad que la 0292. `NEW.nit`, `NEW.contacto` y `NEW.telefono` solo se nombran en la rama
-- de Logística: PL/pgSQL resuelve el campo al ejecutar la sentencia, y el perfil de SOAT no los tiene.
CREATE OR REPLACE FUNCTION flito_proveedor_perfil_crea_padre() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  perfil jsonb := to_jsonb(NEW);  -- El perfil de SOAT no tiene NIT, contacto ni teléfono: quedan NULL.
  padre flito_proveedores%ROWTYPE;
  restriccion text;
BEGIN
  SELECT * INTO padre FROM flito_proveedores p WHERE p.id = NEW.id;
  IF FOUND THEN
    NEW.nombre := padre.nombre;
    NEW.activo := padre.activo;
    IF TG_TABLE_NAME = 'flito_proveedores_logistica' THEN
      NEW.nit := padre.nit;
      NEW.contacto := padre.contacto;
      NEW.telefono := padre.telefono;
    END IF;
    RETURN NEW;
  END IF;

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

-- ── Reactivar y retirar ─────────────────────────────────────────────────────────────────────────────────
-- Al reactivar, `perfil_a_padre` (AFTER) compara el perfil ya copiado con el padre y no escribe nada. Al retirar,
-- ese trigger no sube nada de un perfil de baja (0293), así que el vaciado no llega al padre.
CREATE OR REPLACE FUNCTION flito_proveedor_perfil_espejo_baja() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  padre flito_proveedores%ROWTYPE;
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    SELECT * INTO padre FROM flito_proveedores p WHERE p.id = NEW.id;
    IF FOUND THEN
      NEW.nombre := padre.nombre;
      NEW.activo := padre.activo;
      IF TG_TABLE_NAME = 'flito_proveedores_logistica' THEN
        NEW.nit := padre.nit;
        NEW.contacto := padre.contacto;
        NEW.telefono := padre.telefono;
      END IF;
    END IF;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND TG_TABLE_NAME = 'flito_proveedores_logistica' THEN
    NEW.nit := NULL;
    NEW.contacto := NULL;
    NEW.telefono := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS perfil_espejo_baja ON flito_proveedores_soat;
CREATE TRIGGER perfil_espejo_baja BEFORE UPDATE OF deleted_at ON flito_proveedores_soat
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_espejo_baja();
DROP TRIGGER IF EXISTS perfil_espejo_baja ON flito_proveedores_logistica;
CREATE TRIGGER perfil_espejo_baja BEFORE UPDATE OF deleted_at ON flito_proveedores_logistica
  FOR EACH ROW EXECUTE FUNCTION flito_proveedor_perfil_espejo_baja();
