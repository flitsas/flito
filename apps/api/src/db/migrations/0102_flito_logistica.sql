-- FLITO Logística (Fase 1) — trazabilidad del documento físico (LT/placa) del organismo al cliente.
-- Ver docs/features/FEATURE_LOGISTICA.md. La unidad de trazabilidad es el DOCUMENTO individual (RN-01);
-- actas y rutas son agrupaciones sobre él.
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).

-- ── Rol de mensajero (PWA de campo, Fase 2; el valor se declara ya) ─────────
-- ADD VALUE es válido dentro de la transacción del runner en PG12+ porque el valor no se USA aquí.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'mensajero';

-- ── Config por compañía: acepta entregas parciales (CA-08/09) ───────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logistica_permite_parcial BOOLEAN NOT NULL DEFAULT false;

-- ── Enums del dominio (idempotentes) ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE flito_logistica_doc_estado AS ENUM ('generado', 'recogido', 'clasificado', 'en_acta', 'despachado', 'entregado', 'novedad', 'devuelto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_logistica_acta_estado AS ENUM ('generada', 'despachada', 'entregada', 'devuelta');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_logistica_tipo_doc AS ENUM ('licencia_transito', 'placa', 'otro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Proveedores logísticos (mensajería propia PWA o integración con tercero, §6) ──
CREATE TABLE IF NOT EXISTS flito_proveedores_logistica (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(150) NOT NULL UNIQUE,
  estrategia VARCHAR(40) NOT NULL DEFAULT 'pwa_propia',
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Actas: agrupación por empresa para despacho/entrega (CA-04). La firma + evidencia
--    (columnas de entrega) se pueblan en la Fase 2 (PWA); aquí quedan definidas. ──
CREATE TABLE IF NOT EXISTS flito_logistica_actas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id INTEGER NOT NULL REFERENCES clients(id),
  estado flito_logistica_acta_estado NOT NULL DEFAULT 'generada',
  mensajero_id INTEGER REFERENCES users(id),
  proveedor_logistica_id UUID REFERENCES flito_proveedores_logistica(id),
  permite_parcial BOOLEAN NOT NULL DEFAULT false,
  direccion_entrega VARCHAR(300),
  contacto_nombre VARCHAR(150),
  contacto_documento VARCHAR(30),
  pdf_storage_key VARCHAR(400),
  firma_storage_key VARCHAR(400),
  foto_storage_key VARCHAR(400),
  receptor_nombre VARCHAR(150),
  receptor_documento VARCHAR(30),
  entregado_lat NUMERIC(10, 7),
  entregado_lng NUMERIC(10, 7),
  entregado_en TIMESTAMPTZ,
  motivo_devolucion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_log_actas_compania ON flito_logistica_actas (compania_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_actas_estado ON flito_logistica_actas (estado);
CREATE INDEX IF NOT EXISTS idx_flito_log_actas_mensajero ON flito_logistica_actas (mensajero_id);

-- ── Documentos físicos individuales (RN-01). Congela organismo (origen) y compañía (destino). ──
CREATE TABLE IF NOT EXISTS flito_logistica_documentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id UUID NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  tipo flito_logistica_tipo_doc NOT NULL,
  estado flito_logistica_doc_estado NOT NULL DEFAULT 'generado',
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  compania_id INTEGER REFERENCES clients(id),
  compania_nit VARCHAR(30),
  vehiculo_id INTEGER NOT NULL REFERENCES vehicles(id),
  identificador VARCHAR(120),
  acta_id UUID REFERENCES flito_logistica_actas(id),
  motivo TEXT,
  flit_raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un documento físico por (trámite, tipo): la sincronización repetida no duplica registros (RN-06).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_doc_tramite_tipo ON flito_logistica_documentos (tramite_id, tipo);
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_estado ON flito_logistica_documentos (estado);
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_compania ON flito_logistica_documentos (compania_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_acta ON flito_logistica_documentos (acta_id);

-- ── Bitácora de transición por documento (CA-07: actor, hora, ubicación; RN-04 motivo; RN-07 GPS). ──
CREATE TABLE IF NOT EXISTS flito_logistica_documento_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id UUID NOT NULL REFERENCES flito_logistica_documentos(id) ON DELETE CASCADE,
  estado_anterior VARCHAR(20),
  estado_nuevo VARCHAR(20) NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  lat NUMERIC(10, 7),
  lng NUMERIC(10, 7),
  motivo TEXT,
  origen VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_log_eventos_documento ON flito_logistica_documento_eventos (documento_id, created_at DESC);
