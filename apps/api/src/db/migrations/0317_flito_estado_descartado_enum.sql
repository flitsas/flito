-- 0317_flito_estado_descartado_enum.sql
-- Épica #14707 «Un trámite anulado, abortado o revocado no existe en FLITO» — ADR-0049 §2, diseño
-- docs/diseno/epica-14707-tramite-muerto.md §5.2. Valor terminal `descartado` de los enums de SOAT e impuesto.
--
-- Va en un archivo APARTE de la 0318 (columnas, CHECK, índices, trigger) y de la 0319 (saneo): `ALTER TYPE …
-- ADD VALUE` no se puede USAR en la misma transacción en que se añade (55P04), y el runner envuelve cada archivo
-- en una transacción (precedente 0275/0276). Esta migración solo añade los valores; nada los usa aquí.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente: IF NOT EXISTS.

ALTER TYPE flito_soat_estado ADD VALUE IF NOT EXISTS 'descartado';
ALTER TYPE flito_impuesto_estado ADD VALUE IF NOT EXISTS 'descartado';
