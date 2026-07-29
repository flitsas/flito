-- 0107 — Derechos de trámite (HU #10950).
--
-- Lo que el organismo de tránsito cobra por radicar el trámite. Hasta ahora ese costo era una
-- constante quemada (COSTOS_FIJOS.derechoTramite = 75000 en finanzas.service.ts) aplicada a TODOS
-- los trámites; estas tablas lo convierten en un dato real leído del recibo del organismo.
--
-- A diferencia del SOAT (anclado al VIN por RN-01), el derecho se paga POR TRÁMITE: cada radicación
-- tiene el suyo, de ahí el UNIQUE sobre tramite_id. No hay máquina de estados: el recibo llega ya
-- pagado y el registro es la prueba de cuánto se pagó.
--
-- Sin BEGIN/COMMIT (ADR-DB-001). Idempotente.

CREATE TABLE IF NOT EXISTS flito_derechos_tramite (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id          uuid NOT NULL UNIQUE REFERENCES flito_tramites(id) ON DELETE CASCADE,
  organismo_codigo    varchar(5) REFERENCES organismos_transito_config(codigo),
  compania_id         integer REFERENCES clients(id),
  valor               numeric(14,2),
  fecha_pago          date,
  numero_radicado     varchar(40),
  tipo_tramite_recibo varchar(60),
  origen              varchar(20) NOT NULL,
  soporte_id          uuid,
  extraccion          jsonb,
  advertencias        jsonb,
  registrado_por_id   integer REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_derechos_organismo ON flito_derechos_tramite (organismo_codigo);
CREATE INDEX IF NOT EXISTS idx_flito_derechos_compania  ON flito_derechos_tramite (compania_id);

-- Soporte (archivo) del derecho. Nullable como soat_id/impuesto_id: un soporte cuelga de exactamente
-- uno de los tres flujos, o de ninguno mientras espera en la cola de revisión.
ALTER TABLE flito_soportes
  ADD COLUMN IF NOT EXISTS derecho_id uuid REFERENCES flito_derechos_tramite(id) ON DELETE CASCADE;

-- Buffer de recibos cuya placa aún no cruza con ningún trámite. NO es cola de revisión humana: la
-- sincronización lo reintenta sola, porque el recibo del organismo suele llegar antes que el trámite
-- desde FLIT. Meterlos en flito_revisiones ahogaría la cola que sí exige a una persona.
CREATE TABLE IF NOT EXISTS flito_derechos_pendientes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placa               varchar(10) NOT NULL,
  soporte_id          uuid NOT NULL REFERENCES flito_soportes(id) ON DELETE CASCADE,
  organismo_codigo    varchar(5),
  valor               numeric(14,2),
  fecha_pago          date,
  numero_radicado     varchar(40),
  tipo_tramite_recibo varchar(60),
  extraccion          jsonb,
  origen              varchar(20) NOT NULL,
  intentos            integer NOT NULL DEFAULT 1,
  ultimo_intento_en   timestamptz NOT NULL DEFAULT now(),
  resuelto            boolean NOT NULL DEFAULT false,
  resuelto_tramite_id uuid REFERENCES flito_tramites(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_derechos_pendientes_placa
  ON flito_derechos_pendientes (placa, resuelto);

-- Pista opcional que se concatena al prompt genérico de OCR. Existe porque cada organismo emite el
-- recibo con un formato distinto: en vez de un extractor por organismo, una línea de configuración
-- desambigua las etiquetas raras (p.ej. "el total se rotula VALOR NETO A PAGAR").
ALTER TABLE organismos_transito_config
  ADD COLUMN IF NOT EXISTS flito_ocr_prompt_hint text;
