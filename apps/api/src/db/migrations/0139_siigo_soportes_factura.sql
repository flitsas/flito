-- 0139_siigo_soportes_factura.sql
-- Feature #11243 — Archivar el PDF y el XML como soporte del trámite. HU #11335.
-- Autor: equipo FLITO. Motivo: colgar los documentos de la factura electrónica de la MISMA tabla
-- donde ya viven los soportes del SOAT, del impuesto y del derecho de tránsito.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ UNA CUARTA CLAVE FORÁNEA Y NO UN `tramite_id`
-- ============================================================================
--
-- El Feature pide los documentos «enlazados al trámite, junto a los demás soportes». Leído sin
-- mirar el modelo, eso sugiere `flito_soportes.tramite_id`. Esa columna NO EXISTE: un soporte
-- cuelga de `soat_id`, `impuesto_id` o `derecho_id`, uno y solo uno, porque cada flujo tiene su
-- propio registro y el trámite se alcanza desde él. Añadir `tramite_id` habría creado un quinto
-- camino al mismo sitio y dos formas de contestar «¿de qué es este documento?».
--
-- Así que se sigue el patrón que ya existe: una columna nullable más, `siigo_factura_id`, hacia la
-- tabla de facturas de la Feature #11242. Es una clave foránea HACIA `siigo_facturas`, no una
-- columna SOBRE ella (AC7): la tabla de facturas no se toca. El trámite se alcanza por
-- `siigo_factura_tramites`, que ya es el puente y que además sabe cuáles siguen vivos.
--
-- ============================================================================
-- LO QUE ESTE ARCHIVO IMPIDE
-- ============================================================================
--
-- 1. **Dos veces el mismo documento** (AC3). El índice único parcial es lo que lo cierra de
--    verdad: el archivo lo dispara un barrido periódico, y entre el «¿ya está?» del servicio y su
--    INSERT cabe otro ciclo. Comprobarlo solo en código deja esa carrera abierta, y el resultado
--    serían dos «el PDF de la factura» para una sola factura, que es justo lo que nadie sabría
--    cuál mirar. El índice excluye los descartados por la misma razón que el resto del módulo: un
--    soporte descartado libera su sitio para poder rehacer el archivo.
-- 2. **Un soporte que cuelgue de dos cosas a la vez.** La regla «uno y solo uno» estaba escrita en
--    comentarios y en nada más. Aquí se afirma para la columna nueva: una fila con
--    `siigo_factura_id` no puede llevar además `soat_id`, `impuesto_id` ni `derecho_id`. No se
--    extiende a las tres viejas entre sí a propósito — eso sería cambiar una regla vigente en una
--    migración que viene a otra cosa.

-- ── La cuarta clave foránea ─────────────────────────────────────────────────
--
-- `ON DELETE CASCADE` como las otras tres: el soporte es de la factura y no tiene vida sin ella.
-- Hoy no hay ningún camino que borre una fila de `siigo_facturas` —una factura aceptada por la
-- DIAN no se deshace, y `siigo_facturas.lote_id` es `ON DELETE RESTRICT`—, así que el cascade es
-- coherencia del modelo, no una puerta abierta.
ALTER TABLE flito_soportes
  ADD COLUMN IF NOT EXISTS siigo_factura_id uuid REFERENCES siigo_facturas(id) ON DELETE CASCADE;

COMMENT ON COLUMN flito_soportes.siigo_factura_id IS
  'Documento archivado de la factura electronica (PDF/XML). Cuarta FK nullable del mismo patron que soat_id/impuesto_id/derecho_id: flito_soportes NO tiene tramite_id.';

-- AC3 — el mismo documento no se archiva dos veces.
--
-- Parcial en las dos condiciones y por motivos distintos: `IS NOT NULL` deja fuera los millones de
-- soportes que no son de facturación (sin él, todas esas filas competirían por la pareja
-- `(NULL, tipo)` — que en un UNIQUE no colisiona, pero engorda el índice sin servir a nadie), y
-- `descartado = false` es lo que permite rehacer el archivo de un documento rechazado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_soportes_factura_tipo
    ON flito_soportes (siigo_factura_id, tipo)
    WHERE siigo_factura_id IS NOT NULL AND descartado = false;

-- ── Uno y solo uno ──────────────────────────────────────────────────────────
--
-- Se valida al vuelo sin escanear la tabla: todas las filas existentes tienen `siigo_factura_id`
-- NULL, así que satisfacen el predicado trivialmente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_soportes_factura_excluyente_chk') THEN
    ALTER TABLE flito_soportes ADD CONSTRAINT flito_soportes_factura_excluyente_chk
      CHECK (
        siigo_factura_id IS NULL
        OR (soat_id IS NULL AND impuesto_id IS NULL AND derecho_id IS NULL)
      );
  END IF;
END $$;

-- ── Barrido de lo que falta por archivar ────────────────────────────────────
--
-- El ciclo pregunta «¿qué facturas emitidas no tienen todavía sus dos documentos?». Sin este
-- índice esa consulta recorre `siigo_facturas` entera cada vez, y crece con el histórico de
-- facturación, no con lo pendiente.
CREATE INDEX IF NOT EXISTS idx_siigo_facturas_archivo_pendiente
    ON siigo_facturas (enviada_en)
    WHERE estado = 'emitida' AND cufe IS NOT NULL;
