-- HU #13804 (Feature #13695) — Dr. Flit: intentos de radicación en FLIT - SOPORTE.
-- Solo METADATOS (D6): ningún texto del caso (ni título, ni detalle, ni contacto, ni área). Purga a 12
-- meses por el cron `dr-flit.cron.ts` (RN-DRF1). Diseño: docs/diseno/feature-13695-dr-flit-soporte.md.
--
-- · UNIQUE (usuario_id, clave_idempotencia): la clave es del cliente y se reutiliza al reintentar; una
--   clave ajena (otro usuario) no colisiona ni revela que exista un caso.
-- · autorizacion_id ata el envío al consentimiento exacto que lo autorizó (RESTRICT: la tabla de
--   autorizaciones es de solo inserción, y un intento nunca debe quedar sin su prueba).
-- · Idempotente: IF NOT EXISTS en tabla e índices. Sin control de transacción propio (lo pone el runner).
CREATE TABLE IF NOT EXISTS flito_drflit_casos_soporte (
  id                  serial      PRIMARY KEY,
  usuario_id          integer     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  autorizacion_id     integer     NOT NULL REFERENCES flito_drflit_autorizaciones(id) ON DELETE RESTRICT,
  clave_idempotencia  uuid        NOT NULL,
  estado              varchar(12) NOT NULL DEFAULT 'pendiente',
  numero_ado          integer,
  ambiente            varchar(3)  NOT NULL,
  adjuntos_cantidad   smallint    NOT NULL DEFAULT 0,
  reintentos          smallint    NOT NULL DEFAULT 0,
  error_codigo        varchar(40),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  actualizado_en      timestamptz NOT NULL DEFAULT now(),
  radicado_en         timestamptz,
  CONSTRAINT ck_flito_drflit_casos_estado   CHECK (estado IN ('pendiente','creado','fallido')),
  CONSTRAINT ck_flito_drflit_casos_numero   CHECK (estado <> 'creado' OR numero_ado IS NOT NULL),
  CONSTRAINT ck_flito_drflit_casos_ambiente CHECK (ambiente IN ('DEV','QA','PDN')),
  CONSTRAINT ck_flito_drflit_casos_adjuntos CHECK (adjuntos_cantidad BETWEEN 0 AND 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_drflit_casos_usuario_clave
  ON flito_drflit_casos_soporte (usuario_id, clave_idempotencia);
CREATE INDEX IF NOT EXISTS ix_flito_drflit_casos_creado_en ON flito_drflit_casos_soporte (creado_en);
CREATE INDEX IF NOT EXISTS ix_flito_drflit_casos_autorizacion ON flito_drflit_casos_soporte (autorizacion_id);
