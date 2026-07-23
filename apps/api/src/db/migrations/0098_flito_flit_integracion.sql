-- FLITO Fase 8 — integración con FLIT real (solo lectura). Ver docs/integracion/integracionFlit.md.
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).
--
-- El reporte de FLIT trae TODOS los trámites en cualquier estado. Se guardan tal cual (upsert):
-- el estado real vive como texto (flit_estado); el enum interno `estado` deja de ser obligatorio.
-- Compañía y organismo pueden NO existir/emparejar aún (empresa a crear, secretaría sin match por
-- nombre), así que sus FKs pasan a NULLABLE y se guarda el dato crudo (compania_nit, transito_nombre_flit).

-- ── flito_tramites: datos del payload real ──────────────────────────────────
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS flit_estado VARCHAR(60);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS tipo_tramite VARCHAR(60);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS ciudad VARCHAR(120);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS transito_nombre_flit VARCHAR(200);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS compania_nit VARCHAR(30);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS factura_venta_flit_id VARCHAR(120);
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS fecha_aprobacion TIMESTAMPTZ;
ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS flit_raw JSONB;

-- La verdad del estado la lleva flit_estado (texto). El enum interno se conserva para el ciclo de
-- entrega FLITO pero ya no es obligatorio (un Borrador de FLIT no tiene equivalente interno).
ALTER TABLE flito_tramites ALTER COLUMN estado DROP NOT NULL;
-- Compañía y organismo pueden no existir/emparejar todavía.
ALTER TABLE flito_tramites ALTER COLUMN compania_id DROP NOT NULL;
ALTER TABLE flito_tramites ALTER COLUMN organismo_codigo DROP NOT NULL;
-- Campos derivados del mock que el reporte real no siempre trae.
ALTER TABLE flito_tramites ALTER COLUMN tipo_propiedad DROP NOT NULL;
ALTER TABLE flito_tramites ALTER COLUMN process_status DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flito_tramites_flit_estado ON flito_tramites (flit_estado);
CREATE INDEX IF NOT EXISTS idx_flito_tramites_compania_nit ON flito_tramites (compania_nit);

-- ── Historial de cambios del trámite (auditoría campo por campo, punto 4) ────
-- Cada diferencia detectada al sincronizar (origen 'api') o al ejecutar una acción (origen 'usuario')
-- deja una fila: qué campo cambió, de qué a qué, cuándo y quién (si aplica).
CREATE TABLE IF NOT EXISTS flito_tramite_historial (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id UUID NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  campo VARCHAR(60) NOT NULL,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  origen VARCHAR(10) NOT NULL,
  usuario_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_tramite_historial_tramite ON flito_tramite_historial (tramite_id, created_at DESC);
