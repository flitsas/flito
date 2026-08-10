-- 0140_siigo_factura_correcciones.sql
-- Feature #11244 — Operación y auditoría de la facturación electrónica. HU #11343.
-- Autor: equipo FLITO. Motivo: registrar la corrección de una factura ya emitida.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ EXISTE ESTA TABLA ANTES DE QUE SE DECIDA NADA
-- ============================================================================
--
-- La pregunta 8 (§6 del diseño) sigue abierta: no está decidido si corregir una factura emitida
-- entra en el alcance del sistema o se maneja a mano en Siigo Nube. Esta tabla es la mitad que **no
-- depende de esa respuesta**, porque «por ahora se maneja a mano» TAMBIÉN necesita software: alguien
-- hace la corrección en Siigo Nube y, si no la registra aquí, FLITO sigue creyendo que la factura
-- está vigente y nadie puede explicar después qué pasó.
--
-- LO QUE ESTA MIGRACIÓN SE CUIDA DE NO AFIRMAR
--
-- No aparece por ningún lado el valor `nota_credito`. `docs/integraciones/siigo-api.md` §3 documenta
-- `DELETE /v1/invoices/{id}` = **borrar** y `POST /v1/invoices/{id}/annul` = **anular** como
-- operaciones distintas, y dice que **ninguna aplica** a una factura en proceso de envío a la DIAN o
-- ya aceptada (con CUFE) — justo el caso que hay que corregir. El grupo `/v1/credit-notes` **nunca
-- se ha leído**. Escribir `nota_credito` en un CHECK sería convertir una incógnita en un hecho, con
-- la agravante de que dentro de un año nadie recordaría que lo era.
--
-- Así que el catálogo se queda corto A PROPÓSITO y `otra` recoge lo que no sabemos nombrar, con
-- `motivo` obligatorio para que se cuente. Ampliarlo exige una migración: el mismo patrón con el que
-- la 0135 trata la granularidad, las retenciones y la moneda. Una migración es una decisión con
-- fecha y autor; un literal nuevo en un `switch` no lo es.
--
-- TRES COSAS QUE ESTE ARCHIVO IMPIDE
--
--   1. **Que la corrección se coma la factura.** No hay ni una columna nueva sobre `siigo_facturas`.
--      La Feature 13 tiene que poder seguir evolucionando su fila sin arrastrar a nadie, y una
--      factura corregida SIGUE existiendo ante la DIAN: el documento no se borra de la historia.
--   2. **Que una corrección registrada se pueda reescribir.** Append-only por disparador, como
--      `siigo_operaciones` (0126). Si lo que afirma que una factura se anuló se pudiera editar, no
--      probaría nada.
--   3. **Que un doble clic invente dos correcciones.** En una tabla que prohíbe DELETE, una fila
--      duplicada por un envío repetido no se puede limpiar: se queda para siempre. El UNIQUE sobre
--      (factura, documento) la impide antes de nacer.

CREATE TABLE IF NOT EXISTS siigo_factura_correcciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factura_id        uuid NOT NULL REFERENCES siigo_facturas(id) ON DELETE RESTRICT,

  -- Qué se hizo. Ver el encabezado sobre por qué NO existe 'nota_credito'.
  tipo              varchar(20) NOT NULL,
  -- Quién lo ejecutó. Un solo valor hoy; el ejecutor automático es la HU #11344, bloqueada.
  ejecutor          varchar(20) NOT NULL DEFAULT 'manual',

  -- Número o identificador del documento en Siigo. NOT NULL a propósito: una corrección que no se
  -- puede ir a verificar en Siigo es un rumor, y este registro existe justamente para que el trámite
  -- deje de mentir. Si la operación no produjo documento nuevo, se anota el de la factura corregida.
  documento_siigo   varchar(100) NOT NULL,
  -- Obligatorio (AC3). Es lo único que explica una corrección de tipo 'otra'.
  motivo            text NOT NULL,

  -- Cuándo se hizo EN SIIGO. Distinto de created_at, que es cuándo se anotó en FLITO: entre las dos
  -- puede haber días, y confundirlas haría irreconstruible la línea de tiempo del documento.
  fecha_correccion  date NOT NULL,

  registrado_por    integer REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_correccion_tipo_chk     CHECK (tipo IN ('anulacion', 'borrado', 'otra')),
  CONSTRAINT siigo_correccion_ejecutor_chk CHECK (ejecutor IN ('manual')),
  CONSTRAINT siigo_correccion_motivo_chk   CHECK (length(btrim(motivo)) >= 10),
  CONSTRAINT siigo_correccion_documento_chk CHECK (length(btrim(documento_siigo)) >= 1)
);

-- «¿Qué correcciones tiene esta factura?», más reciente primero.
CREATE INDEX IF NOT EXISTS idx_siigo_correcciones_factura
    ON siigo_factura_correcciones (factura_id, created_at DESC);

-- Un mismo documento de Siigo no se registra dos veces contra la misma factura. Ver el punto 3 del
-- encabezado: aquí no hay DELETE con el que arreglar un duplicado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_correcciones_documento
    ON siigo_factura_correcciones (factura_id, lower(btrim(documento_siigo)));

-- ── Append-only ─────────────────────────────────────────────────────────────
--
-- Mismo mecanismo que `siigo_operaciones` (0126). Función propia y no reutilizada: el mensaje
-- nombra a esta tabla, y quien lo lea en un log tiene que saber cuál se intentó tocar.

CREATE OR REPLACE FUNCTION fn_siigo_correcciones_worm()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'siigo_factura_correcciones es append-only: % no permitido',
    TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_siigo_correcciones_no_update ON siigo_factura_correcciones;
CREATE TRIGGER trg_siigo_correcciones_no_update BEFORE UPDATE ON siigo_factura_correcciones
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_correcciones_worm();

DROP TRIGGER IF EXISTS trg_siigo_correcciones_no_delete ON siigo_factura_correcciones;
CREATE TRIGGER trg_siigo_correcciones_no_delete BEFORE DELETE ON siigo_factura_correcciones
  FOR EACH ROW EXECUTE FUNCTION fn_siigo_correcciones_worm();

-- Endurecimiento por ownership, igual que en 0126. El guard existe porque en docker-compose el
-- POSTGRES_USER es `operaciones_app` y no hay ningún rol `postgres`: sin él la cadena moriría con
-- `role "postgres" does not exist`. Los disparadores sí se crean siempre.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER TABLE siigo_factura_correcciones OWNER TO postgres;
    ALTER FUNCTION fn_siigo_correcciones_worm() OWNER TO postgres;
  END IF;
END $$;

-- Permisos mínimos: SELECT + INSERT. NO UPDATE, NO DELETE, NO TRUNCATE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT ON siigo_factura_correcciones TO operaciones_app;
  END IF;
END $$;

COMMENT ON TABLE siigo_factura_correcciones IS
  'Correccion de una factura ya emitida, hecha por fuera y registrada aqui (HU #11343). Append-only. La factura original NO se toca.';
COMMENT ON COLUMN siigo_factura_correcciones.tipo IS
  'PREGUNTA ABIERTA 8: el catalogo NO incluye la nota credito, porque ese grupo de la API de Siigo nunca se ha leido. Ampliarlo exige migracion.';
COMMENT ON COLUMN siigo_factura_correcciones.ejecutor IS
  'Solo manual. El ejecutor que actua contra Siigo es la HU #11344, bloqueada por la pregunta 8.';
COMMENT ON COLUMN siigo_factura_correcciones.documento_siigo IS
  'Numero o identificador en Siigo. Sin el, la correccion no se puede verificar y el registro no vale.';
COMMENT ON COLUMN siigo_factura_correcciones.fecha_correccion IS
  'Cuando se hizo EN SIIGO. created_at es cuando se anoto en FLITO; entre las dos puede haber dias.';
