-- 0271_flito_logistica_traslados.sql
-- HU #14109 (Feature #14091, Epica #13758) — ADR-0030: traslados, lineas por LT, motivos de llegada,
-- lineas y firmas de acta; `punto` en el acta; indicador `acta_organismo_pendiente`.
-- ENMIENDA 2026-10-28 (ADR-0030 §17, ninguna HU de la Epica en develop => se enmienda en su lugar):
--   · acta por COMPANIA en los tres puntos (`compania_id` NOT NULL siempre; sin acta multi-compania);
--   · fila propia del firmante del organismo (`flito_logistica_recogida_firmantes`), compartida por las actas de
--     una recogida via `actas.firmante_id`;
--   · LT por vehiculo: `documentos.tramite_id` NULLABLE (LT pendiente de tramite) + `recogida_firmante_id`.
-- Una BD que ya aplico la 0271 ANTERIOR (compania_id NULLABLE + ck_flito_log_actas_compania_punto) se SANA al
-- correr este archivo a mano con psql (el runner no lo reaplica: calcula por nombre); falla si hay actas sin compania.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner envuelve el archivo). Idempotente: la segunda pasada no
-- cambia NI UNA FILA. El valor `en_flit` del enum esta en la 0270 y NO se usa aqui.
--
-- Las columnas viejas del acta (receptor_*, firma_*, contacto_documento) NO se tocan: receptor_documento
-- sigue en claro hasta la HU de cifrado del historico (#14112).
-- PII: la cedula de los firmantes va CIFRADA (documento_cifrado) + documento_ultimos; nunca en claro.

-- ---------------------------------------------------------------------------
-- 1. Motivos de llegada a FLIT (catalogo)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_motivos_llegada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(120) NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_por_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_motivos_llegada_nombre ON flito_logistica_motivos_llegada (lower(nombre));
CREATE INDEX IF NOT EXISTS idx_flito_log_motivos_llegada_orden ON flito_logistica_motivos_llegada (activo, orden);

INSERT INTO flito_logistica_motivos_llegada (nombre, orden) VALUES
  ('Sin dirección de entrega al recoger', 10),
  ('Destino lejano (transportadora externa)', 20),
  ('Otro', 30)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Traslados (un viaje de LT de UNA compania)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_traslados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  destino VARCHAR(10) NOT NULL,
  origen VARCHAR(10) NOT NULL,
  estado VARCHAR(12) NOT NULL DEFAULT 'registrado',
  mensajero_id INTEGER REFERENCES users(id),
  registrado_por_id INTEGER REFERENCES users(id),
  registrado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  legado BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_flito_log_traslados_destino CHECK (destino IN ('flit','cliente')),
  CONSTRAINT ck_flito_log_traslados_origen CHECK (origen IN ('organismo','flit')),
  CONSTRAINT ck_flito_log_traslados_estado CHECK (estado IN ('registrado','en_ruta','entregado','devuelto','anulado')),
  CONSTRAINT ck_flito_log_traslados_ruta CHECK (destino <> 'flit' OR origen = 'organismo')
);
CREATE INDEX IF NOT EXISTS idx_flito_log_traslados_compania ON flito_logistica_traslados (compania_id, estado);
CREATE INDEX IF NOT EXISTS idx_flito_log_traslados_mensajero ON flito_logistica_traslados (mensajero_id);
-- Soporta la FK compuesta de las lineas (traslado_id, destino).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_traslados_id_destino ON flito_logistica_traslados (id, destino);

-- ---------------------------------------------------------------------------
-- 3. Lineas por LT (precio congelado al registrar)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_traslado_lts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  traslado_id UUID NOT NULL,
  destino VARCHAR(10) NOT NULL,
  documento_id UUID NOT NULL REFERENCES flito_logistica_documentos(id) ON DELETE RESTRICT,
  estado VARCHAR(12) NOT NULL DEFAULT 'registrado',
  concepto_precio VARCHAR(20),
  precio NUMERIC(14,2),
  tarifa_vigencia_id UUID REFERENCES flito_tarifas_vigencias(id) ON DELETE RESTRICT,
  motivo_llegada_id UUID REFERENCES flito_logistica_motivos_llegada(id) ON DELETE RESTRICT,
  motivo_nota VARCHAR(300),
  motivo_por_id INTEGER REFERENCES users(id),
  motivo_en TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_flito_log_traslado_lts_traslado_destino FOREIGN KEY (traslado_id, destino)
    REFERENCES flito_logistica_traslados (id, destino),
  CONSTRAINT ck_flito_log_traslado_lts_destino CHECK (destino IN ('flit','cliente')),
  CONSTRAINT ck_flito_log_traslado_lts_estado CHECK (estado IN ('registrado','en_ruta','entregado','devuelto','anulado')),
  CONSTRAINT ck_flito_log_traslado_lts_precio CHECK (precio IS NULL OR precio >= 0),
  CONSTRAINT ck_flito_log_traslado_lts_precio_legado CHECK (precio IS NOT NULL OR concepto_precio = 'legado'),
  CONSTRAINT ck_flito_log_traslado_lts_motivo CHECK (destino <> 'flit' OR motivo_llegada_id IS NOT NULL)
);
-- Una LT, un viaje VIVO por destino (red de la BD ante carreras). Excluye devuelto/anulado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_traslado_lt_vivo ON flito_logistica_traslado_lts (documento_id, destino)
  WHERE estado NOT IN ('devuelto','anulado');
CREATE INDEX IF NOT EXISTS idx_flito_log_traslado_lts_traslado ON flito_logistica_traslado_lts (traslado_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_traslado_lts_motivo ON flito_logistica_traslado_lts (motivo_llegada_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_traslado_lts_documento ON flito_logistica_traslado_lts (documento_id);

-- ---------------------------------------------------------------------------
-- 4a. Firmante del organismo (UNA firma por recogida, compartida por las actas de las companias de esa recogida).
--     PII: cedula CIFRADA con AAD = `id` (lo genera la app, NO hay DEFAULT: el id se necesita ANTES de cifrar).
--     `documento_cifrado` es NULL tras la purga a 10 anios; el nombre y la firma se conservan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_recogida_firmantes (
  id UUID PRIMARY KEY,
  organismo_codigo VARCHAR(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  nombre VARCHAR(150) NOT NULL,
  documento_cifrado TEXT,
  documento_ultimos VARCHAR(4),
  firma_storage_key VARCHAR(400) NOT NULL,
  registrado_por_id INTEGER NOT NULL REFERENCES users(id),
  firmado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  CONSTRAINT ck_flito_log_recogida_firmantes_ultimos CHECK (documento_ultimos IS NULL OR char_length(documento_ultimos) <= 4)
);
CREATE INDEX IF NOT EXISTS idx_flito_log_recogida_firmantes_registrado ON flito_logistica_recogida_firmantes (registrado_por_id, firmado_en DESC);
CREATE INDEX IF NOT EXISTS idx_flito_log_recogida_firmantes_organismo ON flito_logistica_recogida_firmantes (organismo_codigo);

-- ---------------------------------------------------------------------------
-- 4. Extensiones del acta: `punto`, organismo, traslado, firmante; `compania_id` NOT NULL en todos los puntos
-- ---------------------------------------------------------------------------
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS punto VARCHAR(10) NOT NULL DEFAULT 'cliente';
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS organismo_codigo VARCHAR(5) REFERENCES organismos_transito_config(codigo);
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS traslado_id UUID REFERENCES flito_logistica_traslados(id);
ALTER TABLE flito_logistica_actas ADD COLUMN IF NOT EXISTS firmante_id UUID REFERENCES flito_logistica_recogida_firmantes(id);
-- Sana la forma anterior de la 0271 (CHECK de acta de organismo sin compania + NULLABLE). No-op en BD limpia.
ALTER TABLE flito_logistica_actas DROP CONSTRAINT IF EXISTS ck_flito_log_actas_compania_punto;
ALTER TABLE flito_logistica_actas ALTER COLUMN compania_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_log_actas_punto') THEN
    ALTER TABLE flito_logistica_actas
      ADD CONSTRAINT ck_flito_log_actas_punto CHECK (punto IN ('organismo','flit','cliente'));
  END IF;
  -- El acta de organismo siempre referencia al firmante de la recogida.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_log_actas_firmante_punto') THEN
    ALTER TABLE flito_logistica_actas
      ADD CONSTRAINT ck_flito_log_actas_firmante_punto CHECK (punto <> 'organismo' OR firmante_id IS NOT NULL);
  END IF;
END
$$;
-- Una acta de organismo por compania y recogida (idempotencia en BD).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_actas_firmante_compania ON flito_logistica_actas (firmante_id, compania_id)
  WHERE punto = 'organismo';
CREATE INDEX IF NOT EXISTS idx_flito_log_actas_firmante ON flito_logistica_actas (firmante_id);
CREATE INDEX IF NOT EXISTS idx_flito_log_actas_traslado ON flito_logistica_actas (traslado_id);

-- ---------------------------------------------------------------------------
-- 4b. Documentos: la LT pertenece a un VEHICULO; el tramite puede estar pendiente (ADR-0030 §17.2).
--     `tramite_id` NULLABLE (= LT pendiente de tramite; ortogonal al estado, sin valor nuevo en el enum).
--     `compania_id` de documentos ya era NULLABLE desde la 0102: no cambia. Una pendiente no tiene compania.
-- ---------------------------------------------------------------------------
ALTER TABLE flito_logistica_documentos ALTER COLUMN tramite_id DROP NOT NULL;
ALTER TABLE flito_logistica_documentos ADD COLUMN IF NOT EXISTS recogida_firmante_id UUID REFERENCES flito_logistica_recogida_firmantes(id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_log_doc_tramite_compania') THEN
    ALTER TABLE flito_logistica_documentos
      ADD CONSTRAINT ck_flito_log_doc_tramite_compania CHECK (tramite_id IS NOT NULL OR compania_id IS NULL);
  END IF;
END
$$;
-- No hay dos LT pendientes del mismo vehiculo (con tramite, la unicidad la da uq_flito_log_doc_tramite_tipo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_doc_vehiculo_pendiente ON flito_logistica_documentos (vehiculo_id, tipo)
  WHERE tramite_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_flito_log_doc_recogida_firmante ON flito_logistica_documentos (recogida_firmante_id);

-- ---------------------------------------------------------------------------
-- 5. Lineas del acta (LT por acta y por punto)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_acta_lineas (
  acta_id UUID NOT NULL REFERENCES flito_logistica_actas(id) ON DELETE CASCADE,
  documento_id UUID NOT NULL REFERENCES flito_logistica_documentos(id) ON DELETE RESTRICT,
  punto VARCHAR(10) NOT NULL,
  traslado_lt_id UUID REFERENCES flito_logistica_traslado_lts(id),
  compania_id INTEGER REFERENCES clients(id),
  PRIMARY KEY (acta_id, documento_id),
  CONSTRAINT ck_flito_log_acta_lineas_punto CHECK (punto IN ('organismo','flit','cliente'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_acta_linea_organismo ON flito_logistica_acta_lineas (documento_id)
  WHERE punto = 'organismo';
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_log_acta_linea_traslado_lt ON flito_logistica_acta_lineas (traslado_lt_id)
  WHERE traslado_lt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_log_acta_lineas_documento ON flito_logistica_acta_lineas (documento_id);

-- ---------------------------------------------------------------------------
-- 6. Firmas del acta de FLIT y de cliente (cedula CIFRADA; la del organismo vive en recogida_firmantes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flito_logistica_acta_firmas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acta_id UUID NOT NULL REFERENCES flito_logistica_actas(id) ON DELETE CASCADE,
  rol VARCHAR(10) NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  documento_cifrado TEXT,
  documento_ultimos VARCHAR(4),
  firma_storage_key VARCHAR(400) NOT NULL,
  usuario_id INTEGER REFERENCES users(id),
  firmado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  CONSTRAINT uq_flito_log_acta_firmas_acta_rol UNIQUE (acta_id, rol),
  CONSTRAINT ck_flito_log_acta_firmas_rol CHECK (rol IN ('entrega','recibe')),
  CONSTRAINT ck_flito_log_acta_firmas_ultimos CHECK (documento_ultimos IS NULL OR char_length(documento_ultimos) <= 4)
);

-- ---------------------------------------------------------------------------
-- 7. Eventos del documento: columnas para eventos de traslado/acta (payload: solo ids/codigos, sin PII)
-- ---------------------------------------------------------------------------
ALTER TABLE flito_logistica_documento_eventos ADD COLUMN IF NOT EXISTS tipo VARCHAR(30);
ALTER TABLE flito_logistica_documento_eventos ADD COLUMN IF NOT EXISTS traslado_id UUID REFERENCES flito_logistica_traslados(id);
ALTER TABLE flito_logistica_documento_eventos ADD COLUMN IF NOT EXISTS acta_id UUID REFERENCES flito_logistica_actas(id);
ALTER TABLE flito_logistica_documento_eventos ADD COLUMN IF NOT EXISTS destino VARCHAR(10);
ALTER TABLE flito_logistica_documento_eventos ADD COLUMN IF NOT EXISTS payload JSONB;

-- ---------------------------------------------------------------------------
-- 8. Indicador `acta_organismo_pendiente` (indicador, NO bloqueo)
--    Backfill UNICO: solo en el instante en que la columna nace. En ese momento las LT YA ENTREGADAS quedan en
--    FALSE (no se pide acta retroactiva de algo entregado) y el resto en TRUE (DEFAULT). Dentro del bloque
--    condicional una segunda corrida no vuelve a tocar datos (si no, pisaria LT entregadas despues con pendiente real).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'flito_logistica_documentos'
      AND column_name = 'acta_organismo_pendiente'
  ) THEN
    ALTER TABLE flito_logistica_documentos ADD COLUMN acta_organismo_pendiente BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE flito_logistica_documentos SET acta_organismo_pendiente = FALSE WHERE estado = 'entregado';
  END IF;
END
$$;
