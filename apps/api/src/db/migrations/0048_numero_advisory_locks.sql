-- Sprint 1 Ola A · P0-DBA-1
-- Numeradores correlativos MAN-YYYYMM-#### / REM-YYYYMM-#### con advisory lock
-- transaccional. Antes el cálculo era SELECT MAX()+1 sin lock → race condition bajo
-- concurrencia (cluster PM2 + pool 50). Ahora la sección crítica está serializada
-- por hash de namespace.

-- Namespace alto para evitar colisión con CEA/CALE/Catastro/Flotas que comparten host.
-- hashtext('operaciones') es estable; usamos 2-arg form de pg_advisory_xact_lock para
-- separar dominios (manifiesto vs remesa) sin colisión interna.

CREATE OR REPLACE FUNCTION fn_next_manifiesto_numero() RETURNS varchar AS $$
DECLARE
  v_mes varchar(6) := to_char(NOW(), 'YYYYMM');
  v_next int;
BEGIN
  -- Lock transaccional namespaced (operaciones × manifiesto × mes).
  PERFORM pg_advisory_xact_lock(hashtext('operaciones'), hashtext('manifiesto_numero_' || v_mes));

  SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '^MAN-' || v_mes || '-', ''), '')::int), 0) + 1
    INTO v_next
    FROM manifiestos
   WHERE numero LIKE 'MAN-' || v_mes || '-%';

  RETURN 'MAN-' || v_mes || '-' || lpad(v_next::text, 4, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION fn_next_remesa_numero() RETURNS varchar AS $$
DECLARE
  v_mes varchar(6) := to_char(NOW(), 'YYYYMM');
  v_next int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('operaciones'), hashtext('remesa_numero_' || v_mes));

  SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '^REM-' || v_mes || '-', ''), '')::int), 0) + 1
    INTO v_next
    FROM remesas
   WHERE numero LIKE 'REM-' || v_mes || '-%';

  RETURN 'REM-' || v_mes || '-' || lpad(v_next::text, 4, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

GRANT EXECUTE ON FUNCTION fn_next_manifiesto_numero() TO operaciones_app;
GRANT EXECUTE ON FUNCTION fn_next_remesa_numero() TO operaciones_app;
