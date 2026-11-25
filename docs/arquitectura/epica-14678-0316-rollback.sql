-- epica-14678-0316-rollback.sql — INVERSO de la migración 0316_flito_menu_areas_proximamente.sql.
--
-- NO ES UNA MIGRACIÓN: no va en apps/api/src/db/migrations/ y ningún runner la aplica. Se corre a mano, solo si se
-- decide revertir la imagen de la API a una sin la 0316 (Épica #14678, PR 4; diseño
-- docs/arquitectura/epica-14678-menu-por-areas.md §PR 4), y con el «sí» humano.
--
-- Cuándo y en qué orden:
--   1. ANTES de revertir la imagen (mismo motivo que la 0315: la fila del ledger sin su archivo queda huérfana para el
--      initContainer `db-apply` de la imagen anterior; este script la borra).
--   2. Si también se revierte la 0315, ESTE inverso va PRIMERO y después docs/arquitectura/epica-14678-0315-rollback.sql.
--   3. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/arquitectura/epica-14678-0316-rollback.sql
--      (en PDN, con el pg_dump previo de siempre).
--   4. Revertir la imagen (commit de flit-gitops). Roll-forward: al volver a desplegar la imagen con la 0316, el
--      initContainer la aplica de nuevo (ya no está en el ledger); es idempotente.
--
-- Qué restaura: quita los cinco elementos vacíos (Comercial, Diseño, Tecnología, Infraestructura, Producto) con TODAS
-- sus marcas de rol y de usuario —también las que un administrador haya puesto desde el panel después de la 0316: con
-- el código anterior esas áreas no existen y no daban ninguna pantalla, así que lo efectivo en páginas no cambia— y
-- devuelve Gerencial y Kyverum a su orden de la 0315 (3 y 4).
-- Probado (2026-11-25): en BEGIN/ROLLBACK sobre la base local con la 0316 aplicada (P6), y lo ejerce
-- `apps/api/__tests__/db/migracion-0316.test.ts` (deja la base exactamente como antes de la 0316, también con marcas
-- puestas desde el panel).
BEGIN;
DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('menu.comercial', 'menu.diseno', 'menu.tecnologia', 'menu.infraestructura', 'menu.producto');
DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN ('menu.comercial', 'menu.diseno', 'menu.tecnologia', 'menu.infraestructura', 'menu.producto');
DELETE FROM permisos_funciones WHERE codigo IN ('menu.comercial', 'menu.diseno', 'menu.tecnologia', 'menu.infraestructura', 'menu.producto');
UPDATE permisos_funciones AS f SET orden = v.orden
  FROM (VALUES ('menu.gerencial', 3), ('menu.kyverum', 4)) AS v(codigo, orden)
 WHERE f.codigo = v.codigo AND f.orden IS DISTINCT FROM v.orden;
DELETE FROM _kyverum_applied_migrations WHERE filename = '0316_flito_menu_areas_proximamente.sql'; -- para que el roll-forward la vuelva a aplicar
COMMIT;
