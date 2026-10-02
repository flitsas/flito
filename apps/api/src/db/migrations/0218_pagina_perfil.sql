-- 0218_pagina_perfil.sql
-- Feature #13254 — Perfil y cambio autonomo de contrasena (Epica #12811). HU #13255 (pieza backend):
--   la pantalla nueva «Perfil» (HU #13256) entra al motor de permisos como la pagina
--   `pagina.perfil`. Con ella un principal externo puede cambiar SU PROPIA contrasena por
--   `PATCH /api/users/:id/password`. Reparto SOLO a `admin`: la pagina no va en los defaults de
--   ningun otro rol, `cliente` incluido; quien deba verla la recibe desde el panel de roles.
-- Autor: equipo FLITO. Antecedentes: 0179/0181 (catalogo y reparto de permisos), 0200 (misma pieza
--   para `pagina.finanzas_gastos_diarios`, calco literal), ADR-DB-001 (sin control de transaccion
--   propio), ADR-0015 (permisos en base).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Idempotente en sentido fuerte: los dos INSERT van con ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila.
--   - Las filas son SALIDA de `npm run permisos:seed -w apps/api` sobre el catalogo del codigo
--     (PAGE_GROUPS + DEFAULTS_POR_ROL de shared-types), recortadas a esta pagina: el test estatico de
--     la 0179 las compara con lo que el generador produce hoy, y el de la 0218 con el catalogo.
--   - INSERT en forma parseable por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — La funcion de tipo pagina ──────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.perfil', 'general', 'Perfil', 'Entrar a la pantalla «Perfil».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: solo admin ─────────────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.perfil')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0218$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones WHERE codigo = 'pagina.perfil' AND tipo = 'pagina';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'pagina.perfil' AND rol_codigo = 'admin';
  IF n_funcion <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0218: pagina.perfil inconsistente (funcion=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0218: pagina.perfil sembrada (1 funcion, % fila de reparto: admin)', n_reparto;
END $resumen0218$;
