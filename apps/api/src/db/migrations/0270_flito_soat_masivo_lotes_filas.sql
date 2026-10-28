-- HU #14131 (Feature #14013, Épica #13760, ADR-0032) — carga masiva de SOAT sin trámite: lotes y filas.
-- A1: solo el alta. Las columnas del worker (0271) y de la purga de PII (0272) llegan después.
-- Idempotente: CREATE ... IF NOT EXISTS y CHECK con DROP previo. Sin BEGIN/COMMIT (el runner ya envuelve).
-- PII de las filas EFÍMERA: se anonimiza al terminar el lote y se purga (HU siguientes). No se guarda el Excel.

CREATE TABLE IF NOT EXISTS flito_soat_masivo_lotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id integer NOT NULL REFERENCES clients(id),
  creado_por_id integer REFERENCES users(id),
  creado_por_nombre varchar(150) NOT NULL,
  tipo_soat varchar(10) NOT NULL,
  estado varchar(12) NOT NULL DEFAULT 'en_cola',
  total_filas smallint NOT NULL,
  archivo_hash varchar(64) NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_tipo_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_tipo_chk
  CHECK (tipo_soat IN ('renovacion','inicial'));
ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_estado_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_estado_chk
  CHECK (estado IN ('en_cola','procesando','terminado'));
ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_total_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_total_chk
  CHECK (total_filas BETWEEN 1 AND 200);

-- Un lote activo por compañía: la inserción concurrente pierde con 23505 (la API responde 409).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_masivo_lote_activo
  ON flito_soat_masivo_lotes (compania_id) WHERE estado IN ('en_cola','procesando');
CREATE INDEX IF NOT EXISTS idx_flito_soat_masivo_lotes_compania_creado
  ON flito_soat_masivo_lotes (compania_id, creado_en DESC);

CREATE TABLE IF NOT EXISTS flito_soat_masivo_filas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id uuid NOT NULL REFERENCES flito_soat_masivo_lotes(id) ON DELETE CASCADE,
  n_fila smallint NOT NULL,
  estado varchar(12) NOT NULL,
  motivo_rechazo varchar(30),
  placa varchar(10),
  documento varchar(30),
  nombre varchar(150),
  correo varchar(150),
  celular varchar(20),
  vin varchar(17)
);

-- Documento hasta 30 (mismo tope que el alta individual); idempotente también sobre una BD que ya tenía varchar(20).
ALTER TABLE flito_soat_masivo_filas ALTER COLUMN documento TYPE varchar(30);

ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_estado_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_estado_chk
  CHECK (estado IN ('pendiente','consultando','aceptada','por_validar','rechazada'));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_motivo_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_motivo_chk
  CHECK (motivo_rechazo IS NULL OR motivo_rechazo IN
    ('placa_invalida','documento_invalido','nombre_invalido','correo_invalido','celular_invalido','vin_invalido','fila_duplicada'));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_rechazo_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_rechazo_chk
  CHECK ((estado = 'rechazada') = (motivo_rechazo IS NOT NULL));
-- Una fila pendiente o en consulta no puede nacer sin los datos de su tipo (placa+documento o vin).
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_pii_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_pii_chk
  CHECK (estado NOT IN ('pendiente','consultando') OR (placa IS NOT NULL AND documento IS NOT NULL) OR vin IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_masivo_filas_lote_fila
  ON flito_soat_masivo_filas (lote_id, n_fila);
CREATE INDEX IF NOT EXISTS idx_flito_soat_masivo_filas_lote
  ON flito_soat_masivo_filas (lote_id, estado);
