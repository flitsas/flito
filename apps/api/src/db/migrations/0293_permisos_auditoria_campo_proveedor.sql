-- 0293_permisos_auditoria_campo_proveedor.sql
-- Autor: David Chica
-- HU #14341 (Feature #14325, ADR-0039 §3) — El historial de permisos registra la pertenencia en `flito_proveedor_id`.
-- Un usuario de un proveedor solo de Logística tiene vacía la columna vieja: registrarlo como `flito_proveedor_soat_id`
-- afirmaría un valor que esa columna no tiene. Las filas antiguas conservan su campo.
-- Solo amplía la lista blanca de la 0185. Sin BEGIN/COMMIT. Idempotente: quitar y volver a poner la restricción.
SET LOCAL lock_timeout = '5s';

ALTER TABLE permisos_auditoria DROP CONSTRAINT IF EXISTS permisos_auditoria_campo_lista_chk;
ALTER TABLE permisos_auditoria ADD CONSTRAINT permisos_auditoria_campo_lista_chk CHECK (
  campo IS NULL OR campo IN (
    'role','active','deleted_at','password','funciones','allowed_pages',
    'organismos_codigos','compania_id','flito_proveedor_soat_id','flito_proveedor_id','transito_codigo',
    'nombre','descripcion','tipo_enlace','tipo_principal','activo',
    'conjunto'
  )
) NOT VALID;
ALTER TABLE permisos_auditoria VALIDATE CONSTRAINT permisos_auditoria_campo_lista_chk;
