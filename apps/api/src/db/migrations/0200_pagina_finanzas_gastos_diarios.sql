-- 0200_pagina_finanzas_gastos_diarios.sql
-- Feature #12621 — Gastos diarios de Finanzas (Epica #12248). HU #12623 (pieza backend):
--   la pantalla nueva «Finanzas — Gastos diarios» (`/finanzas/gastos-diarios`, HU #12624) y su
--   consulta `GET /api/finanzas/gastos-diarios` entran al motor de permisos como la pagina
--   `pagina.finanzas_gastos_diarios`. Reparto SOLO a `admin`: la pagina no va en los defaults de
--   ningun otro rol (DEFAULTS_POR_ROL no cambia); quien deba verla la recibe desde el panel de roles.
-- Autor: equipo FLITO. Antecedentes: 0179/0181 (catalogo y reparto de permisos), 0192 (misma pieza
--   para `pagina.flito_servicios_adicionales`, calco literal con reparto recortado a admin),
--   ADR-DB-001 (sin control de transaccion propio), ADR-0015 (permisos en base).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: los dos INSERT van con ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila.
--   - Las filas son SALIDA de `npm run permisos:seed -w apps/api` sobre el catalogo del codigo
--     (PAGE_GROUPS + DEFAULTS_POR_ROL de shared-types), recortadas a esta pagina: el test estatico de
--     la 0179 las compara con lo que el generador produce hoy, y el de la 0200 con el catalogo.
--   - INSERT en forma parseable por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — La funcion de tipo pagina ──────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.finanzas_gastos_diarios', 'finanzas', 'Finanzas — Gastos diarios', 'Entrar a la pantalla «Finanzas — Gastos diarios».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: solo admin ─────────────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.finanzas_gastos_diarios')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0200$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones WHERE codigo = 'pagina.finanzas_gastos_diarios' AND tipo = 'pagina';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'pagina.finanzas_gastos_diarios' AND rol_codigo = 'admin';
  IF n_funcion <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0200: pagina.finanzas_gastos_diarios inconsistente (funcion=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0200: pagina.finanzas_gastos_diarios sembrada (1 funcion, % fila de reparto: admin)', n_reparto;
END $resumen0200$;
