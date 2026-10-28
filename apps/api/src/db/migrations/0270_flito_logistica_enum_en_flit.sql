-- 0270_flito_logistica_enum_en_flit.sql
-- HU #14109 (Feature #14091, Epica #13758) — ADR-0030. Valor `en_flit` del enum de estado del documento.
--
-- Va en un archivo APARTE de la 0271 (tablas/columnas): `ALTER TYPE ... ADD VALUE` no se puede USAR en la
-- misma transaccion en que se anade, y el runner envuelve cada archivo en una transaccion (precedente: 0167/0168).
-- Esta migracion solo anade el valor; nada la usa aqui.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente: IF NOT EXISTS.

ALTER TYPE flito_logistica_doc_estado ADD VALUE IF NOT EXISTS 'en_flit';
