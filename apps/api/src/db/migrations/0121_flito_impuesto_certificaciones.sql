-- 0121 — Certificación de impuestos contra el RUNT (HU #11164, Feature #11159).
--
-- Certificar es contrastar lo que FLITO cree del vehículo con lo que el RUNT reporta, ANTES de que
-- salga el dinero. Esta tabla es el rastro de esa verificación: sin ella el estado «Certificado» se
-- perdería al refrescar y no habría evidencia que mostrarle a una auditoría.
--
-- Una fila por INTENTO EXITOSO, no una por impuesto. Recertificar (RN-10) apaga la anterior y
-- escribe otra, de modo que el historial queda completo. Los intentos fallidos —discrepancia de
-- datos o error del servicio— NO dejan fila (RN-06, RN-07): el registro conserva su certificación
-- previa si la tenía.
--
-- `snapshot_runt` guarda la respuesta cruda para regenerar el certificado sin volver a consultar el
-- RUNT. Es la razón de que la certificación se persista aunque el PDF no (RN-11).
--
-- PII: `documento_consultado` y `snapshot_runt` contienen datos personales (Ley 1581). Deben
-- entrar en la política de retención del módulo de privacidad.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_impuesto_certificaciones (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impuesto_id             uuid NOT NULL REFERENCES flito_impuestos(id) ON DELETE CASCADE,
  vigente                 boolean NOT NULL DEFAULT true,
  -- Placa y documento con los que se autenticó la consulta. El documento es la PRUEBA DE PROPIEDAD
  -- (RN-02): la consulta de vehículo del RUNT no devuelve al propietario, pero solo responde OK si
  -- esta pareja placa+documento corresponde al propietario registrado.
  placa_consultada        varchar(10) NOT NULL,
  documento_consultado    varchar(30) NOT NULL,
  -- Código RUNT del tipo de documento que resolvió la consulta ('C', 'E', 'T', …).
  tipo_doc_propietario    varchar(5),
  -- ComparacionCampo[]: qué se comparó, con qué valores y si el campo era bloqueante.
  campos                  jsonb NOT NULL,
  snapshot_runt           jsonb,
  certificado_por_id      integer REFERENCES users(id) ON DELETE SET NULL,
  certificado_por_nombre  varchar(150) NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- El detalle por campo se lee siempre como lista; una fila sin campos sería un certificado vacío.
ALTER TABLE flito_impuesto_certificaciones
  DROP CONSTRAINT IF EXISTS flito_imp_cert_campos_es_lista;
ALTER TABLE flito_impuesto_certificaciones
  ADD CONSTRAINT flito_imp_cert_campos_es_lista
  CHECK (jsonb_typeof(campos) = 'array');

-- Historial del impuesto, en orden cronológico.
CREATE INDEX IF NOT EXISTS idx_flito_imp_cert_impuesto
  ON flito_impuesto_certificaciones (impuesto_id, created_at);

-- Como máximo UNA certificación vigente por impuesto. En la base, no solo en el servicio: una
-- recertificación concurrente que no apagara la anterior dejaría dos vigentes y el certificado
-- pasaría a depender del orden de lectura.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_imp_cert_una_vigente
  ON flito_impuesto_certificaciones (impuesto_id)
  WHERE vigente;
