-- 0287_pii_key_registry.sql
-- Feature #13978, HU #14100 y #13987 (ADR-0033 D6) — base para rotar `PII_ENC_KEY`.
--   1. `pii_key_registry`: un canario por versión de llave. Lo escribe la API al arrancar; el Job de
--      rotación solo lo lee. El canario es una constante cifrada, sin PII.
--   2. `flito_bolsas_documentos.storage_key_previa`: objeto anterior de una fila recifrada, conservado
--      durante la ventana de rollback. No se usa hasta el PR del script de rotación.
-- Sin índices nuevos: el registro se lee entero al arrancar y el recifrado va por clave primaria.
-- Sin BEGIN/COMMIT. Idempotente.

CREATE TABLE IF NOT EXISTS pii_key_registry (
  version smallint PRIMARY KEY,
  canario text NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE flito_bolsas_documentos ADD COLUMN IF NOT EXISTS storage_key_previa text;
