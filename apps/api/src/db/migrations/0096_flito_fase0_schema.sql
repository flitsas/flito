-- FLITO (migración packages/ → Operaciones) — Fase 0: esquema del dominio SOAT/Impuestos.
-- Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §5. Sin control de transacción propio
-- (ADR-DB-001: el runner envuelve el archivo en sql.begin()).
--
-- Convenciones: entidades internas FLITO usan uuid; FK a clients/vehicles/users son
-- integer; FK a organismos_transito_config son varchar(5) (su PK `codigo`, DIVIPOLA).
-- La MODALIDAD del organismo vive en flito_organismo_vigencias (CA-04), no como columna.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE flito_soat_estado AS ENUM ('pendiente', 'en_adquisicion', 'pagado', 'rechazado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_impuesto_estado AS ENUM ('sin_factura', 'retenido', 'pendiente', 'en_gestion', 'pagado', 'rechazado', 'no_aplica');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_tramite_estado AS ENUM ('asignado', 'entregado', 'aprobado', 'anulado', 'rechazado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_modalidad_organismo AS ENUM ('sin_clasificar', 'requiere_gestion', 'autogestionado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Extensiones a tablas existentes ─────────────────────────────────────────
-- Parametrización por compañía (D-8: se extiende `clients`, no se crea `compania`).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS soat_autogestionable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS impuestos_autogestionable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logistica_autogestionable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS flito_carpeta_storage VARCHAR(300);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS flito_tolerancia_valor_impuesto NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Umbral OCR y SLA por organismo (§6.2 Impuestos).
ALTER TABLE organismos_transito_config ADD COLUMN IF NOT EXISTS flito_umbral_ocr NUMERIC(4,3);
ALTER TABLE organismos_transito_config ADD COLUMN IF NOT EXISTS flito_sla_horas INTEGER;

-- ── Proveedores SOAT (antes de la FK en users) ──────────────────────────────
CREATE TABLE IF NOT EXISTS flito_proveedores_soat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(150) NOT NULL UNIQUE,
  estrategia VARCHAR(40) NOT NULL DEFAULT 'portal',
  umbral_ocr NUMERIC(4,3),
  sla_horas INTEGER,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Atadura de visibilidad del gestor SOAT (rol `proveedor`) → CA-09. El gestor de
-- impuestos (rol `gestor_impuestos`) reutiliza users.transito_codigo como organismo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS flito_proveedor_soat_id UUID REFERENCES flito_proveedores_soat(id);

-- ── Vigencias de modalidad del organismo (CA-04) ────────────────────────────
CREATE TABLE IF NOT EXISTS flito_organismo_vigencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  modalidad flito_modalidad_organismo NOT NULL,
  desde TIMESTAMPTZ NOT NULL,
  hasta TIMESTAMPTZ,
  motivo TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  actor_nombre VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_vig_organismo ON flito_organismo_vigencias (organismo_codigo);
-- CA-04: a lo sumo UNA vigencia vigente (hasta IS NULL) por organismo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_vig_vigente ON flito_organismo_vigencias (organismo_codigo) WHERE hasta IS NULL;

-- ── SOAT anclado al VIN (RN-01: vin UNIQUE) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_soat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vin VARCHAR(17) NOT NULL UNIQUE,
  vehiculo_id INTEGER NOT NULL UNIQUE REFERENCES vehicles(id),
  estado flito_soat_estado NOT NULL DEFAULT 'pendiente',
  compania_id INTEGER NOT NULL REFERENCES clients(id),
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  proveedor_soat_id UUID REFERENCES flito_proveedores_soat(id),
  proveedor_sobrescrito BOOLEAN NOT NULL DEFAULT false,
  enviado_por_id INTEGER REFERENCES users(id),
  enviado_en TIMESTAMPTZ,
  pagado_en TIMESTAMPTZ,
  valor_pagado NUMERIC(14,2),
  motivo_rechazo TEXT,
  extraccion JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_soat_estado ON flito_soat (estado);
CREATE INDEX IF NOT EXISTS idx_flito_soat_proveedor ON flito_soat (proveedor_soat_id);

-- ── Trámite sincronizado desde FLIT (coexiste con tramites_digitales) ────────
CREATE TABLE IF NOT EXISTS flito_tramites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_flit VARCHAR(60) NOT NULL UNIQUE,
  estado flito_tramite_estado NOT NULL,
  tipo_propiedad VARCHAR(30) NOT NULL,
  compania_id INTEGER NOT NULL REFERENCES clients(id),
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  vehiculo_id INTEGER NOT NULL REFERENCES vehicles(id),
  soat_id UUID REFERENCES flito_soat(id),
  valor_impuesto_liquidado NUMERIC(14,2),
  process_status INTEGER NOT NULL,
  plate_complete VARCHAR(20),
  sincronizado_en TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_tramites_estado ON flito_tramites (estado);

-- ── Impuesto, uno por trámite (tramite_id UNIQUE) ───────────────────────────
CREATE TABLE IF NOT EXISTS flito_impuestos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id UUID NOT NULL UNIQUE REFERENCES flito_tramites(id),
  estado flito_impuesto_estado NOT NULL DEFAULT 'sin_factura',
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  compania_id INTEGER NOT NULL REFERENCES clients(id),
  modalidad_aplicada flito_modalidad_organismo NOT NULL,
  valor_liquidado NUMERIC(14,2),
  valor_pagado NUMERIC(14,2),
  marcado_por_diferencia BOOLEAN NOT NULL DEFAULT false,
  factura_venta_soporte_id UUID,
  extraccion_factura_venta JSONB,
  enviado_por_id INTEGER REFERENCES users(id),
  enviado_en TIMESTAMPTZ,
  pagado_en TIMESTAMPTZ,
  motivo_rechazo TEXT,
  extraccion JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_impuestos_estado ON flito_impuestos (estado);
CREATE INDEX IF NOT EXISTS idx_flito_impuestos_organismo ON flito_impuestos (organismo_codigo);

-- ── Compradores (múltiple propietario → varias filas) ───────────────────────
CREATE TABLE IF NOT EXISTS flito_compradores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id UUID NOT NULL REFERENCES flito_tramites(id) ON DELETE CASCADE,
  nombre_completo VARCHAR(200) NOT NULL,
  numero_documento VARCHAR(30) NOT NULL,
  correo VARCHAR(150),
  celular VARCHAR(30),
  direccion VARCHAR(300),
  orden INTEGER NOT NULL DEFAULT 0,
  porcentaje_participacion NUMERIC(5,2)
);
CREATE INDEX IF NOT EXISTS idx_flito_compradores_tramite ON flito_compradores (tramite_id);

-- ── Soportes en S3 (storage_key sustituye driveItemId+ruta; hash indexado CA-08) ─
CREATE TABLE IF NOT EXISTS flito_soportes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo VARCHAR(40) NOT NULL,
  nombre_archivo VARCHAR(300) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  tamano_bytes BIGINT NOT NULL,
  soat_id UUID REFERENCES flito_soat(id) ON DELETE CASCADE,
  impuesto_id UUID REFERENCES flito_impuestos(id) ON DELETE CASCADE,
  subido_por_id INTEGER REFERENCES users(id),
  subido_por_nombre VARCHAR(150) NOT NULL,
  subido_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_soportes_hash ON flito_soportes (hash);

-- ── Cola de revisión OCR (CA-06/CA-07) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_revisiones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  modulo VARCHAR(20) NOT NULL,
  motivo VARCHAR(40) NOT NULL,
  detalle TEXT NOT NULL,
  registro_id UUID,
  soporte_id UUID NOT NULL REFERENCES flito_soportes(id) ON DELETE CASCADE,
  placa_sugerida VARCHAR(10),
  extraccion JSONB NOT NULL,
  resuelto BOOLEAN NOT NULL DEFAULT false,
  resuelto_por_id INTEGER REFERENCES users(id),
  resuelto_en TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flito_revisiones_resuelto ON flito_revisiones (resuelto);

-- ── Reglas de proveedor SOAT por ámbito ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_reglas_proveedor_soat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ambito VARCHAR(20) NOT NULL,
  compania_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  organismo_codigo VARCHAR(5) REFERENCES organismos_transito_config(codigo) ON DELETE CASCADE,
  proveedor_soat_id UUID NOT NULL REFERENCES flito_proveedores_soat(id) ON DELETE CASCADE,
  prioridad INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Andamiaje FLIT simulado (llaves externas, sin FK; se retira con FLIT real) ─
CREATE TABLE IF NOT EXISTS flito_mock_tramite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_flit VARCHAR(60) NOT NULL UNIQUE,
  process_status INTEGER NOT NULL,
  plate_complete VARCHAR(20),
  vin VARCHAR(17) NOT NULL,
  placa VARCHAR(10) NOT NULL,
  marca VARCHAR(60) NOT NULL,
  linea VARCHAR(80) NOT NULL,
  cilindraje INTEGER NOT NULL,
  capacidad INTEGER NOT NULL,
  tipo_vehiculo VARCHAR(40) NOT NULL,
  compania_nit VARCHAR(20) NOT NULL,
  organismo_codigo VARCHAR(10) NOT NULL,
  tipo_propiedad VARCHAR(30) NOT NULL,
  compradores JSONB NOT NULL,
  valor_impuesto_liquidado NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
