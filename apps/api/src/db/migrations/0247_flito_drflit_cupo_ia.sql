-- HU #13854 (Feature #13696, IA-2) — Dr. Flit: cupo diario de mensajes a la IA por usuario.
-- Diseño: docs/diseno/feature-13696-dr-flit-ia.md («Cupo diario: tabla nueva (no Redis)») · ADR-0027.
--
-- Un contador por usuario × día calendario de America/Bogota. La reserva es un UPSERT condicionado
-- (`ON CONFLICT … DO UPDATE … WHERE usados < tope`), atómico frente a pestañas concurrentes.
-- MINIMIZACIÓN (Ley 1581): solo usuario, día, usados y fecha de actualización. Sin texto, IP ni intent.
-- RETENCIÓN: 90 días por `dia` (`dr-flit-purga.service.ts`, cron de `dr-flit.cron.ts`).
-- `ON DELETE CASCADE` hacia `users`: el contador no tiene valor probatorio, a diferencia de 0245/0246.
-- Idempotente; sin control de transacción propio (lo pone el runner).

CREATE TABLE IF NOT EXISTS flito_drflit_cupo_ia (
  usuario_id     integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dia            date        NOT NULL,
  usados         smallint    NOT NULL DEFAULT 0,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_flito_drflit_cupo_ia PRIMARY KEY (usuario_id, dia),
  CONSTRAINT ck_flito_drflit_cupo_ia_usados CHECK (usados >= 0)
);

-- Purga por día (la PK empieza por usuario_id y no sirve para `dia < corte`).
CREATE INDEX IF NOT EXISTS ix_flito_drflit_cupo_ia_dia ON flito_drflit_cupo_ia (dia);

COMMENT ON TABLE flito_drflit_cupo_ia IS
  'Dr. Flit IA (HU #13854): mensajes a la IA por usuario y día America/Bogota. Sin contenido. Retención 90 días.';
