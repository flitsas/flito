-- 0193_tramite_servicios_adicionales.sql
-- Feature #12544 — Servicios adicionales por tramite. HU #12545 (asignacion de servicios a un tramite):
--   la tabla PUENTE flito_tramite_servicios_adicionales (fila viva: se crea al asignar y se borra al
--   quitar; nombre/descripcion/valor son el SNAPSHOT del tipo en el instante de asignar, CF-03) y las
--   tres funciones del motor de permisos que la gobiernan, bajo el modulo `finanzas`:
--     finanzas.servicios_adicionales.ver     -> admin, financiera, auditor (mismo alcance que LECTURA)
--     finanzas.servicios_adicionales.asignar -> admin, financiera
--     finanzas.servicios_adicionales.quitar  -> admin, financiera
-- Autor: equipo FLITO. Antecedentes: 0191 (catalogo de tipos, calco literal del DDL), 0192 (reparto),
--   ADR-0005 (FK a users RESTRICT en pareja con la marca de tiempo), ADR-0017 (snapshot en la puente y
--   guarda transaccional), ADR-DB-001 (sin control de transaccion propio), ADR-0015 (permisos en base).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: CREATE TABLE/INDEX IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila.
--   - Las tuplas de permisos van una por linea, byte a byte con catalogo-operaciones.ts: el test de la
--     0179 las compara con el generador y el de la 0193 con el catalogo.

-- ── Paso 1 — La tabla puente ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_tramite_servicios_adicionales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  tipo_id uuid NOT NULL REFERENCES flito_servicios_adicionales_tipos(id) ON DELETE RESTRICT,
  nombre varchar(120) NOT NULL,
  descripcion text,
  valor numeric(14,2) NOT NULL,
  asignado_por_id integer REFERENCES users(id) ON DELETE RESTRICT,
  asignado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_tramite_serv_adic_valor_chk CHECK (valor >= 0),
  CONSTRAINT flito_tramite_serv_adic_tramite_tipo_uq UNIQUE (tramite_id, tipo_id)
);

COMMENT ON TABLE flito_tramite_servicios_adicionales IS 'HU #12545 servicios adicionales ASIGNADOS a un trámite. Fila viva: nace al asignar y se borra físicamente al quitar; solo se toca mientras el trámite no está liquidado. Al sellar, la liquidación copia nombre y valor a su propio detalle.';
COMMENT ON COLUMN flito_tramite_servicios_adicionales.nombre IS 'Snapshot del nombre del tipo al asignar; editar o dar de baja el tipo después no lo cambia (CF-03).';
COMMENT ON COLUMN flito_tramite_servicios_adicionales.descripcion IS 'Snapshot de la descripción del tipo al asignar.';
COMMENT ON COLUMN flito_tramite_servicios_adicionales.valor IS 'Snapshot del valor del tipo al asignar; nunca se relee del catálogo.';
COMMENT ON COLUMN flito_tramite_servicios_adicionales.asignado_por_id IS 'Actor de la asignación; FK RESTRICT (ADR-0005). Acompaña a asignado_en.';

-- Un tipo por trámite (23505 -> 409 SERVICIO_YA_ASIGNADO) y la lectura por trámite del reporte.
CREATE INDEX IF NOT EXISTS idx_flito_tramite_serv_adic_tramite
  ON flito_tramite_servicios_adicionales (tramite_id);

-- ── Paso 2 — Las tres funciones (modulo finanzas, tipo operacion) ────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('finanzas.servicios_adicionales.asignar', 'finanzas', 'Asignar un servicio adicional a un trámite', 'Añadir a un trámite no liquidado un servicio adicional del catálogo, copiando su nombre y valor en ese instante.', 'operacion'),
  ('finanzas.servicios_adicionales.quitar', 'finanzas', 'Quitar un servicio adicional de un trámite', 'Retirar de un trámite no liquidado un servicio adicional asignado.', 'operacion'),
  ('finanzas.servicios_adicionales.ver', 'finanzas', 'Ver los servicios adicionales de un trámite', 'Consultar los servicios adicionales asignados a un trámite y su total.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 3 — El reparto: ver a admin, financiera y auditor; asignar y quitar a admin y financiera ──
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'finanzas.servicios_adicionales.asignar'),
  ('admin', 'finanzas.servicios_adicionales.quitar'),
  ('admin', 'finanzas.servicios_adicionales.ver'),
  ('auditor', 'finanzas.servicios_adicionales.ver'),
  ('financiera', 'finanzas.servicios_adicionales.asignar'),
  ('financiera', 'finanzas.servicios_adicionales.quitar'),
  ('financiera', 'finanzas.servicios_adicionales.ver')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0193$
DECLARE n_tabla int; n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_tabla FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'flito_tramite_servicios_adicionales';
  SELECT count(*) INTO n_funcion FROM permisos_funciones
    WHERE codigo LIKE 'finanzas.servicios_adicionales.%' AND tipo = 'operacion';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo LIKE 'finanzas.servicios_adicionales.%' AND rol_codigo IN ('admin', 'financiera', 'auditor');
  IF n_tabla <> 1 OR n_funcion <> 3 OR n_reparto <> 7 THEN
    RAISE EXCEPTION '0193: servicios adicionales por tramite inconsistente (tabla=%, funciones=%, reparto=%)', n_tabla, n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0193: flito_tramite_servicios_adicionales lista; % funciones finanzas.servicios_adicionales.* y % filas de reparto (ver: admin, financiera, auditor; asignar y quitar: admin, financiera)', n_funcion, n_reparto;
END $resumen0193$;
