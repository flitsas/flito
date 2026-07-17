-- Sprint 4 Fase 4.1 — Permisos página RNDC.
-- Ya el catálogo se gestiona en código (apps/api/src/shared/permissions.ts).
-- Esta migración documenta el slug y opcionalmente otorga acceso al admin existente.

-- Marcar admin con permiso explícito (defensa en profundidad — el rol admin ya tiene todo).
UPDATE users
   SET allowed_pages = (
     SELECT array_agg(DISTINCT p)
       FROM unnest(COALESCE(allowed_pages, '{}'::text[]) || ARRAY['rndc', 'rndc_admin']) AS p
   )
 WHERE role = 'admin';
