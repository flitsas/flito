-- 0132_clients_modelo_fiscal.sql
-- Feature #11241 — Sincronización de clientes con terceros de Siigo. HU #11292.
-- Autor: equipo FLITO. Motivo: `clients` no tiene los datos que Siigo exige para crear un tercero.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- Regla que gobierna todo el archivo: **no adivinar**. Un tipo de persona equivocado cambia la
-- forma del nombre que se le envía a Siigo y, con él, el nombre que sale impreso en una factura
-- ante la DIAN. Donde el dato existente no alcanza, la fila queda marcada y esperando a una
-- persona; no se rellena con el valor más común.

-- ── Columnas nuevas ─────────────────────────────────────────────────────────
--
-- Todas nulables o con valor por defecto: crear un cliente sigue necesitando solo el nombre (AC1).
-- Ningún flujo actual se entera de que estas columnas existen.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS person_type            varchar(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS id_type                varchar(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS check_digit            smallint;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS fiscal_responsibilities text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE clients ADD COLUMN IF NOT EXISTS country_code           varchar(2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS state_code             varchar(5);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city_code              varchar(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS commercial_name        varchar(200);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS branch_office          integer NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_first_name     varchar(100);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_last_name      varchar(100);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_email          varchar(150);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_indicative       varchar(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_number           varchar(10);

-- De dónde salió `person_type` (AC2: «la derivación queda registrada para poder auditarla»). Sin
-- esto, dentro de seis meses nadie distingue un tipo que confirmó una persona de uno que dedujo
-- este archivo, y la diferencia importa cuando Siigo rechace una factura.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS person_type_origen     varchar(20) NOT NULL DEFAULT 'sin_derivar';

-- Lo que ESTA migración encontró y le impide facturar (AC3, AC5). No es el veredicto completo de
-- facturabilidad —el informe cliente por cliente es de la HU #11296 y mira además dirección,
-- contacto y códigos de ciudad—: son los tres motivos que solo se pueden ver al migrar.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS facturacion_bloqueos   text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN clients.person_type IS
  'Siigo person_type: Person | Company. NULL = sin clasificar, no facturable.';
COMMENT ON COLUMN clients.id_type IS
  'Código de tipo de identificación de Siigo (31 NIT, 13 CC, 22 CE, 12 TI...), no el document_type de FLITO.';
COMMENT ON COLUMN clients.branch_office IS
  'Sucursal de Siigo (0-999). Junto con la identificación forma la clave real del tercero.';
COMMENT ON COLUMN clients.person_type_origen IS
  'derivado (de document_type por la migración 0132) | manual (lo fijó una persona) | sin_derivar.';
COMMENT ON COLUMN clients.facturacion_bloqueos IS
  'Motivos detectados al migrar que impiden facturar. Vacío no significa facturable: ver HU #11296.';

-- ── Restricciones de dominio ────────────────────────────────────────────────
--
-- En la base y no solo en Zod: la ruta de clientes no es el único camino a esta tabla (también
-- escriben `flito-tramites.service.ts`, `flito-parametrizacion.routes.ts` y los seeds), y un
-- `id_type` inventado no se descubre hasta que Siigo rechaza la factura.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_person_type_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_person_type_chk
      CHECK (person_type IS NULL OR person_type IN ('Person', 'Company'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_id_type_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_id_type_chk
      CHECK (id_type IS NULL OR id_type IN (
        '11','12','13','21','22','31','41','42','43','47','48','50','89','91','R-00-PN'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_check_digit_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_check_digit_chk
      CHECK (check_digit IS NULL OR (check_digit BETWEEN 0 AND 9));
  END IF;

  -- `<@` = «todo elemento está contenido en». Un código fiscal inventado no entra.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_fiscal_resp_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_fiscal_resp_chk
      CHECK (fiscal_responsibilities <@ ARRAY['R-99-PN','O-13','O-15','O-23','O-47']::text[]);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_branch_office_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_branch_office_chk
      CHECK (branch_office BETWEEN 0 AND 999);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_person_type_origen_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_person_type_origen_chk
      CHECK (person_type_origen IN ('derivado', 'manual', 'sin_derivar'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_bloqueos_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_bloqueos_chk
      CHECK (facturacion_bloqueos <@ ARRAY[
        'tipo_persona_sin_derivar','id_tipo_sin_equivalencia','identificacion_duplicada'
      ]::text[]);
  END IF;

  -- Los tres códigos de ubicación acaban en `audit_logs.detail`, que es append-only por REVOKE y
  -- que ningún cron purga. Sin patrón, usar `city_code` como campo libre metería PII imborrable
  -- justo en la tabla de la que este módulo la mantiene fuera.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_ubicacion_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_ubicacion_chk
      CHECK (
        (country_code IS NULL OR country_code ~ '^[A-Za-z]{2}$')
        AND (state_code IS NULL OR state_code ~ '^[0-9]{1,5}$')
        AND (city_code  IS NULL OR city_code  ~ '^[0-9]{1,10}$')
      );
  END IF;

  -- Siigo exige indicativo y número numéricos de hasta 10 caracteres cada uno.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_phone_partes_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_phone_partes_chk
      CHECK (
        (phone_indicative IS NULL OR phone_indicative ~ '^[0-9]{1,10}$')
        AND (phone_number IS NULL OR phone_number ~ '^[0-9]{1,10}$')
      );
  END IF;
END $$;

-- ── Derivación del tipo de persona y del tipo de identificación (AC2, AC4) ──
--
-- Solo las cuatro equivalencias confirmadas. `document_type` es un varchar(5) libre: cualquier otra
-- cosa que haya ahí se queda sin derivar a propósito.
--
-- `person_type_origen = 'sin_derivar'` en el WHERE hace la idempotencia y además protege el trabajo
-- humano: si alguien ya clasificó una fila a mano (origen `manual`), reejecutar no se la pisa.

UPDATE clients
   SET person_type = CASE upper(trim(document_type))
                       WHEN 'NIT' THEN 'Company'
                       WHEN 'CC'  THEN 'Person'
                       WHEN 'CE'  THEN 'Person'
                       WHEN 'TI'  THEN 'Person'
                     END,
       person_type_origen = 'derivado'
 WHERE person_type_origen = 'sin_derivar'
   AND upper(trim(COALESCE(document_type, ''))) IN ('NIT', 'CC', 'CE', 'TI');

UPDATE clients
   SET id_type = CASE upper(trim(document_type))
                   WHEN 'NIT' THEN '31'
                   WHEN 'CC'  THEN '13'
                   WHEN 'CE'  THEN '22'
                   WHEN 'TI'  THEN '12'
                 END
 WHERE id_type IS NULL
   AND upper(trim(COALESCE(document_type, ''))) IN ('NIT', 'CC', 'CE', 'TI');

-- ── Marcado de lo que no se pudo derivar (AC3, AC4) ─────────────────────────

UPDATE clients
   SET facturacion_bloqueos =
         (SELECT array_agg(DISTINCT b)
            FROM unnest(facturacion_bloqueos || ARRAY['tipo_persona_sin_derivar']) AS b)
 WHERE person_type IS NULL
   AND NOT ('tipo_persona_sin_derivar' = ANY(facturacion_bloqueos));

UPDATE clients
   SET facturacion_bloqueos =
         (SELECT array_agg(DISTINCT b)
            FROM unnest(facturacion_bloqueos || ARRAY['id_tipo_sin_equivalencia']) AS b)
 WHERE id_type IS NULL
   AND NOT ('id_tipo_sin_equivalencia' = ANY(facturacion_bloqueos));

-- ── Conflictos de identidad (AC5) ───────────────────────────────────────────
--
-- La migración NO falla ante identificaciones repetidas: son datos que ya existen y que solo una
-- persona puede resolver —¿son el mismo tercero y hay que fusionarlos, o son sucursales distintas
-- del mismo NIT?—. Se marcan los DOS lados del conflicto para que ninguno se facture por error:
-- en Siigo la pareja (identificación, sucursal) sería la misma y el segundo pisaría al primero.
--
-- Por el mismo motivo no se crea todavía el índice único sobre (document, branch_office): sobre
-- los datos actuales fallaría y dejaría el despliegue a medias. La unicidad se exige en la ruta
-- (HU #11292, AC5) y el índice entra cuando el informe de la HU #11296 confirme que no quedan
-- conflictos abiertos. Está declarado como deuda en el PR, no olvidado.

UPDATE clients c
   SET facturacion_bloqueos =
         (SELECT array_agg(DISTINCT b)
            FROM unnest(c.facturacion_bloqueos || ARRAY['identificacion_duplicada']) AS b)
 WHERE c.document IS NOT NULL
   AND trim(c.document) <> ''
   AND NOT ('identificacion_duplicada' = ANY(c.facturacion_bloqueos))
   AND EXISTS (
     SELECT 1 FROM clients o
      WHERE o.id <> c.id
        AND o.document IS NOT NULL
        AND trim(upper(o.document)) = trim(upper(c.document))
        AND o.branch_office = c.branch_office
   );

-- ── Índice de apoyo ─────────────────────────────────────────────────────────
--
-- El aseguramiento del tercero (HU #11297) busca por la pareja completa, no por el documento solo.
CREATE INDEX IF NOT EXISTS idx_clients_document_branch
    ON clients (document, branch_office);
