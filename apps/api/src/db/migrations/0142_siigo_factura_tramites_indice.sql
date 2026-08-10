-- 0142_siigo_factura_tramites_indice.sql
-- Feature #11243 — Entrega y seguimiento de la factura electrónica. HU #11337.
-- Autor: equipo FLITO. Motivo: índice utilizable al buscar la factura de un lote de trámites.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- POR QUÉ NO BASTA EL ÍNDICE QUE YA HAY
-- ============================================================================
--
-- `siigo_factura_tramites` tiene dos índices desde la 0135: uno sobre `factura_id` y otro sobre
-- `tramite_id` que es **parcial** — `WHERE activo`. Ese segundo existe para garantizar que solo hay
-- un enlace vivo por trámite, y para esa garantía es perfecto.
--
-- Pero la consulta que alimenta el reporte de costos pregunta:
--
--     WHERE tramite_id = ANY($1) AND (activo OR sf.estado = 'fallida')
--
-- El `OR` incluye filas con `activo = false`, así que PostgreSQL **no puede demostrar** que el
-- predicado de la consulta implique el del índice parcial, y lo descarta. El resultado es un
-- recorrido secuencial de una tabla que crece con cada factura emitida, ejecutado en cada carga de
-- una pantalla que el área financiera abre todo el día.
--
-- La condición no se puede simplificar para encajar en el índice parcial: incluir las fallidas es
-- justamente lo que impide que un trámite con emisión fallida parezca no haberse intentado nunca
-- (el disparador de la 0135 pone `activo = false` cuando la factura falla). Así que lo que hay que
-- ajustar es el índice, no la pregunta.
--
-- Un btree plano sobre `tramite_id` sirve a las dos: la búsqueda por lote de esta HU y cualquier
-- consulta futura que parta del trámite sin saber si su enlace está vivo. No sustituye al parcial
-- —ese sigue siendo quien impone la unicidad— y su coste es un índice más sobre una tabla estrecha.

CREATE INDEX IF NOT EXISTS idx_siigo_factura_tramites_tramite
    ON siigo_factura_tramites (tramite_id);

COMMENT ON INDEX idx_siigo_factura_tramites_tramite IS
  'Búsqueda por lote de trámites (HU #11337). El índice parcial WHERE activo no sirve aquí: la '
  'consulta incluye las fallidas, que tienen activo = false, y el planificador no puede usarlo.';
