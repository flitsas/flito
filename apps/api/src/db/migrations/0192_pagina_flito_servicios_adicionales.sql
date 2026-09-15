-- 0192_pagina_flito_servicios_adicionales.sql
-- Feature #12540 — Servicios adicionales. HU #12542 (pieza backend, R0 del diseno UX):
--   la pantalla nueva del catalogo de servicios adicionales (`/flito/servicios-adicionales`) entra al
--   motor de permisos como la pagina `pagina.flito_servicios_adicionales`, repartida a `admin` y
--   `financiera`: los mismos dos roles que ya tienen las operaciones
--   `parametrizacion.servicios_adicionales.*` que esa pantalla consume (0191). `auditor` queda fuera
--   a proposito (la 0191 no le concede ni `parametrizacion.servicios_adicionales.listar`).
-- Autor: equipo FLITO. Antecedentes: 0179/0181 (catalogo y reparto de permisos), 0184 (misma pieza
--   para `pagina.flito_tarifas`, calco literal), 0191 (tabla y operaciones del catalogo),
--   ADR-DB-001 (sin control de transaccion propio), ADR-0015 (permisos en base).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: los dos INSERT van con ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila.
--   - Las filas son SALIDA de `npm run permisos:seed -w apps/api` sobre el catalogo del codigo
--     (PAGE_GROUPS + DEFAULTS_POR_ROL de shared-types), recortadas a esta pagina: el test estatico de
--     la 0179 las compara con lo que el generador produce hoy, y el de la 0192 con el catalogo.
--   - INSERT en forma parseable por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — La funcion de tipo pagina ──────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.flito_servicios_adicionales', 'finanzas', 'Finanzas — Servicios adicionales', 'Entrar a la pantalla «Finanzas — Servicios adicionales».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: admin y financiera ─────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.flito_servicios_adicionales'),
  ('financiera', 'pagina.flito_servicios_adicionales')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0192$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones WHERE codigo = 'pagina.flito_servicios_adicionales' AND tipo = 'pagina';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'pagina.flito_servicios_adicionales' AND rol_codigo IN ('admin', 'financiera');
  IF n_funcion <> 1 OR n_reparto <> 2 THEN
    RAISE EXCEPTION '0192: pagina.flito_servicios_adicionales inconsistente (funcion=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0192: pagina.flito_servicios_adicionales sembrada (1 funcion, % filas de reparto: admin y financiera)', n_reparto;
END $resumen0192$;
