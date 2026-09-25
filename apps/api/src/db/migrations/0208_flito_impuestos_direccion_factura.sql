-- 0208_flito_impuestos_direccion_factura.sql
-- HU #12833 (Épica #12809, Feature #12824) — dirección del comprador leída de la factura de venta,
--   corrección manual con permiso y marca «Dirección sin confirmar» en el Excel ampliado.
--   Diseño: docs/diseno-hu-12833-direccion-comprador.md (D1, D5).
-- Autor: equipo FLITO. Antecedentes: 0207 (columnas de flito_impuestos del análisis), 0203 (siembra de
--   una función nueva SOLO a admin, reparto en VALUES explícitos).
--
-- La dirección vive en flito_impuestos y NUNCA en flito_compradores: el sync con FLIT borra y
-- vuelve a insertar los compradores, así que ahí se perdería.
--   direccion_factura/municipio_factura/departamento_factura: solo valores CONFIRMADOS. La propuesta
--     sin confirmar ya está en extraccion_factura_venta (no se duplica).
--   direccion_fuente: NULL = sin dirección confirmada (se lee la de FLIT); 'factura' = la confirmó el
--     análisis; 'manual' = corregida por un usuario. Es el discriminante (no confirmada_por_id, que
--     queda NULL si se borra el usuario).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo.
--   - Idempotente: ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING y backfill cuyo WHERE excluye
--     las filas ya decididas. La 2a pasada no cambia nada. La anterior es la 0207_.

-- ── Paso 1 — Columnas ────────────────────────────────────────────────────────────────────────────
ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS direccion_factura               text,
  ADD COLUMN IF NOT EXISTS municipio_factura               text,
  ADD COLUMN IF NOT EXISTS departamento_factura            text,
  ADD COLUMN IF NOT EXISTS direccion_fuente                text
    CONSTRAINT flito_impuestos_direccion_fuente_chk CHECK (direccion_fuente IN ('factura', 'manual')),
  ADD COLUMN IF NOT EXISTS direccion_pendiente_revision    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_por_id     integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_por_nombre text,
  ADD COLUMN IF NOT EXISTS direccion_confirmada_en         timestamptz;

-- ── Paso 2 — Backfill de lo ya analizado (misma regla que el paso `direccion` del análisis) ──────
-- 2a. Dirección confiable → confirmada; municipio/departamento solo si su campo es confiable.
UPDATE flito_impuestos
   SET direccion_factura       = trim(extraccion_factura_venta->'direccion'->>'valor'),
       municipio_factura       = CASE WHEN (extraccion_factura_venta->'municipio'->>'confiable')::boolean
                                      THEN nullif(trim(extraccion_factura_venta->'municipio'->>'valor'), '') END,
       departamento_factura    = CASE WHEN (extraccion_factura_venta->'departamento'->>'confiable')::boolean
                                      THEN nullif(trim(extraccion_factura_venta->'departamento'->>'valor'), '') END,
       direccion_fuente        = 'factura',
       direccion_confirmada_en = now()
 WHERE analisis_estado IN ('completado', 'error_analisis')
   AND direccion_fuente IS NULL
   AND NOT direccion_pendiente_revision
   AND (extraccion_factura_venta->'direccion'->>'confiable')::boolean
   AND nullif(trim(extraccion_factura_venta->'direccion'->>'valor'), '') IS NOT NULL;

-- 2b. El resto de lo analizado sin dirección confirmada → pendiente de revisión.
UPDATE flito_impuestos
   SET direccion_pendiente_revision = true
 WHERE analisis_estado IN ('completado', 'error_analisis')
   AND direccion_fuente IS NULL
   AND NOT direccion_pendiente_revision;

-- ── Paso 3 — Función nueva (byte a byte con catalogo-operaciones.ts) ─────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('impuestos.tramite.corregir_direccion', 'impuestos', 'Corregir dirección del comprador', 'Guardar la dirección, municipio y departamento correctos del comprador de un trámite de impuestos.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 4 — Reparto en VALUES explícitos (forma que parsea __tests__/helpers/permisos-seed-sql.ts).
--   Solo admin: el administrador la reparte desde el panel.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'impuestos.tramite.corregir_direccion')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0208$
DECLARE n_ops int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones
   WHERE tipo = 'operacion' AND codigo = 'impuestos.tramite.corregir_direccion';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE rol_codigo = 'admin' AND funcion_codigo = 'impuestos.tramite.corregir_direccion';
  IF n_ops <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0208: función de corregir dirección inconsistente (ops=%, reparto=%)', n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0208: función impuestos.tramite.corregir_direccion sembrada (solo admin)';
END $resumen0208$;
