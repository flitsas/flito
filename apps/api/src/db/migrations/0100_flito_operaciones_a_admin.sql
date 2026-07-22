-- FLITO — el operador del dominio ES el admin (despliegue FLITO-only). El rol `operaciones` se
-- fusiona en `admin`: los usuarios que lo tenían pasan a admin (acceso total, que aquí = FLITO).
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).
--
-- Nota: NO se elimina el valor 'operaciones' del enum user_role (quitar valores de un enum en
-- Postgres exige recrear el tipo y es innecesario): queda deprecado, sin usuarios ni asignable.
UPDATE users SET role = 'admin' WHERE role = 'operaciones';
