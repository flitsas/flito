-- 0243_permisos_retirar_sync_lanzar.sql
-- HU #13631 (Feature #13612, Épica #13576) — se retira la sincronización manual de FLIT 1 y su función.
--   `POST /api/flito/sync/sincronizar` ya no existe (responde 404); FLIT 1 se lee solo de forma
--   automática (HU #13629). La función `sync.sync.lanzar` sale del catálogo y de la matriz.
-- Autor: equipo FLITO. Antecedente: 0242. En ambientes con la 0233 la fila ya pudo salir (absorbida por
--   `accion.tramites.sincronizar`); entonces los DELETE no encuentran nada y solo queda el NOTICE.
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. El bloque DO lleva dollar-quoting etiquetado.
--   - Borra SOLO por código de función. Ningún literal de rol (la 0227 tumbó DEV por uno con FK).
--   - Orden: primero las marcas (FK RESTRICT de rol_funcion y usuario_funcion), luego la función.
--   - Idempotente: la segunda corrida borra 0 filas y termina sin error.
--   - `sync.sync.ver_estado` y `tramites.sincronizacion.configurar` no se tocan.
--   - `permisos_intentos_denegados` y `permisos_auditoria` son historia (sin FK): no se tocan.

-- Forma canónica de retiro (la de la 0240): la lee el pliegue de `__tests__/helpers/permisos-seed-sql.ts`.
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN ('sync.sync.lanzar');
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('sync.sync.lanzar');
DELETE FROM permisos_funciones WHERE codigo IN ('sync.sync.lanzar');

DO $resumen0243$
BEGIN
  IF EXISTS (SELECT 1 FROM permisos_funciones WHERE codigo = 'sync.sync.lanzar')
     OR EXISTS (SELECT 1 FROM permisos_rol_funcion WHERE funcion_codigo = 'sync.sync.lanzar')
     OR EXISTS (SELECT 1 FROM permisos_usuario_funcion WHERE funcion_codigo = 'sync.sync.lanzar') THEN
    RAISE EXCEPTION '0243: sync.sync.lanzar sigue en el catálogo o en la matriz';
  END IF;
  RAISE NOTICE '0243: sync.sync.lanzar retirada del catálogo y de la matriz';
END $resumen0243$;
