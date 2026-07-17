-- Sprint 4 Fase 4.1 — Núcleo operacional RNDC: remesas + manifiestos + asociación.
-- Función fn_conductor_apto + bloqueo en INSERT de manifiestos.

DO $$ BEGIN
  CREATE TYPE remesa_estado AS ENUM ('borrador', 'activa', 'cumplida', 'anulada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE manifiesto_estado AS ENUM (
    'borrador', 'listo', 'radicado_rndc', 'aceptado', 'rechazado', 'cumplido', 'anulado'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE titular_pago_tipo AS ENUM ('propietario', 'conductor', 'empresa', 'tercero');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================
-- REMESAS
-- ===========================================================
CREATE TABLE IF NOT EXISTS remesas (
  id serial PRIMARY KEY,
  numero varchar(30) NOT NULL UNIQUE,
  consecutivo_rndc varchar(30),
  cliente_id integer REFERENCES clients(id),
  propietario_carga_id integer REFERENCES propietarios_carga(id),
  destinatario_carga_id integer REFERENCES destinatarios_carga(id),
  municipio_origen_dane varchar(5) NOT NULL REFERENCES rndc_municipios(codigo_dane),
  municipio_destino_dane varchar(5) NOT NULL REFERENCES rndc_municipios(codigo_dane),
  direccion_cargue varchar(300),
  direccion_descargue varchar(300),
  producto_codigo varchar(10) REFERENCES rndc_productos_transportar(codigo),
  naturaleza naturaleza_carga NOT NULL DEFAULT 'carga_normal',
  empaque_codigo varchar(10) REFERENCES rndc_empaques(codigo),
  unidad_medida_codigo varchar(10) REFERENCES rndc_unidades_medida(codigo),
  cantidad_cargada numeric(14, 3) NOT NULL,
  cantidad_entregada numeric(14, 3),
  peso_kg numeric(14, 3),
  fecha_cargue date NOT NULL,
  hora_cargue time,
  fecha_descargue_pactada date,
  valor_flete numeric(15, 2) NOT NULL DEFAULT 0,
  valor_anticipo numeric(15, 2) NOT NULL DEFAULT 0,
  moneda moneda_rndc NOT NULL DEFAULT 'COP',
  modo_pago_codigo varchar(10) REFERENCES rndc_modos_pago(codigo),
  estado remesa_estado NOT NULL DEFAULT 'borrador',
  manifiesto_id integer,
  cumplido_at timestamptz,
  cumplido_observaciones text,
  cumplido_evidencia_keys text[] NOT NULL DEFAULT '{}'::text[],
  observaciones text,
  deleted_at timestamptz,
  deleted_by integer REFERENCES users(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_remesa_cantidades CHECK (
    cantidad_entregada IS NULL OR cantidad_entregada <= cantidad_cargada
  ),
  CONSTRAINT chk_remesa_anticipo CHECK (valor_anticipo <= valor_flete),
  CONSTRAINT chk_remesa_consecutivo CHECK (consecutivo_rndc IS NULL OR length(consecutivo_rndc) > 0)
);

CREATE INDEX IF NOT EXISTS idx_remesas_estado ON remesas(estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_remesas_cliente ON remesas(cliente_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_remesas_manifiesto ON remesas(manifiesto_id);
CREATE INDEX IF NOT EXISTS idx_remesas_fecha ON remesas(fecha_cargue DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_remesas_consecutivo_rndc
  ON remesas(consecutivo_rndc) WHERE consecutivo_rndc IS NOT NULL;

-- ===========================================================
-- MANIFIESTOS
-- ===========================================================
CREATE TABLE IF NOT EXISTS manifiestos (
  id serial PRIMARY KEY,
  numero varchar(30) NOT NULL UNIQUE,
  consecutivo_rndc varchar(30),
  vehiculo_principal_id integer NOT NULL REFERENCES vehicles(id),
  vehiculo_remolque_id integer REFERENCES vehicles(id),
  conductor_id integer NOT NULL REFERENCES users(id),
  tenedor_id integer REFERENCES tenedores(id),
  municipio_origen_dane varchar(5) NOT NULL REFERENCES rndc_municipios(codigo_dane),
  municipio_destino_dane varchar(5) NOT NULL REFERENCES rndc_municipios(codigo_dane),
  fecha_expedicion date NOT NULL,
  fecha_pactada_pago date,
  valor_flete_total numeric(15, 2) NOT NULL DEFAULT 0,
  valor_anticipo numeric(15, 2) NOT NULL DEFAULT 0,
  retencion_fuente numeric(15, 2) NOT NULL DEFAULT 0,
  retencion_ica numeric(15, 2) NOT NULL DEFAULT 0,
  titular_pago_tipo titular_pago_tipo NOT NULL DEFAULT 'conductor',
  titular_pago_doc varchar(20),
  titular_pago_nombre varchar(200),
  titular_pago_cuenta varchar(40),
  observaciones text,
  qr_token varchar(64) UNIQUE,
  estado manifiesto_estado NOT NULL DEFAULT 'borrador',
  rechazo_motivo text,
  anulado_motivo text,
  anulado_por integer REFERENCES users(id),
  anulado_at timestamptz,
  radicado_at timestamptz,
  aceptado_at timestamptz,
  cumplido_at timestamptz,
  deleted_at timestamptz,
  deleted_by integer REFERENCES users(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_manifiesto_anticipo CHECK (valor_anticipo <= valor_flete_total)
);

CREATE INDEX IF NOT EXISTS idx_manifiestos_estado ON manifiestos(estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_manifiestos_vehiculo ON manifiestos(vehiculo_principal_id);
CREATE INDEX IF NOT EXISTS idx_manifiestos_conductor ON manifiestos(conductor_id);
CREATE INDEX IF NOT EXISTS idx_manifiestos_fecha ON manifiestos(fecha_expedicion DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manifiestos_consecutivo_rndc
  ON manifiestos(consecutivo_rndc) WHERE consecutivo_rndc IS NOT NULL;

-- FK diferida desde remesas (no se pudo crear inline porque manifiestos no existía aún).
ALTER TABLE remesas
  ADD CONSTRAINT fk_remesas_manifiesto
  FOREIGN KEY (manifiesto_id) REFERENCES manifiestos(id) ON DELETE SET NULL;

-- ===========================================================
-- M:N MANIFIESTO - REMESAS
-- ===========================================================
CREATE TABLE IF NOT EXISTS manifiesto_remesas (
  manifiesto_id integer NOT NULL REFERENCES manifiestos(id) ON DELETE CASCADE,
  remesa_id integer NOT NULL REFERENCES remesas(id) ON DELETE RESTRICT,
  orden integer NOT NULL DEFAULT 1,
  PRIMARY KEY (manifiesto_id, remesa_id),
  CONSTRAINT uq_manifiesto_remesa_orden UNIQUE (manifiesto_id, orden)
);

CREATE INDEX IF NOT EXISTS idx_manifiesto_remesas_remesa ON manifiesto_remesas(remesa_id);

-- ===========================================================
-- FUNCIÓN: ¿conductor apto para manifiesto?
-- Reglas: es_conductor=true, no suspendido por alcohol, último checklist no anulado del par
-- (vehiculo, conductor) NO es 'no_apto' (si existe).
-- ===========================================================
CREATE OR REPLACE FUNCTION fn_conductor_apto(p_user_id integer, p_vehicle_id integer)
RETURNS boolean AS $$
DECLARE
  v_es_conductor boolean;
  v_suspendido boolean;
  v_ultimo_decision text;
BEGIN
  SELECT u.es_conductor INTO v_es_conductor FROM users u WHERE u.id = p_user_id;
  IF v_es_conductor IS NULL OR v_es_conductor = false THEN RETURN false; END IF;

  SELECT COALESCE(dp.suspendido_por_alcohol, false) INTO v_suspendido
    FROM driver_profile dp WHERE dp.user_id = p_user_id;
  IF v_suspendido = true THEN RETURN false; END IF;

  -- Si hay un checklist NO anulado del par (vehiculo, conductor) y es no_apto → bloquea.
  SELECT c.decision::text INTO v_ultimo_decision
    FROM checklists c
    WHERE c.vehicle_id = p_vehicle_id
      AND c.conductor_id = p_user_id
      AND c.anulado_at IS NULL
    ORDER BY c.fecha_hora DESC
    LIMIT 1;

  IF v_ultimo_decision = 'no_apto' THEN RETURN false; END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

-- ===========================================================
-- TRIGGER: bloquea INSERT de manifiestos si conductor no apto.
-- Aplica solo a insert/update directo. UI valida antes y muestra detalle al usuario.
-- ===========================================================
CREATE OR REPLACE FUNCTION fn_validar_manifiesto_conductor()
RETURNS trigger AS $$
BEGIN
  IF NOT fn_conductor_apto(NEW.conductor_id, NEW.vehiculo_principal_id) THEN
    RAISE EXCEPTION 'Conductor % no es apto para vehículo % (suspendido o último checklist no_apto)',
      NEW.conductor_id, NEW.vehiculo_principal_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_manifiestos_conductor_apto ON manifiestos;
CREATE TRIGGER trg_manifiestos_conductor_apto
  BEFORE INSERT OR UPDATE OF conductor_id, vehiculo_principal_id ON manifiestos
  FOR EACH ROW
  WHEN (NEW.estado IN ('borrador', 'listo'))
  EXECUTE FUNCTION fn_validar_manifiesto_conductor();

-- ===========================================================
-- TRIGGER: actualiza updated_at automáticamente
-- ===========================================================
CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_remesas_touch ON remesas;
CREATE TRIGGER trg_remesas_touch BEFORE UPDATE ON remesas
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_manifiestos_touch ON manifiestos;
CREATE TRIGGER trg_manifiestos_touch BEFORE UPDATE ON manifiestos
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON
  remesas, manifiestos, manifiesto_remesas
  TO operaciones_app;

GRANT USAGE, SELECT ON SEQUENCE
  remesas_id_seq, manifiestos_id_seq
  TO operaciones_app;

GRANT EXECUTE ON FUNCTION fn_conductor_apto(integer, integer) TO operaciones_app;
