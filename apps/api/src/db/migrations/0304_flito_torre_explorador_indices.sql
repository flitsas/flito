-- 0304_flito_torre_explorador_indices.sql
-- Autor: David Chica
-- Épica #14590 — Torre de Control: Explorador flexible (ADR-0044). Índices de las sugerencias de placa y de la
-- fecha base «facturación». SQL plano, idempotente, sin BEGIN/COMMIT (el runner envuelve) y sin CONCURRENTLY.

-- ── 1. Sugerencias «contiene» de placa (ADR-0044 §d, RN-TOR-P5) ───────────────────────────────────────────────
-- Solo si pg_trgm ya está instalada: NO se hace CREATE EXTENSION (no se asume que el rol de la migración pueda).
-- Sin la extensión la consulta funciona igual con un recorrido completo; la migración avisa y no falla.
-- El índice no se declara en Drizzle porque depende de la extensión: mismo patrón que los GIN trigram de 0012/0026/0041/0042,
-- que viven solo en SQL.
DO $torre0304$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_flito_tramites_placa_trgm
               ON flito_tramites USING gin (upper(plate_complete) gin_trgm_ops)';
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE '0304: gin_trgm_ops no visible en el search_path; sugerencias de placa sin índice';
    END;
  ELSE
    RAISE NOTICE '0304: pg_trgm no instalada; sugerencias de placa sin índice (recorrido completo)';
  END IF;
END $torre0304$;

-- ── 2. Fecha de facturación = primera factura Siigo activa (ADR-0044 §a2, RN-TOR-M14) ─────────────────────────
-- Recorrido solo de índice para GROUP BY tramite_id + min(created_at) WHERE activo. Acelera también FACTURADO y
-- RN-TOR-P4. Declarado en Drizzle en `schema/siigo.ts` (`activoCreadoIdx`).
CREATE INDEX IF NOT EXISTS idx_siigo_factura_tramites_activo_creado
  ON siigo_factura_tramites (tramite_id, created_at) WHERE activo;
