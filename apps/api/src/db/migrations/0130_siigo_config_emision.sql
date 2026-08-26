-- 0130_siigo_config_emision.sql
-- Feature #11240 — Facturación electrónica. HU #11284: configuración global de emisión.
-- Autor: equipo FLITO. Motivo: que la emisión no dependa de valores escritos en el código ni de lo
-- que recuerde quien la dispara.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ─────────────────────────── Por qué hay HISTORIAL y no una sola fila ───────────────────────────
--
-- El AC1 pide «una sola configuración VIGENTE por ambiente», no «una sola fila». La diferencia
-- importa: con estos cuatro valores se emiten documentos ante la DIAN, y la pregunta «¿con qué
-- vendedor se emitió la factura de marzo?» solo se puede responder si la configuración de marzo
-- sigue existiendo. Un UPDATE en sitio la borraría.
--
-- Por eso guardar es INSERTAR una fila nueva y apagar la anterior. El índice único parcial sobre
-- `vigente` garantiza el AC1 desde la base, no desde el código.
--
-- ──────────────────────── Los tres campos que contabilidad no ha decidido ────────────────────────
--
-- `forma_pago_codigo` es UNA, no una lista (AC3): Siigo no admite más de una forma de pago por
-- factura. Si mañana se decide capturarla por cliente, esa es otra historia — hoy el modelo de
-- FLITO no tiene forma de pago en ninguna parte donde capturarla.
--
-- `plazo_vencimiento_dias` se declara aquí y se USA en la historia de emisión (AC4). Cero por
-- defecto significa «de contado», que es una afirmación, no un hueco.
--
-- `estrategia_numeracion` lleva un CHECK con UN SOLO valor (AC5). No es un enum a medio hacer: es
-- que enviar el consecutivo desde FLITO no está implementado ni confirmado, y un CHECK de un
-- elemento obliga a que añadirlo sea una migración —es decir, una decisión— en vez de un valor que
-- alguien escriba en un formulario y que la emisión no sepa tratar.

CREATE TABLE IF NOT EXISTS siigo_config_emision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ambiente               varchar(12) NOT NULL,

  -- Los cuatro códigos salen de la copia local de los catálogos (HU #11281), nunca se escriben a
  -- mano. Se guardan como texto por la misma razón que en `siigo_catalogos`: hay catálogos con
  -- código alfanumérico y migrar el tipo después es peor que preverlo.
  documento_tipo_codigo  varchar(60),
  vendedor_codigo        varchar(60),
  forma_pago_codigo      varchar(60),
  -- Nullable a propósito: solo es obligatorio si el tipo de comprobante elegido lo exige
  -- (`cost_center_mandatory` del catálogo). Exigirlo siempre marcaría como incompleta una
  -- configuración correcta.
  centro_costo_codigo    varchar(60),

  plazo_vencimiento_dias integer NOT NULL DEFAULT 0,
  estrategia_numeracion  varchar(30) NOT NULL DEFAULT 'siigo',

  notas                  text,
  vigente                boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             integer REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             integer REFERENCES users(id),

  CONSTRAINT siigo_config_emision_ambiente_chk
    CHECK (ambiente IN ('pruebas', 'produccion')),
  -- AC5 — un único valor admitido en esta historia.
  CONSTRAINT siigo_config_emision_numeracion_chk
    CHECK (estrategia_numeracion IN ('siigo')),
  -- AC4 — un plazo negativo no significa nada; el tope evita un dato absurdo por un dedazo.
  CONSTRAINT siigo_config_emision_plazo_chk
    CHECK (plazo_vencimiento_dias >= 0 AND plazo_vencimiento_dias <= 365)
);

-- AC1 — Una sola configuración VIGENTE por ambiente. Parcial sobre `vigente`: las apagadas son
-- historial y pueden repetirse tantas veces como se haya reconfigurado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_config_emision_vigente
  ON siigo_config_emision (ambiente)
  WHERE vigente;

-- La consulta del historial de un ambiente, de lo más reciente a lo más antiguo.
CREATE INDEX IF NOT EXISTS idx_siigo_config_emision_historial
  ON siigo_config_emision (ambiente, created_at DESC);

COMMENT ON TABLE siigo_config_emision IS
  'Configuración global de emisión por ambiente (HU #11284). Guardar inserta una fila nueva y '
  'apaga la anterior: con estos valores se emiten documentos ante la DIAN y el historial es lo '
  'que permite reconstruir con qué parametrización salió cada factura.';
COMMENT ON COLUMN siigo_config_emision.forma_pago_codigo IS
  'UNA sola forma de pago (AC3): Siigo no admite más de una por factura. Capturarla por cliente o '
  'por trámite sería otra historia; hoy no existe forma de pago en el modelo de FLITO.';
COMMENT ON COLUMN siigo_config_emision.centro_costo_codigo IS
  'Obligatorio solo si el tipo de comprobante lo exige (cost_center_mandatory del catálogo).';
COMMENT ON COLUMN siigo_config_emision.plazo_vencimiento_dias IS
  'Días de plazo (AC4). Cero = de contado, que es una afirmación y no un hueco. El cálculo de la '
  'fecha de vencimiento vive en la historia de emisión, no aquí.';
COMMENT ON COLUMN siigo_config_emision.estrategia_numeracion IS
  'AC5 — solo «siigo» (consecutivo asignado por Siigo). Enviar el número desde FLITO no está '
  'implementado ni confirmado: añadirlo exige migración, es decir, una decisión explícita.';
COMMENT ON COLUMN siigo_config_emision.vigente IS
  'false = configuración histórica. El índice único parcial garantiza una sola vigente por ambiente.';
