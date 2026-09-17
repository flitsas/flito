-- 0203_permiso_excel_exportar_pago.sql
-- Bug #12642 (Feature #11908 — Excel de las colas de SOAT e Impuestos): las DOS funciones que abren
--   el archivo AMPLIADO con valor pagado, fechas de solicitud/pago y trazabilidad. Son funciones
--   distintas de `soat.excel.exportar` / `impuestos.excel.exportar` a proposito: el archivo de hoy
--   (27 columnas del vehiculo y su titular) lo descarga el gestor de partida; el ampliado lleva lo
--   que FLITO paga y a quien, y eso no se le entrega a un proveedor por el hecho de poder bajar la
--   cola. Se siembran SOLO a admin: el administrador las reparte desde el panel.
-- Autor: equipo FLITO. Antecedentes: 0201 (calco literal de la siembra operacion + reparto),
--   0199 (funciones nuevas SOLO a admin), 0197/0192 (una tupla por linea, byte a byte con
--   catalogo-operaciones.ts), ADR-DB-001 (sin control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. La anterior es la 0202_ (HU #12654, comprobantes F3).

-- ── Paso 1 — Las dos operaciones (byte a byte con catalogo-operaciones.ts) ────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('soat.excel.exportar_pago',      'soat',      'Exportar la cola de SOAT a Excel con datos de pago y trazabilidad',      'Descargar el listado filtrado con el valor pagado, las fechas de solicitud y pago y el gestor.', 'operacion'),
  ('impuestos.excel.exportar_pago', 'impuestos', 'Exportar la cola de impuestos a Excel con datos de pago y trazabilidad', 'Descargar el listado filtrado con el valor liquidado y pagado, las fechas de solicitud y pago y el gestor.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — Reparto en VALUES explicitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'soat.excel.exportar_pago'),
  ('admin', 'impuestos.excel.exportar_pago')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0203$
DECLARE n_ops int; n_reparto int;
BEGIN
  -- Por codigo exacto y NO por modulo/prefijo: `soat.*` e `impuestos.*` tienen decenas de filas previas.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN
    ('soat.excel.exportar_pago', 'impuestos.excel.exportar_pago');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE rol_codigo = 'admin' AND funcion_codigo IN
    ('soat.excel.exportar_pago', 'impuestos.excel.exportar_pago');
  IF n_ops <> 2 OR n_reparto <> 2 THEN
    RAISE EXCEPTION '0203: funciones de export ampliado inconsistentes (ops=%, reparto=%)', n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0203: 2 funciones de export ampliado sembradas (% filas de reparto: solo admin)', n_reparto;
END $resumen0203$;
