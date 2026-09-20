-- 0197_permiso_recibo_caja.sql
-- Feature #12589 — Recibo de caja de impuestos. HU #12591 (recibo de caja puntual desde el detalle
--   del impuesto): la funcion del motor de permisos que gobierna POST /api/flito/impuestos/:id/recibo-caja,
--   bajo el modulo `impuestos`:
--     impuestos.recibos.cargar_caja -> admin (SOLO Operaciones; el gestor del organismo NO la recibe
--                                     de partida, aunque tenga impuestos.recibos.cargar)
-- Autor: equipo FLITO. Antecedentes: 0193 (calco literal de la siembra funcion + reparto), 0196
--   (liquidado_en, la marca sobre la que se carga el recibo de caja), ADR-0015 (permisos en base),
--   ADR-DB-001 (sin control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: INSERT … ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Las tuplas de permisos van una por linea, byte a byte con catalogo-operaciones.ts: el test de la
--     0179 las compara con el generador y el de la 0197 con el catalogo.

-- ── Paso 1 — La funcion (modulo impuestos, tipo operacion) ───────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('impuestos.recibos.cargar_caja', 'impuestos', 'Cargar recibo de caja', 'Cargar sobre un impuesto con liquidación el recibo de caja del pago en ventanilla y dejarlo pagado.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: solo admin ─────────────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'impuestos.recibos.cargar_caja')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0197$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones
    WHERE codigo = 'impuestos.recibos.cargar_caja' AND tipo = 'operacion';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'impuestos.recibos.cargar_caja' AND rol_codigo = 'admin';
  IF n_funcion <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0197: permiso de recibo de caja inconsistente (funciones=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0197: % funcion impuestos.recibos.cargar_caja y % fila de reparto (admin)', n_funcion, n_reparto;
END $resumen0197$;
