-- 0290_flito_proveedores_logistica_unicidad_viva.sql
-- Autor: David Chica
-- Feature #14324, HU #14332, #14333 y #14334 (ADR-0039 §3 y §16.8b). F2 es el primero que escribe en el padre.
--
-- 1. La unicidad de Logística deja de contar a las filas de baja: dar de baja libera nombre y NIT. La restricción
--    del nombre se llama `flito_proveedores_logistica_nombre_key` en las BD creadas por SQL (0102) y
--    `…_nombre_unique` es el nombre que le daría Drizzle: se retiran ambas, como hizo la 0259 con SOAT.
-- 2. Un perfil de baja deja de recibir datos del padre y de enviárselos. Sin esto, editar el padre le copiaría
--    NIT, contacto y teléfono a un perfil de Logística retirado, y una escritura sobre ese perfil se los llevaría
--    al padre, incluso ya eliminado.
--
-- Sin BEGIN/COMMIT (ADR-DB-001): lo pone el runner. Idempotente: se puede aplicar dos veces.

-- ── Paso 1. Unicidad entre vigentes ─────────────────────────────────────────────────────────────────────
-- Con `strategy: Recreate` en PDN la API ya está caída: sin un límite, un lock ajeno la dejaría esperando sin
-- ningún error en el log. Así falla a los 30 s y queda visible en el initContainer.
SET LOCAL lock_timeout = '30s';

ALTER TABLE flito_proveedores_logistica DROP CONSTRAINT IF EXISTS flito_proveedores_logistica_nombre_key;
ALTER TABLE flito_proveedores_logistica DROP CONSTRAINT IF EXISTS flito_proveedores_logistica_nombre_unique;
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_proveedores_logistica_nombre_vivo
  ON flito_proveedores_logistica (nombre) WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uq_flito_proveedores_logistica_nit;
CREATE UNIQUE INDEX uq_flito_proveedores_logistica_nit
  ON flito_proveedores_logistica (nit) WHERE nit IS NOT NULL AND deleted_at IS NULL;

-- ── Paso 2. Un perfil de baja no sincroniza con el padre ────────────────────────────────────────────────
-- Misma función de la 0289, salvo la guarda de la copia: solo sube un perfil vigente, y solo a un padre vigente. La
-- rama de la baja no cambia: es la que usa la imagen anterior.
CREATE OR REPLACE FUNCTION flito_proveedor_perfil_a_padre() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  restriccion text;
BEGIN
  IF pg_trigger_depth() >= 2 THEN
    RETURN NULL;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    IF TG_TABLE_NAME = 'flito_proveedores_soat' THEN
      UPDATE flito_proveedores p
         SET nombre = NEW.nombre, activo = NEW.activo, updated_at = now(), version = p.version + 1
       WHERE p.id = NEW.id AND p.deleted_at IS NULL AND (p.nombre, p.activo) IS DISTINCT FROM (NEW.nombre, NEW.activo);
    ELSE
      UPDATE flito_proveedores p
         SET nombre = NEW.nombre, activo = NEW.activo, nit = NULLIF(btrim(NEW.nit), ''), contacto = NEW.contacto,
             telefono = NEW.telefono, updated_at = now(), version = p.version + 1
       WHERE p.id = NEW.id AND p.deleted_at IS NULL
         AND (p.nombre, p.activo, p.nit, p.contacto, p.telefono) IS DISTINCT FROM
             (NEW.nombre, NEW.activo, NULLIF(btrim(NEW.nit), ''), NEW.contacto, NEW.telefono);
    END IF;
  END IF;

  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE flito_proveedores p
       SET deleted_at = NEW.deleted_at, deleted_by = NEW.deleted_by,
           nit = NULL, telefono = NULL, correo = NULL, direccion = NULL, contacto = NULL,
           updated_at = now(), version = p.version + 1
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

-- Logística solo copia a un perfil vigente. Dar de baja el padre sigue vaciando los perfiles vigentes porque el
-- servicio escribe primero el padre; un perfil retirado antes ya se vació al retirarlo.
CREATE OR REPLACE FUNCTION flito_proveedor_padre_a_perfil() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE flito_proveedores_soat s
     SET nombre = NEW.nombre, activo = NEW.activo
   WHERE s.id = NEW.id AND (s.nombre, s.activo) IS DISTINCT FROM (NEW.nombre, NEW.activo);
  UPDATE flito_proveedores_logistica l
     SET nombre = NEW.nombre, activo = NEW.activo, nit = NEW.nit, contacto = NEW.contacto, telefono = NEW.telefono
   WHERE l.id = NEW.id AND l.deleted_at IS NULL
     AND (l.nombre, l.activo, l.nit, l.contacto, l.telefono) IS DISTINCT FROM
         (NEW.nombre, NEW.activo, NEW.nit, NEW.contacto, NEW.telefono);
  RETURN NULL;
END
$fn$;
