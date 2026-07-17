-- F2 LAFT — KYC empleados + cifrado PII de contrapartes
-- (Resolución UIAF 122/2021 + Circular SuperTransporte 4607/2026)
--
-- Esta migración:
--   1. Crea `laft_employees_kyc` para revisar empleados (factores, antecedentes,
--      match contra listas restrictivas, reKYC anual) — paralelo al patrón ya
--      existente de `laft_counterparties`.
--   2. Extiende `laft_counterparties` con columnas *_enc (CipherBundle JSONB)
--      + doc_number_hash (HMAC) para cifrar PII.
--
-- IMPORTANTE: NO se dropean las columnas `doc_number`, `email`, `phone` en
-- claro en este paso. La migración de datos vive en
-- `apps/api/src/scripts/laft-encrypt-pii-backfill.ts` (idempotente). Una vez
-- validado el backfill en producción se hará una migración 0064 de drop.
--
-- Concurrencia con F1 (otra agente): F1 usa la 0062. No tocamos sus tablas.

BEGIN;

-- ============================================================================
-- 1. laft_employees_kyc
-- ============================================================================

CREATE TABLE IF NOT EXISTS laft_employees_kyc (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Tres factores principales (paralelo a counterparties pero ajustados a empleado).
  -- JSONB para que la UI pueda capturar evidencia/observaciones por factor sin
  -- migrar nuevas columnas cada vez (ej: {value:2, reason:'ocupación previa de riesgo'}).
  factor_persona JSONB,                 -- doc tipo, edad, ocupación previa
  factor_canal JSONB,                   -- modalidad de contratación (planta/temporal/...)
  factor_zona JSONB,                    -- ciudades de residencia/trabajo

  -- Antecedentes: snapshot de las consultas Procuraduría/Policía/Contraloría.
  antecedentes_check_at TIMESTAMPTZ,
  antecedentes_resultado JSONB,         -- {procuraduria:'limpio', policia:'limpio', contraloria:'limpio'}
  antecedentes_documento_path TEXT,     -- path del soporte (S3 / local), opcional

  pep BOOLEAN NOT NULL DEFAULT FALSE,
  pep_detalle TEXT,

  risk_level VARCHAR(10) NOT NULL DEFAULT 'bajo'
    CHECK (risk_level IN ('bajo', 'medio', 'alto')),

  -- match_blocked = TRUE si hay coincidencia exacta de doc en lista vinculante.
  -- Bloquea login (auth-block.service consulta esta columna).
  match_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  match_blocked_reason TEXT,

  next_review_at DATE NOT NULL,         -- siguiente reKYC (anual default)

  observaciones TEXT,
  version INT NOT NULL DEFAULT 1,       -- optimistic locking

  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_laft_emp_kyc_user UNIQUE (user_id)
);

-- Índice para el cron de reKYC (filtra los próximos a vencer).
CREATE INDEX IF NOT EXISTS idx_laft_emp_kyc_next_review
  ON laft_employees_kyc(next_review_at) WHERE match_blocked = FALSE;

-- Índice para el hot-path de auth-block (lookups por user_id sólo cuando hay bloqueo).
CREATE INDEX IF NOT EXISTS idx_laft_emp_kyc_blocked
  ON laft_employees_kyc(user_id) WHERE match_blocked = TRUE;

CREATE INDEX IF NOT EXISTS idx_laft_emp_kyc_risk
  ON laft_employees_kyc(risk_level);

-- ============================================================================
-- 2. Cifrado PII de laft_counterparties (extiende patrón mig 0051)
-- ============================================================================
-- A diferencia de driver_profile (mig 0051) que usa columnas bytea separadas,
-- aquí el plan (F2) define columnas JSONB *_enc con la estructura de
-- `CipherBundle { cipher, iv, authTag, keyVersion }`. La razón: laft_counterparties
-- tiene 3 columnas PII y la app las maneja como bundle homogéneo desde el día 1.
-- El driver_profile fue migrado pre-existente con columnas separadas; mantenemos
-- esa convención cuando ya está en uso, pero introducimos la JSONB más simple
-- para tablas nuevas a cifrar.
--
-- Nota: el HMAC `doc_number_hash` SÍ usa el patrón del 0051 (Buffer hex de 32 bytes
-- almacenado como VARCHAR(64)) para reutilizar `hmacCedula()` del crypto util.

ALTER TABLE laft_counterparties
  ADD COLUMN IF NOT EXISTS doc_number_enc JSONB,
  ADD COLUMN IF NOT EXISTS doc_number_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS email_enc JSONB,
  ADD COLUMN IF NOT EXISTS phone_enc JSONB;

-- Índice de lookup por hash (permite búsqueda exacta sin descifrar).
CREATE INDEX IF NOT EXISTS idx_laft_cp_doc_hash
  ON laft_counterparties(doc_number_hash) WHERE doc_number_hash IS NOT NULL;

-- ============================================================================
-- 3. Grants para operaciones_app (sigue el patrón de migración 0011).
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON laft_employees_kyc TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE laft_employees_kyc_id_seq TO operaciones_app;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Próximos pasos (fuera de esta migración):
--   1. Desplegar código F2 (encrypt PII en INSERT/UPDATE de counterparties).
--   2. Correr `npm run laft:backfill-pii` (idempotente).
--   3. Validar 7d sin issues.
--   4. Migración 0064: DROP COLUMN doc_number, email, phone (claro) en
--      laft_counterparties.
-- ============================================================================
