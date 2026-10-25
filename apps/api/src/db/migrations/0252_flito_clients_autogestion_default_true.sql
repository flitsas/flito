-- 0252_flito_clients_autogestion_default_true.sql
-- HU #13937 — una empresa (compañía) NUEVA nace sin servicios gestionados por FLITO: las tres banderas
-- de autogestión de `clients` pasan a DEFAULT true. Aplica a todo INSERT que no las envíe
-- (`POST /clients` legacy no las acepta; `POST /flito/tramites/crear-empresa` las manda en true
-- salvo que Operaciones marque lo contrario).
-- SIN UPDATE de filas, a propósito (decisión cerrada con el humano): las compañías existentes
-- conservan sus valores (AC5). Solo cambia el DEFAULT de la columna; NOT NULL se mantiene.
-- Escrita a mano e idempotente por naturaleza (SET DEFAULT repetido no cambia nada). NO drizzle-kit.
-- Autor: backend-agent (HU #13937). Espejo: src/db/schema.ts (tabla clients). Sin BEGIN/COMMIT (ADR-DB-001).

ALTER TABLE clients ALTER COLUMN soat_autogestionable SET DEFAULT true;
ALTER TABLE clients ALTER COLUMN impuestos_autogestionable SET DEFAULT true;
ALTER TABLE clients ALTER COLUMN logistica_autogestionable SET DEFAULT true;
