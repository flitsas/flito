-- 0305_ia_consumo_log.sql — Contrato `ia-consumo` v1 (docs/contratos/ia-consumo.v1.md, ADR-0045).
-- Registro de consumo de APIs de IA: una fila por llamada HTTP real al proveedor. Mismo DDL que FLIT 2.0,
-- columna por columna, para consolidar sin traducir. Escrita a mano e idempotente; sin BEGIN/COMMIT (el
-- runner envuelve). NO drizzle-kit (AGENTS.md regla 6). Espejo Drizzle: `src/db/schema/ia-consumo.ts`.
--
--   1. `ia_consumo_log`     — la fila por llamada (sin imagen, sin base64, sin llaves; ver contrato §Reglas).
--   2. `ia_consumo_detalle` — prompt y respuesta completos, 1:1, SOLO con IA_CONSUMO_DETALLE=true; la tarea
--                             diaria `ia-consumo-retencion` borra lo más viejo que IA_CONSUMO_DETALLE_DIAS.
--   3. `ia_tarifa_modelo`   — tarifas USD por millón de tokens. Semilla: solo modelos Anthropic con precio
--                             oficial (platform.claude.com/docs/en/about-claude/pricing, leído el 2026-11-18).
--                             `ON CONFLICT DO NOTHING`: una tarifa corregida a mano no se pisa.
--
-- Sin CHECK de catálogo (origen, resultado, tipo_tarea): el contrato los fija en el código para que un uso
-- nuevo no exija migración. Sin FK a `users`: `usuario_id` es texto opaco, igual que en FLIT 2.0.

-- ── 1. Log ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_consumo_log (
  id                      uuid PRIMARY KEY,
  correlacion_id          uuid        NOT NULL,
  intento                 smallint    NOT NULL DEFAULT 1,
  pasada                  smallint    NOT NULL DEFAULT 1,
  fecha_inicio            timestamptz NOT NULL,
  fecha_fin               timestamptz NOT NULL,
  latencia_ms             integer     NOT NULL,
  aplicativo              text        NOT NULL,
  servicio                text        NOT NULL,
  ambiente                text        NOT NULL,
  tenant_id               text        NULL,
  usuario_id              text        NULL,
  usuario_login           text        NULL,
  origen                  text        NOT NULL,
  modulo                  text        NOT NULL,
  proceso                 text        NOT NULL,
  tipo_tarea              text        NOT NULL,
  placa                   text        NULL,
  entidad_tipo            text        NULL,
  entidad_id              text        NULL,
  archivo_mime            text        NULL,
  archivo_bytes           bigint      NULL,
  archivo_paginas         integer     NULL,
  archivo_sha256          text        NULL,
  proveedor               text        NOT NULL,
  modelo_solicitado       text        NULL,
  modelo_respondido       text        NULL,
  id_respuesta_proveedor  text        NULL,
  max_tokens              integer     NULL,
  prompt_codigo           text        NULL,
  prompt_version          text        NULL,
  prompt_hash             text        NULL,
  http_status             integer     NOT NULL DEFAULT 0,
  resultado               text        NOT NULL,
  stop_reason             text        NULL,
  error_codigo            text        NULL,
  error_mensaje           text        NULL,
  tokens_entrada          integer     NOT NULL DEFAULT 0,
  tokens_salida           integer     NOT NULL DEFAULT 0,
  tokens_cache_lectura    integer     NOT NULL DEFAULT 0,
  tokens_cache_escritura  integer     NOT NULL DEFAULT 0,
  costo_usd_estimado      numeric(12,6) NULL,
  metadatos               jsonb       NULL
);
CREATE INDEX IF NOT EXISTS ix_ia_consumo_log_fecha        ON ia_consumo_log (fecha_inicio);
CREATE INDEX IF NOT EXISTS ix_ia_consumo_log_modulo_fecha ON ia_consumo_log (modulo, fecha_inicio);
CREATE INDEX IF NOT EXISTS ix_ia_consumo_log_placa        ON ia_consumo_log (placa) WHERE placa IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ia_consumo_log_usuario      ON ia_consumo_log (usuario_id, fecha_inicio) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ia_consumo_log_correlacion  ON ia_consumo_log (correlacion_id);

-- ── 2. Detalle ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_consumo_detalle (
  consumo_id      uuid PRIMARY KEY REFERENCES ia_consumo_log(id) ON DELETE CASCADE,
  fecha_inicio    timestamptz NOT NULL,
  prompt_texto    text NULL,
  respuesta_texto text NULL
);
CREATE INDEX IF NOT EXISTS ix_ia_consumo_detalle_fecha ON ia_consumo_detalle (fecha_inicio);

-- ── 3. Tarifas ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_tarifa_modelo (
  id                          serial PRIMARY KEY,
  proveedor                   text          NOT NULL,
  modelo                      text          NOT NULL,
  vigente_desde               date          NOT NULL,
  precio_entrada_mtok         numeric(12,6) NOT NULL,
  precio_salida_mtok          numeric(12,6) NOT NULL,
  precio_cache_lectura_mtok   numeric(12,6) NOT NULL DEFAULT 0,
  precio_cache_escritura_mtok numeric(12,6) NOT NULL DEFAULT 0,
  moneda                      text          NOT NULL DEFAULT 'USD',
  UNIQUE (proveedor, modelo, vigente_desde)
);

-- Semilla Anthropic (USD / MTok): entrada, salida, lectura de caché, escritura de caché a 5 min. El modelo va
-- sin sufijo de fecha (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`, ver «Nota tarifa» del contrato).
-- Haiku 5.5 tiene dos tramos; se siembra el de prompts ≤ 100 000 tokens (el único que usa FLITO hoy: Dr. Flit
-- topa su contexto en 32 000 caracteres). Un prompt mayor queda subestimado ×5: es un costo ESTIMADO.
INSERT INTO ia_tarifa_modelo (proveedor, modelo, vigente_desde, precio_entrada_mtok, precio_salida_mtok,
                              precio_cache_lectura_mtok, precio_cache_escritura_mtok, moneda)
VALUES
  ('anthropic', 'claude-haiku-4-5',  DATE '2026-11-18', 1.000000,  5.000000, 0.100000, 1.250000, 'USD'),
  ('anthropic', 'claude-sonnet-4-6', DATE '2026-11-18', 3.000000, 15.000000, 0.300000, 3.750000, 'USD'),
  ('anthropic', 'claude-haiku-5-5',  DATE '2026-11-18', 0.100000,  0.500000, 0.010000, 0.125000, 'USD'),
  ('anthropic', 'claude-sonnet-5-5', DATE '2026-11-18', 2.000000, 10.000000, 0.100000, 2.500000, 'USD'),
  ('anthropic', 'claude-opus-5-5',   DATE '2026-11-18', 4.000000, 20.000000, 0.200000, 5.000000, 'USD')
ON CONFLICT (proveedor, modelo, vigente_desde) DO NOTHING;
