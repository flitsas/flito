-- 0071 — USR-6: eliminar slugs de página muertos del catálogo.
--
-- `maintenance_admin` y `pesv_admin` existían en PAGES/PAGE_GROUPS
-- (packages/shared-types) pero NUNCA tuvieron un `requirePage(...)` que los
-- exigiera ni una ruta SPA que los renderizara (hallazgo F7 de la auditoría
-- USR-01). Se eliminan del catálogo compartido; aquí se limpian de las
-- `allowed_pages` personalizadas de usuarios que pudieran tenerlos.
--
-- Impacto esperado: ninguno operativo (no había forma de navegar a esas
-- páginas ni endpoint que las exigiera). La columna es text[] (array_remove).
--
-- ADR-DB-001: sin BEGIN/COMMIT — el runner db-apply envuelve la transacción.

UPDATE users
   SET allowed_pages = array_remove(array_remove(allowed_pages, 'maintenance_admin'), 'pesv_admin')
 WHERE allowed_pages && ARRAY['maintenance_admin', 'pesv_admin']::text[];
