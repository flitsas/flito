-- 0306_flito_envios_flit2_reencolar_not_allowed.sql
-- Bug #14630 (Feature #13267) — reencolado ÚNICO de los envíos del comprobante a FLIT 2 que quedaron
--   en `error` definitivo por `409 not_allowed_in_state` `terminal:true` en un estado que FLIT 2 ya
--   admite. Decisión de producto 2026-11-19 (FLIT 2 Bug #14625): el comprobante se envía en cualquier
--   estado del trámite salvo `anulado` y `revocado`.
-- Autor: David Chica. Diseño `docs/diseno/feature-13267-envio-comprobante-flit2.md` §1, RN-03, D-1.
--
-- Qué filas: `estado = 'error'` ∧ `destino = 'flit2'` ∧ `ultimo_resultado = 'not_allowed_in_state'`
--   ∧ `estado_flit2` no nulo y fuera de (anulado, revocado) ∧ su impuesto sigue `pagado`
--   (`EstadoImpuesto.PAGADO`). Un impuesto reversado no se reencola.
-- Qué hace: `pendiente`, intentos 0, cita ya, sin arrendamiento, `version + 1` (guarda RN-07: un
--   desenlace en vuelo de la fila vieja se descarta). Deja una fila en `audit_logs` por cada fila
--   reencolada (bitácora RN-08, mismas columnas que `auditar()` de `envio-comun`): solo ids y estados.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo.
--   - Idempotente por construcción: la 2a pasada no encuentra filas en `error` que cumplan el filtro,
--     así que no actualiza ni audita nada.
--   - El CHECK de estados (0219) admite 'pendiente'; `sync_version_espera`/`en_espera_desde` se dejan
--     NULL (CHECK de espera) y `soporte_id` no se toca (una fila `error` ya lo tiene, CHECK de soporte).
SET LOCAL lock_timeout = '30s';

WITH reencoladas AS (
  UPDATE flito_impuesto_envios_flit2 e
     SET estado = 'pendiente',
         intentos = 0,
         proximo_intento_en = now(),
         tomado_por = NULL,
         tomado_en = NULL,
         sync_version_espera = NULL,
         en_espera_desde = NULL,
         version = e.version + 1,
         updated_at = now()
    FROM flito_impuestos i
   WHERE i.id = e.impuesto_id
     AND i.estado = 'pagado'
     AND e.estado = 'error'
     AND e.destino = 'flit2'
     AND e.ultimo_resultado = 'not_allowed_in_state'
     AND e.estado_flit2 IS NOT NULL
     AND lower(e.estado_flit2) NOT IN ('anulado', 'revocado')
  RETURNING e.impuesto_id, e.estado_flit2
)
INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
SELECT NULL, 'sistema', 'update', 'flito_impuesto', r.impuesto_id::text,
       'Envío a FLIT 2 reencolado (Bug #14630): estaba error por not_allowed_in_state (estado FLIT 2 '
         || lower(r.estado_flit2) || ').'
  FROM reencoladas r;
