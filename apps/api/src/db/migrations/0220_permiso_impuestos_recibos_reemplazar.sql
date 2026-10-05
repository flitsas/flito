-- 0220_permiso_impuestos_recibos_reemplazar.sql
-- HU #13269 (Feature #13267, Épica #12741, ADR-0020) — la función `impuestos.recibos.reemplazar`,
--   que guarda SOLO `POST /api/flito/impuestos/:id/recibos/reemplazar-pago`: sustituir el comprobante
--   de pago ya cargado en un impuesto y reprogramar su envío a FLIT 2. Es una ACCIÓN sensible
--   (descarta un soporte vigente), así que NO se concede a ningún rol (AC7): el administrador la
--   reparte desde el panel de Roles y permisos.
-- Autor: equipo FLITO. Antecedentes: 0212 (calco de la siembra), 0208 (función de un sub-router
--   propio de impuestos), ADR-DB-001 (sin control de transacción propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente: ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - Ni CREATE ni ALTER: solo siembra. Sin reparto (AC7). La anterior es la 0219_ (outbox FLIT 2).

-- ── Paso 1 — La operación (byte a byte con catalogo-operaciones.ts) ──────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('impuestos.recibos.reemplazar', 'impuestos', 'Reemplazar el comprobante de pago de un impuesto', 'Sustituir el comprobante de pago ya cargado en un impuesto por otro corregido y, si el trámite viene de FLIT 2, reenviarlo allá.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- ── Sin Paso 2 — Sin reparto: la función nace sin rol (AC7). Ni siquiera admin.

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0220$
DECLARE n_ops int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'impuestos.recibos.reemplazar';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE funcion_codigo = 'impuestos.recibos.reemplazar';
  IF n_ops <> 1 THEN
    RAISE EXCEPTION '0220: función de reemplazo de comprobante inconsistente (ops=%)', n_ops;
  END IF;
  RAISE NOTICE '0220: función impuestos.recibos.reemplazar sembrada (% filas de reparto; nace sin rol)', n_reparto;
END $resumen0220$;
