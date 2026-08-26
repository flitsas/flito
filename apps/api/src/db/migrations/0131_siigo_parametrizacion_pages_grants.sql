-- 0131_siigo_parametrizacion_pages_grants.sql
-- Feature #11240 — Facturación electrónica. HU #11287: clave de página de la parametrización.
-- Autor: equipo FLITO. Motivo: que la primera pantalla de Siigo tenga permiso propio.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- El catálogo de páginas vive en CÓDIGO (`packages/shared-types/src/permissions.ts`), igual que en
-- el precedente `0044_rndc_pages_grants.sql`. Esta migración solo hace lo que el código no puede:
-- otorgar la página a los usuarios que YA existen.
--
-- `admin` ya tiene todas las páginas por rol (`ROLE_DEFAULT_PAGES.admin` es `Object.keys(PAGES)`),
-- así que esto es defensa en profundidad: si algún día alguien restringe a un admin por
-- `allowed_pages`, la parametrización de facturación no se le cae sin querer.
--
-- **Solo `admin`, igual que el precedente.** `financiera` y `auditor` reciben la página por
-- `ROLE_DEFAULT_PAGES`, y `getEffectivePages` une rol ∪ usuario, así que ya la tienen sin escribir
-- nada en su fila. Materializarla en `allowed_pages` tendría un efecto lateral indeseado: el
-- permiso dejaría de depender del rol, y un usuario que mañana pase de `auditor` a otro rol
-- CONSERVARÍA la página —`PATCH /users` solo reemplaza `allowedPages` si el llamador lo envía—.
-- No sería una fuga de datos (los routers de Siigo gatean por `requireRole`, así que todas sus
-- llamadas devolverían 403), pero sí un menú con una opción que no lleva a ninguna parte.

UPDATE users
   SET allowed_pages = (
     SELECT array_agg(DISTINCT p)
       FROM unnest(COALESCE(allowed_pages, '{}'::text[]) || ARRAY['siigo_parametrizacion']) AS p
   )
 WHERE role = 'admin'
   -- Idempotente: no vuelve a tocar a quien ya la tiene, así que reejecutar no cambia nada.
   AND NOT ('siigo_parametrizacion' = ANY(COALESCE(allowed_pages, '{}'::text[])));
