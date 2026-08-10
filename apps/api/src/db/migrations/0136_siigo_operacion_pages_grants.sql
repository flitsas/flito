-- 0136_siigo_operacion_pages_grants.sql
-- Feature #11244 — Facturación electrónica. HU #11342 (AC5): clave de página de la OPERACIÓN.
-- Autor: equipo FLITO. Motivo: que la pantalla de operación tenga permiso propio, distinto del de
-- parametrización (`siigo_parametrizacion`, migración 0131) y del reporte de costos.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- Calcada de `0131_siigo_parametrizacion_pages_grants.sql`, incluido su razonamiento, porque el
-- problema es el mismo: el catálogo de páginas vive en CÓDIGO
-- (`packages/shared-types/src/permissions.ts`) y esta migración solo hace lo que el código no puede,
-- que es otorgar la página a los usuarios que YA existen.
--
-- `admin` ya tiene todas las páginas por rol (`ROLE_DEFAULT_PAGES.admin` es `Object.keys(PAGES)`),
-- así que esto es defensa en profundidad: si algún día alguien restringe a un admin por
-- `allowed_pages`, la operación de facturación no se le cae sin querer.
--
-- **Solo `admin`, igual que el precedente.** `financiera` y `auditor` reciben la página por
-- `ROLE_DEFAULT_PAGES`, y `getEffectivePages` une rol ∪ usuario, así que ya la tienen sin escribir
-- nada en su fila. Materializarla en `allowed_pages` tendría un efecto lateral indeseado: el
-- permiso dejaría de depender del rol, y un usuario que mañana pase de `auditor` a otro rol
-- CONSERVARÍA la página —`PATCH /users` solo reemplaza `allowedPages` si el llamador lo envía—.
-- No sería una fuga de datos (las acciones de operación gatean en el servidor por la tabla de
-- `siigo.permisos.ts`, que a un rol ajeno le niega todo), pero sí un menú con una opción que no
-- lleva a ninguna parte.
--
-- Los usuarios que ya tenían permisos personalizados NO los pierden: el UPDATE agrega a
-- `allowed_pages`, no lo reemplaza.

UPDATE users
   SET allowed_pages = (
     SELECT array_agg(DISTINCT p)
       FROM unnest(COALESCE(allowed_pages, '{}'::text[]) || ARRAY['siigo_operacion']) AS p
   )
 WHERE role = 'admin'
   -- Idempotente: no vuelve a tocar a quien ya la tiene, así que reejecutar no cambia nada.
   AND NOT ('siigo_operacion' = ANY(COALESCE(allowed_pages, '{}'::text[])));
