-- 0110 — Tarifas negociadas por compañía gestora (HU #10963, Feature #10939 §2.1 y §2.2).
--
-- Hasta ahora el valor del trámite digital y el de la logística eran constantes quemadas en
-- finanzas.service.ts (COSTOS_FIJOS.tramiteDigital = 300000, COSTOS_FIJOS.logistica = 15000),
-- iguales para todos los clientes. El requerimiento dice lo contrario: cada compañía tiene su
-- propio valor negociado, y cita $200.000 en una y $1.500 en otra para el mismo concepto.
--
-- `tipo_tramite` NULL es la tarifa GENÉRICA del concepto: se usa cuando no hay una específica para
-- el tipo del trámite. Así se pueden añadir tipos nuevos (rematrícula, cambio de servicio…) sin
-- migración ni despliegue, que es justo lo que un catálogo abierto como el de FLIT exige.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.

CREATE TABLE IF NOT EXISTS flito_tarifas_compania (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id        integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  concepto           varchar(30) NOT NULL,
  -- NULL = tarifa genérica del concepto. Se guarda ya normalizado (mayúsculas, sin espacios
  -- sobrantes) porque en flito_tramites.tipo_tramite es texto libre de FLIT.
  tipo_tramite       varchar(60),
  valor              numeric(14,2) NOT NULL,
  activo             boolean NOT NULL DEFAULT true,
  actualizado_por_id integer REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_tarifas_valor_no_negativo CHECK (valor >= 0)
);

-- Una sola tarifa por compañía + concepto + tipo. El COALESCE es imprescindible: en un índice único
-- normal, NULL no colisiona con NULL y se podrían crear varias tarifas genéricas del mismo concepto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_tarifas_unica
  ON flito_tarifas_compania (compania_id, concepto, COALESCE(tipo_tramite, ''));

-- Resolver la tarifa de un trámite es siempre «esta compañía, este concepto».
CREATE INDEX IF NOT EXISTS idx_flito_tarifas_compania_concepto
  ON flito_tarifas_compania (compania_id, concepto);
