-- FLITO Fase 8 — retiro del andamiaje del FLIT simulado. Ya existe la integración HTTP real
-- (FLIT_ADAPTER único = http; ver 0098_flito_flit_integracion). El panel de demo y el adaptador
-- mock se eliminaron del código; esta tabla era su único almacén y ya no la referencia nadie.
-- ADR-DB-001: sin control de transacción propio (el runner envuelve en sql.begin()).
--
-- Sin FKs entrantes/salientes (referenciaba compañía/organismo por llaves externas), así que el
-- DROP es aislado. IF EXISTS: idempotente en ambientes donde la tabla nunca se creó.
DROP TABLE IF EXISTS flito_mock_tramite;
