-- 0223_flito_soportes_documentos_adicionales_carga_eliminar.sql
-- HU #13364 (Feature #13361, Épica #13201) — cargar y eliminar documentos adicionales de una solicitud de SOAT existente.
--   - Índice único parcial `uq_flito_soportes_adicional_soat_hash` (soat_id, hash): un adicional VIVO por contenido y
--     solicitud. Cierra la carrera de dos cargas simultáneas del mismo archivo (la carga usa
--     `ON CONFLICT (soat_id, hash) WHERE <predicado> DO NOTHING`). Las por validar (`soat_id NULL`) quedan fuera.
--   - Funciones `soat.documentos_adicionales.cargar` (POST /api/flito/soat/:id/documentos-adicionales) y
--     `soat.documentos_adicionales.eliminar` (DELETE …/:id/documentos-adicionales/:soporteId), repartidas a operación
--     FLIT (`admin`) y al proveedor SOAT (`proveedor`). NO al `cliente`.
-- Autor: equipo FLITO. Antecedente: 0222 (calco de la siembra). La anterior es la 0222_.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING; la 2a pasada no toca nada.

-- ── Paso 1 — Guarda: sin duplicados vivos que impidan el índice ─────────────────────────────────────
-- La HU #13362 deduplica por envío, así que no debería haber ninguno; si los hubiera, un error claro con
-- el conteo en lugar del críptico de CREATE UNIQUE INDEX.
DO $dup0223$
DECLARE n_dup int;
BEGIN
  SELECT count(*) INTO n_dup FROM (
    SELECT soat_id, hash FROM flito_soportes
     WHERE tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL
     GROUP BY soat_id, hash HAVING count(*) > 1
  ) d;
  IF n_dup > 0 THEN
    RAISE EXCEPTION '0223: % pares (soat_id, hash) de documentos adicionales duplicados; depurar antes del índice único', n_dup;
  END IF;
END $dup0223$;

-- ── Paso 2 — Índice único parcial ─────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soportes_adicional_soat_hash
  ON flito_soportes (soat_id, hash)
  WHERE tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL;

-- ── Paso 3 — Las operaciones (byte a byte con catalogo-operaciones.ts) ───────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('soat.documentos_adicionales.cargar', 'soat', 'Cargar documentos adicionales en una solicitud de SOAT', 'Adjuntar documentos adicionales a una solicitud de SOAT existente, en cualquier estado.', 'operacion'),
  ('soat.documentos_adicionales.eliminar', 'soat', 'Eliminar documentos adicionales de una solicitud de SOAT', 'Borrar definitivamente un documento adicional de una solicitud de SOAT, en cualquier estado, aunque lo haya cargado otra persona.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 4 — Reparto: operación FLIT y proveedor SOAT; el cliente NO ─────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'soat.documentos_adicionales.cargar'),
  ('proveedor', 'soat.documentos_adicionales.cargar'),
  ('admin', 'soat.documentos_adicionales.eliminar'),
  ('proveedor', 'soat.documentos_adicionales.eliminar')
ON CONFLICT DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────────
DO $resumen0223$
DECLARE n_ops int; n_reparto int; n_cliente int; n_idx int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones
   WHERE tipo = 'operacion' AND codigo IN ('soat.documentos_adicionales.cargar', 'soat.documentos_adicionales.eliminar');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE funcion_codigo IN ('soat.documentos_adicionales.cargar', 'soat.documentos_adicionales.eliminar')
     AND rol_codigo IN ('admin', 'proveedor');
  SELECT count(*) INTO n_cliente FROM permisos_rol_funcion
   WHERE funcion_codigo IN ('soat.documentos_adicionales.cargar', 'soat.documentos_adicionales.eliminar')
     AND rol_codigo = 'cliente';
  SELECT count(*) INTO n_idx FROM pg_indexes
   WHERE tablename = 'flito_soportes' AND indexname = 'uq_flito_soportes_adicional_soat_hash';
  IF n_ops <> 2 OR n_reparto <> 4 OR n_cliente <> 0 OR n_idx <> 1 THEN
    RAISE EXCEPTION '0223: documentos adicionales inconsistente (ops=%, reparto=%, cliente=%, indice=%)', n_ops, n_reparto, n_cliente, n_idx;
  END IF;
  RAISE NOTICE '0223: funciones cargar/eliminar sembradas (% filas de reparto) e índice único creado', n_reparto;
END $resumen0223$;
