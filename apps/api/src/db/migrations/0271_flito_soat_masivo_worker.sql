-- HU #14132 (Feature #14013, Épica #13760, ADR-0032) — carga masiva de SOAT sin trámite: el WORKER.
-- Sobre la 0270 (lotes y filas). Añade: avance y contadores congelados del lote, columnas de reclamo/reintento/
-- idempotencia de la fila, motivos RUNT del vocabulario de rechazo, y los índices del reclamo con SKIP LOCKED.
-- Idempotente: ADD COLUMN IF NOT EXISTS, CHECK con DROP previo, CREATE INDEX IF NOT EXISTS. Sin BEGIN/COMMIT
-- (el runner ya envuelve). Sin PII nueva: `vigente_hasta` es la fecha de vencimiento de un SOAT (dato del vehículo).

-- ───────────────────────────── Lote ─────────────────────────────
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS terminado_en timestamptz;
-- Último avance real del lote (una fila resuelta): lo lee el vigilante de lotes sin progreso (2 h).
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS ultimo_avance_en timestamptz NOT NULL DEFAULT now();
-- Contadores CONGELADOS: se escriben una sola vez, al terminar. Durante el avance se calculan con GROUP BY.
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS n_aceptadas smallint;
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS n_por_validar smallint;
ALTER TABLE flito_soat_masivo_lotes ADD COLUMN IF NOT EXISTS n_rechazadas smallint;

-- Saneo previo a los CHECK: un lote que A1 hubiera dejado `terminado` (sin worker no debería existir) se completa.
UPDATE flito_soat_masivo_lotes l SET
  terminado_en = COALESCE(l.terminado_en, l.creado_en),
  n_aceptadas = COALESCE(l.n_aceptadas, (SELECT count(*) FROM flito_soat_masivo_filas f WHERE f.lote_id = l.id AND f.estado = 'aceptada')),
  n_por_validar = COALESCE(l.n_por_validar, (SELECT count(*) FROM flito_soat_masivo_filas f WHERE f.lote_id = l.id AND f.estado = 'por_validar')),
  n_rechazadas = COALESCE(l.n_rechazadas, (SELECT count(*) FROM flito_soat_masivo_filas f WHERE f.lote_id = l.id AND f.estado = 'rechazada'))
WHERE l.estado = 'terminado';
UPDATE flito_soat_masivo_lotes SET iniciado_en = COALESCE(iniciado_en, creado_en) WHERE estado = 'procesando';

ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_terminado_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_terminado_chk
  CHECK ((estado = 'terminado') = (terminado_en IS NOT NULL));
ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_contadores_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_contadores_chk
  CHECK (
    (estado = 'terminado') = (n_aceptadas IS NOT NULL AND n_por_validar IS NOT NULL AND n_rechazadas IS NOT NULL)
    AND (n_aceptadas IS NULL OR (n_aceptadas >= 0 AND n_por_validar >= 0 AND n_rechazadas >= 0
         AND n_aceptadas + n_por_validar + n_rechazadas = total_filas))
  );
ALTER TABLE flito_soat_masivo_lotes DROP CONSTRAINT IF EXISTS flito_soat_masivo_lotes_iniciado_chk;
ALTER TABLE flito_soat_masivo_lotes ADD CONSTRAINT flito_soat_masivo_lotes_iniciado_chk
  CHECK (estado <> 'procesando' OR iniciado_en IS NOT NULL);

-- Lotes por terminar, por antigüedad del último avance (vigilante y cierre de lotes vacíos).
CREATE INDEX IF NOT EXISTS idx_flito_soat_masivo_lotes_por_terminar
  ON flito_soat_masivo_lotes (ultimo_avance_en) WHERE estado <> 'terminado';

-- ───────────────────────────── Fila ─────────────────────────────
-- `intentos` cuenta las caídas del RUNT (y los fallos transitorios); el 429 NO gasta intento.
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS intentos smallint NOT NULL DEFAULT 0;
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS proximo_intento_en timestamptz NOT NULL DEFAULT now();
-- Arrendamiento (lease): instante del reclamo; vencido a los 3 min, otro proceso recupera la fila.
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS reclamada_en timestamptz;
-- Fijado al reclamar y reutilizado al crear el SOAT o la incompleta: la repetición tras una caída no duplica.
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS soat_id_reservado uuid;
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS soat_id uuid REFERENCES flito_soat(id);
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS incompleta_id uuid REFERENCES flito_soat_incompletas(id);
-- Mismo vocabulario cerrado de `causaDeCaida` (timeout|red|circuito|otro); el 429 se mapea a `otro`.
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS ultima_causa varchar(10);
-- Solo para `soat_vigente`: hasta cuándo está vigente el SOAT (el texto del rechazo lo dice).
ALTER TABLE flito_soat_masivo_filas ADD COLUMN IF NOT EXISTS vigente_hasta date;

ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_intentos_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_intentos_chk CHECK (intentos BETWEEN 0 AND 3);
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_causa_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_causa_chk
  CHECK (ultima_causa IS NULL OR ultima_causa IN ('timeout','red','circuito','otro'));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_consultando_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_consultando_chk
  CHECK (estado <> 'consultando' OR (reclamada_en IS NOT NULL AND soat_id_reservado IS NOT NULL));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_aceptada_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_aceptada_chk
  CHECK ((estado = 'aceptada') = (soat_id IS NOT NULL));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_por_validar_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_por_validar_chk
  CHECK ((estado = 'por_validar') = (incompleta_id IS NOT NULL));
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_vigente_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_vigente_chk
  CHECK (vigente_hasta IS NULL OR motivo_rechazo = 'soat_vigente');

-- Se AMPLÍA el vocabulario de motivos (A1 + motivos RUNT + vigilante `no_procesada`).
ALTER TABLE flito_soat_masivo_filas DROP CONSTRAINT IF EXISTS flito_soat_masivo_filas_motivo_chk;
ALTER TABLE flito_soat_masivo_filas ADD CONSTRAINT flito_soat_masivo_filas_motivo_chk
  CHECK (motivo_rechazo IS NULL OR motivo_rechazo IN
    ('placa_invalida','documento_invalido','nombre_invalido','correo_invalido','celular_invalido','vin_invalido','fila_duplicada',
     'runt_no_cuadra','runt_sin_registro','runt_sin_vin','soat_vigente','sin_soat_anterior','solicitud_existente','no_procesada'));

-- Índices del reclamo: el parcial por `pendiente` sirve al SELECT ... FOR UPDATE SKIP LOCKED y el de `consultando`
-- a la recuperación de huérfanas por arrendamiento vencido.
CREATE INDEX IF NOT EXISTS idx_flito_soat_masivo_filas_claim
  ON flito_soat_masivo_filas (lote_id, proximo_intento_en, n_fila) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_flito_soat_masivo_filas_huerfanas
  ON flito_soat_masivo_filas (reclamada_en) WHERE estado = 'consultando';
-- Idempotencia del id reservado: una fila por id (y búsqueda al recuperar tras una caída).
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_masivo_filas_soat_reservado
  ON flito_soat_masivo_filas (soat_id_reservado) WHERE soat_id_reservado IS NOT NULL;
