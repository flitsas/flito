-- 0187_pagina_roles_permisos.sql
-- Feature #12072 — Roles y permisos configurables. HU #12085 (pieza backend de la pantalla): el panel
--   nuevo «Roles y permisos» (`/roles-permisos`) entra al motor de permisos como la pagina
--   `pagina.roles_permisos`, repartida SOLO a `admin`: el unico rol que hoy tiene las siete
--   operaciones `permisos.*` que esa pantalla consume (0186). Ningun otro rol la recibe por defecto
--   (precedente: `siigo_credenciales`); concedersela seria regalar una pantalla que responde 403.
-- Autor: equipo FLITO. Antecedentes: 0179/0181 (catalogo y reparto), 0184 (estilo: pagina nueva al
--   catalogo), 0186 (las operaciones del panel), ADR-DB-001 (sin control de transaccion propio),
--   ADR-0015 (permisos en base).
--
-- Depende de la 0178 (permisos_roles) y la 0179 (permisos_funciones, permisos_rol_funcion).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado y
--     la etiqueta no se nombra en ningun comentario.
--   - Idempotente en sentido fuerte: los dos INSERT van con ON CONFLICT DO NOTHING; la 2a pasada no
--     toca una fila (INSERT 0 0 en los dos).
--   - SOLO siembra: ni CREATE, ni ALTER, ni DROP, ni DELETE, ni UPDATE.
--   - Las filas son SALIDA de `npm run permisos:seed -w apps/api` sobre el catalogo del codigo
--     (PAGE_GROUPS + DEFAULTS_POR_ROL de shared-types), recortadas a esta pagina: el test estatico de
--     la 0179 las compara con lo que el generador produce hoy, y el de la 0187 con el catalogo.
--   - INSERT en forma parseable por __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO).

-- ── Paso 1 — La funcion de tipo pagina ──────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.roles_permisos', 'administracion', 'Roles y permisos', 'Entrar a la pantalla «Roles y permisos».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 2 — El reparto: solo admin ─────────────────────────────────────────────────────────────
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.roles_permisos')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0187$
DECLARE n_funcion int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_funcion FROM permisos_funciones WHERE codigo = 'pagina.roles_permisos' AND tipo = 'pagina';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
    WHERE funcion_codigo = 'pagina.roles_permisos' AND rol_codigo = 'admin';
  IF n_funcion <> 1 OR n_reparto <> 1 THEN
    RAISE EXCEPTION '0187: pagina.roles_permisos inconsistente (funcion=%, reparto=%)', n_funcion, n_reparto;
  END IF;
  RAISE NOTICE '0187: pagina.roles_permisos sembrada (1 funcion, % fila de reparto: admin)', n_reparto;
END $resumen0187$;
