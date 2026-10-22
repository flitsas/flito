-- 0225_flito_storage_borrados_pendientes.sql
-- Autor: backend-agent (HU #13410, Feature #13408, Épica #13201)
--
-- Borrados PENDIENTES de objetos del almacenamiento. Hoy los escribe solo el borrado de un documento
-- adicional del SOAT (`origen = 'soat.documento_adicional'`): el pendiente se inserta en la MISMA
-- transacción que borra la fila de `flito_soportes`, así que si el proceso muere antes de borrar el
-- objeto, la base recuerda qué falta. El cron horario `flito-soat-borrados-pendientes.cron.ts`
-- reintenta los abiertos, los cierra y alerta a las 72 h.
--
-- PII (Ley 1581): `storage_key` lleva la carpeta del NIT y el nombre del archivo. Solo vive en la
-- fila mientras el pendiente está ABIERTO (hace falta para borrar): el UPDATE que lo cierra la pone a
-- NULL. Para correlacionar queda `clave_hash` (sha256, 16 hex), la misma huella que va a los logs.
-- El CHECK `ck_flito_storage_borrados_pendientes_clave` lo hace estructural: abierto ⇔ clave presente.
--
-- Índice parcial de abiertos por antigüedad: el cron los lee ordenados por `creado_en` y la alerta
-- de 72 h también la mira. Los cerrados salen del índice.
--
-- Idempotente: CREATE TABLE / INDEX IF NOT EXISTS (los CHECK van dentro del CREATE). Sin BEGIN/COMMIT
-- (el runner envuelve cada archivo en su transacción).

CREATE TABLE IF NOT EXISTS flito_storage_borrados_pendientes (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key       text,
  clave_hash        varchar(16)  NOT NULL,
  origen            varchar(50)  NOT NULL,
  intentos          integer      NOT NULL DEFAULT 0,
  ultimo_intento_en timestamptz,
  ultimo_error      varchar(100),
  creado_en         timestamptz  NOT NULL DEFAULT now(),
  resuelto_en       timestamptz,
  motivo_cierre     varchar(20),
  ultima_alerta_en  timestamptz,
  CONSTRAINT ck_flito_storage_borrados_pendientes_intentos CHECK (intentos >= 0),
  CONSTRAINT ck_flito_storage_borrados_pendientes_motivo
    CHECK (motivo_cierre IS NULL OR motivo_cierre IN ('borrado', 'inexistente', 'referenciada')),
  CONSTRAINT ck_flito_storage_borrados_pendientes_cierre
    CHECK ((resuelto_en IS NULL) = (motivo_cierre IS NULL)),
  CONSTRAINT ck_flito_storage_borrados_pendientes_clave
    CHECK ((resuelto_en IS NULL) = (storage_key IS NOT NULL))
);

COMMENT ON TABLE flito_storage_borrados_pendientes IS
  'HU #13410: objetos del almacenamiento cuya fila ya se borró y cuyo objeto falta borrar. Abierto = resuelto_en NULL.';
COMMENT ON COLUMN flito_storage_borrados_pendientes.storage_key IS
  'PII (NIT de la carpeta + nombre de archivo). Solo mientras el pendiente está abierto; NULL al cerrarlo. Nunca a logs ni Bitácora.';
COMMENT ON COLUMN flito_storage_borrados_pendientes.clave_hash IS
  'sha256 de storage_key, 16 hex: la huella que va a los logs. Sobrevive al cierre.';
COMMENT ON COLUMN flito_storage_borrados_pendientes.ultimo_error IS
  'code/name del último error del almacenamiento. NUNCA el mensaje (puede repetir la clave).';

CREATE INDEX IF NOT EXISTS idx_flito_storage_borrados_pendientes_abiertos
  ON flito_storage_borrados_pendientes (creado_en)
  WHERE resuelto_en IS NULL;
