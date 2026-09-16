-- 0199_tramite_viajes_logistica.sql
-- Epica #12244 / Feature #12617 — Logistica: viajes adicionales por tramite. HU #12619 (modelo, permisos y
--   API): la tabla flito_tramite_viajes_logistica (una fila por viaje ADICIONAL; el 1 va incluido en la
--   tarifa de logistica, asi que numero >= 2; valor es lo que se cobra y tarifa_vigente el snapshot de la
--   tarifa de logistica al registrar) y las tres funciones del motor de permisos que la gobiernan, bajo el
--   modulo `logistica`:
--     logistica.viajes.ver       -> admin
--     logistica.viajes.registrar -> admin
--     logistica.viajes.quitar    -> admin
--   Reparto SOLO a admin: el administrador reparte a los demas roles desde el panel (Feature #12072).
-- Autor: equipo FLITO. Antecedentes: 0193 (tabla + siembra en un archivo, calco literal), ADR-0005 (FK a
--   users RESTRICT en pareja con la marca de tiempo), ADR-0017 (snapshot y guarda transaccional),
--   ADR-DB-001 (sin control de transaccion propio), ADR-0015 (permisos en base).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: CREATE TABLE IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Las tuplas de permisos van una por linea, byte a byte con catalogo-operaciones.ts: el test de la
--     0179 las compara con el generador y el de la 0199 con el catalogo.
--   - Los CHECKs llevan el mismo nombre que en db/schema/flito-logistica-viajes.ts (leccion 0157).

-- ── Paso 1 — La tabla de viajes adicionales ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_tramite_viajes_logistica (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id uuid NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  numero integer NOT NULL,
  modo varchar(10) NOT NULL,
  valor numeric(14,2) NOT NULL,
  tarifa_vigente numeric(14,2),
  motivo varchar(30) NOT NULL,
  motivo_detalle text,
  registrado_por_id integer REFERENCES users(id) ON DELETE RESTRICT,
  registrado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_tramite_viajes_log_numero_chk CHECK (numero >= 2),
  CONSTRAINT flito_tramite_viajes_log_valor_chk CHECK (valor >= 0),
  CONSTRAINT flito_tramite_viajes_log_modo_chk CHECK (modo IN ('inicial', 'manual')),
  CONSTRAINT flito_tramite_viajes_log_motivo_chk CHECK (motivo IN ('devolucion', 'segunda_entrega', 'documento_faltante', 'otro')),
  CONSTRAINT flito_tramite_viajes_log_motivo_detalle_chk CHECK (motivo <> 'otro' OR (motivo_detalle IS NOT NULL AND btrim(motivo_detalle) <> '')),
  CONSTRAINT flito_tramite_viajes_log_tarifa_inicial_chk CHECK (modo = 'manual' OR tarifa_vigente IS NOT NULL),
  CONSTRAINT flito_tramite_viajes_log_valor_inicial_chk CHECK (modo <> 'inicial' OR valor = tarifa_vigente),
  CONSTRAINT flito_tramite_viajes_log_tramite_numero_uq UNIQUE (tramite_id, numero)
);

COMMENT ON TABLE flito_tramite_viajes_logistica IS 'HU #12619 viajes ADICIONALES de logística de un trámite. El viaje 1 va incluido en la tarifa; aquí solo los que se cobran aparte (numero >= 2). Fila viva: nace al registrar y se borra físicamente al quitar; solo se toca mientras el trámite no está liquidado. No sale en las actas ni en su PDF.';
COMMENT ON COLUMN flito_tramite_viajes_logistica.numero IS 'Ordinal del viaje en el trámite: MAX+1 bajo el FOR UPDATE del trámite. No se renumera al quitar.';
COMMENT ON COLUMN flito_tramite_viajes_logistica.modo IS 'inicial = copia la tarifa de logística vigente; manual = precio fijado a mano.';
COMMENT ON COLUMN flito_tramite_viajes_logistica.valor IS 'Lo que se cobra por este viaje. En inicial es igual a tarifa_vigente.';
COMMENT ON COLUMN flito_tramite_viajes_logistica.tarifa_vigente IS 'Snapshot de la tarifa de logística vigente al registrar; cambiar la tarifa después no lo toca. NULL solo en manual sin tarifa configurada.';
COMMENT ON COLUMN flito_tramite_viajes_logistica.motivo IS 'devolucion | segunda_entrega | documento_faltante | otro (otro exige motivo_detalle).';
COMMENT ON COLUMN flito_tramite_viajes_logistica.registrado_por_id IS 'Actor del registro; FK RESTRICT (ADR-0005). Acompaña a registrado_en.';

-- ── Paso 2 — Las tres funciones (modulo logistica, tipo operacion) ───────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('logistica.viajes.quitar', 'logistica', 'Quitar un viaje adicional de un trámite', 'Retirar de un trámite no liquidado un viaje adicional de logística registrado.', 'operacion'),
  ('logistica.viajes.registrar', 'logistica', 'Registrar un viaje adicional en un trámite', 'Añadir a un trámite no liquidado un viaje adicional de logística, copiando la tarifa vigente o fijando el precio a mano.', 'operacion'),
  ('logistica.viajes.ver', 'logistica', 'Ver los viajes adicionales de un trámite', 'Consultar los viajes adicionales de logística de un trámite y su total.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 3 — El reparto: SOLO admin; el administrador reparte desde el panel ─────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'logistica.viajes.quitar'),
  ('admin', 'logistica.viajes.registrar'),
  ('admin', 'logistica.viajes.ver')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0199$
DECLARE n_tabla int; n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_tabla FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'flito_tramite_viajes_logistica';
  SELECT count(*) INTO n_funcion FROM permisos_funciones
    WHERE codigo LIKE 'logistica.viajes.%' AND tipo = 'operacion';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo LIKE 'logistica.viajes.%' AND rol_codigo = 'admin';
  IF n_tabla <> 1 OR n_funcion <> 3 OR n_reparto <> 3 THEN
    RAISE EXCEPTION '0199: viajes adicionales de logistica inconsistente (tabla=%, funciones=%, reparto=%)', n_tabla, n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0199: flito_tramite_viajes_logistica lista; % funciones logistica.viajes.* y % filas de reparto solo a admin; el administrador reparte desde el panel', n_funcion, n_reparto;
END $resumen0199$;
