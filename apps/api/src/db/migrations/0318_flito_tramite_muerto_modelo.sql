-- 0318_flito_tramite_muerto_modelo.sql
-- Épica #14707 «Un trámite anulado, abortado o revocado no existe en FLITO» — ADR-0049 §1-§3 y §7, diseño
-- docs/diseno/epica-14707-tramite-muerto.md §5. Autor: equipo FLITO. Usa el valor `descartado` que añadió la 0317
-- (va en archivo aparte por 55P04: el runner envuelve cada migración en una transacción, ADR-DB-001).
--
-- En este orden:
--   1. Columnas del descarte en `flito_soat` (`tramite_origen_id`, `descartado_en`, `motivo_descarte`,
--      `descartado_por_tramite_id`) y en `flito_impuestos` (`descartado_en`, `motivo_descarte`), con sus CHECK.
--      Las dos referencias nuevas a `flito_tramites` van SIN FK: cerrarían el ciclo con `flito_tramites.soat_id`
--      (mismo motivo que `factura_venta_soporte_id`); las filas de `flito_tramites` nunca se borran.
--   2. Índices únicos parciales «abierto» (ADR-0031, 0267) recreados excluyendo también `descartado`, con el mismo
--      nombre (cuadran con el schema Drizzle), e índice del originador.
--   3. Trigger `flito_descartado_terminal`: salir de `descartado` lanza ERRCODE 'FL409' (el errorHandler lo traduce a
--      409 TRAMITE_NO_VIGENTE). Solo vigila `estado`: la retención (Ley 1581) puede seguir limpiando columnas.
--   4. Tabla `flito_avisos_usuario` (solo referencias; sin placa ni datos del titular).
--   5. Backfill D1 (FLIT 1): `Abortado`/`Revocado` → `estado='anulado'`, ANTES de que arranque el código nuevo
--      (el initContainer corre primero). FLIT 2 ya los escribía así.
--   6. Backfill del originador del SOAT: el primer trámite ligado por (created_at, id), regla de ADR-0041 §13.8.
--      Solo `origen='tramite'`; el canal Cliente queda en NULL (no lo originó ningún trámite).
-- Sin BEGIN/COMMIT propio. Idempotente: IF NOT EXISTS, DROP … IF EXISTS + CREATE, UPDATE con guarda; la 2.ª corrida
-- no cambia filas.

-- 1. Columnas y CHECK ────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS tramite_origen_id uuid,
  ADD COLUMN IF NOT EXISTS descartado_en timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_descarte varchar(10),
  ADD COLUMN IF NOT EXISTS descartado_por_tramite_id uuid;

ALTER TABLE flito_impuestos
  ADD COLUMN IF NOT EXISTS descartado_en timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_descarte varchar(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_soat_motivo_descarte_chk') THEN
    ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_motivo_descarte_chk
      CHECK (motivo_descarte IS NULL OR motivo_descarte IN ('anulado', 'abortado', 'revocado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_soat_descarte_chk') THEN
    ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_descarte_chk
      CHECK ((estado = 'descartado') = (descartado_en IS NOT NULL AND motivo_descarte IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_impuestos_motivo_descarte_chk') THEN
    ALTER TABLE flito_impuestos ADD CONSTRAINT flito_impuestos_motivo_descarte_chk
      CHECK (motivo_descarte IS NULL OR motivo_descarte IN ('anulado', 'abortado', 'revocado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_impuestos_descarte_chk') THEN
    ALTER TABLE flito_impuestos ADD CONSTRAINT flito_impuestos_descarte_chk
      CHECK ((estado = 'descartado') = (descartado_en IS NOT NULL AND motivo_descarte IS NOT NULL));
  END IF;
END $$;

-- 2. Índices «abierto» excluyen `descartado` (mismo nombre) + originador ─────────────────────────────────────
DROP INDEX IF EXISTS uq_flito_soat_vin_abierto;
CREATE UNIQUE INDEX uq_flito_soat_vin_abierto ON flito_soat (vin) WHERE estado NOT IN ('pagado', 'descartado');
DROP INDEX IF EXISTS uq_flito_soat_vehiculo_abierto;
CREATE UNIQUE INDEX uq_flito_soat_vehiculo_abierto ON flito_soat (vehiculo_id) WHERE estado NOT IN ('pagado', 'descartado');
CREATE INDEX IF NOT EXISTS idx_flito_soat_tramite_origen ON flito_soat (tramite_origen_id) WHERE tramite_origen_id IS NOT NULL;

-- 3. Trigger terminal ─────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION flito_descartado_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado::text = 'descartado' AND NEW.estado::text <> 'descartado' THEN
    RAISE EXCEPTION 'registro descartado: su trámite no existe en FLITO' USING ERRCODE = 'FL409';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_flito_soat_descartado_terminal ON flito_soat;
CREATE TRIGGER trg_flito_soat_descartado_terminal BEFORE UPDATE OF estado ON flito_soat
  FOR EACH ROW EXECUTE FUNCTION flito_descartado_terminal();
DROP TRIGGER IF EXISTS trg_flito_impuestos_descartado_terminal ON flito_impuestos;
CREATE TRIGGER trg_flito_impuestos_descartado_terminal BEFORE UPDATE OF estado ON flito_impuestos
  FOR EACH ROW EXECUTE FUNCTION flito_descartado_terminal();

-- 4. Avisos por usuario (solo referencias) ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_avisos_usuario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo varchar(30) NOT NULL,
  concepto varchar(10) NOT NULL,
  registro_id uuid NOT NULL,
  tramite_id uuid REFERENCES flito_tramites(id),
  motivo varchar(10) NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  visto_en timestamptz,
  CONSTRAINT flito_avisos_usuario_tipo_chk CHECK (tipo IN ('solicitud_retirada')),
  CONSTRAINT flito_avisos_usuario_concepto_chk CHECK (concepto IN ('soat', 'impuesto')),
  CONSTRAINT flito_avisos_usuario_motivo_chk CHECK (motivo IN ('anulado', 'abortado', 'revocado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_avisos_usuario_registro
  ON flito_avisos_usuario (usuario_id, tipo, concepto, registro_id);
CREATE INDEX IF NOT EXISTS idx_flito_avisos_usuario_no_vistos
  ON flito_avisos_usuario (usuario_id, creado_en) WHERE visto_en IS NULL;

-- 5. Backfill D1 (FLIT 1): Abortado/Revocado → anulado ──────────────────────────────────────────────────────
UPDATE flito_tramites SET estado = 'anulado', updated_at = now()
 WHERE lower(trim(flit_estado)) IN ('abortado', 'revocado') AND estado IS DISTINCT FROM 'anulado';

-- 6. Backfill del originador: primer trámite ligado por (created_at, id) ─────────────────────────────────────
UPDATE flito_soat s SET tramite_origen_id = o.id
  FROM (SELECT DISTINCT ON (soat_id) soat_id, id FROM flito_tramites
         WHERE soat_id IS NOT NULL ORDER BY soat_id, created_at, id) o
 WHERE s.id = o.soat_id AND s.origen = 'tramite' AND s.tramite_origen_id IS NULL;
