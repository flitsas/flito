-- 0184_pagina_flito_tarifas.sql
-- Feature #12365 — Tarifas como vigencias con historial. HU #12375 (pieza backend, R0 del diseno UX):
--   la pantalla nueva del configurador de tarifas (`/flito/tarifas`) entra al motor de permisos como
--   la pagina `pagina.flito_tarifas`, repartida a `admin` y `financiera`: los mismos dos roles que ya
--   tienen las operaciones `parametrizacion.tarifas.*` que esa pantalla consume (0182). `auditor`
--   queda fuera a proposito (la 0182 le retiro `parametrizacion.tarifas.listar`, AC16 de #12373).
-- Autor: equipo FLITO. Antecedentes: 0179/0181 (catalogo y reparto de permisos), 0182 (vigencias y
--   sus operaciones), ADR-DB-001 (sin control de transaccion propio), ADR-0015 (permisos en base).
--
-- Numeracion: se tomo 0184 dejando 0183 para `0183_tarifas_vigencias_desde_siempre.sql` (HU #12374,
--   en paralelo). Si esta HU aterriza ANTES que la #12374, este archivo se renumera a 0183 en el
--   rebase (y con el, el nombre en __tests__/db/migracion-0184.test.ts y en MIGRACIONES_CON_REPARTO).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: los dos INSERT van con ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila.
--   - Las filas son SALIDA de `npm run permisos:seed -w apps/api` sobre el catalogo del codigo
--     (PAGE_GROUPS + DEFAULTS_POR_ROL de shared-types), recortadas a esta pagina: el test estatico de
--     la 0179 las compara con lo que el generador produce hoy, y el de la 0184 con el catalogo.
--   - INSERT en forma parseable por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — La funcion de tipo pagina ──────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.flito_tarifas', 'finanzas', 'Finanzas — Tarifas', 'Entrar a la pantalla «Finanzas — Tarifas».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: admin y financiera ─────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.flito_tarifas'),
  ('financiera', 'pagina.flito_tarifas')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0184$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones WHERE codigo = 'pagina.flito_tarifas' AND tipo = 'pagina';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'pagina.flito_tarifas' AND rol_codigo IN ('admin', 'financiera');
  IF n_funcion <> 1 OR n_reparto <> 2 THEN
    RAISE EXCEPTION '0184: pagina.flito_tarifas inconsistente (funcion=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0184: pagina.flito_tarifas sembrada (1 funcion, % filas de reparto: admin y financiera)', n_reparto;
END $resumen0184$;
