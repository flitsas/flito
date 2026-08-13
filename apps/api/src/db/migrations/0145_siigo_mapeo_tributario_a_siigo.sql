-- 0145_siigo_mapeo_tributario_a_siigo.sql
-- Feature #11242 — A7: el tratamiento tributario deja de vivir en FLITO.
-- Autor: equipo FLITO. Motivo: documentar en el esquema que tres columnas dejaron de leerse.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ============================================================================
-- QUÉ CAMBIÓ Y POR QUÉ NO SE BORRA NADA
-- ============================================================================
--
-- `siigo_mapeo_conceptos` guardaba una copia del tratamiento tributario de cada concepto
-- —clasificación e impuestos— y exigía que contabilidad la firmara antes de poder emitir. Esa copia
-- duplicaba algo de lo que Siigo ya es dueño y que además publica: `GET /v1/products` devuelve, por
-- producto, `taxes[]` con id, tipo y porcentaje.
--
-- Desde A7 la factura NO envía `items[].taxes` —es campo opcional del contrato— y los aplica Siigo
-- desde el propio producto. Con eso el mapeo se queda con la única pregunta que FLITO puede
-- responder: qué producto de Siigo corresponde a cada concepto de la liquidación.
--
-- **Las columnas se marcan, no se borran.** Dos razones, y ninguna es prudencia genérica:
--
--   1. `confirmado_por_id` / `confirmado_en` son el registro de QUIÉN firmó y CUÁNDO. Aunque la
--      firma ya no bloquee, borrar ese rastro elimina la respuesta a «¿con qué parametrización
--      salió aquella factura de marzo?», que es exactamente lo que se pregunta cuando la DIAN
--      objeta una.
--   2. Un `DROP COLUMN` no se deshace. Si la decisión se revierte —y es una decisión de negocio,
--      no técnica: mueve la garantía del IVA a la parametrización de Siigo Nube— volver atrás con
--      las columnas puestas es editar código; sin ellas es recuperar datos que ya no existen.
--
-- El día que esto lleve tiempo asentado en producción, retirarlas es una migración de dos líneas.

COMMENT ON COLUMN siigo_mapeo_conceptos.clasificacion_tributaria IS
  'NO SE LEE desde A7. El tratamiento tributario lo aplica Siigo desde el producto (GET /v1/products '
  'devuelve taxes[] por producto) y la factura ya no envia items[].taxes. Se conserva como historial.';

COMMENT ON COLUMN siigo_mapeo_conceptos.impuestos IS
  'NO SE LEE desde A7. Era la copia local de los impuestos del producto; la fuente es Siigo. '
  'Se conserva como historial de lo que FLITO llego a declarar.';

COMMENT ON COLUMN siigo_mapeo_conceptos.confirmado_contabilidad IS
  'YA NO BLOQUEA desde A7: sin tratamiento tributario en FLITO no queda nada que firmar aqui. '
  'La columna y sus companeras confirmado_por_id/confirmado_en se conservan como registro de quien '
  'firmo y cuando, que es lo que responde por que una factura vieja salio como salio.';
