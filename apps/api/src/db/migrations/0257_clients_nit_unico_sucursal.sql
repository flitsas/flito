-- HU #13952 (Feature #13943, Épica #13671) — Garantizar NIT único por sucursal en altas y ediciones de clientes.
-- Autor: David Chica. Módulo legacy `clients`.
--
-- 1. Baja lógica de `clients`: `deleted_at timestamptz NULL` (NULL = vigente) y `deleted_by` (actor, FK a `users.id`
--    ON DELETE RESTRICT, como en `users`). Esta migración NO las escribe: la baja la hace la HU #13954.
-- 2. Índice único parcial `uq_clients_document_branch_vivo`: un mismo NIT + sucursal solo puede estar en UN cliente
--    vigente. Misma normalización que la validación previa de la API (`upper(btrim(document))`). Sin NIT (NULL o
--    vacío) no participa; un cliente dado de baja tampoco. Es la red de seguridad de la carrera entre dos altas: la
--    API traduce su 23505 al mismo 409 de la validación.
--    `idx_clients_document_branch` (no único, columna cruda, incluye bajas) se CONSERVA: sirve a las búsquedas por
--    (document, branch_office) exactos, que este índice parcial y por expresión no cubre.
--
-- AVISO PDN: hacer `pg_dump` antes. Si hay clientes vigentes duplicados por NIT + sucursal, el bloque DO aborta la
-- migración (y con ella la transacción del runner) listando las parejas: se depuran a mano y se vuelve a correr.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, FK solo si no existe, CREATE UNIQUE INDEX IF NOT EXISTS. Sin control de
-- transacción propio (lo pone el runner).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_by integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_deleted_by_users_id_fk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_deleted_by_users_id_fk
      FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
DECLARE
  duplicados text;
BEGIN
  SELECT string_agg(format('NIT %s sucursal %s (ids %s)', nit, branch_office, ids), '; ' ORDER BY nit, branch_office)
    INTO duplicados
  FROM (
    SELECT upper(btrim(document)) AS nit, branch_office, string_agg(id::text, ',' ORDER BY id) AS ids
    FROM clients
    WHERE deleted_at IS NULL AND document IS NOT NULL AND btrim(document) <> ''
    GROUP BY upper(btrim(document)), branch_office
    HAVING count(*) > 1
  ) d;
  IF duplicados IS NOT NULL THEN
    RAISE EXCEPTION '0257: hay clientes vigentes con el mismo NIT y sucursal; depúrelos antes de migrar: %', duplicados;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_document_branch_vivo
  ON clients (upper(btrim(document)), branch_office)
  WHERE deleted_at IS NULL AND document IS NOT NULL AND btrim(document) <> '';
