-- HU #13946 (Feature #13939, Épica #13671) — Retener los trámites de FLIT de un cliente inactivo.
--
-- `flito_tramites.retenido`: el trámite llegó de FLIT (FLIT 1 o FLIT 2) cuando su compañía estaba inactiva. Se guarda,
-- pero no aparece en la bandeja de trámites ni arranca SOAT/impuesto. Al activar el cliente (`cambiarEstadoCliente`),
-- en la misma transacción, sus retenidos pasan a `false` y arrancan con las reglas de un trámite recién llegado.
--
-- Sin migración de datos: los trámites existentes nacen `false` (comportamiento de hoy).
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Sin control de transacción propio (lo pone
-- el runner).

ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS retenido boolean NOT NULL DEFAULT false;

-- Parcial: la activación busca los retenidos de UNA compañía; casi todas las filas son `false` y no entran.
CREATE INDEX IF NOT EXISTS idx_flito_tramites_retenido_compania ON flito_tramites (compania_id) WHERE retenido;
