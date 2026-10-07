-- 0222_flito_soportes_documentos_adicionales_soat.sql
-- HU #13362 (Feature #13360, Épica #13201) — documentos adicionales en el alta de SOAT del canal Cliente.
--   - `flito_soportes.etiqueta`: el nombre que la persona le dio al documento (o su nombre de archivo).
--   - `flito_soportes.soat_incompleta_id`: el adicional de un alta APARCADA (RUNT caído → 202) cuelga de la
--     incompleta hasta que se completa; entonces recibe `soat_id` y conserva esta FK como rastro. Sin CASCADE,
--     igual que `flito_compradores.soat_incompleta_id` (0210).
--   - CHECK: un `documento_adicional_soat` tiene etiqueta y cuelga de una solicitud o de una por validar.
--   - La función `soat.documentos_adicionales.ver` (GET /api/flito/soat/:id/documentos-adicionales),
--     repartida a operación FLIT (`admin`) y al proveedor SOAT (`proveedor`). NO al `cliente`.
-- Autor: equipo FLITO. Antecedentes: 0212/0220 (calco de la siembra), 0210 (FK sin CASCADE a incompletas).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING; la 2a pasada no toca nada.
--   - `tipo` es varchar(40) sin enum ni CHECK: el valor nuevo no exige ALTER TYPE. La anterior es la 0221_.

-- ── Paso 1 — Columnas e índice ────────────────────────────────────────────────────────────────────
ALTER TABLE flito_soportes ADD COLUMN IF NOT EXISTS etiqueta varchar(150);
ALTER TABLE flito_soportes ADD COLUMN IF NOT EXISTS soat_incompleta_id uuid REFERENCES flito_soat_incompletas(id);
CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_incompleta
  ON flito_soportes (soat_incompleta_id) WHERE soat_incompleta_id IS NOT NULL;

-- ── Paso 2 — Integridad del tipo nuevo (las filas existentes son de otros tipos: la cumplen) ────
DO $chk0222$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_soportes_documento_adicional_chk') THEN
    ALTER TABLE flito_soportes ADD CONSTRAINT flito_soportes_documento_adicional_chk
      CHECK (tipo <> 'documento_adicional_soat'
             OR (etiqueta IS NOT NULL AND (soat_id IS NOT NULL OR soat_incompleta_id IS NOT NULL)));
  END IF;
END $chk0222$;

-- ── Paso 3 — La operación (byte a byte con catalogo-operaciones.ts) ──────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('soat.documentos_adicionales.ver', 'soat', 'Ver los documentos adicionales de una solicitud de SOAT', 'Abrir y descargar los documentos adicionales que el cliente adjuntó a la solicitud de SOAT.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 4 — Reparto: operación FLIT y proveedor SOAT; el cliente NO ─────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'soat.documentos_adicionales.ver'),
  ('proveedor', 'soat.documentos_adicionales.ver')
ON CONFLICT DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0222$
DECLARE n_ops int; n_reparto int; n_cliente int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'soat.documentos_adicionales.ver';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE funcion_codigo = 'soat.documentos_adicionales.ver';
  SELECT count(*) INTO n_cliente FROM permisos_rol_funcion WHERE funcion_codigo = 'soat.documentos_adicionales.ver' AND rol_codigo = 'cliente';
  IF n_ops <> 1 OR n_cliente <> 0 THEN
    RAISE EXCEPTION '0222: función de documentos adicionales inconsistente (ops=%, cliente=%)', n_ops, n_cliente;
  END IF;
  RAISE NOTICE '0222: función soat.documentos_adicionales.ver sembrada (% filas de reparto)', n_reparto;
END $resumen0222$;
